# ioBroker.zappi

Leichter ioBroker-Adapter fuer die Steuerung einer myenergi Zappi Wallbox.

## Ziel

- Zappi-Status in ioBroker verfuegbar machen
- Lade-Modus direkt schalten (Fast, Eco, Eco+, Stop)
- Mindest-Gruenanteil setzen
- Direkte Leistungssteuerung ohne CT-Clamps ueber einen konfigurierbaren API-Pfad

## Installation (lokal)

1. Im Projektordner Abhaengigkeiten installieren:

```bash
npm install
```

2. Adapter in ioBroker lokal hinzufuegen (dev-Umgebung):

```bash
iobroker add zappi --host this
```

## Konfiguration

In der Admin-Konfiguration:

- Hub Serialnumber (wird intern als username verwendet)
- API Key (wird intern als password verwendet)
- API Base URL (standardmaessig `https://s18.myenergi.net`)
- Polling-Intervall
- Phasen (1 oder 3) fuer die Umrechnung von Watt in Ampere
- Current-limit API path template (optional, aber noetig fuer direkte Strom/Leistungsvorgabe)

Hinweis zur Authentifizierung:

- myenergi verwendet bei diesen Endpunkten HTTP Digest Auth.
- Dabei ist die Hub-Seriennummer der Benutzername und der API-Key das Passwort.

### Current-limit Template

Da myenergi je nach Firmware/API-Stand unterschiedliche Endpunkte fuer Current-Limits bereitstellt,
ist die direkte Stromvorgabe als Template konfigurierbar.

Beispiel:

```text
/cgi-set-device-limit-Z{serial}-{amps}
```

Verfuegbare Platzhalter:

- `{serial}`
- `{amps}`
- `{powerW}`

## States

Pro gefundener Zappi-Seriennummer werden States unter `<serial>.*` angelegt.

Wichtige Steuer-States:

- `<serial>.control.chargeMode` (`fast|eco|ecoplus|stop`)
- `<serial>.control.minGreenPercent` (1..100)
- `<serial>.control.maxCurrentA` (6..32, benoetigt `currentLimitPathTemplate`)
- `<serial>.control.targetPowerW` (wird anhand Phasen in Ampere umgerechnet, benoetigt `currentLimitPathTemplate`)
- `<serial>.control.refresh`

## Hinweise

- Digest-Auth und ASN-Redirects (`x_myenergi-asn`) sind implementiert.
- Der Adapter fokussiert bewusst auf Zappi-Steuerung.
- Falls dein Firmware-Stand einen anderen Current-Limit-Endpunkt benoetigt, passe das Template entsprechend an.
