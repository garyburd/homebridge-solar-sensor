# homebridge-solar-sensor

A [Homebridge](https://homebridge.io) plugin that exposes **ContactSensor** accessories whose state is determined by the sun's position in the sky and (optionally) real-time cloud cover from [OpenWeatherMap](https://openweathermap.org).

The contact sensor **closes** (CONTACT_DETECTED) when all of the following are true:

1. The sun's **azimuth** is within the sensor's configured range.
2. The sun's **altitude** is within the sensor's configured range.
3. **Cloud cover** is at or below the sensor's configured threshold *(only checked when an OpenWeatherMap API key is provided)*.

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
      "openWeatherMapApiKey": "YOUR_OWM_API_KEY",
      "pollInterval": 60,
      "sensors": [
        {
          "name": "Sun in West Window",
          "azimuthMin": 240,
          "azimuthMax": 300,
          "altitudeMin": 10,
          "altitudeMax": 60,
          "cloudCoverMax": 40
        },
        {
          "name": "Sun in South Window",
          "azimuthMin": 150,
          "azimuthMax": 210,
          "altitudeMin": 5,
          "altitudeMax": 90,
          "cloudCoverMax": 75
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
| `openWeatherMapApiKey` | string | no | — | Your OpenWeatherMap API key. When omitted, cloud cover is ignored and sensors fire on sun position alone. |
| `pollInterval` | integer | no | `60` | Seconds between sun-position recalculations (min 10). Weather is always fetched every 10 minutes independently. |

### Sensor Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"Solar Sensor"` | Name shown in HomeKit |
| `azimuthMin` | number | `0` | Start of azimuth window (°) |
| `azimuthMax` | number | `360` | End of azimuth window (°) |
| `altitudeMin` | number | `0` | Minimum sun altitude (°) |
| `altitudeMax` | number | `90` | Maximum sun altitude (°) |
| `cloudCoverMax` | integer | `50` | Maximum cloud cover percentage at which the contact will still close. Only used when an API key is configured. |

---

## Conventions

- **Azimuth** is measured in degrees from north, clockwise: 0° = north, 90° = east, 180° = south, 270° = west.
- **Altitude** is degrees above the horizon. 0° = horizon, 90° = directly overhead. Negative values mean the sun is below the horizon.
- **Wrap-around azimuth**: If `azimuthMin` > `azimuthMax`, the range wraps through north (0°). For example, `azimuthMin: 350, azimuthMax: 10` matches azimuths from 350° through 0° to 10°.
- **Cloud cover** is a percentage from 0 (clear sky) to 100 (fully overcast), as reported by OpenWeatherMap.

---

## How It Works

The plugin uses [suncalc](https://github.com/mourner/suncalc) to compute the sun's position based on your latitude, longitude, and the current time. Every `pollInterval` seconds it recalculates the sun position and updates each sensor.

When an `openWeatherMapApiKey` is provided, the plugin also calls the [OpenWeatherMap Current Weather API](https://openweathermap.org/current) every **10 minutes** to fetch the current cloud cover percentage at your location. Sensors are re-evaluated immediately whenever new weather data arrives.

A sensor's contact state is determined by:

| Sun in azimuth/altitude window? | Cloud cover ≤ threshold? | Contact state |
|---|---|---|
| Yes | Yes (or no API key) | **Closed** (CONTACT_DETECTED) |
| Yes | No | Open |
| No | — | Open |

---

## Getting an OpenWeatherMap API Key

1. Create a free account at [openweathermap.org](https://openweathermap.org).
2. Navigate to **API keys** in your account dashboard.
3. Copy your key and paste it into the `openWeatherMapApiKey` field.

The free tier allows up to 1,000 API calls per day. At one call every 10 minutes, this plugin uses about 144 calls per day — well within the limit.

---

## Use-Case Examples

- **Close motorised blinds** when the sun hits a specific window *and* the sky is clear.
- **Turn on a fan** when afternoon sun heats a west-facing room on sunny days.
- **Enable "golden hour" lighting scenes** by targeting low altitudes near sunset azimuth.
- **Skip automations on overcast days** by setting a low `cloudCoverMax`.

---

## Troubleshooting

Enable debug logging in Homebridge to see detailed sun position, cloud cover, and sensor evaluation output:

```bash
homebridge -D
```

or set `"debug": true` in your Homebridge UI settings.

---

## License

MIT
