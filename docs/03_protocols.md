# 03 — Protocol families and packet formats

## 1. Protocol selection

The current `com.paperang.libprinter` metadata explicitly contains four protocol implementations:

| implementation | head | tail | status |
|---|---:|---:|---|
| `Protocol_02` | `0x02` | `0x03` | frame format and many commands reconstructed |
| `Protocol_07` | `0x07` | `0x03` | framing confirmed, detailed payload pending |
| `Protocol_A5` | `0xA5` | `0x5A` | hierarchical command namespace visible |
| `Protocol_17` | `0x17` | not yet statically recovered | newer print state machine visible |

The parent `Protocol` parser identifies the active family from the stream head and dispatches data accordingly.

---

## 2. Protocol 0x02

### 2.1 Frame markers — APK-confirmed

Static values in `Protocol_02`:

```text
frame_head = 0x02
frame_tail = 0x03
```

### 2.2 Frame layout — cross-validated

Independent Paperang implementations use:

```text
offset  size  field
0       1     0x02
1       1     command
2       1     packet index
3       2     payload length, little-endian
5       N     payload
5+N     4     CRC32(payload, key), little-endian
9+N     1     0x03
```

Equivalent Python:

```python
struct.pack("<BBBH", 0x02, command, packet_index, len(payload))
+ payload
+ struct.pack("<I", zlib.crc32(payload, crc_key) & 0xffffffff)
+ b"\x03"
```

See [`../tools/protocol02.py`](../tools/protocol02.py).

### 2.3 CRC key — APK-confirmed

The current APK's `CRC32Util` static metadata contains:

```text
standardKey = 896963873 = 0x35769521
crcKey      = 0 initially
```

`CRC16Util` carries the same standard-key value, indicating the value is a shared transport/protocol seed rather than an accidental constant.

This reproduces the fixed-standard registration frame used as a historical
vector:

```text
02 18 00 04 00 21 95 76 35 1c df 44 21 03
```

Breakdown:

```text
02           frame head
18           PRT_SET_CRC_KEY
00           packet index
04 00        payload length = 4
21 95 76 35  payload = 0x35769521 little-endian
1c df 44 21  seeded CRC32 = 0x2144df1c little-endian
03           frame tail
```

Reproduction:

```python
>>> import zlib
>>> hex(zlib.crc32(bytes.fromhex("21957635"), 0x35769521) & 0xffffffff)
'0x2144df1c'
```

Some classic SPP/Bleak clients negotiate a session key instead. For
`session_key = 0x06b8ef59`, they send `session_key XOR standardKey` as the
four-byte payload, producing:

```text
0218000400787ace332c8980f003
```

The browser's default P1 WebBLE path does not send either registration frame;
it uses the standard seed directly. Registration is exposed as an explicit
diagnostic operation for firmware variants that require it.

### 2.4 Command table — APK-confirmed

The current APK contains 98 static `Protocol_02$Command` constants. The complete generated table is in [`../evidence/protocol_02_commands.csv`](../evidence/protocol_02_commands.csv).

Key printing/control entries:

| command | value | meaning |
|---|---:|---|
| `PRT_PRINT_DATA` | `0x00` | raster/print data |
| `PRT_FIRMWARE_DATA` | `0x02` | firmware data |
| `PRT_GET_VERSION` | `0x04` | firmware/version query |
| `PRT_SENT_VERSION` | `0x05` | version response |
| `PRT_GET_SN` | `0x0A` | serial number query |
| `PRT_SENT_SN` | `0x0B` | serial number response |
| `PRT_SENT_STATUS` | `0x0D` | status response |
| `PRT_GET_BAT_STATUS` | `0x10` | battery query |
| `PRT_SENT_BAT_STATUS` | `0x11` | battery response |
| `PRT_SET_CRC_KEY` | `0x18` | CRC key registration |
| `PRT_SET_HEAT_DENSITY` | `0x19` | print heat/density |
| `PRT_FEED_LINE` | `0x1A` | paper feed |
| `PRT_PRINT_TEST_PAGE` | `0x1B` | self-test print |
| `PRT_SET_POWER_DOWN_TIME` | `0x1E` | set auto-off time |
| `PRT_GET_POWER_DOWN_TIME` | `0x1F` | query auto-off time |
| `PRT_SENT_POWER_DOWN_TIME` | `0x20` | auto-off response |
| `PRT_FEED_TO_HEAD_LINE` | `0x21` | feed to print head line |
| `PRT_SET_MAX_GAP_LENGTH` | `0x27` | gap/label-related parameter |
| `PRT_SET_PAPER_TYPE` | `0x2C` | paper type |
| `PRT_DISCONNECT_BT_CMD` | `0x2F` | Bluetooth disconnect command |
| `PRT_GET_PRINTER_MODEL` | `0x30` | printer model query |
| `PRT_SET_PRINT_SPEED` | `0x39` | print speed |
| `PRT_GET_LABEL_NUM` | `0x3C` | label count query |
| `PRT_SET_PAPER_LEARN` | `0x3E` | paper calibration/learning |
| `PRT_SET_CACHE_TIME` | `0x3F` | cache timing |
| `PRT_SET_PAPER_PIECE` | `0x40` | paper piece/count setting |
| `PRT_SET_BINARY_TREE_PARAMETERS` | `0x41` | device-side parameter |
| `PRT_GET_BT_MODEL` | `0x42` | Bluetooth module model |

The new APK has extended the original 0x00–0x30-era command set considerably with alarms, time/tomato features, printer identity, and other device functions.

### 2.5 Print raster data

Public P1 interoperability implementations show a 384-dot head:

```text
384 pixels / 8 = 48 bytes per raster row
```

Each bit represents a dot. The P1 WebBLE implementation uses black=`1`, white=`0`, MSB-first packing within a byte and splits image payloads on complete rows. It selects a 480-byte payload block (10 × 48-byte rows) to avoid tearing across incomplete lines.

The current APK independently contains:

- bitmap→byte-array processing
- `sendImageBytes_Paperang`
- `sendUniPrintData_Paperang`
- `sendMultiPrintData_Paperang`
- `splitDataByContentLength`
- MTU-aware send paths

so this raster/chunk architecture is consistent with the current app even though exact widths vary by model.

---

## 3. Protocol 0x07

APK static metadata:

```text
frame_head = 0x07
frame_tail = 0x03
```

Methods:

```text
isRightData
parse
```

The app groups `0x02` and `0x07` together in multiple method names:

```text
sendCRCKey_0207
registerCrcKey_0207
checkIfCanSendCommand_0207
sendCommand_0207
sendData_Pro0207
sendFeedLine_02_07
sendSelfTest_02_07
```

This strongly suggests 0x07 is a related generation sharing significant command/transport machinery with 0x02 while using a different packet head and/or validation rule.

---

## 4. Protocol 0xA5 / 0x5A

Static framing:

```text
frame_head = 0xA5
frame_tail = 0x5A
```

Unlike protocol 0x02's mostly flat command byte table, A5 exposes a hierarchical namespace with parent/child functions. Thermal-printer commands visible in static metadata include:

```text
data_function_parent_thermalprinter       = 0x05
data_thermal_child_get_print_voltage      = 0x08
data_thermal_child_get_print_temperature  = 0x0A
data_thermal_child_get_print_heat_density = 0x10
data_thermal_child_set_print_heat_density = 0x11
data_thermal_child_get_print_sensitivity  = 0x12
data_thermal_child_set_print_sensitivity  = 0x13
data_thermal_child_get_print_speed        = 0x14
data_thermal_child_set_print_speed        = 0x15
data_thermal_child_print_qr_code          = 0x18
data_thermal_child_ctrl_print_start       = 0x19
data_thermal_child_ctrl_print_end         = 0x1A
data_thermal_child_ctrl_print_data        = 0x1B
```

Methods include:

```text
packData
printData_Prefix
printStart
printFinish
grayPrintStart / grayPrintEnd
getTpPrintDensity / setTpPrintDensity
getTpPrintSensitivity / setTpPrintSensitivity
```

This family is used by newer/more capable devices and contains non-print domains as well (system, networking, audio, health/eye-protection, file transfer, word-book functions, NFC/tag functions).

---

## 5. Protocol 0x17

Static metadata gives:

```text
frame_head = 0x17
```

and a print-handshake vocabulary:

```text
req_print_head_18 = 0x18
req_print_head_19 = 0x19
req_print_head_1A = 0x1A
req_print_head_1B = 0x1B
req_print_head_1C = 0x1C
req_print_head_1D = 0x1D
resp_imready      = 0x4E  # 'N'
resp_recvall      = 0x44  # 'D'
resp_retryit      = 0x52  # 'R'
```

Methods:

```text
packData_17
packDataPrint_17
reqPrintImage
sendPrintImage
getDeviceInfo
getBatLevel
getPrintDirection
getPrintParams
washPrintHead
```

Error/status values include explicit CRC, MCU-MD5, packet-length/value, command, initialization, and print-status errors. This looks more transaction-oriented than the simple 0x02 raster stream and likely has explicit readiness/retry semantics.

The exact binary layout remains an open item because the implementation body is still protected.

---

## 6. Response parsing

The current library has both:

```text
Protocol.receiveData / analyseData / dispatchData
ProtocolParser.tmpBytes
ResponseDataParseUtil
```

and many transport callbacks (`onBatteryLevelReceived`, `onDeviceStatusReceived`, `onCrcKeyReceived`, `onPrinterIsIDLE`, etc.). In other words, the app treats the connection as a bidirectional stream and reconstructs frames across arbitrary Bluetooth/GATT read boundaries.

For protocol 0x02, `tools/protocol02.py::unpack_frame` implements the verified basic frame boundary/CRC check; higher-level response payload semantics should be handled command by command.

## Public cross-validation sources

- `createskyblue/paperang-miaomiaoji-tool-gen2` packet builder and commands:
  https://github.com/createskyblue/paperang-miaomiaoji-tool-gen2
- `Yrr0r/paperang-web` P1 WebBLE implementation:
  https://github.com/Yrr0r/paperang-web
- `python-paperang` lineage for historical P1/P2 raster control:
  https://github.com/shafr/python-paperang
