"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const tls = require("node:tls");
const selfsigned = require("selfsigned");
const utils = require("@iobroker/adapter-core");

function normalizeSki(value) {
  return String(value || "")
    .replace(/[^a-fA-F0-9]/g, "")
    .toUpperCase();
}

function pemLooksValid(value, label) {
  const text = String(value || "");
  return text.includes(`-----BEGIN ${label}-----`) && text.includes(`-----END ${label}-----`);
}

function sha1Hex(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex").toUpperCase();
}

function certificateFingerprint(cert) {
  if (!cert) {
    return "";
  }
  if (cert.fingerprint) {
    return normalizeSki(cert.fingerprint);
  }
  if (cert.raw) {
    return sha1Hex(cert.raw);
  }
  return "";
}

function asBoolean(value, fallback = false) {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

class EebusAdapter extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: "eebus",
    });

    this.server = null;
    this.pollTimer = null;
    this.connections = new Set();
    this.stopping = false;
    this.localCertificatePem = "";
    this.localPrivateKeyPem = "";
    this.localSki = "";
    this.peerReachable = false;
    this.listenerActive = false;

    this.on("ready", () => this.onReady());
    this.on("stateChange", (id, state) => this.onStateChange(id, state));
    this.on("unload", (callback) => this.onUnload(callback));
  }

  async onReady() {
    this.config = this.normalizeConfig(this.config);
    await this.createBaseObjects();
    await this.subscribeStatesAsync("control.*");
    await this.resetRuntimeStates();

    if (!this.config.enabled) {
      await this.setStateAsync("diagnostics.status", "disabled", true);
      this.log.info("EEbus adapter is disabled");
      return;
    }

    await this.prepareCertificate();
    await this.writeDeviceInfo();

    if (this.config.shipEnabled) {
      await this.startShipListener();
      await this.checkPeer();
      this.startPolling();
    } else {
      await this.setStateAsync("diagnostics.status", "ship-disabled", true);
    }
  }

  normalizeConfig(config) {
    return {
      enabled: asBoolean(config.enabled, true),
      shipEnabled: asBoolean(config.shipEnabled, true),
      shipBind: String(config.shipBind || "0.0.0.0"),
      shipPort: Math.max(Number(config.shipPort || 4712), 1),
      peerHost: String(config.peerHost || "").trim(),
      peerPort: Math.max(Number(config.peerPort || 4712), 1),
      connectTimeoutMs: Math.max(Number(config.connectTimeoutMs || 5000), 1000),
      pollIntervalMs: Math.max(Number(config.pollIntervalMs || 30000), 5000),
      deviceBrand: String(config.deviceBrand || "ioBroker"),
      deviceModel: String(config.deviceModel || "ioBroker EEbus Adapter"),
      deviceType: String(config.deviceType || "EnergyManagementSystem"),
      deviceSerial: String(config.deviceSerial || os.hostname()),
      certificatePem: String(config.certificatePem || ""),
      certificateFile: String(config.certificateFile || ""),
      privateKeyPem: String(config.privateKeyPem || ""),
      privateKeyFile: String(config.privateKeyFile || ""),
      expectedPeerSki: normalizeSki(config.expectedPeerSki),
      autoGenerateCertificate: asBoolean(config.autoGenerateCertificate, true),
      mdnsEnabled: asBoolean(config.mdnsEnabled, true),
      spineEnabled: asBoolean(config.spineEnabled, false),
    };
  }

  async createBaseObjects() {
    await this.setObjectNotExistsAsync("info", { type: "channel", common: { name: "Information" }, native: {} });
    await this.setObjectNotExistsAsync("control", { type: "channel", common: { name: "Control" }, native: {} });
    await this.setObjectNotExistsAsync("diagnostics", { type: "channel", common: { name: "Diagnostics" }, native: {} });
    await this.setObjectNotExistsAsync("ship", { type: "channel", common: { name: "SHIP" }, native: {} });
    await this.setObjectNotExistsAsync("pairing", { type: "channel", common: { name: "Pairing" }, native: {} });
    await this.setObjectNotExistsAsync("discovery", { type: "channel", common: { name: "Discovery" }, native: {} });
    await this.setObjectNotExistsAsync("spine", { type: "channel", common: { name: "SPINE" }, native: {} });

    await this.ensureState("info.connection", "EEbus connection", "boolean", "indicator.connected", true);
    await this.ensureState("info.localSki", "Local SKI", "string", "text", true);
    await this.ensureState("info.deviceJson", "Local EEbus device JSON", "string", "json", true);
    await this.ensureState("control.checkPeer", "Check configured EEbus peer", "boolean", "button", false, true);
    await this.ensureState("control.trustCurrentPeer", "Trust current peer SKI", "boolean", "button", false, true);
    await this.ensureState("diagnostics.status", "Status", "string", "text", true);
    await this.ensureState("diagnostics.lastError", "Last error", "string", "text", true);
    await this.ensureState("diagnostics.lastUpdate", "Last update", "string", "value.time", true);
    await this.ensureState("ship.listenerActive", "SHIP listener active", "boolean", "indicator", true);
    await this.ensureState("ship.listenerAddress", "SHIP listener address", "string", "text", true);
    await this.ensureState("ship.peerHost", "Configured peer host", "string", "text", true);
    await this.ensureState("ship.peerReachable", "Configured peer reachable", "boolean", "indicator.reachable", true);
    await this.ensureState("ship.peerSki", "Peer certificate SKI", "string", "text", true);
    await this.ensureState("ship.peerCertificateJson", "Peer certificate JSON", "string", "json", true);
    await this.ensureState("ship.lastConnection", "Last incoming SHIP connection", "string", "text", true);
    await this.ensureState("pairing.trusted", "Peer trusted", "boolean", "indicator", true);
    await this.ensureState("pairing.expectedPeerSki", "Expected peer SKI", "string", "text", true);
    await this.ensureState("discovery.mdnsStatus", "mDNS status", "string", "text", true);
    await this.ensureState("discovery.serviceName", "mDNS service name", "string", "text", true);
    await this.ensureState("spine.status", "SPINE status", "string", "text", true);
    await this.ensureState("spine.lastMessageJson", "Last SPINE message JSON", "string", "json", true);
  }

  async ensureState(id, name, type, role, read = true, write = false) {
    await this.setObjectNotExistsAsync(id, {
      type: "state",
      common: {
        name,
        type,
        role,
        read,
        write,
      },
      native: {},
    });
  }

  async resetRuntimeStates() {
    await this.setStateAsync("info.connection", false, true);
    await this.setStateAsync("diagnostics.status", "starting", true);
    await this.setStateAsync("diagnostics.lastError", "", true);
    await this.setStateAsync("ship.listenerActive", false, true);
    await this.setStateAsync("ship.listenerAddress", "", true);
    await this.setStateAsync(
      "ship.peerHost",
      this.config.peerHost ? `${this.config.peerHost}:${this.config.peerPort}` : "",
      true,
    );
    await this.setStateAsync("ship.peerReachable", false, true);
    await this.setStateAsync("ship.peerSki", "", true);
    await this.setStateAsync("ship.peerCertificateJson", "{}", true);
    await this.setStateAsync("pairing.expectedPeerSki", this.config.expectedPeerSki, true);
    await this.setStateAsync("pairing.trusted", !this.config.expectedPeerSki, true);
    await this.setStateAsync("discovery.mdnsStatus", this.config.mdnsEnabled ? "prepared" : "disabled", true);
    await this.setStateAsync("discovery.serviceName", "_ship._tcp.local", true);
    await this.setStateAsync("spine.status", this.config.spineEnabled ? "prepared" : "disabled", true);
    await this.setStateAsync("spine.lastMessageJson", "{}", true);
  }

  async prepareCertificate() {
    this.localCertificatePem = this.config.certificatePem;
    this.localPrivateKeyPem = this.config.privateKeyPem;

    if (this.config.certificateFile) {
      try {
        this.localCertificatePem = await this.readConfiguredPemFile(this.config.certificateFile, "certificate");
      } catch (error) {
        await this.setError(error);
      }
    }
    if (this.config.privateKeyFile) {
      try {
        this.localPrivateKeyPem = await this.readConfiguredPemFile(this.config.privateKeyFile, "private key");
      } catch (error) {
        await this.setError(error);
      }
    }

    const hasConfiguredCert =
      pemLooksValid(this.localCertificatePem, "CERTIFICATE") && pemLooksValid(this.localPrivateKeyPem, "PRIVATE KEY");
    if (!hasConfiguredCert && this.config.autoGenerateCertificate) {
      try {
        const generated = await this.generateSelfSignedCertificate();
        this.localCertificatePem = generated.cert;
        this.localPrivateKeyPem = generated.key;
        this.log.info("Generated temporary self-signed EEbus test certificate for this adapter start");
      } catch (error) {
        await this.setError(`Could not generate local certificate: ${errorMessage(error)}`);
      }
    }

    if (pemLooksValid(this.localCertificatePem, "CERTIFICATE")) {
      try {
        const cert = new crypto.X509Certificate(this.localCertificatePem);
        this.localSki = sha1Hex(cert.raw);
      } catch (error) {
        await this.setError(`Could not parse local certificate: ${errorMessage(error)}`);
      }
    }

    await this.setStateAsync("info.localSki", this.localSki, true);
  }

  async readConfiguredPemFile(selectedPath, description) {
    const normalized = String(selectedPath || "").replace(/^\/+/, "");
    const slash = normalized.indexOf("/");
    const storageId = slash === -1 ? `${this.namespace}.certificates` : normalized.slice(0, slash);
    const fileName = slash === -1 ? normalized : normalized.slice(slash + 1);
    if (!fileName || storageId !== `${this.namespace}.certificates`) {
      throw new Error(`Invalid uploaded ${description} path: ${selectedPath}`);
    }

    try {
      const result = await this.readFileAsync(storageId, fileName);
      const data = result && Object.prototype.hasOwnProperty.call(result, "file") ? result.file : result;
      return Buffer.isBuffer(data) ? data.toString("utf8") : String(data || "");
    } catch (error) {
      throw new Error(`Could not read uploaded ${description}: ${errorMessage(error)}`);
    }
  }

  async generateSelfSignedCertificate() {
    const attrs = [
      { shortName: "CN", value: `${this.config.deviceBrand} ${this.config.deviceModel}` },
      { shortName: "O", value: "ioBroker" },
      { shortName: "OU", value: "EEbus" },
    ];
    const pems = await selfsigned.generate(attrs, {
      algorithm: "sha256",
      notAfterDate: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      keySize: 2048,
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true, clientAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: os.hostname() }] },
      ],
    });
    if (!pems.private || !pems.cert) {
      throw new Error("selfsigned did not return key and certificate PEM data");
    }
    return {
      key: pems.private,
      cert: pems.cert,
    };
  }

  async writeDeviceInfo() {
    const device = {
      brand: this.config.deviceBrand,
      model: this.config.deviceModel,
      type: this.config.deviceType,
      serial: this.config.deviceSerial,
      ski: this.localSki,
      ship: {
        host: os.hostname(),
        bind: this.config.shipBind,
        port: this.config.shipPort,
      },
    };
    await this.setStateAsync("info.deviceJson", JSON.stringify(device), true);
    await this.touch();
  }

  async startShipListener() {
    if (
      !pemLooksValid(this.localCertificatePem, "CERTIFICATE") ||
      !pemLooksValid(this.localPrivateKeyPem, "PRIVATE KEY")
    ) {
      await this.setError("SHIP listener skipped because no valid certificate/key is configured");
      return;
    }

    const server = tls.createServer({
      cert: this.localCertificatePem,
      key: this.localPrivateKeyPem,
      requestCert: false,
      rejectUnauthorized: false,
      ALPNProtocols: ["ship"],
    });
    this.server = server;

    server.on("secureConnection", (socket) => this.handleIncomingShip(socket));
    server.on("tlsClientError", (error) => {
      const code = errorCode(error);
      if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up/i.test(error.message)) {
        this.log.debug(`SHIP TLS client disconnected during handshake: ${error.message}`);
        return;
      }
      void this.setError(`SHIP TLS client error: ${error.message}`);
    });
    server.on("error", (error) => {
      this.listenerActive = false;
      void this.setStateAsync("ship.listenerActive", false, true);
      void this.setError(`SHIP listener error: ${error.message}`);
    });

    await new Promise((resolve) => {
      server.listen(this.config.shipPort, this.config.shipBind, async () => {
        this.listenerActive = true;
        const address = server.address();
        const addressText =
          typeof address === "object" && address ? `${address.address}:${address.port}` : String(address || "");
        await this.setStateAsync("ship.listenerActive", true, true);
        await this.setStateAsync("ship.listenerAddress", addressText, true);
        await this.setStateAsync("diagnostics.status", "listening", true);
        this.log.info(`EEbus SHIP test listener active on ${addressText}`);
        resolve(undefined);
      });
      server.once("error", () => resolve(undefined));
    });
  }

  handleIncomingShip(socket) {
    this.connections.add(socket);
    const remote = `${socket.remoteAddress || "unknown"}:${socket.remotePort || 0}`;
    this.log.info(`Incoming EEbus SHIP TLS connection from ${remote}`);
    void this.setStateAsync("ship.lastConnection", `${new Date().toISOString()} ${remote}`, true);
    void this.setStateAsync("info.connection", true, true);

    socket.setTimeout(30000);
    socket.on("data", (data) => {
      void this.setStateAsync(
        "spine.lastMessageJson",
        JSON.stringify({
          direction: "rx",
          bytes: data.length,
          hexPreview: data.subarray(0, 80).toString("hex"),
          timestamp: new Date().toISOString(),
        }),
        true,
      );
    });
    socket.on("close", () => {
      this.connections.delete(socket);
      void this.updateConnectionState();
    });
    socket.on("error", (error) => {
      this.connections.delete(socket);
      void this.setError(`Incoming SHIP connection error: ${error.message}`);
    });
  }

  async checkPeer() {
    if (!this.config.peerHost) {
      await this.setStateAsync("ship.peerReachable", false, true);
      await this.setStateAsync("diagnostics.status", this.listenerActive ? "listening" : "no-peer-configured", true);
      return;
    }

    const result = await this.probePeerTls();
    this.peerReachable = result.reachable;
    await this.setStateAsync("ship.peerReachable", result.reachable, true);
    await this.setStateAsync("ship.peerSki", result.ski || "", true);
    await this.setStateAsync("ship.peerCertificateJson", JSON.stringify(result.certificate || {}), true);

    const trusted = !this.config.expectedPeerSki || (result.ski && result.ski === this.config.expectedPeerSki);
    await this.setStateAsync("pairing.trusted", Boolean(trusted), true);
    await this.setStateAsync(
      "diagnostics.status",
      result.reachable ? "peer-reachable" : this.listenerActive ? "listening-peer-unreachable" : "peer-unreachable",
      true,
    );
    await this.updateConnectionState();
    await this.touch();

    if (!result.reachable && result.error) {
      this.log.info(
        `EEbus peer ${this.config.peerHost}:${this.config.peerPort} not reachable via SHIP/TLS: ${result.error}`,
      );
    }
  }

  probePeerTls() {
    return new Promise((resolve) => {
      let settled = false;
      const socket = tls.connect({
        host: this.config.peerHost,
        port: this.config.peerPort,
        timeout: this.config.connectTimeoutMs,
        rejectUnauthorized: false,
        ALPNProtocols: ["ship"],
        servername: this.config.peerHost,
      });

      const finish = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.on("secureConnect", () => {
        const cert = socket.getPeerCertificate(true);
        const ski = certificateFingerprint(cert);
        finish({
          reachable: true,
          ski,
          certificate: {
            subject: cert.subject || {},
            issuer: cert.issuer || {},
            validFrom: cert.valid_from || "",
            validTo: cert.valid_to || "",
            fingerprint: cert.fingerprint || "",
            fingerprint256: cert.fingerprint256 || "",
            ski,
          },
        });
      });
      socket.on("timeout", () => finish({ reachable: false, error: "timeout" }));
      socket.on("error", (error) => finish({ reachable: false, error: error.message }));
    });
  }

  startPolling() {
    this.clearPolling();
    this.pollTimer = setInterval(() => {
      void this.checkPeer();
    }, this.config.pollIntervalMs);
    this.pollTimer.unref();
  }

  clearPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async updateConnectionState() {
    await this.setStateAsync("info.connection", this.peerReachable || this.connections.size > 0, true);
  }

  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    if (id.endsWith(".control.checkPeer") && state.val) {
      await this.setStateAsync("control.checkPeer", false, true);
      await this.checkPeer();
    }
    if (id.endsWith(".control.trustCurrentPeer") && state.val) {
      await this.setStateAsync("control.trustCurrentPeer", false, true);
      const peerSki = await this.getStateAsync("ship.peerSki");
      await this.setStateAsync("pairing.expectedPeerSki", normalizeSki(peerSki && peerSki.val), true);
      await this.setStateAsync("pairing.trusted", Boolean(peerSki && peerSki.val), true);
      this.log.warn(
        "Peer SKI was trusted only in runtime states. Copy it into the instance configuration to persist it.",
      );
    }
  }

  async setError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    if (message) {
      this.log.warn(message);
      await this.setStateAsync("diagnostics.lastError", message, true);
    }
    await this.touch();
  }

  async touch() {
    await this.setStateAsync("diagnostics.lastUpdate", new Date().toISOString(), true);
  }

  onUnload(callback) {
    this.stopping = true;
    this.clearPolling();
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    if (this.server) {
      this.server.close(() => callback());
      this.server = null;
      return;
    }
    callback();
  }
}

if (require.main !== module) {
  module.exports = (options) => new EebusAdapter(options);
} else {
  new EebusAdapter();
}
