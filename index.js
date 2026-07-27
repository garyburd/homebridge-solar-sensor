const SunCalc = require('suncalc');

const PLUGIN_NAME = 'homebridge-solar-sensor';
const PLATFORM_NAME = 'SolarSensor';

const POLL_INTERVAL = 60 * 1000; // sun poll (ms)
const STATUS_LOG_INTERVAL = 10 * 60 * 1000; // status log (ms)
const WEATHER_POLL_INTERVAL = 10 * 60 * 1000; // weather poll (ms; 144/day)

// Accept finite numbers and decimal strings: digits with an optional
// leading minus and fractional part. Return undefined for all other
// values and strings.
function toFiniteNumber(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(val)) return Number(val);
  return undefined;
}

function clamp(val, min, max, def) {
  const num = toFiniteNumber(val);
  return num === undefined ? def : Math.min(Math.max(num, min), max);
}

function isInRange(value, min, max) {
  if (min <= max) {
    return value >= min && value <= max;
  }
  return value >= min || value <= max;
}

// ------------------------------------------------------------------
// Weather provider
// ------------------------------------------------------------------
class WeatherProvider {
  constructor(name, platform, pollInterval) {
    this.name = name;
    this.platform = platform;
    this.pollInterval = pollInterval;
    this.lastUpdateTime = 0;
    this.sunny = true;
  }

  async fetchJSON(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async isSunny() {
    if (Date.now() - this.lastUpdateTime >= this.pollInterval) {
      try {
        this.sunny = await this._fetch();
      } catch (err) {
        this.platform.log.error(`[${this.name}] Failed to fetch weather: ${err.message || err}`);
        this.sunny = true;
      } finally {
        this.lastUpdateTime = Date.now();
      }
    }
    return this.sunny;
  }
}

// ------------------------------------------------------------------
// OpenWeatherMap current-weather cloud cover
// ------------------------------------------------------------------
class OpenWeatherMapProvider extends WeatherProvider {
  constructor(platform, wp) {
    super('OWM Cloud Cover', platform, WEATHER_POLL_INTERVAL);
    this.apiKey = wp.apiKey;
    this.threshold = clamp(wp.threshold, 0, 100, 50);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/2.5/weather'
      + `?lat=${this.platform.latitude}&lon=${this.platform.longitude}`
      + `&appid=${this.apiKey}`;

    const data = await this.fetchJSON(url);

    const value = data.clouds?.all;
    if (typeof value !== 'number') {
      throw new Error('response missing numeric cloud cover');
    }
    const sunny = value <= this.threshold;
    this.platform.log.info(`[${this.name}] ${value}% (threshold ${this.threshold}%) → ${sunny ? 'sunny' : 'cloudy'}`);
    return sunny;
  }
}

// ------------------------------------------------------------------
// OpenWeatherMap One Call 3.0 (UV + clouds)
// ------------------------------------------------------------------
class OpenWeatherMapOneCallProvider extends WeatherProvider {
  constructor(platform, wp) {
    super('OWM One Call', platform, WEATHER_POLL_INTERVAL);
    this.apiKey = wp.apiKey;
    this.uvThreshold = clamp(wp.uvThreshold, 0, 20, 3);
    this.cloudThreshold = clamp(wp.cloudThreshold, 0, 100, 50);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/3.0/onecall'
      + `?lat=${this.platform.latitude}&lon=${this.platform.longitude}`
      + '&exclude=minutely,hourly,daily,alerts'
      + `&appid=${this.apiKey}`;

    const data = await this.fetchJSON(url);

    const uvi = data.current?.uvi;
    const clouds = data.current?.clouds;
    if (typeof uvi !== 'number' || typeof clouds !== 'number') {
      throw new Error('response missing numeric UV index or cloud cover');
    }
    const sunny = uvi >= this.uvThreshold || clouds <= this.cloudThreshold;
    this.platform.log.info(`[${this.name}] UVI ${uvi} (≥${this.uvThreshold}), clouds ${clouds}% (≤${this.cloudThreshold}%) → ${sunny ? 'sunny' : 'cloudy'}`);
    return sunny;
  }
}

class SolarSensorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.latitude = toFiniteNumber(this.config.latitude);
    this.longitude = toFiniteNumber(this.config.longitude);

    this.accessories = new Map();
    this.weatherProvider = null;
    this.updating = false;
    this.lastPositionLogTime = 0;

    // Comparisons with undefined are false, so missing or unparseable
    // coordinates fail this check too.
    const locationValid = this.latitude >= -90 && this.latitude <= 90
      && this.longitude >= -180 && this.longitude <= 180;

    if (!locationValid) {
      this.log.error('latitude must be −90 to 90 and longitude must be −180 to 180.');
    }

    const wp = this.config.weatherProvider;
    if (wp) {
      const providers = {
        owmCloudCover: OpenWeatherMapProvider,
        owmOneCall: OpenWeatherMapOneCallProvider,
      };
      const Provider = providers[wp.provider || 'owmCloudCover'];
      if (!wp.apiKey) {
        this.log.error('weatherProvider.apiKey is required.');
      } else if (!Provider) {
        this.log.error(`Unknown weather provider: ${wp.provider}`);
      } else {
        this.weatherProvider = new Provider(this, wp);
        this.log.info(`Weather provider: ${this.weatherProvider.name}.`);
      }
    }

    this.api.on('didFinishLaunching', async () => {
      // Leave cached accessories in place so a transient config error
      // doesn't destroy the user's HomeKit automations.
      if (!locationValid) return;

      this.log.info('Finished launching, configuring sensors…');
      this.configureSensors();
      await this.updateAll();
      this.updateTimer = setInterval(() => this.updateAll(), POLL_INTERVAL);
    });
  }

  configureAccessory(accessory) {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  getOrCreateAccessory(key, name, model, validUUIDs) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(key);
    validUUIDs.add(uuid);

    let accessory = this.accessories.get(uuid);
    let isNew = false;
    if (!accessory) {
      this.log.info('Adding new accessory:', name);
      accessory = new this.api.platformAccessory(name, uuid);
      this.accessories.set(uuid, accessory);
      isNew = true;
    }

    const infoService = accessory.getService(Service.AccessoryInformation);
    if (infoService) {
      infoService
        .setCharacteristic(Characteristic.Manufacturer, 'homebridge-solar-sensor')
        .setCharacteristic(Characteristic.Model, model)
        .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 12));
    }

    return { accessory, isNew };
  }

  configureSensors() {
    const { Service, Characteristic } = this.api.hap;
    const validUUIDs = new Set();
    const seenNames = new Set();

    for (const sensorInput of (this.config.sensors || [])) {
      const name = sensorInput.name || 'Solar Sensor';
      if (seenNames.has(name)) {
        this.log.error(`[${name}] duplicate sensor name; skipping.`);
        continue;
      }
      seenNames.add(name);

      const { accessory, isNew } = this.getOrCreateAccessory(
        `${PLUGIN_NAME}.${name}`,
        name,
        'Solar Sensor',
        validUUIDs,
      );

      const cfg = {
        name,
        azimuthMin: clamp(sensorInput.azimuthMin, 0, 360, 0),
        azimuthMax: clamp(sensorInput.azimuthMax, 0, 360, 360),
        altitudeMin: clamp(sensorInput.altitudeMin, -90, 90, 0),
        altitudeMax: clamp(sensorInput.altitudeMax, -90, 90, 90),
        ignoreWeather: sensorInput.ignoreWeather === true,
      };
      accessory.context.sensorConfig = cfg;
      this.log.info(
        `[${name}] azimuth ${cfg.azimuthMin}–${cfg.azimuthMax}°, `
        + `altitude ${cfg.altitudeMin}–${cfg.altitudeMax}°, `
        + `weather ${cfg.ignoreWeather ? 'ignored' : 'used when configured'}`,
      );

      let contactService = accessory.getService(Service.ContactSensor);
      if (!contactService) {
        contactService = accessory.addService(Service.ContactSensor, name);
      }
      contactService.setCharacteristic(Characteristic.Name, name);

      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!validUUIDs.has(uuid)) {
        this.log.info('Removing stale accessory:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  async updateAll() {
    if (this.updating) return;
    this.updating = true;

    try {
      const { Service, Characteristic } = this.api.hap;
      const pos = SunCalc.getPosition(new Date(), this.latitude, this.longitude);

      const azimuth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
      const altitude = (pos.altitude * 180) / Math.PI;

      let isSunny;

      // Log on state changes and at each interval.
      let logStatus = Date.now() - this.lastPositionLogTime >= STATUS_LOG_INTERVAL;

      for (const [, accessory] of this.accessories) {
        const cfg = accessory.context.sensorConfig;
        if (!cfg) continue;
        const contactService = accessory.getService(Service.ContactSensor);
        if (!contactService) continue;

        const state = isInRange(azimuth, cfg.azimuthMin, cfg.azimuthMax)
          && isInRange(altitude, cfg.altitudeMin, cfg.altitudeMax)
          && (cfg.ignoreWeather
            || (isSunny ??= this.weatherProvider == null || await this.weatherProvider.isSunny()));

        contactService.updateCharacteristic(
          Characteristic.ContactSensorState,
          state
            ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : Characteristic.ContactSensorState.CONTACT_DETECTED,
        );

        logStatus = logStatus || accessory.context.lastState !== state;
        accessory.context.lastState = state;
      }

      if (logStatus) {
        const parts = [...this.accessories.values()]
          .filter(a => a.context.sensorConfig)
          .map(a => `${a.context.sensorConfig.name}:${a.context.lastState ? 'O' : 'C'}`)
          .join(', ');
        this.log.info(`az: ${azimuth.toFixed(2)}, alt: ${altitude.toFixed(2)}, sunny: ${isSunny ?? 'unknown'} — ${parts}`);
        this.lastPositionLogTime = Date.now();
      }
    } finally {
      this.updating = false;
    }
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, SolarSensorPlatform);
};
