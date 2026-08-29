# 05 — Web printer implementation

The repository root `index.html` is a dependency-free Web Bluetooth printer UI. The current production build is deployed at `https://paperang-research.vercel.app`.

## Supported paths

### P1 / Protocol 0x02

- raster width: 384 px / 48 bytes per row
- service: `49535343-fe7d-4ae5-8fa9-9fafd205e455`
- known write characteristics:
  - `49535343-6daa-4d02-abf6-19569aca69fe` (historical WebBLE implementation)
  - `49535343-8841-43f4-a8d4-ecbe34729bb3` (newer physically validated implementation)
- notify: `49535343-1e4d-4bd9-ba61-23c647249616`
- protocol: `02 | cmd | index | lenLE16 | payload | CRC32LE | 03`
- CRC seed: `0x35769521`
- raster: black=1, white=0, MSB first
- desktop path sends 10 full rows / 480 payload bytes as one complete 490-byte Protocol 02 frame; iOS/WebBLE mode uses smaller 3-row frames and slower writes

The browser treats `8841` as the primary transparent Protocol 02 data path.
When `8841` is present, Protocol 02 probes are not sent to `6DAA`: the ISSC
controller documents `6DAA` as a connection-parameter characteristic, while
`8841` is the transparent RX path. `6DAA` remains a legacy fallback for devices
that do not expose `8841`. The probe sends `GET_VERSION` with payload `01` and
the standard seed, explicitly trying `writeValueWithoutResponse`,
`writeValueWithResponse`, then legacy `writeValue` on each eligible path.
Response notifications are parsed as a stream, so a response may be fragmented
across notifications or contain multiple frames.

If `8841` accepts direct writes but does not return a verified Protocol 02
frame, the browser automatically writes `SET_CRC_KEY` on that same
characteristic, switches to the public session key, and retries `GET_VERSION`.
If the retry is also write-only, the UI retains the session-CRC path as
`session-registered-unverified`; it does not mistake a successful GATT Promise
for a verified printer response.

The default P1 print job mirrors the public WebBLE reference as a conservative
bring-up path: set density separately, send `0x00` raster chunks, then finish
with `0x1a` using a one-byte feed payload. The browser does not inject `0x22`
default-parameter or `0x2c` paper-type frames into the P1 path until those
commands are physically confirmed for the connected firmware. If session CRC
registration is selected, it changes the CRC seed for subsequent frames but
does not add unverified setup commands.

### P1 adaptation selector

The Advanced settings panel exposes both the P1 transport adapter and the ATT
write method. They take effect on the next connection and are included in the
diagnostic JSON under `p1.adapter` and `p1.writeMode`.

| Adapter | Selection rule | Session CRC |
| --- | --- | --- |
| Auto (default) | `8841` first; historical `6DAA` only if `8841` is absent | automatic after a write-only `8841` probe |
| `8841` session CRC | only `8841` | automatic after a write-only probe |
| `8841` standard CRC | only `8841` | disabled |
| Public WebBLE `6DAA` direct | only `6DAA`; auto-selects `writeValue`; no connection probe or density warm-up | disabled |
| Historical `6DAA` | only `6DAA` | disabled |
| Compatibility sweep | `8841`, other writable candidates, then explicit `6DAA` | automatic on `8841` |

The `6DAA` options are deliberately labelled historical/compatibility modes:
the ISSC characteristic definition identifies it as connection-parameter
control, not the transparent printer data channel. They exist to reproduce
older WebBLE implementations without changing the safe default.

The **Public WebBLE `6DAA` direct** option is stricter than the historical
probe mode. It reproduces the connection/print behavior of
[`Yrr0r/paperang-web`](https://github.com/Yrr0r/paperang-web): select `6DAA`,
use the browser `writeValue` method, keep the standard CRC seed, and do not
send `GET_VERSION`, `SET_CRC_KEY`, or an automatic `SET_DENSITY` during
connection. Its first protocol write is therefore the user-triggered
`PRINT_DATA` or `SELF_TEST` command. The UI marks this path as armed but does
not call it physically verified until the printer produces output.

For this adapter, raster chunks use the public reference's maximum of 480
bytes (10 P1 rows), including on iOS; the reference leaves each Protocol 02
`packetIndex` at zero. The general `8841` path keeps its iOS 3-row/18 ms
 pacing and incrementing packet indexes.

The session-key vector is:

```text
0218000400787ace332c8980f003
```

and switches subsequent CRCs to the negotiated session key. The browser does
this explicitly when the automatic `8841` fallback or a diagnostic action
selects the session path.

Protocol 02 P1 frames up to 512 bytes are attempted as one GATT write. This is
important for the 490-byte desktop raster frame: splitting it at the generic
237-byte A5 budget would turn one printer frame into invalid protocol data. The
[Web Bluetooth specification](https://webbluetoothcg.github.io/web-bluetooth/)
defines a 512-byte maximum attribute value; individual devices/backends can
still impose a smaller effective write limit.

### P2 / FF00 + A5

Cross-validated against a 2026 implementation reporting physical validation on Windows:

- raster width: 576 px / 72 bytes per row
- service `0000ff00-0000-1000-8000-00805f9b34fb`
- notify `ff01`
- write `ff02`
- status notify `ff03`
- frame: `A5 01 | lenLE16 | payload | CRC32LE | 5A`
- CRC seed: `0x35769521`

Print sequence implemented by the site:

```text
status       payload 05 0F 01 00 00 00
start raster payload 05 19 01 00 00
print chunks domain 05 / command 1B
finish       payload 05 22 01 02 00 00 00
```

A5 raster chunks are row-aligned. With 72 bytes per row, a 237-byte frame budget and 26 bytes of framing/command overhead yield 144 bytes (= 2 rows) of raster per A5 packet.

## Image pipeline

The UI performs all processing locally:

1. decode image with `createImageBitmap`;
2. rotate and fit/center to the target head width;
3. flatten alpha against white;
4. luminance conversion;
5. brightness/contrast adjustment;
6. fixed threshold, Floyd–Steinberg, or Atkinson dithering;
7. black=1 / white=0 conversion;
8. MSB-first packing into 48-byte (P1) or 72-byte (P2) rows.

No image is uploaded by the web app.

## Browser support

Web Bluetooth is available in Chromium-family desktop browsers and Android Chrome/Samsung Internet, but not native Safari on iOS/iPadOS or Firefox. It is also restricted to secure contexts, so serve the repository via HTTPS (for example GitHub Pages) rather than opening `index.html` as a local file.

## Validation

Run the pure protocol/raster tests without a printer:

```bash
npm test
```

The suite fixes two important regression vectors:

```text
P1 direct WebBLE self-test: 021b0001000046895e9e03
P1 opt-in session registration: 0218000400787ace332c8980f003
P2 A5 start frame:   a5010500051901000039cb63a65a
```

Hardware validation still matters because Paperang has shipped different Bluetooth profiles across model/hardware revisions.


## Official vs compatible readiness

The current Android APK does not treat `BluetoothGatt.connect()` as printer-ready. Recovered SDK metadata shows a multi-stage lifecycle involving System handshake, software-version retrieval, cache/auth decisions, device information, final `doConnSuccess`, and heartbeat startup. See [`07_official_connection_state_machine.md`](07_official_connection_state_machine.md).

The web UI therefore displays two independent concepts:

- **Official ready** — the SDK's full authenticated `onDevConnSuccess` lifecycle has been reproduced. The browser currently does not claim this for server-auth A5 devices.
- **Compat ready** — a non-printing local Thermal `05/0F` probe receives a valid A5 response. Printing is enabled only from this compatibility state.

If `01/17` official handshake fails, the browser still performs the independent Thermal probe. This is diagnostic: failure of the official handshake does not automatically prove the local print protocol is unusable.

## Connection diagnostic JSON

The UI can export a `paperang-web-diagnostic-v1` JSON report containing stage status, characteristic UUIDs, raw BLE RX hex, reassembled A5 frames, ordered handshake TLVs, read-only device information, and a disconnect-time snapshot. It deliberately excludes Paperang account tokens, extracted APK app secrets, or other proprietary credentials. Printer responses can include a device serial number.

## P1 diagnostic controls

For a connected `Paperang_P1`, the diagnostics panel exposes:

1. `GET_VERSION`, `GET_SN`, and `GET_BATTERY` probes with verified CRC parsing;
2. a `P1 8 行黑条` action that sends 8 rows × 48 bytes of `0xff` raster;
3. an exportable report containing the selected write characteristic, reported
   properties, ordered UUID/method probe attempts, selected write method,
   frame-preservation status, and recent full TX/RX frames.

If the printer produces no paper, export the report before disconnecting. The
key fields are `p1.probe`, `connection.writeCharacteristic`,
`connection.lastWriteMethod`, and `p1.txHistory[*].framePreserved`.
