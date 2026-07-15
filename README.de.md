# ioBroker.eebus

Im Reiter **Zertifikat** koennen ein lokales Zertifikat (`.pem`, `.crt`, `.cer`) und der passende unverschluesselte private Schluessel (`.pem`, `.key`) hochgeladen und wieder heruntergeladen werden. Hochgeladene Dateien haben Vorrang vor den manuell eingetragenen PEM-Texten.

EEbus-Adapterbasis fuer ioBroker.

Diese erste lokale Version bereitet die Adapterstruktur und Laufzeitdiagnose fuer EEbus/SHIP vor:

- lokaler SHIP-TCP/TLS-Listener auf dem konfigurierten Port
- optionale ausgehende SHIP-Peer-Verbindungspruefung
- lokale Zertifikat-/SKI-Diagnose
- Peer-Zertifikat-Fingerprint-Diagnose
- ioBroker-States fuer Verbindung, Discovery, Pairing und spaetere SPINE-Werte

Der Adapter implementiert noch kein vollstaendiges EEbus-SPINE-Modell. Er ist als lokal testbare Basis fuer den naechsten Entwicklungsschritt gedacht.

## Standard-Testziel

Der Standard-Peer-Host ist die ausschließlich für Dokumentation reservierte Adresse `192.0.2.1`, der Standard-SHIP-Port ist `4712`. Die Adresse muss durch die Adresse des eigenen EEBUS-Peers ersetzt werden.

## Lokaler Test

```sh
npm test
npm pack
```

## Sicherheit

Ein als PEM-Text konfigurierter privater Schlüssel wird als verschlüsselte und geschützte Native-Einstellung gespeichert. Für Zertifikat und Schlüssel sollte bevorzugt der Instanz-Dateispeicher verwendet werden. Es sollten nur vertrauenswürdige Geräte gekoppelt und – soweit verfügbar – die Peer-SKI geprüft werden.
