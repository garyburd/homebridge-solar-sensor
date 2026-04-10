const SunCalc = require('suncalc');

const PLUGIN_NAME = 'homebridge-solar-sensor';
const PLATFORM_NAME = 'SolarSensor';

const DEFAULT_POLL_INTERVAL = 60;          // sun-position poll (seconds)
const WEATHER_POLL_INTERVAL = 10 * 60;     // 10 minutes (seconds)
const DEFAULT_CLOUD_COVER_MAX = 50;        // percent

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

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, SolarSensorPlatform);
};

class SolarSensorPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.latitude = this.config.latitude;
    this.longitude = this.config.longitude;
    this.openWeatherMapApiKey = this.config.openWeatherMapApiKey || null;
    this.pollInterval = (this.config.pollInterval || DEFAULT_POLL_INTERVAL) * 1000;
    this.sensors = this.config.sensors || [];
    this.verboseLog = this.config.verboseLog || false;

    this.accessories = new Map();
    this.cloudCover = null;
    this.lastWeatherFetch = 0;
    this.updating = false;

    if (this.latitude == null || this.longitude == null) {
      this.log.error('latitude and longitude are required in the platform config.');
      return;
    }

    if (this.openWeatherMapApiKey) {
      this.log.info('OpenWeatherMap API key configured – cloud cover fetched on demand.');
    } else {
      this.log.info(
        'No OpenWeatherMap API key configured – cloud cover will not be checked. '
        + 'Sensors will trigger based on sun position only.',
      );
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

    for (const sensorInput of this.sensors) {
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
        cloudCoverMax: clamp(sensorInput.cloudCoverMax, 0, 100, DEFAULT_CLOUD_COVER_MAX),
      };

      let contactService = accessory.getService(this.Service.ContactSensor);
      if (!contactService) {
        contactService = accessory.addService(this.Service.ContactSensor, name);
      }
      contactService.setCharacteristic(this.Characteristic.Name, name);

      const infoService = accessory.getService(this.Service.AccessoryInformation);
      if (infoService) {
        infoService
          .setCharacteristic(this.Characteristic.Manufacturer, 'homebridge-solar-sensor')
          .setCharacteristic(this.Characteristic.Model, 'Solar Sensor')
          .setCharacteristic(this.Characteristic.SerialNumber, uuid.slice(0, 12));
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
  // Weather
  // ------------------------------------------------------------------
  fetchWeather() {
    const url =
      'https://api.openweathermap.org/data/2.5/weather'
      + `?lat=${this.latitude}&lon=${this.longitude}`
      + `&appid=${this.openWeatherMapApiKey}`;

    return fetch(url, { signal: AbortSignal.timeout(15000) })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();

        const value = data.clouds?.all;
        if (typeof value !== 'number' || isNaN(value)) {
          throw new Error('response missing numeric cloud cover');
        }
        this.cloudCover = value;
        this.log.debug(`Cloud cover updated: ${this.cloudCover}%`);
      })
      .catch((err) => {
        this.log.error('Failed to fetch weather:', err.message || err);
        this.cloudCover = null;
      })
      .finally(() => {
        this.lastWeatherFetch = Date.now();
      });
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

    const logFn = this.verboseLog ? this.log.info.bind(this.log) : this.log.debug.bind(this.log);

    // Fetch weather on demand: only when sun is in at least one window and data is stale.
    if (this.openWeatherMapApiKey) {
      const age = Date.now() - this.lastWeatherFetch;
      if (age >= WEATHER_POLL_INTERVAL * 1000) {
        this.cloudCover = null;
        for (const [, accessory] of this.accessories) {
          const cfg = accessory.context.sensorConfig;
          if (!cfg) continue;
          if (isInRange(azimuth, cfg.azimuthMin, cfg.azimuthMax)
              && isInRange(altitude, cfg.altitudeMin, cfg.altitudeMax)) {
            await this.fetchWeather();
            break;
          }
        }
      }
    }

    for (const [, accessory] of this.accessories) {
      const cfg = accessory.context.sensorConfig;
      if (!cfg) {
        continue;
      }

      const azimuthInRange = isInRange(azimuth, cfg.azimuthMin, cfg.azimuthMax);
      const altitudeInRange = isInRange(altitude, cfg.altitudeMin, cfg.altitudeMax);
      const sunInWindow = azimuthInRange && altitudeInRange;
      const skyIsClear = this.cloudCover == null || this.cloudCover <= cfg.cloudCoverMax;
      const shouldClose = sunInWindow && skyIsClear;

      const contactService = accessory.getService(this.Service.ContactSensor);
      if (contactService) {
        contactService.updateCharacteristic(
          this.Characteristic.ContactSensorState,
          shouldClose
            ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
            : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED,
        );
      }

      logFn(
        `[${cfg.name}] az ${azimuth} [${cfg.azimuthMin}–${cfg.azimuthMax}]: ${azimuthInRange}, `
        + `alt ${altitude} [${cfg.altitudeMin}–${cfg.altitudeMax}]: ${altitudeInRange}, `
        + `clouds ${this.cloudCover} [≤${cfg.cloudCoverMax}]: ${skyIsClear} → `
        + `${shouldClose ? 'CLOSED' : 'OPEN'}`,
      );
    }

    this.updating = false;
  }

}
