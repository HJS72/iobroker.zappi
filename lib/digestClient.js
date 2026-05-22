"use strict";

const https = require("https");
const { AuthDigest } = require("./authDigest");

class DigestClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = new URL(baseUrl);
    this.auth = new AuthDigest(username, password);
    this.maxRedirects = 3;
    this.maxRetries = 2;
  }

  async get(pathname) {
    return this.request("GET", pathname, 0, 0);
  }

  extractDigestChallenge(wwwAuthenticateHeader) {
    if (!wwwAuthenticateHeader) {
      return "";
    }

    const raw = Array.isArray(wwwAuthenticateHeader)
      ? wwwAuthenticateHeader.join(",")
      : String(wwwAuthenticateHeader);

    if (/^\s*digest\b/i.test(raw)) {
      return raw;
    }

    const digestMatch = raw.match(/Digest\s+[^,]+(?:,\s*\w+=(?:\"[^\"]*\"|[^,\s]+))*/i);
    return digestMatch ? digestMatch[0] : "";
  }

  request(method, pathname, retryCount, redirectCount) {
    return new Promise((resolve, reject) => {
      const headers = {
        Connection: "Keep-Alive",
        Accept: "application/json",
        "Content-Type": "application/json",
        Host: this.baseUrl.host
      };

      const authHeader = this.auth.getAuthorization(method, pathname);
      if (authHeader) {
        headers.Authorization = authHeader;
      }

      const options = {
        hostname: this.baseUrl.hostname,
        host: this.baseUrl.host,
        port: this.baseUrl.port || 443,
        path: pathname,
        method,
        headers
      };

      const req = https.request(options, (res) => {
        let body = "";

        if (res.statusCode === 401) {
          const asnHost = res.headers["x_myenergi-asn"];
          if (asnHost && asnHost !== "undefined" && asnHost !== this.baseUrl.host) {
            if (redirectCount >= this.maxRedirects) {
              reject(new Error(`Too many ASN redirects (${asnHost})`));
              return;
            }
            this.baseUrl.host = asnHost;
            this.baseUrl.hostname = asnHost;
            resolve(this.request(method, pathname, retryCount, redirectCount + 1));
            return;
          }

          const wwwAuth = this.extractDigestChallenge(res.headers["www-authenticate"]);
          if (!wwwAuth) {
            reject(new Error("Authentication failed or unsupported auth scheme"));
            return;
          }

          if (retryCount >= this.maxRetries) {
            reject(new Error("Authentication retry limit reached"));
            return;
          }

          this.auth.init(wwwAuth);
          resolve(this.request(method, pathname, retryCount + 1, redirectCount));
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} for ${pathname}`));
          return;
        }

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve(body));
      });

      req.on("error", (err) => reject(err));
      req.end();
    });
  }
}

module.exports = {
  DigestClient
};
