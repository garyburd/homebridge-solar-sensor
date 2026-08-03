# homebridge-solar-sensor

A [Homebridge](https://homebridge.io) plugin that exposes **ContactSensor** accessories based on sun position and optional real-time [OpenWeatherMap](https://openweathermap.org) data.

The contact sensor **opens** (`CONTACT_NOT_DETECTED`) when:

1. The sun's **azimuth** is within the configured range.
2. The sun's **altitude** is within the configured range.
3. The configured **weather provider**, if any, reports sunny conditions—unless `ignoreWeather` is enabled for that sensor.

Weather checks can use OpenWeatherMap cloud cover or One Call UV and cloud-cover data. This supports automations such as closing blinds only when clear-sky sunlight hits a specific window.

Weather failures are fail-open: the plugin logs the error and uses sun position alone.

---

## Installation

### 1. Install from GitHub

Install into the Homebridge directory (`/var/lib/homebridge` on a standard Raspberry Pi / hb-service install):

```bash
npm install --prefix /var/lib/homebridge github:garyburd/homebridge-solar-sensor
```

### 2. Or clone and link

```bash
git clone https://github.com/garyburd/homebridge-solar-sensor.git
cd homebridge-solar-sensor
npm install
sudo npm link
```

Then, from your Homebridge installation directory:

```bash
sudo npm link homebridge-solar-sensor
```

### 3. Restart Homebridge

```bash
sudo hb-service restart
```

Alternatively, restart from the Homebridge UI.

## Updating

To pick up the latest version from GitHub, uninstall and reinstall, then restart Homebridge:

```bash
npm uninstall --prefix /var/lib/homebridge homebridge-solar-sensor
npm install --prefix /var/lib/homebridge github:garyburd/homebridge-solar-sensor
sudo hb-service restart
```

The uninstall step matters: `npm install` from a GitHub URL does not reliably refresh an already-installed package.

---

## Configuration

Add a `SolarSensor` platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "SolarSensor",
      "name": "Solar Sensor",
      "latitude": 47.978,
      "longitude": -122.202,
      "weatherProvider": {
        "provider": "owmOneCall",
        "apiKey": "YOUR_OWM_API_KEY",
        "uvThreshold": 3,
        "cloudThreshold": 50
      },
      "sensors": [
        {
          "name": "Sun in West Window",
          "azimuthMin": 240,
          "azimuthMax": 300,
          "altitudeMin": 10,
          "altitudeMax": 60
        },
        {
          "name": "Sun in South Window",
          "azimuthMin": 150,
          "azimuthMax": 210,
          "altitudeMin": 5,
          "altitudeMax": 90,
          "ignoreWeather": true
        }
      ]
    }
  ]
}
```

Homebridge UI (config-ui-x) can configure all fields through the plugin's schema.

### Platform Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | yes | — | Must be `"SolarSensor"` |
| `name` | string | yes | — | Platform display name |
| `latitude` | number | yes | — | Latitude (−90 to 90) |
| `longitude` | number | yes | — | Longitude (−180 to 180) |
| `weatherProvider` | object | no | — | Weather provider settings (below) |

### Weather Provider Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | yes | `"owmCloudCover"` | `"owmCloudCover"` (current weather) or `"owmOneCall"` (One Call 3.0 UV and cloud cover) |
| `apiKey` | string | yes | — | OpenWeatherMap API key |
| `threshold` | number | no | `50` | `owmCloudCover`: maximum sunny cloud cover (0–100%) |
| `uvThreshold` | number | no | `3` | `owmOneCall`: minimum sunny UV index (0–20) |
| `cloudThreshold` | number | no | `50` | `owmOneCall`: maximum sunny cloud cover (0–100%) |

Without a weather provider, sensors use sun position alone.

### Sensor Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | HomeKit name |
| `azimuthMin` | number | yes | `0` | Azimuth window start (°) |
| `azimuthMax` | number | yes | `360` | Azimuth window end (°) |
| `altitudeMin` | number | no | `-0.833` | Minimum altitude (°); the default matches the conventional sunrise/sunset threshold |
| `altitudeMax` | number | no | `90` | Maximum altitude (°) |
| `ignoreWeather` | boolean | no | `false` | Use sun position only for this sensor, ignoring the configured weather provider |

---

## Conventions

- **Azimuth** runs clockwise from north: 0° north, 90° east, 180° south, and 270° west.
- **Altitude** measures degrees above the horizon: 0° at the horizon and 90° overhead. Negative values are below the horizon.
- The default minimum altitude is **−0.833°**, the conventional threshold used for sunrise and sunset (accounting for atmospheric refraction and the sun's apparent radius).
- **Wrap-around azimuth**: When `azimuthMin` > `azimuthMax`, the range crosses north. For example, `350` to `10` includes 350° through 0° to 10°.
- **Cloud cover** (`"owmCloudCover"`) ranges from 0% (clear) to 100% (overcast). Values at or below `threshold` are sunny.
- **One Call** (`"owmOneCall"`) reports sunny when UV is at or above `uvThreshold` **or** cloud cover is at or below `cloudThreshold`.

---

## How It Works

The plugin uses [suncalc](https://github.com/mourner/suncalc) to calculate sun position from the configured coordinates and current time, updating every sensor once a minute.

With a `weatherProvider`, the plugin fetches OpenWeatherMap data at most every **10 minutes**, only when the sun is within the position range of a sensor that does not have `ignoreWeather` enabled. Two providers are available:

- **`owmCloudCover`** — Uses the [Current Weather API](https://openweathermap.org/current). Cloud cover at or below `threshold` is sunny.
- **`owmOneCall`** — Uses the [One Call API 3.0](https://openweathermap.org/api/one-call-3). UV at or above `uvThreshold`, or cloud cover at or below `cloudThreshold`, is sunny. Either signal suffices: strong UV can pass through thin clouds, while low cloud cover can indicate clear skies when UV is low near dawn or dusk. Requires a One Call 3.0 subscription (free for 1,000 calls/day).

Request failures count as sunny until the next eligible poll. A missing API key or unknown provider disables weather gating after logging an error.

Contact state follows this table:

| Sun in position range? | `ignoreWeather`? | Weather sunny? | State |
|---|---|---|---|
| Yes | Yes | — | **Open** (`CONTACT_NOT_DETECTED`) |
| Yes | No | Yes, unavailable, or none configured | **Open** (`CONTACT_NOT_DETECTED`) |
| Yes | No | No | Closed |
| No | — | — | Closed |

---

## OpenWeatherMap API Key

1. Create a free account at [openweathermap.org](https://openweathermap.org).
2. Open **API keys** in the dashboard.
3. Copy the key to `weatherProvider.apiKey`.
4. For `owmOneCall`, subscribe to the [One Call API 3.0](https://openweathermap.org/api/one-call-3) (free for 1,000 calls/day).

The free tier allows 1,000 daily calls. Ten-minute polling uses at most 144 calls per day and usually fewer because out-of-range positions skip weather checks.

---

## Examples

- **Close blinds** when clear-sky sunlight hits a specific window.
- **Turn on a fan** when afternoon sun heats a west-facing room.
- **Enable "golden hour" scenes** at low altitudes near sunset azimuth.

---

## Troubleshooting

At startup, the plugin logs sensor settings. It logs all states and sun position after state changes and every 10 minutes. Invalid coordinates disable the plugin (with a logged error) but leave cached sensors in place, so fixing the config preserves existing automations.

---

## License

MIT
