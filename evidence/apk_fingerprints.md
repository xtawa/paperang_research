# APK fingerprints and extraction facts

Source file: `cn.paperang.mm.apk`

> The APK itself and recovered DEX files are intentionally **not committed** to this repository. This file records hashes and structural facts so another researcher can verify that they are working from the same sample.

## APK

- Size: `170146687` bytes
- SHA-256: `c95e182413f9440e61ca072b20c8842eb6602a4d62fc728139de041dcee2e70a`
- ZIP entries: `14610`
- Public/stub DEX entries:
  - `classes.dex`: `146668` bytes
  - `classes2.dex` ... `classes10.dex`: `2436` bytes each

The tiny visible DEX files are shell/bootstrap code, not the full application.

## Signing certificate

From `META-INF/PAPERANG.RSA`:

- Subject / issuer: `CN=www.paperang.cn, OU=Software Department, O=Xiamen Paperang Technology Co Ltd., L=Xiamen, ST=Fujian, C=CN`
- Validity: `2016-12-12` to `2041-12-06`
- SHA-1: `46:A1:D6:6F:36:AB:96:46:A3:2F:BA:B9:98:C4:47:11:63:B9:CF:E5`
- SHA-256: `7A:04:34:7B:B7:84:07:9D:71:FA:F5:5B:A4:D2:0E:F8:9D:53:9A:05:5B:B8:86:7C:22:33:48:A6:A4:85:EB:B4`
- Signature algorithm: `SHA256withRSA`, RSA 2048-bit

## Legu-style shell files

- `assets/0OO00l111l1l`
  - size `32240944`
  - SHA-256 `e3ecf20021cfaecc020437e985e02c163cdc16f538c503379bf95e5c42779629`
- `assets/tosversion`
  - size `35`
  - SHA-256 `964244fb141142d9ac35daf9089d8bcb64941d9bec9618037a3f988be7426b75`
- `lib/arm64-v8a/libshell-super.cn.paperang.mm.so`
  - size `360400`
  - SHA-256 `00c5be5300aa95607b8e3d551b7372e806ca84aa6f7cf20d577922c16ddd431b`
- `lib/arm64-v8a/libshella-4.6.2.2.so`
  - size `6004`
  - SHA-256 `c84898f47acc816f963e4168d7da6c78ce1bd90cc064840568bfda4e741175ac`

The shell filename identifies version `4.6.2.2`.

## `assets/0OO00l111l1l` outer DEX table

The first little-endian `u32` is `10` (number of protected DEX files). Each DEX entry follows the older Legu outer structure `u64 unknown, u32 uncompressed_size, u32 compressed_size, u32 unknown, compressed_data`.

| index | uncompressed | compressed |
|---:|---:|---:|
| 0 | 9,743,080 | 2,602,203 |
| 1 | 4,394,784 | 863,331 |
| 2 | 7,510,068 | 1,920,668 |
| 3 | 9,411,648 | 2,476,915 |
| 4 | 9,451,592 | 2,406,647 |
| 5 | 4,889,516 | 1,161,483 |
| 6 | 10,062,448 | 2,441,459 |
| 7 | 4,621,248 | 1,192,436 |
| 8 | 10,117,600 | 2,587,398 |
| 9 | 5,453,892 | 1,134,537 |

All ten entries decompress with NRV2D. In this sample the decompressed buffer begins with a 16-byte wrapper followed by a valid `dex\n035\0` header. The recovered DEX bodies contain class/field/method metadata while protected method instructions remain NOP-filled.
