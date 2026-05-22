"use strict";

const { DigestClient } = require("./digestClient");

class MyEnergiApi {
  constructor(username, password, baseUrl = "https://s18.myenergi.net") {
    this.client = new DigestClient(baseUrl, username, password);
  }

  async getStatusAll() {
    return this.getJson("/cgi-jstatus-*");
  }

  async getJson(path) {
    const raw = await this.client.get(path);
    return JSON.parse(raw || "{}");
  }

  async setZappiChargeMode(serialNo, chargeMode) {
    return this.getJson(`/cgi-zappi-mode-Z${serialNo}-${chargeMode}-0-0-0000`);
  }

  async setZappiBoostMode(serialNo, boostMode, kwh = 0, completeTime = "0000") {
    return this.getJson(`/cgi-zappi-mode-Z${serialNo}-0-${boostMode}-${kwh}-${completeTime}`);
  }

  async setZappiGreenLevel(serialNo, percentage) {
    return this.getJson(`/cgi-set-min-green-Z${serialNo}-${percentage}`);
  }

  async setZappiPhaseSetting(serialNo, phaseSettingCode) {
    return this.getJson(`/cgi-zappi-phase-setting-Z${serialNo}-${phaseSettingCode}`);
  }

  async callTemplate(template, values) {
    let path = template;
    for (const [key, value] of Object.entries(values)) {
      path = path.replaceAll(`{${key}}`, String(value));
    }
    return this.getJson(path);
  }
}

module.exports = {
  MyEnergiApi
};
