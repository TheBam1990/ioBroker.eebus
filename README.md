# ioBroker.eebus

The **Certificate** tab allows uploading and downloading a local certificate (`.pem`, `.crt`, `.cer`) and its matching unencrypted private key (`.pem`, `.key`). Uploaded files take precedence over manually entered PEM text.

EEbus adapter foundation for ioBroker.

This first local version prepares the adapter structure and runtime diagnostics for EEbus/SHIP:

- local SHIP TCP/TLS listener on the configured port
- optional outgoing SHIP peer connectivity check
- local certificate/SKI diagnostics
- peer certificate fingerprint diagnostics
- ioBroker states for connection, discovery, pairing and future SPINE values

The adapter does not yet implement a complete EEbus SPINE model. It is intended as a locally testable base for the next development step.

## Default test target

The default peer host is the documentation-only address `192.0.2.1` and the default SHIP port is `4712`. Replace the address with the address of your EEBUS peer.

## States

- `info.connection`
- `info.localSki`
- `diagnostics.status`
- `diagnostics.lastError`
- `ship.listenerActive`
- `ship.peerReachable`
- `ship.peerCertificateJson`
- `pairing.trusted`
- `spine.status`

## Local test

```sh
npm test
npm pack
```

## Security

The private key configured as PEM text is stored as an encrypted and protected native setting. Prefer the instance file storage for certificate and key uploads. Only pair with devices you trust and verify the peer SKI where available.

## Changelog

### 0.1.4

- Fixed the Admin UI crash caused by delete-enabled certificate file selectors.
- Prepared package metadata, tests and automation for an official ioBroker repository review.

### 0.1.0

- Initial EEbus adapter foundation with SHIP TCP/TLS listener, peer diagnostics, certificate SKI handling and ioBroker states.

Older release notes are archived in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## License

Copyright (c) 2026 TheBam

MIT License. See [LICENSE](LICENSE).
