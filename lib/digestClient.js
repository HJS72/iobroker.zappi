"use strict";

const https = require("https");
const { AuthDigest } = require("./authDigest");

class DigestClient {
  constructor(baseUrl, username, password) {
    this.baseUrl = new URL(baseUrl);
    this.username = String(username || "");
    this.auth = new AuthDigest(username, password);
    this.maxRedirects = 3;
    this.maxRetries = 2;
    this.seenDigestChallenge = false;
  }

  async get(pathname) {
    let lastError = null;
    this.seenDigestChallenge = false;
    const hosts = await this.getCandidateHosts();

    for (const host of hosts) {
      this.baseUrl.host = host;
      this.baseUrl.hostname = host;
      try {
        return await this.request("GET", pathname, 0, 0);
      } catch (error) {
        lastError = error;
      }
    }

    if (this.seenDigestChallenge) {
      throw new Error("Authentication failed: credentials rejected (Hub Serial/API key)");
    }

    throw lastError || new Error("Request failed");
  }

  async getCandidateHosts() {
    const hosts = [];
    const add = (value) => {
      if (!value) {
        return;
      }
      if (!hosts.includes(value)) {
        hosts.push(value);
      }
    };

    add(this.baseUrl.host);
    add("director.myenergi.net");
    add("s18.myenergi.net");

    const discoveredAsn = await this.discoverAsnHost();
    add(discoveredAsn);

    const lastChar = this.username.slice(-1);
    if (/^[0-9]$/.test(lastChar)) {
      add(`s${lastChar}.myenergi.net`);
    }

    return hosts;
  }

  async discoverAsnHost() {
    return new Promise((resolve) => {
      const options = {
        hostname: "director.myenergi.net",
        host: "director.myenergi.net",
        port: 443,
        path: "/cgi-jstatus-E",
        method: "GET",
        headers: {
          Connection: "Keep-Alive",
          Accept: "application/json",
          "Content-Type": "application/json",
          Host: "director.myenergi.net",
          "User-Agent": "Wget/1.14 (linux-gnu)"
        }
      };

      const req = https.request(options, (res) => {
        const asn = this.getAsnHost(res.headers);
        if (asn && asn !== "undefined") {
          resolve(asn);
          return;
        }
        resolve("");
      });

      req.on("error", () => resolve(""));
      req.end();
    });
  }

  getAsnHost(headers) {
    if (!headers) {
      return "";
    }
    return String(
      headers["x_myenergi-asn"] ||
        headers["x-myenergi-asn"] ||
        headers["x_myenergi_asn"] ||
        ""
    ).trim();
  }

  getHeaderValue(res, headerName) {
    const key = String(headerName || "").toLowerCase();
    const fromHeaders = res && res.headers ? res.headers[key] : undefined;
    if (Array.isArray(fromHeaders)) {
      const joined = fromHeaders.join(",").trim();
      if (joined) {
        return joined;
      }
    } else if (typeof fromHeaders === "string" && fromHeaders.trim()) {
      return fromHeaders.trim();
    }

    const rawHeaders = res && Array.isArray(res.rawHeaders) ? res.rawHeaders : [];
    const values = [];
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const rawName = String(rawHeaders[i] || "").toLowerCase();
      const rawValue = String(rawHeaders[i + 1] || "").trim();
      if (rawName === key && rawValue) {
        values.push(rawValue);
      }
    }
    return values.join(",").trim();
  }

  async bootstrapDigestChallenge() {
    const challenge = await new Promise((resolve) => {
      const options = {
        hostname: this.baseUrl.hostname,
        host: this.baseUrl.host,
        port: this.baseUrl.port || 443,
        path: "/cgi-jstatus-E",
        method: "GET",
        headers: {
          Connection: "Keep-Alive",
          Accept: "application/json",
          "Content-Type": "application/json",
          Host: this.baseUrl.host,
          "User-Agent": "Wget/1.14 (linux-gnu)"
        }
      };

      const req = https.request(options, (res) => {
        const headerValue = this.getHeaderValue(res, "www-authenticate");
        const parsed = this.extractDigestChallenge(headerValue);
        resolve(parsed);
      });

      req.on("error", () => resolve(""));
      req.end();
    });

    return challenge;
  }

  extractDigestChallenge(wwwAuthenticateHeader) {
    if (!wwwAuthenticateHeader) {
      return "";
    }

    const raw = Array.isArray(wwwAuthenticateHeader)
      ? wwwAuthenticateHeader.join(",")
      : String(wwwAuthenticateHeader);

    const digestIndex = raw.toLowerCase().indexOf("digest ");
    if (digestIndex !== -1) {
      return raw.slice(digestIndex).trim();
    }

    return "";
  }

  request(method, pathname, retryCount, redirectCount) {
    return new Promise((resolve, reject) => {
      const headers = {
        Connection: "Keep-Alive",
        Accept: "application/json",
        "Content-Type": "application/json",
        Host: this.baseUrl.host,
        "User-Agent": "Wget/1.14 (linux-gnu)"
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
          const asnHost = this.getAsnHost(res.headers);
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

          let wwwAuth = this.extractDigestChallenge(this.getHeaderValue(res, "www-authenticate"));
          if (wwwAuth) {
            this.seenDigestChallenge = true;
          }
          if (!wwwAuth && retryCount === 0) {
            this.bootstrapDigestChallenge()
              .then((bootstrapChallenge) => {
                if (!bootstrapChallenge) {
                  const headerKeys = Object.keys(res.headers || {}).join(", ");
                  const rawWwwAuth = this.getHeaderValue(res, "www-authenticate");
                  reject(
                    new Error(
                      `Authentication failed or unsupported auth scheme (status=401, host=${this.baseUrl.host}, asn=${asnHost || "n/a"}, headers=${headerKeys}, www-authenticate=${rawWwwAuth.slice(0, 300)})`
                    )
                  );
                  return;
                }

                this.seenDigestChallenge = true;
                this.auth.init(bootstrapChallenge);
                resolve(this.request(method, pathname, retryCount + 1, redirectCount));
              })
              .catch((error) => reject(error));
            return;
          }

          if (!wwwAuth) {
            const headerKeys = Object.keys(res.headers || {}).join(", ");
            const rawWwwAuth = this.getHeaderValue(res, "www-authenticate");
            reject(
              new Error(
                `Authentication failed or unsupported auth scheme (status=401, host=${this.baseUrl.host}, asn=${asnHost || "n/a"}, headers=${headerKeys}, www-authenticate=${rawWwwAuth.slice(0, 300)})`
              )
            );
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
