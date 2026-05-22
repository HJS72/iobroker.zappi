"use strict";

const crypto = require("crypto");

class AuthDigest {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.realm = "";
    this.nonce = "";
    this.qop = "auth";
    this.opaque = "";
    this.algorithm = "MD5";
    this.nc = 0;
    this.initialized = false;
  }

  init(wwwAuthenticate) {
    const params = {};
    const digestPart = String(wwwAuthenticate || "").replace(/^\s*Digest\s+/i, "");
    const keyValueRegex = /(\w+)=((?:\"[^\"]*\")|(?:[^,\s]+))/g;
    let match;
    while ((match = keyValueRegex.exec(digestPart)) !== null) {
      const key = match[1];
      const rawValue = match[2];
      const value = rawValue.replace(/^\"|\"$/g, "");
      params[key] = value;
    }

    this.realm = params.realm || this.realm;
    this.nonce = params.nonce || this.nonce;
    if (params.qop) {
      const qopValues = params.qop.split(",").map((item) => item.trim());
      this.qop = qopValues.includes("auth") ? "auth" : qopValues[0] || this.qop;
    }
    this.opaque = params.opaque || this.opaque;
    this.algorithm = params.algorithm || this.algorithm;
    this.nc = 0;
    this.initialized = Boolean(this.realm && this.nonce);
  }

  md5(value) {
    return crypto.createHash("md5").update(value).digest("hex");
  }

  getAuthorization(method, uriPath) {
    if (!this.initialized || !this.nonce || !this.realm) {
      return "";
    }

    this.nc += 1;
    const ncHex = this.nc.toString(16).padStart(8, "0");
    const cnonce = crypto.randomBytes(8).toString("hex");

    const ha1 = this.md5(`${this.username}:${this.realm}:${this.password}`);
    const ha2 = this.md5(`${method}:${uriPath}`);
    const response = this.md5(`${ha1}:${this.nonce}:${ncHex}:${cnonce}:${this.qop}:${ha2}`);

    const parts = [
      `username=\"${this.username}\"`,
      `realm=\"${this.realm}\"`,
      `nonce=\"${this.nonce}\"`,
      `uri=\"${uriPath}\"`,
      `algorithm=${this.algorithm}`,
      `response=\"${response}\"`,
      `qop=\"${this.qop}\"`,
      `nc=${ncHex}`,
      `cnonce=\"${cnonce}\"`
    ];

    if (this.opaque) {
      parts.push(`opaque=\"${this.opaque}\"`);
    }

    return `Digest ${parts.join(", ")}`;
  }
}

module.exports = {
  AuthDigest
};
