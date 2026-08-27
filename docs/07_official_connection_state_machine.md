# Official-app BLE connection state machine (APK reconstruction)

This note narrows the gap between the earlier raw-print interoperability path and the connection lifecycle implemented by the current Android APK.

## Confidence model

The APK is protected by Tencent Legu. The ten protected DEX streams can be decompressed and their DEX metadata is intact, but protected method instruction arrays are zeroed/NOP-filled. Therefore:

- **APK-confirmed** means class/field/method signature or encoded static constant is directly present in recovered DEX metadata.
- **Strongly inferred** means ordering is reconstructed from callback classes, captured anonymous-class fields, matching method signatures, and public packet evidence, but not from executable Java bytecode.
- **Runtime-needed** means a live device capture is still required before treating behavior as universal.

## `BleManager` does not equate GATT with printer-ready

`com.paperang.libprinter.printer.connect.ble.manage.BleManager` contains its own `isConnected` state, a request queue, a heartbeat helper, current `DeviceInfo`, and separate callbacks for physical/device lifecycle.

The public SDK callback `OnDevConnStatusListener` exposes distinct stages:

- `onGetDevInfoStart()`
- `onGetDevInfoSuccess(DeviceInfo)`
- `onGetDevInfoFailed(GetDeviceInfoError)`
- `onAuthStart()`
- `onAuthSuccess()`
- `onDeviceShakeFailed()`
- `onDevVerificationFailed(...)`
- `onDevConnSuccess(DeviceInfo, int, String, String)`
- `onDevConnFailed(...)`
- `onDevConnTimeout()`

This is direct evidence that a successful Android `BluetoothGatt.connect()` is only an early transport stage.

## High-confidence lifecycle

The following `BleManager` methods are APK-confirmed:

```text
connectLeDevice(...)
onGattSuccess(...)
shakeHand()
afterShakeHand(String, String, String, String)
deviceAuth(String, String, String, String, OnDeviceAuthResultListener)
authInServer(String, String, String, String)
afterAuthSuccess(boolean, int, String, String)
queryInfoNecessary(int, String, String)
queryCanCacheInfo(int, String, String)
doConnSuccess(int, String, String)
netPingPong()
pausePingPong()
```

The callback structure gives additional ordering evidence:

- `BleManager$8.onDevHandShakeReceived(String,String,String,String)` is the normal handshake callback.
- `BleManager$6.onDevSwVersionReceived(...)` captures `deviceSN`, `randomCode`, `md5`, and `authCode`.
- `BleManager$7` is a `TimeoutHelper` capturing those same four values plus `haCache`; its nested callback implements `OnDeviceAuthResultListener`.
- later callbacks for device type, max length, SN, battery, protocol version, and max cache carry the `(code, md5, randomCode)` values used by `queryInfoNecessary(...)` / `doConnSuccess(...)`.

A conservative reconstruction is therefore:

```text
GATT connect
  -> service/characteristic discovery
  -> enable notifications
  -> onGattSuccess
  -> shakeHand
  -> get SW version
  -> deviceAuth / authInServer (or an allowed skip path)
  -> queryInfoNecessary / queryCanCacheInfo
  -> populate DeviceInfo
  -> doConnSuccess
  -> heartbeat/ping-pong
  -> printer ready
```

Some exact branch ordering remains runtime-needed because protected method bodies are unavailable.

## A5 System handshake is `01/17`

`Protocol_A5` encoded static constants recover exactly as:

```text
data_function_parent_system              = 0x01
data_system_child_req_shake_hand         = 0x17
data_system_child_set_dev_key            = 0x18
data_system_child_notice_shake_hand_result = 0x1F
MM_SYS_GET_PROTOCOL_VER                  = 0x15
```

The SDK exposes both:

```text
getSystemDeviceShakeHand(listener)
getSystemDeviceShakeHand_NoParams(listener)
setSystemDeviceKey(...)
setSystemDeviceNoticeShakeHand(...)
```

A challenge-form handshake uses the already-established A5 frame and TLV conventions:

```text
A5 01 | payload_len_le16 |
01 17 01 13 00 | 01 10 00 | <16 ASCII challenge> |
crc32(seed=0x35769521) | 5A
```

For challenge `P4sdFat2pBd0h4mh`, the byte-exact frame is:

```text
a5011800011701130001100050347364466174327042643068346d687c3eb3c95a
```

The CRC is independently reproducible.

## Read-only System queries recovered from APK constants

Useful System-domain request command values include:

| Purpose | Domain/command |
|---|---|
| Device info | `01/01` |
| Serial number | `01/02` |
| Software version | `01/07` |
| Product/model | `01/08` |
| Battery | `01/0B` |
| Max data length | `01/14` |
| Protocol version | `01/15` |
| Shake hand | `01/17` |
| Set device key | `01/18` |
| Handshake-result notice | `01/1F` |
| Max package/cache count | `01/20` |

`DeviceInfo` independently contains `devSN`, `devType`, `devVersion`, `devMaxLen`, `devMaxCache`, `protocol`, and `protocolVersion`, consistent with these queries.

## Device authorization

The APK exposes:

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

`BleManager.deviceAuth(...)` takes four strings; the handshake callback names those captured values as `deviceSN`, `randomCode`, `md5`, `authCode`. This strongly suggests the request mapping:

```text
deviceSN <- deviceSN
rcode    <- randomCode
sign     <- md5
code     <- authCode
```

The SDK also contains route string `/api/device/auth`. `MBHttpConfig.RELEASE_BASE_URL` is `https://mo.paperang.com/` and the network layer contains access-token/app identity fields. The web client deliberately does **not** forge or bypass this server authorization. A live device may use an auth-skip path (`CommonManager.canSkippAuth*`) or may require official server/account state.

## Why the first web readiness probe could falsely fail on iOS

The APK has `ProtocolParser` stream state and temporary bytes, showing that transport reads are not packet boundaries. The earlier web implementation called `parseA5Frame()` directly on each BLE notification. That fails whenever CoreBluetooth/Bluefy delivers one A5 response as multiple notification fragments.

The web client now has an `A5StreamParser` that:

1. accumulates arbitrary notification fragments;
2. searches for `A5 01` sync;
3. reads the little-endian payload length;
4. waits until the whole frame is buffered;
5. validates tail and seeded CRC32;
6. emits complete frames;
7. supports multiple frames in a single notification;
8. ignores unrelated short BLE status notifications.

Queries now match replies by A5 `domain + command`, rather than accepting the first arbitrary A5 packet.

## Current web diagnostic sequence

For FF00/A5 devices the browser now attempts:

```text
BLE GATT
 -> FF00 / FF02 profile discovery
 -> subscribe FF01 / FF03 notifications
 -> A5 stream reassembly enabled
 -> System 01/17 challenge handshake
 -> fallback: System 01/17 no-parameter handshake
 -> System 01/07 SW version
 -> identify whether handshake exposes auth material
 -> read-only queries: type, maxLen, SN, battery, protocolVersion, maxCache
 -> Thermal 05/0F non-printing readiness probe
 -> only then enable Print
```

If the handshake succeeds but auth material is returned, the UI marks server auth as not reproduced instead of pretending the official `onDevConnSuccess` state was reached.

## Remaining runtime questions

A capture from a failing/working device is still needed to determine:

1. exact TLV tag-to-field mapping of the four handshake callback strings;
2. which device/firmware families call the no-parameter handshake variant;
3. exact `canSkippAuth` conditions;
4. whether server auth is mandatory for the user's unit or only for binding/cloud features;
5. whether `01/1F` is required before thermal printing on authenticated devices;
6. exact protocol-selection behavior for devices exposing FF00 but ultimately using 02/07/17 or another transport.
