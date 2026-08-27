#!/usr/bin/env python3
"""Experimental Paperang P1 BLE example.

This uses the ISSC UUID set reported by the public paperang-web project. The
current APK analyzed in this repository contains multiple newer FF00/AE00 UUID
families, so run ble_probe.py first for non-P1 devices.

Usage:
  pip install bleak pillow
  python ble_p1_example.py AA:BB:CC:DD:EE:FF image.png
"""
from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
from PIL import Image, ImageOps
from bleak import BleakClient

from protocol02 import (
    PRT_FEED_LINE,
    PRT_PRINT_DATA,
    PRT_SET_HEAT_DENSITY,
    iter_frames,
    pack_frame,
    register_crc_key_frame,
)

SERVICE = "49535343-fe7d-4ae5-8fa9-9fafd205e455"
WRITE_CHAR = "49535343-6daa-4d02-abf6-19569aca69fe"
NOTIFY_CHAR = "49535343-1e4d-4bd9-ba61-23c647249616"
WIDTH = 384
BYTES_PER_ROW = WIDTH // 8
# 10 complete 48-byte rows; mirrors paperang-web's tearing workaround.
PROTOCOL_PAYLOAD_CHUNK = 480


def image_to_p1_bytes(path: Path, threshold: int = 160) -> bytes:
    img = Image.open(path).convert("L")
    if img.width != WIDTH:
        new_h = max(1, round(img.height * WIDTH / img.width))
        img = img.resize((WIDTH, new_h))
    # White background, threshold to one bit. Paperang raster convention here:
    # black = 1, white = 0, most-significant bit first within each byte.
    img = ImageOps.autocontrast(img)
    px = img.load()
    out = bytearray()
    for y in range(img.height):
        for xb in range(BYTES_PER_ROW):
            v = 0
            for bit in range(8):
                x = xb * 8 + bit
                v = (v << 1) | (1 if px[x, y] < threshold else 0)
            out.append(v)
    return bytes(out)


async def write_stream(client: BleakClient, data: bytes, att_chunk: int) -> None:
    """Write a protocol frame as a byte stream, respecting an ATT chunk cap."""
    for start in range(0, len(data), att_chunk):
        await client.write_gatt_char(WRITE_CHAR, data[start:start + att_chunk], response=False)
        await asyncio.sleep(0.01)


async def main(args) -> None:
    raster = image_to_p1_bytes(args.image, args.threshold)
    print(f"raster: {len(raster)} bytes ({len(raster) // BYTES_PER_ROW} rows)")

    async with BleakClient(args.address) as client:
        print("connected:", client.is_connected)

        def on_notify(_, data: bytearray):
            print("notify:", bytes(data).hex())

        try:
            await client.start_notify(NOTIFY_CHAR, on_notify)
        except Exception as exc:
            print("notify unavailable:", exc)

        await write_stream(client, register_crc_key_frame(), args.att_chunk)
        await asyncio.sleep(0.05)
        await write_stream(client, pack_frame(PRT_SET_HEAT_DENSITY, bytes([args.density])), args.att_chunk)
        await asyncio.sleep(0.05)

        for frame in iter_frames(PRT_PRINT_DATA, raster, PROTOCOL_PAYLOAD_CHUNK):
            await write_stream(client, frame, args.att_chunk)
            await asyncio.sleep(args.frame_delay)

        # 210 pixels is the value used by the public WebBLE reference.
        await write_stream(client, pack_frame(PRT_FEED_LINE, bytes([210])), args.att_chunk)
        await asyncio.sleep(0.3)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("address")
    p.add_argument("image", type=Path)
    p.add_argument("--density", type=int, default=75)
    p.add_argument("--threshold", type=int, default=160)
    p.add_argument("--att-chunk", type=int, default=180,
                   help="max bytes per GATT write; reduce if the backend rejects writes")
    p.add_argument("--frame-delay", type=float, default=0.03)
    asyncio.run(main(p.parse_args()))
