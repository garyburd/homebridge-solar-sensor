# homebridge-solar-sensor

A [Homebridge](https://homebridge.io) plugin that exposes **ContactSensor** accessories whose state is determined by the sun's position in the sky and (optionally) real-time weather conditions from [OpenWeatherMap](https://openweathermap.org).

The contact sensor **opens** (CONTACT_NOT_DETECTED) when all of the following are true:

1. The sun's **azimuth** is within the sensor's configured range.
2. The sun's **altitude** is within the sensor's configured range.
3. At least one **sunny source** reports sunny conditions *(only checked when a weather provider or sunny switches are configured)*.

A sunny source is either a configured **weather provider** (OpenWeatherMap cloud cover, or One Call combining UV index and cloud cover) or a **sunny switch** — a HomeKit switch that can be toggled by automations (e.g. from a light sensor detecting bright light). If any sunny source reports sunny, the condition is met.

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
      "weatherProvider": {
        "provider": "owmOneCall",
        "apiKey": "YOUR_OWM_API_KEY",
        "uvThreshold": 3,
        "cloudThreshold": 50
      },
      "sunnySwitches": [
        { "name": "Front Yard Light Sensor" }
      ],
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
| `weatherProvider` | object | no | — | Weather provider configuration (see below). |
| `sunnySwitches` | array | no | `[]` | Sunny switch configurations (see below). |

### Weather Provider Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `provider` | string | yes | `"owmCloudCover"` | `"owmCloudCover"` (OpenWeatherMap current weather API) or `"owmOneCall"` (OpenWeatherMap One Call API 3.0, combining UV and cloud cover). |
| `apiKey` | string | yes | — | Your OpenWeatherMap API key. |
| `threshold` | number | no | `50` | `owmCloudCover` only: max cloud cover percentage to count as sunny (0–100). |
| `uvThreshold` | number | no | `3` | `owmOneCall` only: minimum UV index to count as sunny (0–20). |
| `cloudThreshold` | number | no | `50` | `owmOneCall` only: max cloud cover percentage to count as sunny (0–100). |

### Sunny Switch Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"Sunny Switch"` | Name shown in HomeKit. Must be unique. |

When no weather provider and no sunny switches are configured, sensors fire on sun position alone. When either is configured, at least one must report sunny for sensors to open.

### Sensor Fields

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | — | Name shown in HomeKit |
| `azimuthMin` | number | yes | — | Start of azimuth window (°) |
| `azimuthMax` | number | yes | — | End of azimuth window (°) |
| `altitudeMin` | number | no | `0` | Minimum sun altitude (°) |
| `altitudeMax` | number | no | `90` | Maximum sun altitude (°) |

---

## Conventions

- **Azimuth** is measured in degrees from north, clockwise: 0° = north, 90° = east, 180° = south, 270° = west.
- **Altitude** is degrees above the horizon. 0° = horizon, 90° = directly overhead. Negative values mean the sun is below the horizon.
- **Wrap-around azimuth**: If `azimuthMin` > `azimuthMax`, the range wraps through north (0°). For example, `azimuthMin: 350, azimuthMax: 10` matches azimuths from 350° through 0° to 10°.
- **Cloud cover** (provider `"owmCloudCover"`) is a percentage from 0 (clear sky) to 100 (fully overcast). The sensor is sunny when cloud cover is at or below the threshold.
- **One Call** (provider `"owmOneCall"`) combines UV index and cloud cover. The sensor is sunny when the UV index is at or above `uvThreshold` **or** cloud cover is at or below `cloudThreshold`.

---

## How It Works

The plugin uses [suncalc](https://github.com/mourner/suncalc) to compute the sun's position based on your latitude, longitude, and the current time. Every minute it recalculates the sun position and updates each sensor.

When a `weatherProvider` is configured, the plugin fetches weather data every **10 minutes** from OpenWeatherMap. Weather is only fetched when the sun is above the horizon, to reduce API calls. Two providers are available:

- **`owmCloudCover`** — Uses the [OpenWeatherMap Current Weather API](https://openweathermap.org/current). Sunny when cloud cover percentage is at or below `threshold`.
- **`owmOneCall`** — Uses the [OpenWeatherMap One Call API 3.0](https://openweathermap.org/api/one-call-3). Sunny when UV index is at or above `uvThreshold` **or** cloud cover is at or below `cloudThreshold`. Either signal alone is enough: a high UV reading means the sun is bright even if reported cloud cover is high (thin clouds still let UV through), and low cloud cover means clear sky even if UV is low (e.g. early or late in the day). Requires a One Call API 3.0 subscription (free for 1000 calls/day).

When `sunnySwitches` are configured, the plugin exposes HomeKit switches that can be toggled by automations. For example, you can use a HomeKit automation to turn a sunny switch on when a light sensor detects bright light. When a switch is toggled, sensor states are updated immediately.

A sensor's contact state is determined by:

| Sun in azimuth/altitude window? | Any sunny source says sunny? | Contact state |
|---|---|---|
| Yes | Yes (or no sources configured) | **Open** (CONTACT_NOT_DETECTED) |
| Yes | No | Closed |
| No | — | Closed |

---

## Getting an OpenWeatherMap API Key

1. Create a free account at [openweathermap.org](https://openweathermap.org).
2. Navigate to **API keys** in your account dashboard.
3. Copy your key and paste it into the `weatherProvider.apiKey` field.
4. For the `owmOneCall` provider, subscribe to the [One Call API 3.0](https://openweathermap.org/api/one-call-3) (free for 1000 calls/day).

The free tier allows up to 1,000 API calls per day. Weather is only fetched when the sun is above the horizon, so actual usage is well below the limit.

---

## Use-Case Examples

- **Close motorised blinds** when the sun hits a specific window *and* the sky is clear.
- **Turn on a fan** when afternoon sun heats a west-facing room on sunny days.
- **Enable "golden hour" lighting scenes** by targeting low altitudes near sunset azimuth.

---

## Troubleshooting

Sensor settings are logged on startup. A summary of all sensor states (with sun position) is logged whenever any sensor changes state, and at least every 10 minutes.

---

## License

MIT
