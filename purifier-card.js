/**
 * Purifier Card — a compact graphical Lovelace card for an air purifier
 * (fan + PM2.5/air-quality sensors + LED/child-lock switches + filter +
 * firmware update), as typically exposed by Zigbee2MQTT.
 *
 * No build step, no dependencies (uses HA's built-in <ha-icon>). Follows the
 * dashboard's light/dark theme via HA's own CSS custom properties.
 *
 * Install:
 *   1. Copy to <config>/www/purifier-card.js
 *   2. Settings -> Dashboards -> resources -> add /local/purifier-card.js (module)
 *   3. Add a card:
 *
 *        type: custom:purifier-card
 *        name: Master Room Purifier
 *        fan: fan.master_room_purifier
 *        pm25: sensor.master_room_purifier_pm25
 *        air_quality: sensor.master_room_purifier_air_quality
 *        fan_speed: sensor.master_room_purifier_fan_speed
 *        led: switch.master_room_purifier_led_enable
 *        child_lock: switch.master_room_purifier_child_lock
 *        replace_filter: binary_sensor.master_room_purifier_replace_filter
 *        filter_age: sensor.master_room_purifier_filter_age
 *        device_age: sensor.master_room_purifier_device_age
 *        update: update.master_room_purifier
 *        identify: button.master_room_purifier_identify
 *
 *   Every key except `fan` is optional - the card just omits the row/control
 *   for anything not configured (or not present on the entity).
 */

const VERSION = "1.1.0";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isNA = (s) => !s || s.state === "unavailable" || s.state === "unknown";

function polar(cx, cy, r, deg) {
  const a = (deg - 90) * (Math.PI / 180);
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a0);
  const large = a1 - a0 <= 180 ? 0 : 1;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 0 ${x2} ${y2}`;
}

// air-quality word -> colour + a 0..1 position on the gauge, used both when
// an air_quality entity is configured and as a fallback PM2.5 band.
const AQ_BAND = [
  { test: /excellent|good|great/i, color: "#22c55e", frac: 0.12 },
  { test: /moderate|fair|fine/i, color: "#eab308", frac: 0.40 },
  { test: /poor|unhealthy|bad/i, color: "#f97316", frac: 0.70 },
  { test: /very\s*poor|hazardous|severe/i, color: "#ef4444", frac: 0.95 },
];
function aqFromLabel(label) {
  const hit = AQ_BAND.find((b) => b.test.test(label || ""));
  return hit || { color: "var(--secondary-text-color)", frac: 0.3 };
}
function aqFromPm25(v) {
  // generic PM2.5 µg/m3 bands (AQI-ish), used only when there's no air_quality entity
  if (v <= 12) return { color: "#22c55e", frac: 0.12, label: "Good" };
  if (v <= 35) return { color: "#eab308", frac: 0.40, label: "Moderate" };
  if (v <= 55) return { color: "#f97316", frac: 0.70, label: "Poor" };
  return { color: "#ef4444", frac: 0.95, label: "Very poor" };
}

class PurifierCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._root = document.createElement("div");
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.shadowRoot.append(style, this._root);
    this._bound = false;
    this._showExtra = false;   // "other entities" popup open?
    this._extraIds = null;     // null = not fetched yet; [] = fetched, none left
    this._extraErr = null;     // set if device-registry lookup isn't available/permitted
  }

  setConfig(config) {
    if (!config.fan) throw new Error("purifier-card: 'fan' (a fan entity) is required");
    this._config = { name: null, ...config };
  }

  getCardSize() { return 3; }

  static getStubConfig() {
    return {
      type: "custom:purifier-card",
      name: "Master Room Purifier",
      fan: "fan.master_room_purifier",
      pm25: "sensor.master_room_purifier_pm25",
      air_quality: "sensor.master_room_purifier_air_quality",
      fan_speed: "sensor.master_room_purifier_fan_speed",
      led: "switch.master_room_purifier_led_enable",
      child_lock: "switch.master_room_purifier_child_lock",
      replace_filter: "binary_sensor.master_room_purifier_replace_filter",
      filter_age: "sensor.master_room_purifier_filter_age",
      device_age: "sensor.master_room_purifier_device_age",
      update: "update.master_room_purifier",
      identify: "button.master_room_purifier_identify",
    };
  }

  set hass(hass) { this._hass = hass; this._render(); }

  _call(domain, service, data) { this._hass.callService(domain, service, data); }
  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
  }
  _s(key) {
    const eid = this._config[key];
    return eid ? this._hass.states[eid] : undefined;
  }

  // Discover every entity on the same device as `fan` and remember which
  // ones aren't already configured as a card field - those are what the
  // "other entities" popup lists. Fetched once per card (needs registry
  // read access, i.e. an admin user); fails quietly otherwise.
  async _ensureExtraEntities() {
    if (this._extraIds !== null || this._extraErr) return;
    if (typeof this._hass.callWS !== "function") {
      this._extraErr = "Not available in this frontend.";
      this._render();
      return;
    }
    try {
      const self = await this._hass.callWS({
        type: "config/entity_registry/get",
        entity_id: this._config.fan,
      });
      const deviceId = self.device_id;
      if (!deviceId) {
        this._extraIds = [];
        this._render();
        return;
      }
      const all = await this._hass.callWS({ type: "config/entity_registry/list" });
      const configured = new Set(Object.values(this._config).filter((v) => typeof v === "string" && v.includes(".")));
      this._extraIds = all
        .filter((e) => e.device_id === deviceId && !configured.has(e.entity_id))
        .map((e) => e.entity_id)
        .sort();
    } catch (err) {
      this._extraErr = "Couldn't list related entities (admin access required).";
    }
    this._render();
  }

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const cfg = this._config;
    const fan = this._hass.states[cfg.fan];

    if (act === "power") {
      if (isNA(fan)) return;
      this._call("fan", fan.state === "off" ? "turn_on" : "turn_off", { entity_id: cfg.fan });
    } else if (act === "preset") {
      if (isNA(fan)) return;
      const modes = fan.attributes.preset_modes || [];
      if (modes.length < 2) { this._moreInfo(cfg.fan); return; }
      const next = modes[(modes.indexOf(fan.attributes.preset_mode) + 1) % modes.length];
      this._call("fan", "set_preset_mode", { entity_id: cfg.fan, preset_mode: next });
    } else if (act === "led" || act === "lock") {
      const key = act === "led" ? "led" : "child_lock";
      const s = this._s(key);
      if (!s || isNA(s)) return;
      this._call("switch", "toggle", { entity_id: cfg[key] });
    } else if (act === "update") {
      const s = this._s("update");
      if (!s) return;
      this._call("update", "install", { entity_id: cfg.update });
    } else if (act === "identify") {
      const s = this._s("identify");
      if (!s) return;
      this._call("button", "press", { entity_id: cfg.identify });
    } else if (act === "more") {
      const eid = el.dataset.entity;
      if (eid) this._moreInfo(eid);
    } else if (act === "extra") {
      this._showExtra = true;
      this._render();
      this._ensureExtraEntities();
    } else if (act === "extra-close") {
      this._showExtra = false;
      this._render();
    }
    // act === "stop" (clicks inside the popup panel): intentionally no-op,
    // it only exists so those clicks don't bubble to the backdrop's "extra-close"
  }

  _render() {
    const hass = this._hass, cfg = this._config;
    if (!hass || !cfg) return;
    const fan = hass.states[cfg.fan];
    if (!fan) { this._root.innerHTML = `<div class="pcard err">Unknown entity: ${cfg.fan}</div>`; return; }

    const fanNA = isNA(fan);
    const on = !fanNA && fan.state !== "off";
    const name = cfg.name || fan.attributes.friendly_name || "Purifier";

    const pm25s = this._s("pm25");
    const pm25 = pm25s && !isNA(pm25s) ? Number(pm25s.state) : null;
    const pm25Unit = pm25s?.attributes?.unit_of_measurement || "µg/m³";

    const aqs = this._s("air_quality");
    const aqLabel = aqs && !isNA(aqs) ? String(aqs.state) : null;
    const aq = aqLabel ? aqFromLabel(aqLabel)
             : (pm25 != null ? aqFromPm25(pm25) : { color: "var(--secondary-text-color)", frac: 0.3 });
    const aqText = aqLabel || (pm25 != null ? aq.label : null);

    const speedS = this._s("fan_speed");
    const speedText = speedS && !isNA(speedS)
      ? `Speed ${speedS.state}${speedS.attributes.unit_of_measurement ? " " + speedS.attributes.unit_of_measurement : ""}`
      : null;

    const presetModes = fan.attributes.preset_modes || [];
    const presetMode = fan.attributes.preset_mode;
    const pct = fan.attributes.percentage;

    const led = this._s("led");
    const lock = this._s("child_lock");

    const replaceS = this._s("replace_filter");
    const replaceDue = replaceS && !isNA(replaceS) && replaceS.state === "on";
    const ageS = this._s("filter_age");
    const ageText = ageS && !isNA(ageS)
      ? `${ageS.state}${ageS.attributes.unit_of_measurement ? " " + ageS.attributes.unit_of_measurement : ""}`
      : null;

    const devAgeS = this._s("device_age");
    const devAgeText = devAgeS && !isNA(devAgeS) && devAgeS.state !== "unknown" ? devAgeS.state : null;

    const updS = this._s("update");
    const updAvail = updS && !isNA(updS) && updS.state === "on";

    const idS = this._s("identify");

    // gauge geometry (same 270ish-degree style as the rest of the dashboard)
    const START = 130, SWEEP = 280;
    const frac = pm25 != null ? clamp(aq.frac, 0, 1) : 0;
    const trackPath = arcPath(60, 60, 50, START, START + SWEEP);
    const valPath = arcPath(60, 60, 50, START, START + frac * SWEEP);

    const subParts = [presetMode ? `Preset: ${cap(presetMode)}` : null, speedText].filter(Boolean);

    let extraBody;
    if (this._extraErr) {
      extraBody = `<div class="mnote">${this._extraErr}</div>`;
    } else if (this._extraIds === null) {
      extraBody = `<div class="mnote">Loading…</div>`;
    } else if (!this._extraIds.length) {
      extraBody = `<div class="mnote">Nothing else on this device.</div>`;
    } else {
      extraBody = this._extraIds.map((eid) => {
        const s = hass.states[eid];
        const label = cap(eid.split(".").slice(1).join(" "));
        const val = s ? `${s.state}${s.attributes?.unit_of_measurement ? " " + s.attributes.unit_of_measurement : ""}`
                      : "no state (disabled)";
        return `<button class="mrow" data-act="more" data-entity="${eid}">
            <span class="mname">${label}</span><span class="mval">${val}</span>
          </button>`;
      }).join("");
    }

    this._root.innerHTML = `
      <div class="pcard ${fanNA ? "na" : ""}">
        <div class="head">
          <ha-icon class="dicon" icon="mdi:air-purifier" style="--c:${on ? aq.color : "var(--secondary-text-color)"}"></ha-icon>
          <div class="titles">
            <div class="name">${name}</div>
            <div class="sub">${fanNA ? "Unavailable" : (subParts.join(" · ") || (on ? "On" : "Off"))}</div>
          </div>
          <button class="iconbtn" data-act="extra" title="Other entities on this device">
            <ha-icon icon="mdi:dots-horizontal"></ha-icon>
          </button>
          <button class="pwr ${on ? "on" : ""}" data-act="power" title="Toggle power">
            <ha-icon icon="mdi:power"></ha-icon>
          </button>
        </div>

        <div class="body">
          <div class="gauge" data-act="more" data-entity="${cfg.pm25 || cfg.fan}">
            <svg viewBox="0 0 120 120">
              <path class="track" d="${trackPath}"/>
              ${pm25 != null ? `<path class="val" d="${valPath}" style="stroke:${aq.color}"/>` : ""}
            </svg>
            <div class="gcenter">
              <div class="gnum">${pm25 != null ? Math.round(pm25) : "--"}</div>
              <div class="gunit">${pm25 != null ? pm25Unit : "PM2.5"}</div>
            </div>
          </div>

          <div class="stats">
            ${aqText ? `<div class="aq" style="--c:${aq.color}" data-act="more" data-entity="${cfg.air_quality || cfg.pm25}">
                 <span class="dot"></span>${cap(aqText)}
               </div>` : ""}
            <div class="chips">
              ${presetModes.length ? `<button class="chip ${presetModes.length > 1 ? "tappable" : ""}" data-act="preset">
                   <ha-icon icon="mdi:autorenew"></ha-icon>${cap(presetMode || "—")}
                 </button>` : ""}
              ${pct != null ? `<span class="chip static"><ha-icon icon="mdi:speedometer"></ha-icon>${Math.round(pct)}%</span>` : ""}
              ${led ? `<button class="chip ${isNA(led) ? "" : "tappable"} ${led.state === "on" ? "on" : ""}" data-act="led">
                   <ha-icon icon="mdi:led-outline"></ha-icon>LED
                 </button>` : ""}
              ${lock ? `<button class="chip ${isNA(lock) ? "" : "tappable"} ${lock.state === "on" ? "on" : ""}" data-act="lock">
                   <ha-icon icon="${lock.state === "on" ? "mdi:lock" : "mdi:lock-open-variant"}"></ha-icon>Lock
                 </button>` : ""}
            </div>
          </div>
        </div>

        <div class="foot">
          ${ageText || replaceDue ? `
            <button class="frow ${replaceDue ? "warn" : ""}" data-act="more" data-entity="${cfg.replace_filter || cfg.filter_age}">
              <ha-icon icon="${replaceDue ? "mdi:air-filter" : "mdi:air-filter"}"></ha-icon>
              <span>${replaceDue ? "Replace filter" : `Filter ${ageText}`}</span>
            </button>` : ""}
          ${devAgeText ? `<span class="frow static"><ha-icon icon="mdi:calendar-clock"></ha-icon><span>${devAgeText}</span></span>` : ""}
          <span class="spacer"></span>
          ${updAvail ? `<button class="iconbtn warn" data-act="update" title="Install firmware update ${updS.attributes.latest_version || ""}">
               <ha-icon icon="mdi:package-down"></ha-icon>
             </button>` : ""}
          ${idS ? `<button class="iconbtn" data-act="identify" title="Identify"><ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>` : ""}
        </div>

        <div class="backdrop ${this._showExtra ? "show" : ""}" data-act="extra-close">
          <div class="modal" data-act="stop">
            <div class="mtitle">
              <ha-icon icon="mdi:devices"></ha-icon>
              <span>Other ${name} entities</span>
              <button class="mclose" data-act="extra-close" title="Close"><ha-icon icon="mdi:close"></ha-icon></button>
            </div>
            <div class="mbody">${extraBody}</div>
          </div>
        </div>
      </div>`;

    if (!this._bound) {
      this._root.addEventListener("click", (e) => this._onClick(e));
      this._bound = true;
    }
  }
}

function cap(s) { return String(s).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()); }

const STYLE = `
:host { display:block; }
* { box-sizing:border-box; }
.pcard {
  container-type: inline-size;
  position: relative;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  border-radius: var(--ha-card-border-radius, 12px);
  border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
  box-shadow: var(--ha-card-box-shadow, none);
  color: var(--primary-text-color);
  font-family: var(--paper-font-body1_-_font-family, inherit);
  padding: 14px 16px 12px;
  min-height: 170px;
}
.pcard.err { color: var(--error-color, #db4437); }
.pcard.na { opacity: .55; }

.head { display:flex; align-items:center; gap:12px; }
.dicon { --mdc-icon-size: 28px; color: var(--c, var(--state-icon-color)); flex: 0 0 auto; }
.titles { flex: 1 1 auto; min-width: 0; }
.name { font-size: 16px; font-weight: 500; line-height: 1.25; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sub { font-size: 12.5px; color: var(--secondary-text-color); margin-top: 1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

.pwr {
  width: 38px; height: 38px; border-radius: 50%; border: none; cursor: pointer; flex: 0 0 auto;
  background: var(--secondary-background-color, #eee); color: var(--secondary-text-color);
  display:flex; align-items:center; justify-content:center;
}
.pwr ha-icon { --mdc-icon-size: 20px; }
.pwr.on { background: var(--state-icon-color, #f5a623); color: var(--text-primary-color, #fff); }

.body { display:flex; align-items:center; gap:16px; margin-top:14px; flex-wrap:wrap; }
.gauge { position:relative; width:84px; height:84px; flex:0 0 auto; cursor:pointer; }
.gauge svg { width:100%; height:100%; }
.gauge .track { fill:none; stroke: var(--divider-color, #e0e0e0); stroke-width:9; stroke-linecap:round; }
.gauge .val { fill:none; stroke-width:9; stroke-linecap:round; }
.gcenter { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; }
.gnum { font-size:22px; font-weight:600; line-height:1; }
.gunit { font-size:10px; color: var(--secondary-text-color); margin-top:2px; }

.stats { flex: 1 1 160px; min-width: 140px; display:flex; flex-direction:column; gap:8px; }
.aq { display:flex; align-items:center; gap:6px; font-size:13px; cursor:pointer; width:max-content; }
.aq .dot { width:9px; height:9px; border-radius:50%; background:var(--c); flex:0 0 auto; }

.chips { display:flex; flex-wrap:wrap; gap:6px; }
.chip {
  display:flex; align-items:center; gap:5px; font-size:12px; line-height:1;
  padding: 6px 10px; border-radius: 999px; border: none;
  background: var(--secondary-background-color, #eee); color: var(--primary-text-color);
}
.chip ha-icon { --mdc-icon-size: 15px; }
.chip.tappable { cursor:pointer; }
.chip.static { cursor:default; }
.chip.on { background: var(--state-icon-color, #f5a623); color: var(--text-primary-color, #fff); }

.foot { display:flex; align-items:center; gap:10px; margin-top:14px; flex-wrap:wrap; }
.frow {
  display:flex; align-items:center; gap:6px; font-size:12px; color: var(--secondary-text-color);
  background:none; border:none; padding:0; cursor:pointer;
}
.frow ha-icon { --mdc-icon-size:16px; }
.frow.static { cursor:default; }
.frow.warn, .frow.warn ha-icon { color: var(--error-color, #db4437); }
.spacer { flex: 1 1 auto; }
.iconbtn {
  width:30px; height:30px; border-radius:50%; border:none; cursor:pointer;
  background: var(--secondary-background-color, #eee); color: var(--secondary-text-color);
  display:flex; align-items:center; justify-content:center;
}
.iconbtn ha-icon { --mdc-icon-size:16px; }
.iconbtn.warn { background: color-mix(in srgb, var(--error-color, #db4437) 18%, transparent); color: var(--error-color, #db4437); }

/* "other entities" popup - an overlay scoped to the card itself, not the viewport */
.backdrop {
  position: absolute; inset: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center; padding: 10px;
  background: rgba(0,0,0,.4);
  border-radius: inherit;
  opacity: 0; pointer-events: none; transition: opacity .12s ease;
}
.backdrop.show { opacity: 1; pointer-events: auto; }
.modal {
  width: 100%; max-height: 100%; display: flex; flex-direction: column;
  background: var(--ha-card-background, var(--card-background-color, #fff));
  color: var(--primary-text-color);
  border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.3);
  overflow: hidden;
}
.mtitle {
  display:flex; align-items:center; gap:8px; padding:10px 12px;
  border-bottom: 1px solid var(--divider-color, #e0e0e0); font-size:13px; font-weight:500;
}
.mtitle ha-icon { --mdc-icon-size:18px; color: var(--secondary-text-color); }
.mtitle span { flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mclose {
  width:26px; height:26px; border-radius:50%; border:none; cursor:pointer; flex:0 0 auto;
  background: var(--secondary-background-color, #eee); color: var(--secondary-text-color);
  display:flex; align-items:center; justify-content:center;
}
.mclose ha-icon { --mdc-icon-size:14px; }
.mbody { overflow-y: auto; padding: 4px 0; }
.mnote { padding: 14px 12px; font-size: 12.5px; color: var(--secondary-text-color); }
.mrow {
  display:flex; align-items:center; justify-content:space-between; gap:10px; width:100%;
  padding: 9px 12px; border:none; background:none; cursor:pointer; text-align:left;
  color: var(--primary-text-color); font-size: 12.5px;
  border-bottom: 1px solid var(--divider-color, #e0e0e0);
}
.mrow:last-child { border-bottom: none; }
.mname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mval { color: var(--secondary-text-color); flex: 0 0 auto; }

@container (max-width: 300px) {
  .body { flex-direction:column; align-items:flex-start; }
  .gauge { align-self:center; }
}
`;

customElements.define("purifier-card", PurifierCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "purifier-card",
  name: "Purifier Card",
  description: "Compact graphical card for an air purifier (fan + PM2.5/AQ + LED/lock + filter + firmware).",
  preview: false,
});
console.info(`%c PURIFIER-CARD %c ${VERSION} `, "background:#22c55e;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
