# 08 — P1 WebBLE audit and bring-up matrix

This note resolves a transport mistake in the initial browser path and records
what remains to be established on a physical `Paperang_P1`. The repository
contains no account token, app secret, or proprietary credential.

## Evidence split

The public evidence is internally consistent once WebBLE and SPP/Bleak are
treated as separate transport variants:

| evidence | transport / write UUID | CRC behavior | implication |
|---|---|---|---|
| [`Yrr0r/paperang-web`](https://github.com/Yrr0r/paperang-web) | Web Bluetooth; `...-6daa-...`; notify `...-1e4d-...` | standard seed `0x35769521`; no registration | browser direct path |
| [`ihciah/miaomiaoji-tool`](https://github.com/ihciah/miaomiaoji-tool) | classic Bluetooth SPP | sends `SET_CRC_KEY`, then uses a session key | SPP/session path |
| [`wyrtensi/paperang-cli`](https://github.com/wyrtensi/paperang-cli) | Bleak BLE; `...-8841-...`; notify `...-1e4d-...` | automatic session-key registration | newer Bleak variant; not proof of browser behavior |

All three use the same basic Protocol 02 frame:

```text
02 | command | packet_index | payload_len_le16 | payload | crc32_le(payload) | 03
```

The standard CRC seed is `0x35769521`. The session vector used by the public
SPP/Bleak implementations is `0x06b8ef59`; its registration payload is
`0x06b8ef59 XOR 0x35769521 = 0x33ce7a78`, serialized as `78 7a ce 33`.

## Failure modes found in the original browser path

| item | observation | current status |
|---|---|---|
| CRC algorithm | JavaScript implementation and Python `zlib.crc32(payload, seed)` agree on empty, scalar, row, and 480-byte samples | ruled out |
| CRC state | browser sent registration but continued with standard-seed frames | fixed; no auto registration |
| write UUID | device exposes both `6DAA` and `8841` variants in public evidence | unresolved per device; probe order and report added |
| write method | `writeValue`, response, and without-response behavior varies by characteristic/backend | explicit method selection and report added |
| frame boundary | generic 237-byte chunking could split a 490-byte P1 frame | fixed; preserve complete frames ≤512 bytes |
| notification boundary | P1 notifications were not parsed at all | fixed; fragmented/combined parser added |
| readiness | P1 path declared ready without a version probe | fixed; standard-seed `GET_VERSION` probe added |
| raster polarity/width | public P1 evidence says 384 dots, 48 bytes/row, black=1, MSB-first | software-validated; physical output pending |
| firmware policy | some devices may require session registration or reject a command | device-specific; explicit session method retained |

The 512-byte whole-frame attempt follows the Web Bluetooth attribute-size
limit described in the [Web Bluetooth specification](https://webbluetoothcg.github.io/web-bluetooth/).
The effective limit can still be smaller on a particular browser/backend; if a
whole write fails, the report marks the fallback as `framePreserved: false`.

## Current browser behavior

On a device exposing the P1 service, the web client:

1. enumerates `6DAA`, then `8841`, then other reported writable
   characteristics;
2. subscribes to the known notify characteristic and any additional notify or
   indicate characteristics;
3. probes known candidates with `GET_VERSION` payload `01`, standard CRC, and
   explicit ATT methods in this order: without response, with response, then
   legacy `writeValue`;
4. selects the first UUID/method pair with a CRC-verified response;
5. if no response arrives, retains the first successful known write pair rather
   than the last fallback characteristic and marks the path unverified;
6. reads SN and battery using the public query payload `01` convention when a
   response was verified;
7. sends P1 raster frames intact when they fit the 512-byte whole-write limit;
8. logs every P1 TX/RX frame, CRC seed, UUID, write method, and preservation
   state.

If a candidate accepts writes but does not return notifications, the UI marks
the path as `standard-direct-unverified` and allows the two diagnostic actions.
That state is deliberately not presented as physical compatibility proof.

## Minimal physical test matrix

Use a fresh paper roll and keep the device visible. In the browser:

1. connect to the device named `Paperang_P1`;
2. wait for the P1 probe logs;
3. export diagnostics once the probe completes;
4. press `P1 8 行黑条`;
5. check whether a short solid black strip appears and whether the TX log has:
   - `0x22` default parameters;
   - `0x2c` paper type;
   - `0x00` print data totaling 384 bytes; on iOS the expected frame payloads
     are 144, 144, and 96 bytes (3/3/2 rows), while desktop sends one 384-byte
     payload for this 8-row test;
   - `framePreserved = true`;
   - `0x1a` feed;
6. if there is no output, disconnect and compare `writeCharacteristic`,
   `preferredWriteMethod`, `p1.probe.attempts`, `crcSeed`, `p1History`, and
   `p1.txHistory` before changing protocol constants.

The next discriminating experiment is to call the explicit session path only
after saving a clean direct-path report. If session registration is required by
that firmware, the report should show `registrationSent: true`,
`crcMode: session-registered-unverified`, and all subsequent TX frames using
the session seed. Do not infer success from GATT write completion alone; the
physical strip and a valid response are the acceptance criteria.

## Software verification

The local suite includes protocol parser tests and a fake GATT transport test:

```bash
node --test tests/*.test.mjs
node --check web/src/transport.js
python tools/protocol02.py
```

The fake transport verifies standard direct initialization, method selection for
the 6DAA characteristic, one-write preservation of a 490-byte raster frame, and
opt-in session registration.
