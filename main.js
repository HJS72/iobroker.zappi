"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const { randomUUID } = require("crypto");
const WebSocket = require("ws");
const utils = require("@iobroker/adapter-core");

class ZappiAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "zappi"
    });

    this.automationTimer = null;
    this.autoAuthorizeTimer = null;

    this.httpServer = null;
    this.wsServer = null;
    this.ocppSessions = new Map();
    this.ocppTxCounter = 0;

    this.lastKnownPhaseCount = 3;
    this.connectedStates = new Set();
    this.phaseTextToValue = {
      single: "1",
      three: "3"
    };

    this.authorizationRequired = true;
    this.authorizationCode = "";
    this.authorizationTimeoutSec = 300;
    this.authorizedUntilMs = 0;
    this.failedAuthorizationAttempts = 0;

    this.automationEnabled = false;
    this.automationIntervalSec = 20;
    this.autoAuthorizeEnabled = false;
    this.autoAuthorizeIntervalSec = 120;
    this.autoPowerInputStateId = "";
    this.automationOnlyWhenConnected = true;
    this.autoMinPowerW = 1400;
    this.autoMaxPowerW = 22000;
    this.autoPhaseSwitchEnabled = false;
    this.autoSinglePhaseBelowW = 3500;

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  async onReady() {
    this.readConfig();

    await this.setStateAsync("info.connection", false, true);
    await this.ensureObjects();
    await this.updateAuthorizationStates();
    await this.setStateAsync("control.automationEnabled", this.automationEnabled, true);
    await this.subscribeStatesAsync("control.*");

    await this.startOcppServer();

    if (this.automationEnabled) {
      await this.startAutomationLoop();
    }

    if (this.autoAuthorizeEnabled && this.authorizationRequired) {
      this.autoAuthorizeTimer = setInterval(async () => {
        await this.ensureAutoAuthorized();
      }, this.autoAuthorizeIntervalSec * 1000);
      await this.ensureAutoAuthorized();
    }
  }

  readConfig() {
    this.connectedStates = this.parseConnectedStates(this.config.connectedStatusValues);
    this.phaseTextToValue = {
      single: String(this.config.phaseSingleValue || "1").trim(),
      three: String(this.config.phaseThreeValue || "3").trim()
    };

    this.authorizationRequired = this.config.requireWriteAuthorization !== false;
    this.authorizationCode = String(this.config.authorizationCode || "");
    this.authorizationTimeoutSec = Math.max(30, Number(this.config.authorizationTimeoutSec) || 300);

    this.automationEnabled = this.config.automationEnabled === true;
    this.automationIntervalSec = Math.max(10, Number(this.config.automationIntervalSec) || 20);
    this.autoAuthorizeEnabled = this.config.autoAuthorizeEnabled === true;
    this.autoAuthorizeIntervalSec = Math.max(30, Number(this.config.autoAuthorizeIntervalSec) || 120);
    this.autoPowerInputStateId = String(this.config.autoPowerInputStateId || "").trim();
    this.automationOnlyWhenConnected = this.config.automationOnlyWhenConnected !== false;
    this.autoMinPowerW = Math.max(1400, Number(this.config.autoMinPowerW) || 1400);
    this.autoMaxPowerW = Math.max(this.autoMinPowerW, Number(this.config.autoMaxPowerW) || 22000);
    this.autoPhaseSwitchEnabled = this.config.autoPhaseSwitchEnabled === true;
    this.autoSinglePhaseBelowW = Math.max(1400, Number(this.config.autoSinglePhaseBelowW) || 3500);
  }

  parseConnectedStates(input) {
    const raw = String(input || "Preparing,Charging,SuspendedEV,SuspendedEVSE,Finishing");
    return new Set(
      raw
        .split(",")
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  parsePhaseSetting(value) {
    const txt = String(value == null ? "" : value).trim().toLowerCase();
    if (txt === "single" || txt === "1" || txt === "1p") {
      return "single";
    }
    if (txt === "three" || txt === "3" || txt === "3p") {
      return "three";
    }
    return null;
  }

  async ensureObjects() {
    await this.setObjectNotExistsAsync("status", {
      type: "channel",
      common: { name: "Status" },
      native: {}
    });

    await this.setObjectNotExistsAsync("control", {
      type: "channel",
      common: { name: "Control" },
      native: {}
    });

    const statusDefs = [
      ["status.connectorStatus", "Connector status", "string", "text"],
      ["status.vehicleConnected", "Vehicle connected", "boolean", "indicator.plugged"],
      ["status.charging", "Charging active", "boolean", "indicator.working"],
      ["status.currentA", "Charging current", "number", "value.current", "A"],
      ["status.powerW", "Charging power", "number", "value.power", "W"],
      ["status.energyWh", "Imported energy", "number", "value.power.consumption", "Wh"],
      ["status.phaseSetting", "Phase setting", "string", "text"],
      ["status.lastCommand", "Last command", "string", "text"],
      ["status.lastError", "Last error", "string", "text"],
      ["status.authorizationRequired", "Write authorization required", "boolean", "indicator"],
      ["status.authorizationState", "Authorization state", "string", "text"],
      ["status.authorizationValidUntil", "Authorization valid until (ISO)", "string", "text"],
      ["status.failedAuthorizationAttempts", "Failed authorization attempts", "number", "value"],
      ["status.lastDeniedControl", "Last denied control", "string", "text"],
      ["status.automationActive", "Automation active", "boolean", "indicator.working"],
      ["status.automationInputPowerW", "Automation input power", "number", "value.power", "W"],
      ["status.automationTargetPowerW", "Automation target power", "number", "value.power", "W"],
      ["status.ocppServerRunning", "OCPP server running", "boolean", "indicator"],
      ["status.ocppConnected", "OCPP charge point connected", "boolean", "indicator.connected"],
      ["status.ocppChargePointId", "Connected charge point ID", "string", "text"],
      ["status.ocppLastMessageAction", "Last OCPP message action", "string", "text"],
      ["status.ocppLastMessageAt", "Last OCPP message timestamp", "string", "text"],
      ["status.transactionId", "Current transaction ID", "number", "value"]
    ];

    for (const [id, name, type, role, unit] of statusDefs) {
      await this.setObjectNotExistsAsync(id, {
        type: "state",
        common: {
          name,
          type,
          role,
          unit,
          read: true,
          write: false
        },
        native: {}
      });
    }

    const controlStates = [
      {
        id: "control.refresh",
        common: { name: "Refresh now", type: "boolean", role: "button", read: false, write: true, def: false }
      },
      {
        id: "control.phaseSetting",
        common: {
          name: "Requested phase setting",
          type: "string",
          role: "text",
          states: { single: "Single phase", three: "Three phase" },
          read: true,
          write: true,
          def: "three"
        }
      },
      {
        id: "control.maxCurrentA",
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
        }
      },
      {
        id: "control.targetPowerW",
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
        }
      },
      {
        id: "control.authorizeCode",
        common: { name: "Enter authorization code", type: "string", role: "text", read: false, write: true, def: "" }
      },
      {
        id: "control.lockControls",
        common: { name: "Lock controls now", type: "boolean", role: "button", read: false, write: true, def: false }
      },
      {
        id: "control.automationEnabled",
        common: {
          name: "Automation enabled",
          type: "boolean",
          role: "switch.enable",
          read: true,
          write: true,
          def: false
        }
      },
      {
        id: "control.remoteStart",
        common: { name: "OCPP RemoteStartTransaction", type: "boolean", role: "button", read: false, write: true, def: false }
      },
      {
        id: "control.remoteStop",
        common: { name: "OCPP RemoteStopTransaction", type: "boolean", role: "button", read: false, write: true, def: false }
      },
      {
        id: "control.idTag",
        common: {
          name: "OCPP idTag",
          type: "string",
          role: "text",
          read: true,
          write: true,
          def: String(this.config.defaultIdTag || "A0000001")
        }
      },
      {
        id: "control.connectorId",
        common: {
          name: "OCPP connector ID",
          type: "number",
          role: "value",
          read: true,
          write: true,
          min: 1,
          max: 8,
          def: Math.max(1, Number(this.config.defaultConnectorId) || 1)
        }
      }
    ];

    for (const item of controlStates) {
      await this.setObjectNotExistsAsync(item.id, {
        type: "state",
        common: item.common,
        native: {}
      });
    }
  }

  async updateAuthorizationStates() {
    await this.setStateAsync("status.authorizationRequired", this.authorizationRequired, true);
    await this.setStateAsync("status.failedAuthorizationAttempts", this.failedAuthorizationAttempts, true);

    if (!this.authorizationRequired) {
      await this.setStateAsync("status.authorizationState", "not_required", true);
      await this.setStateAsync("status.authorizationValidUntil", "", true);
      return;
    }

    if (!this.authorizationCode) {
      await this.setStateAsync("status.authorizationState", "no_code_configured", true);
      await this.setStateAsync("status.authorizationValidUntil", "", true);
      return;
    }

    if (Date.now() < this.authorizedUntilMs) {
      await this.setStateAsync("status.authorizationState", "authorized", true);
      await this.setStateAsync("status.authorizationValidUntil", new Date(this.authorizedUntilMs).toISOString(), true);
      return;
    }

    await this.setStateAsync("status.authorizationState", "locked", true);
    await this.setStateAsync("status.authorizationValidUntil", "", true);
  }

  async tryAuthorize(inputCode) {
    if (!this.authorizationRequired) {
      return true;
    }

    const provided = String(inputCode == null ? "" : inputCode);
    if (provided && provided === this.authorizationCode) {
      this.authorizedUntilMs = Date.now() + this.authorizationTimeoutSec * 1000;
      await this.setStateAsync("status.lastError", "", true);
      await this.setStateAsync("status.lastCommand", `authorization granted for ${this.authorizationTimeoutSec}s`, true);
      await this.updateAuthorizationStates();
      return true;
    }

    this.failedAuthorizationAttempts += 1;
    this.authorizedUntilMs = 0;
    await this.setStateAsync("status.lastError", "Falscher Autorisierungscode.", true);
    await this.updateAuthorizationStates();
    return false;
  }

  async ensureAutoAuthorized() {
    if (!this.authorizationRequired || !this.autoAuthorizeEnabled) {
      return true;
    }
    if (!this.authorizationCode) {
      await this.setStateAsync("status.lastError", "Auto-Authorization aktiv, aber authorizationCode fehlt.", true);
      return false;
    }
    if (Date.now() < this.authorizedUntilMs) {
      return true;
    }
    return this.tryAuthorize(this.authorizationCode);
  }

  async isControlAuthorized(control) {
    if (!["phaseSetting", "maxCurrentA", "targetPowerW", "remoteStart", "remoteStop"].includes(control)) {
      return true;
    }

    if (!this.authorizationRequired) {
      return true;
    }

    if (!this.authorizationCode) {
      await this.setStateAsync("status.lastDeniedControl", control, true);
      await this.setStateAsync("status.lastError", "Autorisierung aktiv, aber kein authorizationCode konfiguriert.", true);
      await this.updateAuthorizationStates();
      return false;
    }

    if (Date.now() < this.authorizedUntilMs) {
      return true;
    }

    await this.setStateAsync("status.lastDeniedControl", control, true);
    await this.setStateAsync("status.lastError", `Steuerbefehl '${control}' abgelehnt: bitte zuerst control.authorizeCode setzen.`, true);
    await this.updateAuthorizationStates();
    return false;
  }

  async lockControlsNow() {
    this.authorizedUntilMs = 0;
    await this.setStateAsync("status.lastCommand", "controls locked", true);
    await this.updateAuthorizationStates();
  }

  async readForeignValue(stateId) {
    if (!stateId) {
      return null;
    }
    const foreignState = await this.getForeignStateAsync(stateId);
    if (!foreignState) {
      throw new Error(`State nicht gefunden: ${stateId}`);
    }
    return foreignState.val;
  }

  getAllowedChargePoints() {
    return new Set(
      String(this.config.allowedChargePointIds || "")
        .split(",")
        .map(v => v.trim())
        .filter(Boolean)
    );
  }

  getChargePointFromRequest(req) {
    const url = new URL(req.url || "/", "http://localhost");
    const pathParts = url.pathname.split("/").filter(Boolean);
    const cpId = pathParts.length > 0 ? pathParts[pathParts.length - 1] : "";
    const token = String(url.searchParams.get("token") || "");
    return { cpId, token };
  }

  startOcppServer() {
    return new Promise((resolve, reject) => {
      try {
        const useTls = this.config.ocppTlsEnabled === true;
        const host = String(this.config.ocppServerHost || "0.0.0.0").trim();
        const port = Math.max(1, Number(this.config.ocppServerPort) || 9220);

        if (useTls) {
          const keyPath = String(this.config.ocppTlsKeyPath || "").trim();
          const certPath = String(this.config.ocppTlsCertPath || "").trim();
          if (!keyPath || !certPath) {
            throw new Error("TLS aktiviert, aber Key/Cert Pfad fehlen.");
          }
          this.httpServer = https.createServer({
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
          });
        } else {
          this.httpServer = http.createServer();
        }

        this.wsServer = new WebSocket.Server({ noServer: true });

        this.httpServer.on("upgrade", (req, socket, head) => {
          try {
            const { cpId, token } = this.getChargePointFromRequest(req);
            if (!cpId) {
              socket.write("HTTP/1.1 400 Bad Request\\r\\n\\r\\n");
              socket.destroy();
              return;
            }

            const requiredToken = String(this.config.serverAuthToken || "");
            if (requiredToken && token !== requiredToken) {
              socket.write("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n");
              socket.destroy();
              return;
            }

            const allowed = this.getAllowedChargePoints();
            if (allowed.size > 0 && !allowed.has(cpId)) {
              socket.write("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");
              socket.destroy();
              return;
            }

            this.wsServer.handleUpgrade(req, socket, head, ws => {
              this.wsServer.emit("connection", ws, req, { cpId });
            });
          } catch (error) {
            this.log.error(`OCPP upgrade error: ${error.message}`);
            socket.destroy();
          }
        });

        this.wsServer.on("connection", (ws, req, context) => {
          this.handleOcppConnection(ws, context.cpId);
        });

        this.httpServer.listen(port, host, async () => {
          await this.setStateAsync("status.ocppServerRunning", true, true);
          this.log.info(`OCPP server listening on ${useTls ? "wss" : "ws"}://${host}:${port}`);
          resolve();
        });

        this.httpServer.on("error", async error => {
          await this.setStateAsync("status.ocppServerRunning", false, true);
          reject(error);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  async handleOcppConnection(ws, cpId) {
    const existing = this.ocppSessions.get(cpId);
    if (existing && existing.ws) {
      try {
        existing.ws.close();
      } catch {
        // ignore
      }
    }

    const session = {
      cpId,
      ws,
      pending: new Map()
    };
    this.ocppSessions.set(cpId, session);

    await this.setStateAsync("status.ocppConnected", true, true);
    await this.setStateAsync("status.ocppChargePointId", cpId, true);
    await this.setStateAsync("info.connection", true, true);

    ws.on("message", async data => {
      await this.handleOcppFrame(cpId, String(data));
    });

    ws.on("close", async () => {
      const current = this.ocppSessions.get(cpId);
      if (current && current.ws === ws) {
        for (const entry of current.pending.values()) {
          clearTimeout(entry.timeout);
          entry.reject(new Error("WebSocket disconnected"));
        }
        this.ocppSessions.delete(cpId);
      }

      const anyConnected = this.ocppSessions.size > 0;
      await this.setStateAsync("status.ocppConnected", anyConnected, true);
      await this.setStateAsync("info.connection", anyConnected, true);
      if (!anyConnected) {
        await this.setStateAsync("status.ocppChargePointId", "", true);
      }
    });

    ws.on("error", async error => {
      await this.setStateAsync("status.lastError", `WebSocket error: ${error.message}`, true);
    });
  }

  getActiveSession() {
    for (const session of this.ocppSessions.values()) {
      return session;
    }
    return null;
  }

  sendOcppCall(action, payload, explicitCpId) {
    const session = explicitCpId ? this.ocppSessions.get(explicitCpId) : this.getActiveSession();
    if (!session) {
      return Promise.reject(new Error("Kein OCPP Charge Point verbunden."));
    }

    const messageId = randomUUID();
    const timeoutSec = Math.max(5, Number(this.config.ocppRequestTimeoutSec) || 20);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        session.pending.delete(messageId);
        reject(new Error(`OCPP request timeout for ${action}`));
      }, timeoutSec * 1000);

      session.pending.set(messageId, { resolve, reject, timeout });
      const frame = [2, messageId, action, payload || {}];

      session.ws.send(JSON.stringify(frame), err => {
        if (err) {
          clearTimeout(timeout);
          session.pending.delete(messageId);
          reject(err);
        }
      });
    });
  }

  parseSampledValue(sample, out) {
    const measurand = String(sample.measurand || "Energy.Active.Import.Register");
    const unit = String(sample.unit || "");
    const value = Number(sample.value);
    if (!Number.isFinite(value)) {
      return;
    }

    if (measurand.startsWith("Power.Active.Import")) {
      const scaled = unit.toLowerCase() === "kw" ? value * 1000 : value;
      out.powerW = (out.powerW || 0) + scaled;
    }

    if (measurand.startsWith("Current.Import")) {
      out.currentA = (out.currentA || 0) + value;
    }

    if (measurand === "Energy.Active.Import.Register") {
      out.energyWh = unit.toLowerCase() === "kwh" ? value * 1000 : value;
    }
  }

  parseMeterValues(payload) {
    const out = {};
    const meterValues = Array.isArray(payload.meterValue) ? payload.meterValue : [];
    for (const mv of meterValues) {
      const samples = Array.isArray(mv.sampledValue) ? mv.sampledValue : [];
      for (const sample of samples) {
        this.parseSampledValue(sample, out);
      }
    }
    return out;
  }

  async handleOcppCall(cpId, action, payload) {
    const heartbeatSec = Math.max(10, Number(this.config.ocppHeartbeatIntervalSec) || 30);

    if (action === "BootNotification") {
      await this.setStateAsync("status.lastCommand", `BootNotification from ${cpId}`, true);
      return {
        currentTime: new Date().toISOString(),
        interval: heartbeatSec,
        status: "Accepted"
      };
    }

    if (action === "Heartbeat") {
      return { currentTime: new Date().toISOString() };
    }

    if (action === "StatusNotification") {
      const statusText = String(payload.status || "");
      const statusLc = statusText.toLowerCase();
      await this.setStateAsync("status.connectorStatus", statusText, true);
      await this.setStateAsync("status.vehicleConnected", this.connectedStates.has(statusLc), true);
      await this.setStateAsync("status.charging", statusLc === "charging", true);
      return {};
    }

    if (action === "MeterValues") {
      const values = this.parseMeterValues(payload);
      if (Number.isFinite(values.powerW)) {
        await this.setStateAsync("status.powerW", values.powerW, true);
      }
      if (Number.isFinite(values.currentA)) {
        await this.setStateAsync("status.currentA", values.currentA, true);
      }
      if (Number.isFinite(values.energyWh)) {
        await this.setStateAsync("status.energyWh", values.energyWh, true);
      }
      return {};
    }

    if (action === "StartTransaction") {
      this.ocppTxCounter += 1;
      const txId = this.ocppTxCounter;
      await this.setStateAsync("status.transactionId", txId, true);
      await this.setStateAsync("status.charging", true, true);

      const currentState = await this.getStateAsync("control.maxCurrentA");
      const targetCurrentA = await this.clampCurrent(currentState && currentState.val ? currentState.val : 16);
      void this.applyMaxCurrentA(targetCurrentA, { profilePurpose: "TxProfile" }).catch(async error => {
        await this.setStateAsync("status.lastError", error.message, true);
        this.log.warn(`SetChargingProfile nach StartTransaction fehlgeschlagen: ${error.message}`);
      });

      return {
        transactionId: txId,
        idTagInfo: { status: "Accepted" }
      };
    }

    if (action === "StopTransaction") {
      await this.setStateAsync("status.transactionId", 0, true);
      await this.setStateAsync("status.charging", false, true);
      return { idTagInfo: { status: "Accepted" } };
    }

    if (action === "Authorize") {
      return { idTagInfo: { status: "Accepted" } };
    }

    return {};
  }

  async handleOcppFrame(cpId, rawText) {
    let frame;
    try {
      frame = JSON.parse(rawText);
    } catch {
      return;
    }

    if (!Array.isArray(frame) || frame.length < 2) {
      return;
    }

    const messageType = Number(frame[0]);
    const uniqueId = String(frame[1]);

    await this.setStateAsync("status.ocppLastMessageAt", new Date().toISOString(), true);

    if (messageType === 2) {
      const action = String(frame[2] || "");
      const payload = frame[3] && typeof frame[3] === "object" ? frame[3] : {};
      await this.setStateAsync("status.ocppLastMessageAction", action, true);

      try {
        const responsePayload = await this.handleOcppCall(cpId, action, payload);
        const session = this.ocppSessions.get(cpId);
        if (session) {
          session.ws.send(JSON.stringify([3, uniqueId, responsePayload]));
        }
      } catch (error) {
        const session = this.ocppSessions.get(cpId);
        if (session) {
          session.ws.send(JSON.stringify([4, uniqueId, "InternalError", error.message, {}]));
        }
      }
      return;
    }

    const session = this.ocppSessions.get(cpId);
    if (!session) {
      return;
    }

    if (messageType === 3) {
      const pending = session.pending.get(uniqueId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      session.pending.delete(uniqueId);
      pending.resolve(frame[2] || {});
      return;
    }

    if (messageType === 4) {
      const pending = session.pending.get(uniqueId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      session.pending.delete(uniqueId);
      const errCode = String(frame[2] || "ProtocolError");
      const errDesc = String(frame[3] || "Unknown OCPP error");
      pending.reject(new Error(`${errCode}: ${errDesc}`));
    }
  }

  async clampCurrent(amps) {
    return Math.max(6, Math.min(32, Math.round(Number(amps))));
  }

  async applyPhaseSetting(phaseText) {
    const key = String(this.config.ocppPhaseConfigKey || "NumberOfPhases");
    let appliedVia = "ChangeConfiguration";

    try {
      const response = await this.sendOcppCall("ChangeConfiguration", {
        key,
        value: this.phaseTextToValue[phaseText]
      });
      const status = String(response.status || "");
      if (status && status !== "Accepted" && status !== "RebootRequired") {
        throw new Error(`ChangeConfiguration rejected: ${status}`);
      }
    } catch (error) {
      const msg = String(error && error.message ? error.message : "");
      const notSupported = /ChangeConfiguration rejected: NotSupported|NotSupported|NotImplemented/i.test(msg);
      if (!notSupported) {
        throw error;
      }
      appliedVia = "SetChargingProfile.numberPhases";
      this.log.warn(`ChangeConfiguration fuer Phasenumschaltung nicht unterstuetzt, nutze Fallback ueber SetChargingProfile (${phaseText}).`);
    }

    await this.setStateAsync("control.phaseSetting", phaseText, true);
    await this.setStateAsync("status.phaseSetting", phaseText, true);
    this.lastKnownPhaseCount = phaseText === "single" ? 1 : 3;

    if (appliedVia !== "ChangeConfiguration") {
      const currentAState = await this.getStateAsync("control.maxCurrentA");
      const fallbackAmps = Number(currentAState && currentAState.val ? currentAState.val : 16);
      await this.applyMaxCurrentA(fallbackAmps);
    }

    await this.setStateAsync(
      "status.lastCommand",
      `phaseSetting -> ${phaseText} (${this.phaseTextToValue[phaseText]}) via ${appliedVia}`,
      true
    );
  }

  buildChargingProfile(amps, purpose, connectorId, transactionId) {
    const profile = {
      chargingProfileId: 1,
      stackLevel: 0,
      chargingProfilePurpose: purpose,
      chargingProfileKind: "Recurring",
      recurrencyKind: "Daily",
      chargingSchedule: {
        duration: 86400,
        startSchedule: new Date().toISOString(),
        chargingRateUnit: "A",
        chargingSchedulePeriod: [
          {
            startPeriod: 0,
            limit: amps,
            numberPhases: this.lastKnownPhaseCount === 1 ? 1 : 3
          }
        ]
      }
    };

    if (purpose === "TxProfile" && transactionId > 0) {
      profile.transactionId = transactionId;
    }

    return {
      connectorId,
      csChargingProfiles: profile
    };
  }

  isMissingTransactionProfileError(error) {
    const message = String(error && error.message ? error.message : "");
    return /FormationViolation:.*TxProfile can only be used when a transaction is in progress/i.test(message);
  }

  isSetChargingProfileTimeout(error) {
    const message = String(error && error.message ? error.message : "");
    return /OCPP request timeout for SetChargingProfile/i.test(message);
  }

  isRemoteStartTimeout(error) {
    const message = String(error && error.message ? error.message : "");
    return /OCPP request timeout for RemoteStartTransaction/i.test(message);
  }

  async applyMaxCurrentA(amps, options = {}) {
    const clampedAmps = await this.clampCurrent(amps);
    const connectorState = await this.getStateAsync("control.connectorId");
    const connectorId = Math.max(1, Number(connectorState && connectorState.val ? connectorState.val : this.config.defaultConnectorId || 1));
    const txState = await this.getStateAsync("status.transactionId");
    const transactionId = Number(txState && txState.val ? txState.val : 0);
    const hasActiveTransaction = Number.isFinite(transactionId) && transactionId > 0;

    let profilePurpose = options.profilePurpose || (hasActiveTransaction ? "TxProfile" : "TxDefaultProfile");
    let response;

    try {
      response = await this.sendOcppCall(
        "SetChargingProfile",
        this.buildChargingProfile(clampedAmps, profilePurpose, connectorId, transactionId)
      );
    } catch (error) {
      if (profilePurpose !== "TxProfile" || !this.isMissingTransactionProfileError(error)) {
        if (!hasActiveTransaction && profilePurpose === "TxDefaultProfile" && this.isSetChargingProfileTimeout(error)) {
          await this.setStateAsync("control.maxCurrentA", clampedAmps, true);
          await this.setStateAsync("status.lastCommand", `maxCurrentA -> ${clampedAmps} (deferred until transaction)`, true);
          return clampedAmps;
        }
        throw error;
      }

      profilePurpose = "TxDefaultProfile";
      await this.setStateAsync("status.transactionId", 0, true);
      response = await this.sendOcppCall(
        "SetChargingProfile",
        this.buildChargingProfile(clampedAmps, profilePurpose, connectorId, 0)
      );
    }

    const status = String(response.status || "");
    if (status && status !== "Accepted") {
      throw new Error(`SetChargingProfile rejected: ${status}`);
    }

    await this.setStateAsync("control.maxCurrentA", clampedAmps, true);
    await this.setStateAsync("status.lastCommand", `maxCurrentA -> ${clampedAmps} (${profilePurpose})`, true);
    return clampedAmps;
  }

  async applyTargetPowerW(powerW) {
    const clampedPowerW = Math.max(1400, Math.round(Number(powerW)));
    const phases = this.lastKnownPhaseCount === 1 ? 1 : 3;
    const amps = await this.clampCurrent(clampedPowerW / (230 * phases));

    await this.applyMaxCurrentA(amps);
    await this.setStateAsync("control.targetPowerW", clampedPowerW, true);
    await this.setStateAsync("status.lastCommand", `targetPowerW -> ${clampedPowerW}W (${amps}A @${phases}p)`, true);
    return { clampedPowerW, amps };
  }

  async runAutomationCycle() {
    if (!this.automationEnabled) {
      await this.setStateAsync("status.automationActive", false, true);
      return;
    }

    try {
      if (!this.autoPowerInputStateId) {
        throw new Error("autoPowerInputStateId ist nicht konfiguriert");
      }

      if (this.automationOnlyWhenConnected) {
        const connectedState = await this.getStateAsync("status.vehicleConnected");
        if (!(connectedState && connectedState.val)) {
          await this.setStateAsync("status.automationActive", false, true);
          return;
        }
      }

      const authOk = await this.ensureAutoAuthorized();
      if (!authOk) {
        await this.setStateAsync("status.automationActive", false, true);
        return;
      }

      const inputPowerW = Number(await this.readForeignValue(this.autoPowerInputStateId));
      if (!Number.isFinite(inputPowerW)) {
        throw new Error(`Ungueltiger Automatik-Eingangswert in ${this.autoPowerInputStateId}`);
      }

      const targetPowerW = Math.max(this.autoMinPowerW, Math.min(this.autoMaxPowerW, Math.round(inputPowerW)));
      await this.setStateAsync("status.automationInputPowerW", inputPowerW, true);
      await this.setStateAsync("status.automationTargetPowerW", targetPowerW, true);

      if (this.autoPhaseSwitchEnabled) {
        const desiredPhase = targetPowerW < this.autoSinglePhaseBelowW ? "single" : "three";
        const phaseState = await this.getStateAsync("status.phaseSetting");
        const currentPhase = String(phaseState && phaseState.val ? phaseState.val : "");
        if (currentPhase !== desiredPhase) {
          await this.applyPhaseSetting(desiredPhase);
        }
      }

      await this.applyTargetPowerW(targetPowerW);
      await this.setStateAsync("status.automationActive", true, true);
      await this.setStateAsync("status.lastError", "", true);
    } catch (error) {
      await this.setStateAsync("status.automationActive", false, true);
      await this.setStateAsync("status.lastError", error.message, true);
      this.log.error(`Fehler im Automatikmodus: ${error.message}`);
    }
  }

  async startAutomationLoop() {
    this.stopAutomationLoop();
    if (!this.autoPowerInputStateId) {
      this.log.error("Automatik aktiv, aber autoPowerInputStateId ist nicht konfiguriert.");
      return;
    }

    this.automationTimer = setInterval(async () => {
      await this.runAutomationCycle();
    }, this.automationIntervalSec * 1000);

    await this.runAutomationCycle();
  }

  stopAutomationLoop() {
    if (this.automationTimer) {
      clearInterval(this.automationTimer);
      this.automationTimer = null;
    }
  }

  async handleRemoteStart() {
    const idTagState = await this.getStateAsync("control.idTag");
    const connectorState = await this.getStateAsync("control.connectorId");
    const currentState = await this.getStateAsync("control.maxCurrentA");
    const idTag = String(idTagState && idTagState.val ? idTagState.val : this.config.defaultIdTag || "A0000001");
    const connectorId = Math.max(1, Number(connectorState && connectorState.val ? connectorState.val : this.config.defaultConnectorId || 1));
    const targetCurrentA = await this.clampCurrent(currentState && currentState.val ? currentState.val : 16);

    let response;
    let startMode = "withProfile";

    try {
      response = await this.sendOcppCall("RemoteStartTransaction", {
        idTag,
        connectorId,
        chargingProfile: this.buildChargingProfile(targetCurrentA, "TxDefaultProfile", connectorId, 0).csChargingProfiles
      });
    } catch (error) {
      if (!this.isRemoteStartTimeout(error)) {
        throw error;
      }

      startMode = "withoutProfile";
      try {
        response = await this.sendOcppCall("RemoteStartTransaction", { idTag, connectorId });
      } catch (retryError) {
        if (!this.isRemoteStartTimeout(retryError)) {
          throw retryError;
        }

        startMode = "withoutProfileNoConnector";
        response = await this.sendOcppCall("RemoteStartTransaction", { idTag });
      }
    }

    const status = String(response.status || "");
    if (status && status !== "Accepted") {
      throw new Error(`RemoteStartTransaction rejected: ${status}`);
    }
    await this.setStateAsync(
      "status.lastCommand",
      `remoteStart -> ${status || "Accepted"} (${targetCurrentA}A prepared, ${startMode})`,
      true
    );
  }

  async handleRemoteStop() {
    const txState = await this.getStateAsync("status.transactionId");
    const transactionId = Number(txState && txState.val ? txState.val : 0);
    if (!transactionId) {
      throw new Error("Kein transactionId verfuegbar fuer RemoteStopTransaction.");
    }

    const response = await this.sendOcppCall("RemoteStopTransaction", { transactionId });
    const status = String(response.status || "");
    if (status && status !== "Accepted") {
      throw new Error(`RemoteStopTransaction rejected: ${status}`);
    }
    await this.setStateAsync("status.lastCommand", `remoteStop -> ${status || "Accepted"}`, true);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }

    const localId = id.replace(`${this.namespace}.`, "");
    const parts = localId.split(".");
    if (parts.length !== 2 || parts[0] !== "control") {
      return;
    }

    const control = parts[1];

    try {
      if (control === "refresh") {
        await this.setStateAsync("status.lastCommand", "refresh requested", true);
        await this.setStateAsync("control.refresh", false, true);
        return;
      }

      if (control === "authorizeCode") {
        await this.tryAuthorize(state.val);
        await this.setStateAsync("control.authorizeCode", "", true);
        return;
      }

      if (control === "lockControls") {
        await this.lockControlsNow();
        await this.setStateAsync("control.lockControls", false, true);
        return;
      }

      if (control === "automationEnabled") {
        this.automationEnabled = state.val === true;
        await this.setStateAsync("control.automationEnabled", this.automationEnabled, true);
        if (this.automationEnabled) {
          await this.startAutomationLoop();
        } else {
          this.stopAutomationLoop();
          await this.setStateAsync("status.automationActive", false, true);
        }
        return;
      }

      const isButtonControl = control === "remoteStart" || control === "remoteStop";
      const shouldTriggerButton = state.val === true || state.val === 1 || String(state.val).toLowerCase() === "true";
      if (isButtonControl && !shouldTriggerButton) {
        return;
      }

      const authorized = await this.isControlAuthorized(control);
      if (!authorized) {
        if (isButtonControl) {
          await this.setStateAsync(`control.${control}`, false, true);
        }
        return;
      }

      if (control === "phaseSetting") {
        const phaseText = this.parsePhaseSetting(state.val);
        if (!phaseText) {
          this.log.warn(`Ungueltige phaseSetting '${state.val}'`);
          return;
        }
        await this.applyPhaseSetting(phaseText);
        return;
      }

      if (control === "maxCurrentA") {
        await this.applyMaxCurrentA(state.val);
        return;
      }

      if (control === "targetPowerW") {
        await this.applyTargetPowerW(state.val);
        return;
      }

      if (control === "remoteStart") {
        try {
          await this.handleRemoteStart();
        } finally {
          await this.setStateAsync("control.remoteStart", false, true);
        }
        return;
      }

      if (control === "remoteStop") {
        try {
          await this.handleRemoteStop();
        } finally {
          await this.setStateAsync("control.remoteStop", false, true);
        }
      }
    } catch (error) {
      await this.setStateAsync("status.lastError", error.message, true);
      this.log.error(`Fehler bei Steuerbefehl control.${control}: ${error.message}`);
    }
  }

  async onUnload(callback) {
    try {
      this.stopAutomationLoop();

      if (this.autoAuthorizeTimer) {
        clearInterval(this.autoAuthorizeTimer);
        this.autoAuthorizeTimer = null;
      }

      if (this.wsServer) {
        for (const session of this.ocppSessions.values()) {
          try {
            session.ws.close();
          } catch {
            // ignore
          }
        }
        this.ocppSessions.clear();
        this.wsServer.close();
        this.wsServer = null;
      }

      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = null;
      }

      callback();
    } catch {
      callback();
    }
  }
}

if (module.parent) {
  module.exports = options => new ZappiAdapter(options);
} else {
  (() => new ZappiAdapter())();
}
