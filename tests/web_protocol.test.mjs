import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A5, CRC_SEED, P1, a5PrintChunkSize, buildA5PrintDataPayload, crc32, hex,
  packA5Frame, packP1Frame, parseA5Frame, p1RegistrationFrame,
} from '../web/src/protocol.js';
import { packBinaryPixels, thresholdPixels } from '../web/src/raster.js';

test('CRC32 matches Paperang fixed registration packet', () => {
  assert.equal(CRC_SEED, 0x35769521);
  assert.equal(crc32(Uint8Array.from([0x21,0x95,0x76,0x35])), 0x2144df1c);
  assert.equal(hex(p1RegistrationFrame()), '0218000400219576351cdf442103');
});

test('P1 frame encodes command/index/LE length/payload/CRC/tail', () => {
  const frame = packP1Frame(P1.SET_DENSITY, Uint8Array.from([75]), 3);
  assert.equal(frame[0], 0x02); assert.equal(frame[1], 0x19); assert.equal(frame[2], 3);
  assert.equal(frame[3], 1); assert.equal(frame[4], 0); assert.equal(frame.at(-1), 0x03);
});

test('A5 known start frame and parser', () => {
  const frame = packA5Frame(A5.START_RASTER_PAYLOAD);
  assert.equal(hex(frame), 'a5010500051901000039cb63a65a');
  const parsed = parseA5Frame(frame);
  assert.ok(parsed); assert.deepEqual([...parsed.payload], [...A5.START_RASTER_PAYLOAD]);
});

test('A5 P2 chunking stays row aligned and under validated frame budget', () => {
  assert.equal(a5PrintChunkSize(72), 144);
  const payload = buildA5PrintDataPayload(new Uint8Array(144), 1, 72, false);
  const frame = packA5Frame(payload);
  assert.ok(frame.length <= 237);
});

test('raster packs black=1 MSB first', () => {
  const bits = Uint8Array.from([1,0,1,0,0,0,0,1]);
  assert.deepEqual([...packBinaryPixels(bits, 8, 1)], [0xa1]);
  assert.deepEqual([...thresholdPixels(Uint8Array.from([0,255]), 128, false)], [1,0]);
});
