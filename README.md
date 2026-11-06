# Purifier Card

A compact, graphical Lovelace card for an air purifier — fan power/preset,
a PM2.5 gauge coloured by air quality, LED/child-lock toggles, filter status
and a firmware-update button, all in one small card. Built for devices
exposed via Zigbee2MQTT (one `fan` entity plus several sibling sensors/
switches), but every field beyond `fan` is optional.

Vanilla JS, no dependencies, no build step — uses Home Assistant's built-in
`<ha-icon>` and its theme CSS variables, so it follows your dashboard's
light/dark theme automatically.

## Install

### HACS (custom repository)

1. HACS → ⋮ → **Custom repositories** → `pwillia6/purifier-card`, type **Dashboard** → Add
2. Find **Purifier Card** → **Download**
3. If the resource isn't added automatically: **Settings → Dashboards → ⋮ → Resources** → add `/hacsfiles/purifier-card/purifier-card.js` as a **JavaScript module**

### Manual

1. Copy `purifier-card.js` to `<config>/www/purifier-card.js`
2. Add resource `/local/purifier-card.js`, type **JavaScript module**

## Usage

```yaml
type: custom:purifier-card
name: Master Room Purifier
fan: fan.master_room_purifier
pm25: sensor.master_room_purifier_pm25
air_quality: sensor.master_room_purifier_air_quality
fan_speed: sensor.master_room_purifier_fan_speed
led: switch.master_room_purifier_led_enable
child_lock: switch.master_room_purifier_child_lock
replace_filter: binary_sensor.master_room_purifier_replace_filter
filter_age: sensor.master_room_purifier_filter_age
device_age: sensor.master_room_purifier_device_age
update: update.master_room_purifier
identify: button.master_room_purifier_identify
```

Only `fan` is required. Every other key is optional — the card simply omits
the row/control for anything you don't set (or that your device doesn't
expose), so it works for purifiers with fewer sensors too.

| Key | Entity domain | What it drives |
|---|---|---|
| `fan` | `fan.*` | Power toggle; preset-mode chip (tap to cycle, if the fan has more than one preset); speed chip — becomes a `− NN% +` stepper calling `fan.set_percentage` when the entity supports `SET_SPEED`, otherwise a static readout; the subtitle line |
| `pm25` | `sensor.*` | The centre gauge number + ring |
| `air_quality` | `sensor.*` | Gauge colour/fill and the coloured label (falls back to generic PM2.5 bands if omitted) |
| `fan_speed` | `sensor.*` | Shown in the subtitle |
| `led` | `switch.*` | LED toggle chip |
| `child_lock` | `switch.*` | Lock toggle chip |
| `replace_filter` | `binary_sensor.*` | Turns the filter row red and reads "Replace filter" when `on` |
| `filter_age` | `sensor.*` | Filter row text when `replace_filter` isn't due |
| `device_age` | `sensor.*` | Small footer text (hidden when `unknown`) |
| `update` | `update.*` | Red download button in the footer, shown only when an update is available; tap installs it |
| `identify` | `button.*` | Footer button that presses it |

## License

MIT — see [LICENSE](LICENSE).
