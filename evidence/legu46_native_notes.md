# Legu 4.6.2.2 native notes

Target: `lib/arm64-v8a/libshell-super.cn.paperang.mm.so`

SHA-256:

```text
00c5be5300aa95607b8e3d551b7372e806ca84aa6f7cf20d577922c16ddd431b
```

These are working notes for extending the 2019 Legu unpacking method to this newer shell.

## `tosversion` transform

At shell virtual address around `0x3e0f0`, the ARM64 code:

1. opens a path supplied by the caller;
2. reads `0x10` bytes into a global buffer near `0x67d60`;
3. iterates `i=0..15`;
4. selects a key byte from rodata near `0x4bee8`;
5. conditionally adds `0x20` to that key byte according to two bitmasks;
6. XORs the result with the corresponding byte read from the file;
7. writes it back in place.

Observed constants in the loop:

```text
mask A = 0x5a9f85eb
mask B = 0xbd747f34
```

The nearby 32-byte shell string is:

```text
^o0o7Ql]M8Y5:+1m~nTcA&3a7|?GB1z@
```

For this APK, applying the observed first-16-byte transform to the first 16 bytes of `assets/tosversion` yields:

```text
decfkcoRFmgJk42Y
```

## Why the 2019 decryptor is insufficient

The older public Legu unpacker derives an XTEA-like key and uses three rounds before NRV decompression of the protected hash-map/method-code areas. Repeating that sequence with this sample (including the updated shell string and the transformed 16-byte value) does not produce valid NRV2D streams.

Therefore the 4.6.2.2 shell changed more than a fixed key/string.

## Crypto-core lead

A downstream native routine around `0x3f05c` / nearby code contains 32-bit rotations including:

```text
ROR #0x10   # rotate 16
ROR #0x14   # rotate 20 == left rotate 12
ROR #0x18   # rotate 24 == left rotate 8
ROR #0x19   # rotate 25 == left rotate 7
```

The 16/12/8/7 rotation set is characteristic of the ChaCha quarter-round family. This is a useful lead, but **not proof that the whole protected blob is standard ChaCha20**: test attempts with straightforward standard ChaCha key/nonce constructions did not directly produce a valid decompressed hash-map.

## Current conclusion

- Outer Legu container: confirmed compatible enough to recover 10 DEX skeletons.
- NRV2D DEX decompression: confirmed.
- Old 4.1 method-code XTEA restoration: not compatible as-is.
- ChaCha-family primitive in 4.6 native path: strong lead / hypothesis.
- Full method bytecode restoration: pending runtime trace/dump or complete native crypto reconstruction.
