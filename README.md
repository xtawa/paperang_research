# Paperang printer protocol research

Reverse-engineering notes for a recent `cn.paperang.mm.apk`, focused on **how the Android app discovers, connects to, frames data for, and prints through Paperang / 喵喵机 devices**.

This repository contains reproducible analysis scripts, protocol constants recovered from the APK, and a practical protocol-0x02 tutorial. It deliberately does **not** redistribute the proprietary APK, decrypted application DEX files, or native binaries.

## Main findings

1. **The APK is protected by a Tencent-Legu-style shell (`libshella-4.6.2.2.so`).** The visible DEX files are only tiny shell stubs. The protected asset `assets/0OO00l111l1l` contains ten NRV2D-compressed DEX skeletons. They can be recovered without executing the app, but protected method instructions remain NOP-ed.
2. **The current app ships at least two printer stacks.** The newer one is under `com.paperang.libprinter`; an older compatibility layer exists under `com.paperang.lib.print`.
3. **The current printer library supports multiple local transports:** classic Bluetooth (`BluetoothSocket` + stream thread), BLE/GATT (`BleManager`, MTU-aware writes, notification handling), and Wi-Fi/TCP for supported models.
4. **Four protocol families are explicitly present:** `0x02`, `0x07`, `0xA5`, and `0x17`.
   - `Protocol_02`: head `0x02`, tail `0x03`
   - `Protocol_07`: head `0x07`, tail `0x03`
   - `Protocol_A5`: head `0xA5`, tail `0x5A`
   - `Protocol_17`: head `0x17`
5. **Protocol 0x02 is sufficiently reconstructed to reproduce frames.** The app's static metadata confirms commands including:
   - print data `0x00`
   - battery query `0x10`
   - register CRC key `0x18`
   - set density `0x19`
   - feed line `0x1A`
   - power-down set/get `0x1E/0x1F`
6. **CRC32 seed:** `0x35769521`. This independently explains the known registration packet:

   ```text
   02 18 00 04 00 21 95 76 35 1c df 44 21 03
   ```

   The CRC over payload `21 95 76 35` with seed `0x35769521` is `0x2144df1c`, serialized little-endian as `1c df 44 21`.
7. **Printing is client-side raster printing, not Android's generic print service.** The app has bitmap-to-byte processing, threshold/grayscale paths, normal + 4/8/12/16-rank grayscale modes, then device/protocol-specific splitting and transport sending.

## Web printer

A working browser printer is included at the repository root: [`index.html`](index.html). Serve the repository through HTTPS (GitHub Pages is suitable), open it in Chrome/Edge or Android Chromium, upload an image, connect the printer, tune the binary preview, and print directly over Web Bluetooth.

The web client auto-detects two independently supported paths:

- **P1 / Protocol 0x02** — 384 px, `49535343...` GATT service, both known write-characteristic variants.
- **P2 / FF00 + A5** — 576 px, `FF02` write + `FF01/FF03` notify, A5 raster packet sequence.

It includes threshold, Floyd–Steinberg and Atkinson conversion, rotation, width scaling, density, post-print feed, binary export, RX logging, and row-aligned protocol chunking. All image processing stays local in the browser. See [`docs/05_web_printer.md`](docs/05_web_printer.md) and [`docs/06_protocol_cross_validation_2026.md`](docs/06_protocol_cross_validation_2026.md).

Run browser-protocol unit tests with:

```bash
npm test
```

## Repository map

- [`docs/01_sample_and_packer.md`](docs/01_sample_and_packer.md) — sample provenance, shell, and DEX recovery
- [`docs/02_printer_stack.md`](docs/02_printer_stack.md) — connection/printing architecture reconstructed from APK metadata
- [`docs/03_protocols.md`](docs/03_protocols.md) — protocol families, commands, frame format, CRC
- [`docs/04_reproduction.md`](docs/04_reproduction.md) — hands-on protocol and P1 BLE tutorial
- [`docs/05_web_printer.md`](docs/05_web_printer.md) — Web Bluetooth printer implementation
- [`docs/06_protocol_cross_validation_2026.md`](docs/06_protocol_cross_validation_2026.md) — newer P1/P2 hardware/protocol evidence
- [`evidence/apk_fingerprints.md`](evidence/apk_fingerprints.md) — hashes and exact sample structure
- [`evidence/protocol_02_commands.csv`](evidence/protocol_02_commands.csv) — 98 command constants recovered from current APK metadata
- [`tools/protocol02.py`](tools/protocol02.py) — frame/CRC implementation
- [`tools/ble_probe.py`](tools/ble_probe.py) — enumerate a device's actual GATT layout before sending data
- [`tools/ble_p1_example.py`](tools/ble_p1_example.py) — experimental P1 image printing example based on public P1 UUID evidence
- [`tests/web_protocol.test.mjs`](tests/web_protocol.test.mjs) — P1/A5/raster regression tests

## Confidence labels used in the research

- **APK-confirmed:** directly recovered from this APK's DEX/static/native metadata.
- **Cross-validated:** APK evidence agrees with an independent public implementation.
- **Public prior art:** useful for reproduction but not uniquely attributable to this APK/version.
- **Hypothesis:** reverse-engineering lead that still needs runtime capture/dump before treating it as protocol truth.

## Quick verification

```bash
npm test
python tools/protocol02.py
```

Expected registration frame:

```text
0218000400219576351cdf442103
```

For the full workflow, continue with [`docs/04_reproduction.md`](docs/04_reproduction.md).

## Scope / legal note

This project documents interoperability behavior and research artifacts. It does not contain the proprietary Paperang APK or recovered executable application code. Use the protocol against hardware you own or are authorized to test.
