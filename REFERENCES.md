# References

## Tencent Legu / APK protection

1. Romain Thomas, Quarkslab — **A Glimpse Into Tencent's Legu Packer**  
   https://blog.quarkslab.com/a-glimpse-into-tencents-legu-packer.html

2. Quarkslab — **legu_unpacker_2019**  
   https://github.com/quarkslab/legu_unpacker_2019

The 2019 material is used to identify the outer protected-DEX layout and NRV/XTEA-era design. This research separately verifies which parts still apply to the 4.6.2.2 sample and explicitly does not assume the old method-code decryption is still valid.

## Paperang protocol prior art

3. createskyblue — **paperang-miaomiaoji-tool-gen2**  
   https://github.com/createskyblue/paperang-miaomiaoji-tool-gen2

   Useful independent implementation of protocol-0x02 framing, command constants, CRC packet, and SPP/serial workflow.

4. Yrr0r — **paperang-web**  
   https://github.com/Yrr0r/paperang-web

   Useful P1 WebBLE reference for ISSC GATT UUIDs, `0x02 ... 0x03` frames, CRC seed `0x35769521`, 384-dot/48-byte raster rows, and row-aligned chunking.

5. shafr — **python-paperang**  
   https://github.com/shafr/python-paperang

   Historical Paperang/MiaoMiaoJi interoperability implementation and raster workflow.

## Evidence policy

Statements marked **APK-confirmed** in this repository are derived from the analyzed APK sample itself. Public repositories are used for independent cross-validation and reproduction guidance, not as substitutes for APK evidence.

6. wyrtensi — **paperang-cli** (2026 current implementation)  
   https://github.com/wyrtensi/paperang-cli

   Current independent cross-validation for P1 BLE (`49535343` service, newer `8841` write characteristic), and physically validated P2 BLE FF00/A5 support. The exact A5 framing, FF00 UUIDs, 576 px width, two-row chunk sizing, start/data/finish sequence, and feed calibration are referenced in `docs/06_protocol_cross_validation_2026.md`.

7. mdj2812 — **paperang-p2-lib**  
   https://github.com/mdj2812/paperang-p2-lib

   Useful evidence that other P2 hardware/software paths use classic Bluetooth SPP and 576 px raster. This supports treating "P2" as a family with transport variants rather than assuming every P2 has one BLE profile.
