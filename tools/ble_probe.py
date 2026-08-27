#!/usr/bin/env python3
"""Enumerate a BLE printer's GATT services/characteristics with bleak.

This does not send print data. It is meant to resolve the correct UUID mapping
for a specific Paperang model before using a write characteristic.
"""
import asyncio
import sys
from bleak import BleakClient, BleakScanner

INTERESTING_PREFIXES = ("0000ff", "0000ae", "49535343")


async def main(address: str | None):
    if address is None:
        print("Scanning for 8 seconds...")
        devices = await BleakScanner.discover(timeout=8.0)
        for d in devices:
            print(f"{d.address}\t{d.name}")
        return

    async with BleakClient(address) as client:
        print("connected:", client.is_connected)
        for service in client.services:
            mark = "*" if service.uuid.lower().startswith(INTERESTING_PREFIXES) else " "
            print(f"{mark} SERVICE {service.uuid} {service.description}")
            for ch in service.characteristics:
                mark = "*" if ch.uuid.lower().startswith(INTERESTING_PREFIXES) else " "
                print(f"  {mark} CHAR {ch.uuid} props={','.join(ch.properties)}")
                for desc in ch.descriptors:
                    print(f"       DESC {desc.uuid}")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
