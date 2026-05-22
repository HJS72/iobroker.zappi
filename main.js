"use strict";

const utils = require("@iobroker/adapter-core");
const { MyEnergiApi } = require("./lib/myenergiApi");

const MODE_TO_CODE = {
  fast: 1,
  eco: 2,
  ecoplus: 3,
  stop: 4
};

const CODE_TO_MODE = {
  1: "fast",
  2: "eco",
  3: "ecoplus",
  4: "stop"
};

class ZappiAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "zappi"
    });

    this.api = null;
    this.pollTimer = null;

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  async onReady() {
    this.setState("info.connection", false, true);

    if (!this.config.username || !this.config.password) {
      this.log.error("Bitte Benutzername und Passwort in der Adapter-Konfiguration setzen.");
      return;
    }

    const pollSeconds = Math.max(10, Number(this.config.pollInterval) || 30);
    this.config.pollInterval = pollSeconds;

    this.api = new MyEnergiApi(
      this.config.username,
      this.config.password,
      this.config.apiBaseUrl || "https://s18.myenergi.net"
    );

    await this.discoverAndUpdate();
    this.subscribeStates("*.control.*");

    this.pollTimer = setInterval(async () => {
      await this.discoverAndUpdate();
    }, pollSeconds * 1000);
  }

  async discoverAndUpdate() {
    try {
      const status = await this.api.getStatusAll();
      const zappiDevices = this.extractZappis(status);

      this.setState("info.connection", true, true);

      for (const zappi of zappiDevices) {
        const serial = String(zappi.sno);
        await this.ensureZappiObjects(serial);

        const modeCode = Number(zappi.zmo);
        const modeText = CODE_TO_MODE[modeCode] || "unknown";
        const charging = Number(zappi.div || 0) > 0;
        const powerW = Math.max(0, Number(zappi.div || 0));
        const currentA = Number(zappi.ectt1 || zappi.ectp1 || 0);

        await this.setStateAsync(`${serial}.status.rawJson`, JSON.stringify(zappi), true);
        await this.setStateAsync(`${serial}.status.modeCode`, modeCode, true);
        await this.setStateAsync(`${serial}.status.mode`, modeText, true);
        await this.setStateAsync(`${serial}.status.charging`, charging, true);
        await this.setStateAsync(`${serial}.status.powerW`, powerW, true);
        await this.setStateAsync(`${serial}.status.currentA`, currentA, true);

        if (modeText !== "unknown") {
          await this.setStateAsync(`${serial}.control.chargeMode`, modeText, true);
        }
      }
    } catch (error) {
      this.setState("info.connection", false, true);
      this.log.error(`Fehler beim Aktualisieren der Zappi-Daten: ${error.message}`);
    }
  }

  extractZappis(statusPayload) {
    if (!Array.isArray(statusPayload)) {
      return [];
    }

    const zappis = [];
    for (const group of statusPayload) {
      if (!group || !Array.isArray(group.zappi)) {
        continue;
      }
      for (const item of group.zappi) {
        if (item && item.sno != null) {
          zappis.push(item);
        }
      }
    }
    return zappis;
  }

  async ensureZappiObjects(serial) {
    await this.setObjectNotExistsAsync(serial, {
      type: "device",
      common: { name: `Zappi ${serial}` },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status`, {
      type: "channel",
      common: { name: "Status" },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control`, {
      type: "channel",
      common: { name: "Control" },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.mode`, {
      type: "state",
      common: {
        name: "Charge mode text",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.modeCode`, {
      type: "state",
      common: {
        name: "Charge mode code",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.charging`, {
      type: "state",
      common: {
        name: "Charging active",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.powerW`, {
      type: "state",
      common: {
        name: "Charging power",
        type: "number",
        role: "value.power",
        unit: "W",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.currentA`, {
      type: "state",
      common: {
        name: "Charging current",
        type: "number",
        role: "value.current",
        unit: "A",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.status.rawJson`, {
      type: "state",
      common: {
        name: "Raw zappi status JSON",
        type: "string",
        role: "json",
        read: true,
        write: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control.refresh`, {
      type: "state",
      common: {
        name: "Refresh now",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control.chargeMode`, {
      type: "state",
      common: {
        name: "Charge mode",
        type: "string",
        role: "text",
        states: {
          fast: "Fast",
          eco: "Eco",
          ecoplus: "Eco+",
          stop: "Stop"
        },
        read: true,
        write: true,
        def: "stop"
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control.minGreenPercent`, {
      type: "state",
      common: {
        name: "Minimum green level",
        type: "number",
        role: "level",
        unit: "%",
        min: 1,
        max: 100,
        read: true,
        write: true,
        def: 75
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control.maxCurrentA`, {
      type: "state",
      common: {
        name: "Target max current",
        type: "number",
        role: "level.current",
        unit: "A",
        min: 6,
        max: 32,
        read: true,
        write: true,
        def: 16
      },
      native: {}
    });

    await this.setObjectNotExistsAsync(`${serial}.control.targetPowerW`, {
      type: "state",
      common: {
        name: "Target charging power",
        type: "number",
        role: "level.power",
        unit: "W",
        min: 1400,
        max: 22000,
        read: true,
        write: true,
        def: 3680
      },
      native: {}
    });
  }

  getControlFromId(id) {
    const localId = id.replace(`${this.namespace}.`, "");
    const parts = localId.split(".");
    if (parts.length !== 3 || parts[1] !== "control") {
      return null;
    }
    return { serial: parts[0], control: parts[2] };
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    const parsed = this.getControlFromId(id);
    if (!parsed) {
      return;
    }

    const { serial, control } = parsed;

    try {
      if (control === "refresh") {
        await this.discoverAndUpdate();
        await this.setStateAsync(`${serial}.control.refresh`, false, true);
        return;
      }

      if (control === "chargeMode") {
        const modeText = String(state.val || "").toLowerCase();
        const code = MODE_TO_CODE[modeText];
        if (!code) {
          this.log.warn(`Ungueltiger chargeMode '${state.val}' fuer ${serial}`);
          return;
        }
        await this.api.setZappiChargeMode(serial, code);
        await this.setStateAsync(`${serial}.control.chargeMode`, modeText, true);
        return;
      }

      if (control === "minGreenPercent") {
        const percent = Math.max(1, Math.min(100, Number(state.val)));
        await this.api.setZappiGreenLevel(serial, Math.round(percent));
        await this.setStateAsync(`${serial}.control.minGreenPercent`, Math.round(percent), true);
        return;
      }

      if (control === "maxCurrentA") {
        const amps = Math.max(6, Math.min(32, Math.round(Number(state.val))));
        await this.applyCurrentTemplate(serial, amps, null);
        await this.setStateAsync(`${serial}.control.maxCurrentA`, amps, true);
        return;
      }

      if (control === "targetPowerW") {
        const powerW = Math.max(1400, Math.round(Number(state.val)));
        const phases = Number(this.config.phases) === 1 ? 1 : 3;
        const amps = Math.max(6, Math.min(32, Math.round(powerW / (230 * phases))));
        await this.applyCurrentTemplate(serial, amps, powerW);
        await this.setStateAsync(`${serial}.control.targetPowerW`, powerW, true);
        await this.setStateAsync(`${serial}.control.maxCurrentA`, amps, true);
      }
    } catch (error) {
      this.log.error(`Fehler bei Steuerbefehl ${serial}.${control}: ${error.message}`);
    }
  }

  async applyCurrentTemplate(serial, amps, powerW) {
    const template = String(this.config.currentLimitPathTemplate || "").trim();
    if (!template) {
      throw new Error(
        "Kein currentLimitPathTemplate gesetzt. Bitte in den Adapter-Einstellungen den API-Pfad hinterlegen."
      );
    }

    await this.api.callTemplate(template, {
      serial,
      amps,
      powerW: powerW == null ? "" : powerW
    });
  }

  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      callback();
    } catch (_e) {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new ZappiAdapter(options);
} else {
  (() => new ZappiAdapter())();
}
