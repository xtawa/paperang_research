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
- desktop path normally sends 10 full rows / 480 payload bytes per protocol frame; iOS/WebBLE mode uses smaller 3-row frames and slower writes

On connect, the web app writes the cross-validated fixed CRC registration frame:

```text
0218000400219576351cdf442103
```

It then uses the same seed for subsequent frames.

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
P1 CRC registration: 0218000400219576351cdf442103
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
