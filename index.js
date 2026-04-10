const SunCalc = require('suncalc');

const PLUGIN_NAME = 'homebridge-solar-sensor';
const PLATFORM_NAME = 'SolarSensor';

const DEFAULT_POLL_INTERVAL = 60;          // sun-position poll (seconds)

function clamp(val, min, max, def) {
  if (val == null || typeof val !== 'number' || isNaN(val)) return def;
  return Math.min(Math.max(val, min), max);
}

function isInRange(value, min, max) {
  if (min <= max) {
    return value >= min && value <= max;
  }
  return value >= min || value <= max;
}

// ------------------------------------------------------------------
// Weather provider base class
// ------------------------------------------------------------------
class WeatherProvider {
  constructor(name, log, statusLog, latitude, longitude, pollInterval) {
    this.name = name;
    this.log = log;
    this.statusLog = statusLog;
    this.latitude = latitude;
    this.longitude = longitude;
    this.pollInterval = pollInterval;
    this.lastUpdateTime = 0;
    this.sunny = true;
  }

  async isSunny() {
    if (Date.now() - this.lastUpdateTime >= this.pollInterval) {
      try {
        this.sunny = await this._fetch();
      } catch (err) {
        this.log.error('[%s] Failed to fetch weather:', this.name, err.message || err);
        this.sunny = true;
      } finally {
        this.lastUpdateTime = Date.now();
      }
    }
    return this.sunny;
  }
}

// ------------------------------------------------------------------
// Cloud-cover provider – OpenWeatherMap current weather API
// ------------------------------------------------------------------
class OpenWeatherMapProvider extends WeatherProvider {
  constructor(log, statusLog, latitude, longitude, apiKey, threshold) {
    super('OWM Cloud Cover', log, statusLog, latitude, longitude, 10 * 60 * 1000);
    this.apiKey = apiKey;
    this.threshold = clamp(threshold, 0, 100, 50);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/2.5/weather'
      + `?lat=${this.latitude}&lon=${this.longitude}`
      + `&appid=${this.apiKey}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const value = data.clouds?.all;
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error('response missing numeric cloud cover');
    }
    const sunny = value <= this.threshold;
    this.statusLog(
      `[${this.name}] ${value}% (threshold ${this.threshold}%) → ${sunny ? 'sunny' : 'cloudy'}`,
    );
    return sunny;
  }
}

// ------------------------------------------------------------------
// UV-index provider – OpenWeatherMap One Call API 3.0
// ------------------------------------------------------------------
class OpenWeatherMapUVProvider extends WeatherProvider {
  constructor(log, statusLog, latitude, longitude, apiKey, threshold) {
    super('OWM UV Index', log, statusLog, latitude, longitude, 10 * 60 * 1000);
    this.apiKey = apiKey;
    this.threshold = clamp(threshold, 0, 20, 3);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/3.0/onecall'
      + `?lat=${this.latitude}&lon=${this.longitude}`
      + '&exclude=minutely,hourly,daily,alerts'
      + `&appid=${this.apiKey}`;

    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const value = data.current?.uvi;
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error('response missing numeric UV index');
    }
    const sunny = value >= this.threshold;
    this.statusLog(
      `[${this.name}] UVI ${value} (threshold ${this.threshold}) → ${sunny ? 'sunny' : 'cloudy'}`,
    );
    return sunny;
  }
}

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, SolarSensorPlatform);
};

class SolarSensorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.latitude = this.config.latitude;
    this.longitude = this.config.longitude;
    this.pollInterval = (this.config.pollInterval || DEFAULT_POLL_INTERVAL) * 1000;
    this.statusLog = this.config.verboseLog
      ? this.log.info.bind(this.log)
      : this.log.debug.bind(this.log);

    this.accessories = new Map();
    this.weatherProvider = null;
    this.updating = false;

    if (this.latitude == null || this.longitude == null) {
      this.log.error('latitude and longitude are required in the platform config.');
      return;
    }

    const wp = this.config.weatherProvider;
    if (wp) {
      const providers = {
        owmCloudCover: OpenWeatherMapProvider,
        owmUVIndex: OpenWeatherMapUVProvider,
      };
      const Provider = providers[wp.provider || 'owmCloudCover'];
      if (!wp.apiKey) {
        this.log.error('weatherProvider.apiKey is required.');
      } else if (!Provider) {
        this.log.error('Unknown weather provider: %s', wp.provider);
      } else {
        this.weatherProvider = new Provider(
          this.log, this.statusLog,
          this.latitude, this.longitude,
          wp.apiKey, wp.threshold,
        );
        this.log.info('Weather provider: %s (threshold %s).', this.weatherProvider.name, this.weatherProvider.threshold);
      }
    }

    this.api.on('didFinishLaunching', async () => {
      this.log.info('Finished launching, configuring sensors…');
      this.configureSensors();
      await this.updateAll();
      this.updateTimer = setInterval(() => this.updateAll(), this.pollInterval);
    });
  }

  configureAccessory(accessory) {
    this.log.info('Restoring cached accessory:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  // ------------------------------------------------------------------
  // Sensor setup
  // ------------------------------------------------------------------
  configureSensors() {
    const validUUIDs = new Set();

    for (const sensorInput of (this.config.sensors || [])) {
      const name = sensorInput.name || 'Solar Sensor';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}.${name}`);
      validUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (!accessory) {
        this.log.info('Adding new accessory:', name);
        accessory = new this.api.platformAccessory(name, uuid);
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      accessory.context.sensorConfig = {
        name,
        azimuthMin: clamp(sensorInput.azimuthMin, 0, 360, 0),
        azimuthMax: clamp(sensorInput.azimuthMax, 0, 360, 360),
        altitudeMin: clamp(sensorInput.altitudeMin, -90, 90, 0),
        altitudeMax: clamp(sensorInput.altitudeMax, -90, 90, 90),
      };

      let contactService = accessory.getService(this.api.hap.Service.ContactSensor);
      if (!contactService) {
        contactService = accessory.addService(this.api.hap.Service.ContactSensor, name);
      }
      contactService.setCharacteristic(this.api.hap.Characteristic.Name, name);

      const infoService = accessory.getService(this.api.hap.Service.AccessoryInformation);
      if (infoService) {
        infoService
          .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'homebridge-solar-sensor')
          .setCharacteristic(this.api.hap.Characteristic.Model, 'Solar Sensor')
          .setCharacteristic(this.api.hap.Characteristic.SerialNumber, uuid.slice(0, 12));
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

  // ------------------------------------------------------------------
  // Sensor evaluation
  // ------------------------------------------------------------------
  async updateAll() {
    if (this.updating) return;
    this.updating = true;

    const pos = SunCalc.getPosition(new Date(), this.latitude, this.longitude);

    const azimuth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
    const altitude = (pos.altitude * 180) / Math.PI;

    for (const [, accessory] of this.accessories) {
      const cfg = accessory.context.sensorConfig;
      if (!cfg) {
        continue;
      }

      const azimuthInRange = isInRange(azimuth, cfg.azimuthMin, cfg.azimuthMax);
      const altitudeInRange = isInRange(altitude, cfg.altitudeMin, cfg.altitudeMax);
      let shouldClose = azimuthInRange && altitudeInRange;
      // Only check weather when sun is in window to reduce API calls.
      if (shouldClose && this.weatherProvider) {
        shouldClose = await this.weatherProvider.isSunny();
      }

      const contactService = accessory.getService(this.api.hap.Service.ContactSensor);
      if (contactService) {
        contactService.updateCharacteristic(
          this.api.hap.Characteristic.ContactSensorState,
          shouldClose
            ? this.api.hap.Characteristic.ContactSensorState.CONTACT_DETECTED
            : this.api.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        );
      }

      this.statusLog(
        `[${cfg.name}] az ${azimuth} [${cfg.azimuthMin}–${cfg.azimuthMax}]: ${azimuthInRange}, `
        + `alt ${altitude} [${cfg.altitudeMin}–${cfg.altitudeMax}]: ${altitudeInRange} → `
        + `${shouldClose ? 'CLOSED' : 'OPEN'}`,
      );
    }

    this.updating = false;
  }

}
