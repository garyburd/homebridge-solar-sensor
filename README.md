# homebridge-solar-sensor

A [Homebridge](https://homebridge.io) plugin that exposes **ContactSensor** accessories whose state is determined by the sun's position in the sky and (optionally) real-time weather conditions from [OpenWeatherMap](https://openweathermap.org).

The contact sensor **opens** (CONTACT_NOT_DETECTED) when all of the following are true:

1. The sun's **azimuth** is within the sensor's configured range.
2. The sun's **altitude** is within the sensor's configured range.
3. The configured **weather provider** reports sunny conditions *(only checked when a weather provider is configured)*.

This lets you build HomeKit automations that trigger based on where the sun actually is and whether it is shining — for example, closing blinds only when the sun is hitting a particular window on a clear day.

---

## Installation (from GitHub)

### 1. Install directly from the repository

```bash
sudo npm install -g github:YOUR_USERNAME/homebridge-solar-sensor
```

Replace `YOUR_USERNAME` with the GitHub account hosting the repository.

### 2. Or clone and link manually

```bash
git clone https://github.com/YOUR_USERNAME/homebridge-solar-sensor.git
cd homebridge-solar-sensor
npm install
sudo npm link
```

Then in your Homebridge installation directory:

```bash
sudo npm link homebridge-solar-sensor
```

### 3. Restart Homebridge

```bash
sudo systemctl restart homebridge
```

or, if you use Homebridge UI, restart from the web interface.

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
      "pollInterval": 60,
      "weatherProvider": {
        "provider": "owmUVIndex",
        "apiKey": "YOUR_OWM_API_KEY",
        "threshold": 3
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
          "altitudeMax": 90
        }
      ]
    }
  ]
}
```

If you use Homebridge UI (config-ui-x), the plugin provides a full schema so you can configure everything through the GUI.

### Platform Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | yes | — | Must be `"SolarSensor"` |
| `name` | string | yes | — | Display name for the platform |
| `latitude` | number | yes | — | Location latitude (−90 to 90) |
| `longitude` | number | yes | — | Location longitude (−180 to 180) |
| `pollInterval` | integer | no | `60` | Seconds between sun-position recalculations. |
| `weatherProvider` | object | no | — | Weather provider configuration (see below). When omitted, sensors fire on sun position alone. |

### Weather Provider Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | yes | `"owmCloudCover"` | `"owmCloudCover"` (OpenWeatherMap current weather API) or `"owmUVIndex"` (OpenWeatherMap One Call API 3.0). |
| `apiKey` | string | yes | — | Your OpenWeatherMap API key. |
| `threshold` | number | no | varies | For `owmCloudCover`: max cloud cover percentage (0–100, default 50). For `owmUVIndex`: minimum UV index to count as sunny (0–20, default 3). |

### Sensor Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"Solar Sensor"` | Name shown in HomeKit |
| `azimuthMin` | number | `0` | Start of azimuth window (°) |
| `azimuthMax` | number | `360` | End of azimuth window (°) |
| `altitudeMin` | number | `0` | Minimum sun altitude (°) |
| `altitudeMax` | number | `90` | Maximum sun altitude (°) |

---

## Conventions

- **Azimuth** is measured in degrees from north, clockwise: 0° = north, 90° = east, 180° = south, 270° = west.
- **Altitude** is degrees above the horizon. 0° = horizon, 90° = directly overhead. Negative values mean the sun is below the horizon.
- **Wrap-around azimuth**: If `azimuthMin` > `azimuthMax`, the range wraps through north (0°). For example, `azimuthMin: 350, azimuthMax: 10` matches azimuths from 350° through 0° to 10°.
- **Cloud cover** (provider `"owmCloudCover"`) is a percentage from 0 (clear sky) to 100 (fully overcast). The sensor is sunny when cloud cover is at or below the threshold.
- **UV index** (provider `"owmUVIndex"`) measures solar radiation reaching the ground. The sensor is sunny when the UV index is at or above the threshold.

---

## How It Works

The plugin uses [suncalc](https://github.com/mourner/suncalc) to compute the sun's position based on your latitude, longitude, and the current time. Every `pollInterval` seconds it recalculates the sun position and updates each sensor.

When a `weatherProvider` is configured, the plugin fetches weather data every **10 minutes** from OpenWeatherMap. Weather is only fetched when the sun is in at least one sensor's window, to reduce API calls. Two providers are available:

- **`owmCloudCover`** — Uses the [OpenWeatherMap Current Weather API](https://openweathermap.org/current). Sunny when cloud cover percentage is at or below the threshold.
- **`owmUVIndex`** — Uses the [OpenWeatherMap One Call API 3.0](https://openweathermap.org/api/one-call-3). Sunny when UV index is at or above the threshold. This is a more direct measure of whether the sun is actually bright, since thin high clouds can report high cloud cover while still allowing strong sunlight. Requires a One Call API 3.0 subscription (free for 1000 calls/day).

A sensor's contact state is determined by:

| Sun in azimuth/altitude window? | Weather provider says sunny? | Contact state |
|---|---|---|
| Yes | Yes (or no provider configured) | **Open** (CONTACT_NOT_DETECTED) |
| Yes | No | Closed |
| No | — | Closed |

---

## Getting an OpenWeatherMap API Key

1. Create a free account at [openweathermap.org](https://openweathermap.org).
2. Navigate to **API keys** in your account dashboard.
3. Copy your key and paste it into the `weatherProvider.apiKey` field.
4. For the `uvIndex` provider, subscribe to the [One Call API 3.0](https://openweathermap.org/api/one-call-3) (free for 1000 calls/day).

The free tier allows up to 1,000 API calls per day. Weather is only fetched when the sun is in a sensor's window, so actual usage is well below the limit.

---

## Use-Case Examples

- **Close motorised blinds** when the sun hits a specific window *and* the sky is clear.
- **Turn on a fan** when afternoon sun heats a west-facing room on sunny days.
- **Enable "golden hour" lighting scenes** by targeting low altitudes near sunset azimuth.
- **Skip automations on overcast days** by configuring a weather provider with a low threshold.

---

## Troubleshooting

Sensor state changes are logged at info level. Sun position is logged at info level every 10 minutes. For full debug output on every poll:

```bash
homebridge -D
```

or set `"debug": true` in your Homebridge UI settings.

---

## License

MIT
