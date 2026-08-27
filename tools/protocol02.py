#!/usr/bin/env python3
"""Minimal Paperang protocol-0x02 framing helpers.

The constants in this file were cross-checked against static metadata recovered
from cn.paperang.mm.apk. Transport (BLE/SPP/USB serial) is intentionally kept
separate from framing.
"""
from __future__ import annotations

from dataclasses import dataclass
import struct
import zlib
from typing import Iterable

FRAME_HEAD = 0x02
FRAME_TAIL = 0x03
STANDARD_CRC_KEY = 0x35769521
# The public SPP/Bleak implementations use this session key after sending
# SET_CRC_KEY with (session_key ^ STANDARD_CRC_KEY) as the payload. The browser
# WebBLE path intentionally does not register it by default.
SESSION_CRC_KEY = 0x06B8EF59

PRT_PRINT_DATA = 0x00
PRT_GET_SN = 0x0A
PRT_GET_BAT_STATUS = 0x10
PRT_SET_CRC_KEY = 0x18
PRT_SET_HEAT_DENSITY = 0x19
PRT_FEED_LINE = 0x1A
PRT_PRINT_TEST_PAGE = 0x1B
PRT_SET_POWER_DOWN_TIME = 0x1E
PRT_GET_POWER_DOWN_TIME = 0x1F
PRT_FEED_TO_HEAD_LINE = 0x21
PRT_SET_PAPER_TYPE = 0x2C


def crc32_seeded(payload: bytes, seed: int = STANDARD_CRC_KEY) -> int:
    """Return the unsigned CRC32 used by protocol-0x02."""
    return zlib.crc32(payload, seed) & 0xFFFFFFFF


def pack_frame(command: int, payload: bytes = b"", index: int = 0,
               crc_key: int = STANDARD_CRC_KEY) -> bytes:
    """Pack one 0x02/0x03 frame.

    Layout:
        02 | command | packet_index | payload_len:u16le | payload |
        crc32(payload, seed):u32le | 03
    """
    if not 0 <= command <= 0xFF:
        raise ValueError("command must fit in one byte")
    if not 0 <= index <= 0xFF:
        raise ValueError("index must fit in one byte")
    if len(payload) > 0xFFFF:
        raise ValueError("single-frame payload exceeds uint16 length")
    return (
        struct.pack("<BBBH", FRAME_HEAD, command, index, len(payload))
        + payload
        + struct.pack("<I", crc32_seeded(payload, crc_key))
        + bytes([FRAME_TAIL])
    )


def iter_frames(command: int, payload: bytes, chunk_size: int,
                crc_key: int = STANDARD_CRC_KEY) -> Iterable[bytes]:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    for index, start in enumerate(range(0, len(payload), chunk_size)):
        if index > 0xFF:
            raise ValueError("more than 256 protocol chunks")
        yield pack_frame(command, payload[start:start + chunk_size], index, crc_key)
    if not payload:
        yield pack_frame(command, b"", 0, crc_key)


@dataclass(frozen=True)
class Frame:
    command: int
    index: int
    payload: bytes
    crc32: int
    crc_ok: bool


def unpack_frame(frame: bytes, crc_key: int = STANDARD_CRC_KEY) -> Frame:
    if len(frame) < 10:
        raise ValueError("frame too short")
    if frame[0] != FRAME_HEAD or frame[-1] != FRAME_TAIL:
        raise ValueError("bad frame marker")
    _, command, index, payload_len = struct.unpack_from("<BBBH", frame, 0)
    expected_len = 10 + payload_len
    if len(frame) != expected_len:
        raise ValueError(f"length mismatch: expected {expected_len}, got {len(frame)}")
    payload = frame[5:5 + payload_len]
    crc = struct.unpack_from("<I", frame, 5 + payload_len)[0]
    return Frame(command, index, payload, crc, crc == crc32_seeded(payload, crc_key))


def register_crc_key_frame(session_key: int = SESSION_CRC_KEY) -> bytes:
    """Build the CRC-key registration frame.

    Registration is a session-oriented transport operation, not part of the
    default browser WebBLE path. The printer receives the session key XORed
    with the standard key; the registration frame itself is CRC'd with the
    standard key. The public SPP/Bleak session-key vector is:
      0218000400787ace332c8980f003

    To reproduce the older fixed-standard vector explicitly, call
    ``register_crc_key_frame(STANDARD_CRC_KEY)``.
    """
    encoded = (session_key ^ STANDARD_CRC_KEY) & 0xFFFFFFFF
    payload = struct.pack("<I", encoded)
    return pack_frame(PRT_SET_CRC_KEY, payload, 0, STANDARD_CRC_KEY)


def command_frame(command: int, value: int | None = None, width: int = 1) -> bytes:
    """Convenience helper for common scalar commands."""
    if value is None:
        payload = b""
    elif width == 1:
        payload = struct.pack("<B", value)
    elif width == 2:
        payload = struct.pack("<H", value)
    elif width == 4:
        payload = struct.pack("<I", value)
    else:
        raise ValueError("width must be 1, 2 or 4")
    return pack_frame(command, payload)


if __name__ == "__main__":
    f = register_crc_key_frame()
    print(f.hex())
    print(unpack_frame(f))
