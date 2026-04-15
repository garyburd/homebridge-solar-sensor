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
// Cloud-cover provider – OpenWeatherMap current weather API
// ------------------------------------------------------------------
class OpenWeatherMapProvider extends WeatherProvider {
  constructor(platform, apiKey, threshold) {
    super('OWM Cloud Cover', platform, 10 * 60 * 1000);
    this.apiKey = apiKey;
    this.threshold = clamp(threshold, 0, 100, 50);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/2.5/weather'
      + `?lat=${this.platform.latitude}&lon=${this.platform.longitude}`
      + `&appid=${this.apiKey}`;

    const data = await this.fetchJSON(url);

    const value = data.clouds?.all;
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error('response missing numeric cloud cover');
    }
    const sunny = value <= this.threshold;
    this.platform.log.info(`[${this.name}] ${value}% (threshold ${this.threshold}%) → ${sunny ? 'sunny' : 'cloudy'}`);
    return sunny;
  }
}

// ------------------------------------------------------------------
// UV-index provider – OpenWeatherMap One Call API 3.0
// ------------------------------------------------------------------
class OpenWeatherMapUVProvider extends WeatherProvider {
  constructor(platform, apiKey, threshold) {
    super('OWM UV Index', platform, 10 * 60 * 1000);
    this.apiKey = apiKey;
    this.threshold = clamp(threshold, 0, 20, 3);
  }

  async _fetch() {
    const url =
      'https://api.openweathermap.org/data/3.0/onecall'
      + `?lat=${this.platform.latitude}&lon=${this.platform.longitude}`
      + '&exclude=minutely,hourly,daily,alerts'
      + `&appid=${this.apiKey}`;

    const data = await this.fetchJSON(url);

    const value = data.current?.uvi;
    if (typeof value !== 'number' || isNaN(value)) {
      throw new Error('response missing numeric UV index');
    }
    const sunny = value >= this.threshold;
    this.platform.log.info(`[${this.name}] UVI ${value} (threshold ${this.threshold}) → ${sunny ? 'sunny' : 'cloudy'}`);
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

    this.accessories = new Map();
    this.switchStates = new Map();
    this.weatherProvider = null;
    this.updating = false;
    this.lastPositionLogTime = 0;

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
        this.log.error(`Unknown weather provider: ${wp.provider}`);
      } else {
        this.weatherProvider = new Provider(this, wp.apiKey, wp.threshold);
        this.log.info(`Weather provider: ${this.weatherProvider.name} (threshold ${this.weatherProvider.threshold}).`);
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
    const { Service, Characteristic } = this.api.hap;
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

      const cfg = {
        name,
        azimuthMin: clamp(sensorInput.azimuthMin, 0, 360, 0),
        azimuthMax: clamp(sensorInput.azimuthMax, 0, 360, 360),
        altitudeMin: clamp(sensorInput.altitudeMin, -90, 90, 0),
        altitudeMax: clamp(sensorInput.altitudeMax, -90, 90, 90),
      };
      accessory.context.sensorConfig = cfg;
      this.log.info(`[${name}] azimuth ${cfg.azimuthMin}–${cfg.azimuthMax}°, altitude ${cfg.altitudeMin}–${cfg.altitudeMax}°`);

      let contactService = accessory.getService(Service.ContactSensor);
      if (!contactService) {
        contactService = accessory.addService(Service.ContactSensor, name);
      }
      contactService.setCharacteristic(Characteristic.Name, name);

      const infoService = accessory.getService(Service.AccessoryInformation);
      if (infoService) {
        infoService
          .setCharacteristic(Characteristic.Manufacturer, 'homebridge-solar-sensor')
          .setCharacteristic(Characteristic.Model, 'Solar Sensor')
          .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 12));
      }
    }

    for (const switchInput of (this.config.sunnySwitches || [])) {
      const name = switchInput.name || 'Sunny Switch';
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}.switch.${name}`);
      validUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (!accessory) {
        this.log.info('Adding new sunny switch:', name);
        accessory = new this.api.platformAccessory(name, uuid);
        this.accessories.set(uuid, accessory);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      accessory.context.switchConfig = { name };
      this.switchStates.set(uuid, false);

      let switchService = accessory.getService(Service.Switch);
      if (!switchService) {
        switchService = accessory.addService(Service.Switch, name);
      }
      switchService.setCharacteristic(Characteristic.Name, name);

      switchService.getCharacteristic(Characteristic.On)
        .onGet(() => this.switchStates.get(uuid) || false)
        .onSet((value) => {
          const on = !!value;
          this.switchStates.set(uuid, on);
          this.log.info(`[${name}] switch → ${on ? 'ON' : 'OFF'}`);
          this.updateAll();
        });

      const infoService = accessory.getService(Service.AccessoryInformation);
      if (infoService) {
        infoService
          .setCharacteristic(Characteristic.Manufacturer, 'homebridge-solar-sensor')
          .setCharacteristic(Characteristic.Model, 'Sunny Switch')
          .setCharacteristic(Characteristic.SerialNumber, uuid.slice(0, 12));
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

    try {
      const { Service, Characteristic } = this.api.hap;
      const pos = SunCalc.getPosition(new Date(), this.latitude, this.longitude);

      const azimuth = ((pos.azimuth * 180) / Math.PI + 180) % 360;
      const altitude = (pos.altitude * 180) / Math.PI;

      let anyChanged = false;
      for (const [, accessory] of this.accessories) {
        const cfg = accessory.context.sensorConfig;
        if (!cfg) {
          continue;
        }

        const state = isInRange(azimuth, cfg.azimuthMin, cfg.azimuthMax)
          && isInRange(altitude, cfg.altitudeMin, cfg.altitudeMax)
          && ((!this.weatherProvider && this.switchStates.size === 0)
            || [...this.switchStates.values()].some(v => v)
            || (this.weatherProvider && await this.weatherProvider.isSunny()));

        const contactService = accessory.getService(Service.ContactSensor);
        if (contactService) {
          contactService.updateCharacteristic(
            Characteristic.ContactSensorState,
            state
              ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
              : Characteristic.ContactSensorState.CONTACT_DETECTED,
          );
        }

        const changed = accessory.context.lastState !== state;
        accessory.context.lastState = state;
        anyChanged = anyChanged || changed;
      }

      if (anyChanged || Date.now() - this.lastPositionLogTime >= 10 * 60 * 1000) {
        const states = [...this.accessories.values()]
          .filter(a => a.context.sensorConfig)
          .map(a => `${a.context.sensorConfig.name}: ${a.context.lastState ? 'OPEN' : 'CLOSED'}`)
          .join(', ');
        this.log.info(`az ${azimuth.toFixed(2)}, alt ${altitude.toFixed(2)} — ${states}`);
        this.lastPositionLogTime = Date.now();
      }
    } finally {
      this.updating = false;
    }
  }

}
