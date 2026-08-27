import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A5, CRC_SEED, P1, a5PrintChunkSize, buildA5PrintDataPayload, crc32, hex,
  A5StreamParser, buildHandshakeRequest, buildSystemRequest, parseA5Payload, parseTlvArgs,
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

test('APK-confirmed A5 System 01/17 handshake frame matches captured layout', () => {
  const frame = packA5Frame(buildHandshakeRequest('P4sdFat2pBd0h4mh'));
  assert.equal(hex(frame), 'a5011800011701130001100050347364466174327042643068346d687c3eb3c95a');
  const parsed = parseA5Payload(parseA5Frame(frame));
  assert.equal(parsed.domain, 0x01);
  assert.equal(parsed.command, 0x17);
  assert.equal(parsed.kind, 0x01);
  assert.equal(parsed.tlv.values[0].tag, 0x01);
  assert.equal(parsed.tlv.values[0].text, 'P4sdFat2pBd0h4mh');
});

test('A5 stream parser reassembles fragmented notifications and skips BLE noise', () => {
  const parser = new A5StreamParser();
  const one = packA5Frame(buildSystemRequest(A5.SYS_PROTOCOL_VERSION));
  const two = packA5Frame(buildSystemRequest(A5.SYS_SN));
  assert.equal(parser.push(Uint8Array.from([0x01, 0x04, ...one.slice(0, 5)])).length, 0);
  const frames = parser.push(Uint8Array.from([...one.slice(5), ...two]));
  assert.equal(frames.length, 2);
  assert.equal(parseA5Payload(frames[0]).command, A5.SYS_PROTOCOL_VERSION);
  assert.equal(parseA5Payload(frames[1]).command, A5.SYS_SN);
});

test('TLV parser handles multiple handshake response fields', () => {
  const bytes = Uint8Array.from([1,2,0,65,66, 2,3,0,120,121,122]);
  const parsed = parseTlvArgs(bytes);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.values[0].text, 'AB');
  assert.equal(parsed.values[1].text, 'xyz');
});
