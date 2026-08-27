# 06 — 2026 protocol cross-validation and hardware variants

This note records newer independent evidence found after the first APK-only pass.

## P1 BLE characteristic variants

Two independent public implementations use the same proprietary `49535343-fe7d-4ae5-8fa9-9fafd205e455` service and the same notification characteristic, but different write characteristics:

| source | write characteristic |
|---|---|
| historical browser implementation | `49535343-6daa-4d02-abf6-19569aca69fe` |
| current `paperang-cli` P1 driver | `49535343-8841-43f4-a8d4-ecbe34729bb3` |

The web client therefore enumerates the service and supports both, falling back to any characteristic whose GATT properties report write/write-without-response.

The current P1 driver also cross-validates:

- seed `0x35769521`
- `02 ... 03` frame format
- Bluetooth command numbers recovered from the APK
- 384 px head
- post-connect density/status queries

## P2 is not one transport family

Public P2 research is inconsistent only if every P2 is assumed to be identical. Current evidence supports multiple hardware/firmware variants:

1. some P2 paths expose classic Bluetooth SPP / RFCOMM;
2. a physically validated P2 variant advertising `Paperang_P2` exposes BLE `FF00` and uses A5 frames;
3. older/other software also referenced Nordic UART BLE profiles.

This matches the analyzed APK, which contains classic `BluetoothSocket`, BLE managers, multiple UUID families, and four protocol classes rather than a single hard-coded transport.

## FF00/A5 details now independently reproduced

The 2026 FF00 implementation provides exact values that align with the APK's `Protocol_A5` static metadata:

```text
service        0000ff00-0000-1000-8000-00805f9b34fb
notify         0000ff01-0000-1000-8000-00805f9b34fb
write          0000ff02-0000-1000-8000-00805f9b34fb
status notify  0000ff03-0000-1000-8000-00805f9b34fb
frame prefix   A5 01
frame suffix   5A
CRC seed       35769521
```

Exact packet structure:

```text
A5 01
len_le16
payload
crc32_le(payload, seed=0x35769521)
5A
```

Inner command payload:

```text
domain | command | kind | args_len_le16 | args
```

This explains why APK metadata names a thermal-printer parent domain `0x05` and child functions such as `0x19` start and `0x1B` print data.

## P2 RawBT-style raster payload

For print data (`domain 05`, command `1B`), current validated prior art uses:

```text
chunk_no_le16
(chunk_len + 8)_le16
01
width_bytes
00 00 00 00
chunk_len_le16
raster...
```

The command `kind` is `0x01` for intermediate chunks and `0x03` for the final chunk.

For 576 px P2:

```text
width_bytes = 72
max frame = 237
print-data frame overhead = 26
max raster <= 211
row aligned chunk = floor(211/72)*72 = 144 bytes = 2 rows
```

## Remaining unknowns

- exact model → protocol/UUID mapping for every printer in the current Android APK;
- semantics of all Protocol_07 and Protocol_17 packet fields;
- whether every P1 firmware accepts both known write characteristics;
- whether A5 `FF00-C243-40B9-AC41-A10BA3AD5D1A` and `AE00` families correspond to additional Paperang hardware generations;
- exact grayscale multi-pass/rank encoding used by the official app.

The web app therefore probes services/characteristics instead of assigning protocol solely by advertised device name.
