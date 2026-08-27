# 01 — Sample and packer

## Target

The research sample is the Android package `cn.paperang.mm.apk` supplied separately by the researcher. Proprietary APK/DEX/native binaries are not redistributed in this repository.

Verification values:

```text
size      170146687 bytes
sha256    c95e182413f9440e61ca072b20c8842eb6602a4d62fc728139de041dcee2e70a
zip files 14610
```

Full hashes and signing-certificate details are in [`../evidence/apk_fingerprints.md`](../evidence/apk_fingerprints.md).

## Why normal JADX output is incomplete

The visible APK DEX layout is anomalous: `classes.dex` is only about 143 KiB and `classes2.dex` through `classes10.dex` are about 2.4 KiB each. The package instead contains a Legu-style protected payload and native shell components:

```text
assets/0OO00l111l1l
assets/tosversion
lib/arm64-v8a/libshell-super.cn.paperang.mm.so
lib/arm64-v8a/libshella-4.6.2.2.so
```

That means direct JADX output primarily exposes the bootstrap/shell rather than the real application logic.

## Outer protected DEX container

The first little-endian `u32` in `assets/0OO00l111l1l` is `10`. Ten packed DEX entries follow an outer record compatible with the older Legu family:

```text
u64 unknown
u32 uncompressed_size
u32 compressed_size
u32 unknown
compressed_data[compressed_size]
```

All ten compressed data blocks were successfully decompressed with NRV2D. Their output has a 16-byte wrapper followed by a valid `dex\n035\0` header. This is enough to recover large DEX metadata skeletons and expose the Paperang printer classes, command constants, protocol names, Bluetooth APIs, and image-processing pipeline.

## What remains protected

Many method instruction regions inside those recovered DEXes are NOP-filled. The older Quarkslab 4.1.x method restoration does not decrypt this 4.6.2.2 sample unchanged. Static analysis of `libshell-super.cn.paperang.mm.so` shows a changed `tosversion` transform and a downstream native routine with the 16/12/8/7 rotate pattern characteristic of a ChaCha-family quarter round. That is a strong crypto lead, not yet proof of a standard ChaCha20 container.

See [`../evidence/legu46_native_notes.md`](../evidence/legu46_native_notes.md).

## Why useful printer results are still recoverable

Even with protected method bodies, DEX metadata retains enough evidence to reconstruct much of the architecture:

- class/package names such as `com.paperang.libprinter`;
- protocol classes `Protocol_02`, `Protocol_07`, `Protocol_A5`, `Protocol_17`;
- static frame markers and command constants;
- CRC utility static values;
- BLE/Classic Bluetooth/Wi-Fi transport class structures;
- callback and method signatures describing status and print flows;
- raster/grayscale mode class families.

Those APK-derived facts are then cross-validated against independent Paperang implementations before being used in the browser client.
