# Official-app BLE connection state machine (APK reconstruction)

This note separates two concepts that earlier browser prototypes accidentally conflated:

- **official connection readiness** — the Android SDK has completed its handshake/auth/device-info lifecycle and reaches `doConnSuccess` / `onDevConnSuccess`;
- **compatible local print readiness** — the browser can exchange the already cross-validated local print protocol with the printer, even though the official account/server lifecycle has not been reproduced.

The distinction matters for devices that establish GATT successfully but refuse print traffic until additional initialization has occurred.

## Confidence model and Legu limitation

The APK is protected by Tencent Legu. The ten protected DEX streams can be NRV2D-decompressed and retain class, field, method, prototype, string, anonymous-class capture, and debug metadata. Protected method instruction arrays are effectively unavailable/NOP-filled.

Therefore:

- **APK-confirmed** — class/field/method signature, callback surface, captured anonymous-class field, string, or debug source-line metadata recovered from the DEX skeletons.
- **Cross-validated** — the APK metadata agrees with an independent implementation or a byte-exact packet previously validated in this project.
- **Strongly inferred** — ordering/semantics follow from callback structure and captured values but executable Java bytecode is unavailable.
- **Runtime-needed** — a live printer response is still needed before treating the behavior as universal.

Important: encoded `static_values` from the protected `Protocol_A5` class are not reliable in this sample; several decode to values inconsistent with known frame/domain constants. Numeric System command values below are therefore kept only where supported by existing packet/protocol evidence and method semantics, not because the Legu-protected static-value table is trusted.

## GATT connection is only an early transport stage

`com.paperang.libprinter.printer.connect.ble.manage.BleManager` contains its own connection state, `currentDeviceInfo`, `BluetoothGatt`, request queue, MTU state, heartbeat helper, and lifecycle callbacks.

`com.paperang.sdk.client.callback.printer.OnDevConnStatusListener` exposes distinct stages:

```text
onGetDevInfoStart()
onGetDevInfoSuccess(DeviceInfo)
onGetDevInfoFailed(GetDeviceInfoError)
onAuthStart()
onAuthSuccess()
onDeviceShakeFailed()
onDevVerificationFailed(...)
onDevConnSuccess(DeviceInfo, int, String, String)
onDevConnFailed(...)
onDevConnTimeout()
onDeviceDisconnected(int)
```

This directly disproves the earlier assumption that `BluetoothGatt.connect()` + writable characteristic discovery means the printer is application-ready.

## Debug-metadata ordering inside `BleManager`

The recovered DEX debug metadata retains initial Java source lines for protected methods. Relevant methods are ordered as follows:

| Source line | Method |
|---:|---|
| 621 | `connectLeDevice(...)` |
| 972 | `onGattSuccess(BluetoothGatt,int)` |
| 1237 | `deviceAuth(String,String,String,String,OnDeviceAuthResultListener)` |
| 1625 | `netPingPong()` |
| 1984 | `doConnSuccess(int,String,String)` |
| 2135 | `shakeHand()` |
| 2174 | `afterShakeHand(String,String,String,String)` |
| 2202 | `authInServer(String,String,String,String)` |
| 2271 | `afterAuthSuccess(boolean,int,String,String)` |
| 2290 | `queryInfoNecessary(int,String,String)` |
| 2297 | `queryCanCacheInfo(int,String,String)` |
| 2312 | `getSystemDeviceProtocolVersion(int,String,String)` |
| 2326 | `getSystemDeviceType(int,String,String)` |
| 2342 | `getSystemDeviceMaxLen(int,String,String)` |
| 2363 | `getSystemDeviceMaxCache(int,String,String)` |
| 2376 | `getSystemDeviceSN(int,String,String)` |
| 2392 | `getSystemDeviceBattery(int,String,String)` |

Source-line order alone is not a call graph, but combined with anonymous callback captures it strongly supports the lifecycle below.

## Anonymous callback captures reveal the data flow

Recovered anonymous classes include:

- `BleManager$8.onDevHandShakeReceived(String,String,String,String)` — handshake callback.
- `BleManager$6` implements the SW-version receive callback and captures fields named `deviceSN`, `randomCode`, `md5`, and `authCode`.
- `BleManager$7` captures the same four values plus boolean `haCache`; its nested `$7$1` implements `onDeviceAuthSuccess(...)` / `onDeviceAuthFailed(...)`.
- `BleManager$9` and later device-info callbacks propagate `code`, `md5`, and `randomCode` while querying type/max-len/SN/battery/etc.

The APK also contains log text:

```text
随机码+MD5+SN+鉴权码 [
鉴权结果 [
BLE deviceAuth
BLE deviceAuth onSuccess
BLE deviceAuth onFailed --> code:
BLE deviceAuth onNoAuthorizationRequired
```

The four semantic values are therefore high confidence, but **their positional order in the raw handshake TLVs is not yet proven**. The browser diagnostic client intentionally records raw TLV index/tag/text/hex without assigning `field[0] = SN` or another speculative mapping.

## High-confidence official lifecycle

A conservative reconstruction is:

```text
BLE GATT connect
  -> service/characteristic discovery
  -> enable notifications / CCCD
  -> onGattSuccess
  -> shakeHand
  -> afterShakeHand(...four values...)
  -> query software version
  -> cache/auth decision
  -> deviceAuth / authInServer OR an allowed skip path
  -> afterAuthSuccess
  -> queryInfoNecessary / queryCanCacheInfo
  -> protocol version
  -> device type
  -> max data length
  -> max cache
  -> serial number
  -> battery
  -> populate DeviceInfo
  -> doConnSuccess
  -> onDevConnSuccess
  -> heartbeat / netPingPong
  -> official printer-ready state
```

Exact branches for device families and cache hits remain runtime-needed.

## Handshake and System-domain operations

`CommonManager`/`Protocol_A5` expose the following high-value methods:

```text
getSystemDeviceShakeHand(listener)
getSystemDeviceShakeHand_NoParams(listener)
getSystemDeviceSwVersion(listener)
getSystemDeviceProtocolVersion(listener)
getSystemDeviceType(listener)
getSystemDeviceMaxLen(listener)
getSystemDeviceMaxCache(listener)
getSystemDeviceSN(listener)
getSystemDeviceBattery(listener)
setSystemDeviceKey(String, listener)
setSystemDeviceNoticeShakeHand(String, String, listener)
```

Existing project packet evidence supports a System-domain handshake request at `01/17`. A challenge-form packet uses the normal A5 frame plus one TLV carrying a 16-byte challenge:

```text
A5 01 | payload_len_le16 |
01 17 01 13 00 | 01 10 00 | <16-byte challenge> |
crc32(seed=0x35769521) | 5A
```

For the existing regression vector `P4sdFat2pBd0h4mh`:

```text
a5011800011701130001100050347364466174327042643068346d687c3eb3c95a
```

The browser also attempts the APK-confirmed no-parameter handshake method if the challenge form receives no A5 reply.

## Authentication is a server-result → device-verification loop

APK-confirmed request/response models:

```text
DeviceAuthRequest:
  deviceSN
  rcode
  sign
  code

DeviceAuthResponse:
  code
  sign
```

`DeviceClientApi.deviceAuth(DeviceAuthRequest, OnServerDataListener)` exists, and the callback surface includes `onNoAuthorizationRequired()` in addition to success/failure.

The printer side exposes:

```text
setSystemDeviceNoticeShakeHand(String, String, OnDeviceHandShakeResultRecvListener)
OnDeviceHandShakeResultRecvListener.onDevHandShakeResultReceived(boolean)
```

Together with classic-Bluetooth parallel callback metadata, this strongly indicates the full path is:

```text
handshake material
  -> cache / skip-auth decision
  -> server deviceAuth request
  -> DeviceAuthResponse(code, sign) OR no-authorization-required
  -> send server result back to printer via System handshake-result notice
  -> printer returns boolean verification result
  -> afterAuthSuccess
```

The browser intentionally does **not** extract or replay proprietary App credentials, account tokens, embedded app secrets, or attempt to forge this server authorization. A future server integration should use a legitimate documented/user-authorized authentication path if one exists.

## Cache/skip-auth branches

The APK contains:

```text
CommonManager.canSkippAuth(DeviceInfo)
CommonManager.canSkippAuthOnlyByDevice(DeviceInfo)
CacheManager.canSkipAuth(String,String)
CacheManager.canSkipAuthWithoutNet(String,String)
CacheManager.getCacheDeviceInfo(String,String,String)
```

This explains why some devices/pairings may print without a fresh online authorization while a newly paired or different firmware unit may not. The exact cache keys and conditions cannot be reconstructed safely from NOP-filled method bodies and require runtime observation.

## Current browser diagnostic model

The web client now keeps **official** and **compatibility** state separate.

For FF00/A5 it attempts:

```text
GATT
 -> FF00/FF02 discovery
 -> FF01/FF03 notifications
 -> A5 stream reassembly
 -> System 01/17 challenge handshake
 -> fallback 01/17 no-parameter handshake
 -> System SW-version query
 -> mark official auth/cache stage as unresolved (never forge auth)
 -> read-only diagnostics in observed App order:
      protocolVersion -> type -> maxLen -> maxCache -> SN -> battery
 -> separately probe Thermal 05/0F
```

Results are represented as:

- `officialReady` — only true if the official lifecycle is actually reproduced. Current web implementation deliberately leaves this false for A5 server-auth devices.
- `compatReady` — true only if the local Thermal compatibility channel answers the non-printing `05/0F` probe.
- `ready` — browser printing permission; currently follows `compatReady` for FF00/A5.

If official handshake fails, the browser **still performs the independent non-printing Thermal probe**. This distinguishes “official handshake unsupported/required another branch” from “local print transport itself is dead”.

## Diagnostic export

The page can export `paperang-web-diagnostic-v1` JSON containing:

- browser/iOS/WebBLE environment;
- selected profile and characteristic UUIDs;
- each connection stage and status;
- raw BLE RX hex history;
- reassembled A5 frame/domain/command/TLV history;
- handshake mode/challenge and raw ordered TLVs;
- read-only `DeviceInfo` values observed;
- `officialReady`, `compatReady`, and auth-state labels;
- disconnect-time snapshot when the device drops.

It intentionally contains no Paperang account token, APK app secret, or extracted proprietary credential. Device responses can contain a printer serial number, so exported logs should be treated as device-identifying diagnostic data.

## Remaining runtime questions

A capture from the user's unit is now the highest-value next input. It can resolve:

1. whether the unit answers challenge or no-parameter `01/17`;
2. the exact raw TLV order/tag mapping of handshake values;
3. whether an authenticated/cached path is mandatory before Thermal commands;
4. whether `setSystemDeviceNoticeShakeHand(code,sign,...)` is mandatory for this unit;
5. the actual protocol/version returned after auth;
6. whether the FF00 profile is really its print path or only a management channel;
7. disconnect timing and the last accepted command before link teardown.
