# ioBroker.zappi

Server-only ioBroker adapter with integrated OCPP 1.6J WebSocket server.

## Goal

One adapter only:

- zappi connects directly to this adapter via OCPP
- no external OCPP adapter required

## Main Features

- direct OCPP server (ws/wss)
- charge point access control (token and allowlist)
- write authorization for control commands
- vehicle connected detection
- 1/3 phase switching
- dynamic current and power control
- optional built-in automation loop
- remote start and remote stop controls

## Security

### OCPP endpoint security

- optional token check via query string token
- optional charge point ID allowlist
- optional TLS (WSS) with key/cert files

### Control authorization

Protected controls:

- control.phaseSetting
- control.maxCurrentA
- control.targetPowerW
- control.remoteStart
- control.remoteStop

Unlock flow:

1. write authorization code to control.authorizeCode
2. adapter unlocks for authorizationTimeoutSec
3. lock immediately with control.lockControls

## Configuration

### OCPP server

- ocppServerHost
- ocppServerPort
- ocppTlsEnabled
- ocppTlsKeyPath
- ocppTlsCertPath
- serverAuthToken
- allowedChargePointIds
- ocppHeartbeatIntervalSec
- ocppRequestTimeoutSec

### Control behavior

- connectedStatusValues
- phaseSingleValue
- phaseThreeValue
- ocppPhaseConfigKey
- defaultIdTag
- defaultConnectorId

### Authorization

- requireWriteAuthorization
- authorizationCode
- authorizationTimeoutSec

### Built-in automation

- automationEnabled
- automationIntervalSec
- autoPowerInputStateId
- automationOnlyWhenConnected
- autoMinPowerW
- autoMaxPowerW
- autoPhaseSwitchEnabled
- autoSinglePhaseBelowW
- autoAuthorizeEnabled
- autoAuthorizeIntervalSec

## Datapoints

### status.*

- status.connectorStatus
- status.vehicleConnected
- status.charging
- status.currentA
- status.powerW
- status.energyWh
- status.phaseSetting
- status.transactionId
- status.lastCommand
- status.lastError
- status.authorizationRequired
- status.authorizationState
- status.authorizationValidUntil
- status.failedAuthorizationAttempts
- status.lastDeniedControl
- status.automationActive
- status.automationInputPowerW
- status.automationTargetPowerW
- status.ocppServerRunning
- status.ocppConnected
- status.ocppChargePointId
- status.ocppLastMessageAction
- status.ocppLastMessageAt

### control.*

- control.refresh
- control.phaseSetting
- control.maxCurrentA
- control.targetPowerW
- control.authorizeCode
- control.lockControls
- control.automationEnabled
- control.remoteStart
- control.remoteStop
- control.idTag
- control.connectorId

## OCPP messages handled

Incoming:

- BootNotification
- Heartbeat
- StatusNotification
- MeterValues
- StartTransaction
- StopTransaction
- Authorize

Outgoing control calls:

- ChangeConfiguration
- SetChargingProfile
- RemoteStartTransaction
- RemoteStopTransaction

## Quick start

1. Configure server host and port
2. Configure zappi/myaccount OCPP backend URI to this adapter endpoint
3. Optionally enable TLS and token check
4. Set authorization code
5. Test control.remoteStart, control.maxCurrentA and control.phaseSetting

## Installation

```bash
npm install
```

```bash
iobroker add zappi --host this
```
