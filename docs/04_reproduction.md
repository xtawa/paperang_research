# 04 — Reproduction / interoperability tutorial

This tutorial separates **protocol framing** from **transport**. That distinction matters because the APK supports several device generations and multiple Bluetooth UUID families.

## Step 1 — Confirm you have the same APK sample (optional)

```bash
sha256sum cn.paperang.mm.apk
```

Expected for this research sample:

```text
c95e182413f9440e61ca072b20c8842eb6602a4d62fc728139de041dcee2e70a
```

If your APK differs, command tables may have changed.

---

## Step 2 — Recover metadata DEX skeletons

The protected asset still follows the old Legu outer table closely enough that all ten DEX payloads can be NRV2D-decompressed after skipping the 16-byte wrapper that precedes each recovered `dex\n035\0` body. The APK fingerprint and per-DEX compressed/uncompressed lengths are recorded in [`../evidence/apk_fingerprints.md`](../evidence/apk_fingerprints.md).

The public Quarkslab `legu_unpacker_2019` project is useful as a structural reference, but its full 4.1.x method-bytecode restoration **does not work unchanged on this 4.6.2.2 shell**. For this sample, use its container/Kaitai and NRV knowledge as reference only, or recover the outer DEX streams with any NRV2D implementation and then analyze the resulting metadata DEXes with JADX/androguard/dexdump.

The key sanity check is that each decompressed stream has a valid DEX header at offset 16 and the DEX file size matches the outer table's recorded uncompressed size after removing that wrapper. Protected method bodies remain NOP-filled; static strings, class names, field constants, signatures, and much of the printer architecture are still recoverable.

See [`../evidence/legu46_native_notes.md`](../evidence/legu46_native_notes.md) for the newer shell crypto lead and why the 2019 XTEA restoration should not be presented as a working 4.6.2.2 decryptor.

---

## Step 3 — Verify protocol 0x02 locally, with no printer

```bash
python tools/protocol02.py
```

Expected first line:

```text
0218000400219576351cdf442103
```

Run the repository regression tests:

```bash
npm test
```

The Node test suite checks the same P1 registration vector plus P1 frame structure, the P2/A5 start-frame vector, A5 row-aligned chunk sizing, and raster bit packing. Together with `python tools/protocol02.py`, this proves the browser and Python framing code agree on the known protocol constants.

---

## Step 4 — Understand the packet you are about to send

Protocol 0x02 packet:

```text
02 | command | packet_index | length_le16 | payload | crc_le32 | 03
```

Example: set density to decimal 75 (`0x4B`):

```bash
PYTHONPATH=tools python - <<'PY'
from protocol02 import pack_frame, PRT_SET_HEAT_DENSITY
print(pack_frame(PRT_SET_HEAT_DENSITY, bytes([75])).hex())
PY
```

Example: feed 32 pixels/units with a two-byte payload used by several classic implementations:

```bash
PYTHONPATH=tools python - <<'PY'
from protocol02 import pack_frame, PRT_FEED_LINE
print(pack_frame(PRT_FEED_LINE, (32).to_bytes(2, "little")).hex())
PY
```

Payload width can be model/firmware-specific. P1 WebBLE prior art sends a one-byte feed payload for its tested hardware; older Python implementations use `u16le`. Keep the transport capture/response when validating a specific model.

---

## Step 5 — Identify the hardware transport instead of guessing

### BLE

Install:

```bash
pip install bleak
```

Scan:

```bash
python tools/ble_probe.py
```

Connect and enumerate a known device:

```bash
python tools/ble_probe.py AA:BB:CC:DD:EE:FF
```

The current APK contains these notable GATT families:

```text
0000FF00/01/02/03-0000-1000-8000-00805F9B34FB
0000FF00/01/02/03-C243-40B9-AC41-A10BA3AD5D1A
0000AE00/01/02-0000-1000-8000-00805F9B34FB
```

Do not assign one to your model solely from this list; the protected static initializer prevents a reliable model→UUID mapping from static DEX alone.

### Classic Bluetooth SPP

The current APK contains the standard serial service UUID:

```text
00001101-0000-1000-8000-00805f9b34fb
```

and its classic Bluetooth send thread writes protocol bytes to a `BluetoothSocket` `OutputStream`. On systems where the printer exposes an RFCOMM serial port, protocol framing can therefore be sent as an ordinary serial byte stream.

---

## Step 6 — P1-specific BLE path (publicly cross-validated)

For Paperang P1, public WebBLE research reports:

```text
service: 49535343-fe7d-4ae5-8fa9-9fafd205e455
write:   49535343-6daa-4d02-abf6-19569aca69fe
notify:  49535343-1e4d-4bd9-ba61-23c647249616
```

The same reference uses:

```text
384 dots per row = 48 bytes per row
480 bytes protocol payload = 10 complete rows
black bit = 1, white bit = 0
```

and protocol-0x02 CRC seed `0x35769521`.

An experimental Python equivalent is included:

```bash
pip install bleak pillow
python tools/ble_p1_example.py AA:BB:CC:DD:EE:FF image.png
```

Important: BLE backends differ in maximum GATT write size. The example fragments each complete protocol frame into ATT writes (`--att-chunk`, default 180) while keeping the printer-facing protocol frame intact as a byte stream. Reduce the size if your platform rejects the write.

---

## Step 7 — Raster conversion

For the P1 reference path:

1. resize image to width 384;
2. convert to grayscale;
3. threshold each pixel;
4. pack 8 pixels per byte, MSB first;
5. represent black as 1, white as 0;
6. concatenate row bytes;
7. split on complete-row boundaries;
8. send each block as command `0x00` (`PRT_PRINT_DATA`).

The official APK is more sophisticated. Its metadata shows separate paths for:

- no processing
- text bitmap
- threshold
- grayscale
- normal print mode
- 4/8/12/16-rank grayscale

so a production-compatible implementation should select the conversion based on the target model and `imageType` rather than force P1 binary raster on every printer.

---

## Step 8 — Suggested safe bring-up order on a new model

Before sending a large image, test small reversible queries:

1. enumerate transport UUIDs / establish SPP;
2. subscribe to notifications or start input stream;
3. register/confirm CRC key if the device/protocol requires it;
4. query battery (`0x10` for protocol 0x02);
5. query SN/model/version;
6. optionally print the built-in test page (`0x1B`);
7. send a tiny one-row/ten-row raster;
8. only then send full image data.

This makes it easier to distinguish **bad transport selection**, **bad CRC/framing**, **wrong protocol generation**, and **bad raster encoding**.

---

## Step 9 — Capture evidence for model mapping

For each physical printer, record:

```text
model label / BLE name
firmware version
Bluetooth classic services
BLE service + characteristic UUIDs
MTU / max write size
first bytes of successful request/response
protocol head (02 / 07 / A5 / 17)
print-head width
working raster polarity and bit order
```

With several devices, these captures can turn the current UUID/protocol inventory into a verified per-model compatibility table.
