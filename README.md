# ioBroker.zappi

Custom ioBroker adapter for zappi with integrated OCPP 1.6J server mode.

## Overview

This adapter supports two architectures:

- server mode: this adapter provides the OCPP WebSocket server directly
- bridge mode: this adapter reads/writes states of another OCPP adapter instance

If you want only one adapter, use server mode.

## Core Features

- detect if vehicle is connected
- switch 1/3 phases
- set charging current/power and change it while charging
- optional built-in automation loop
- write authorization with timeout
- integrated OCPP commands: RemoteStartTransaction and RemoteStopTransaction

## Security and Authorization

### Adapter write authorization

Protected controls:

- control.phaseSetting
- control.maxCurrentA
- control.targetPowerW
- control.remoteStart
- control.remoteStop

Unlock flow:

1. write code to control.authorizeCode
2. adapter unlocks controls until authorizationTimeoutSec
3. optional immediate lock with control.lockControls

### OCPP server access control

Server-side hardening options:

- serverAuthToken: requires query token (?token=...)
- allowedChargePointIds: CP ID allowlist
- TLS/WSS with ocppTlsEnabled + key/cert paths
- request timeout for outbound OCPP calls

## Configuration

### General

- connectionMode: server or bridge
- connectedStatusValues: status values counted as "vehicle connected"

### Server Mode (direct)

- ocppServerHost
- ocppServerPort
- ocppTlsEnabled
- ocppTlsKeyPath
- ocppTlsCertPath
- serverAuthToken
- allowedChargePointIds
- ocppHeartbeatIntervalSec
- ocppRequestTimeoutSec
- ocppPhaseConfigKey
- defaultIdTag
- defaultConnectorId

### Bridge Mode

- connectorStatusStateId
- currentStateId (optional)
- powerStateId (optional)
- phaseReadStateId (optional)
- phaseSetStateId
- currentSetStateId

### Authorization

- requireWriteAuthorization
- authorizationCode
- authorizationTimeoutSec

### Built-in Automation

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

## Power Conversion

When writing targetPowerW:

amps = powerW / (230 * phases)

Current is rounded and clamped to 6..32A.

## OCPP Notes

Implemented OCPP server handling includes common 1.6J core flows:

- BootNotification
- Heartbeat
- StatusNotification
- MeterValues
- StartTransaction
- StopTransaction
- Authorize

Outgoing control calls used by this adapter:

- ChangeConfiguration (phase switching key/value)
- SetChargingProfile (current limit)
- RemoteStartTransaction
- RemoteStopTransaction

## Quick Start (single adapter)

1. Set connectionMode=server
2. Configure host/port and optional TLS
3. Configure zappi/myaccount OCPP backend URI to this server endpoint
4. Set authorizationCode and requireWriteAuthorization=true
5. Test control.remoteStart, control.maxCurrentA, control.phaseSetting

## Installation (local)

```bash
npm install
```

```bash
iobroker add zappi --host this
```
