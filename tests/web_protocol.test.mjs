import test from 'node:test';
import assert from 'node:assert/strict';
import {
  A5, CRC_SEED, P1, P1_SESSION_CRC_KEY, a5PrintChunkSize, buildA5PrintDataPayload, crc32, hex,
  A5StreamParser, buildHandshakeNoParamsRequest, buildHandshakeRequest, buildSystemRequest, parseA5Payload, parseTlvArgs,
  packA5Frame, packP1Frame, parseA5Frame, p1RegistrationFrame,
} from '../web/src/protocol.js';
import { packBinaryPixels, thresholdPixels } from '../web/src/raster.js';

test('P1 CRC registration matches public Paperang session-key implementation', () => {
  assert.equal(CRC_SEED, 0x35769521);
  assert.equal(P1_SESSION_CRC_KEY, 0x06b8ef59);
  assert.equal(hex(p1RegistrationFrame()), '0218000400787ace332c8980f003');
  assert.equal(hex(packP1Frame(P1.SET_DENSITY, Uint8Array.from([75]), 0, P1_SESSION_CRC_KEY)), '02190001004b2a26bd2103');
});

test('P1 frame encodes command/index/LE length/payload/CRC/tail', () => {
  const frame = packP1Frame(P1.SET_DENSITY, Uint8Array.from([75]), 3, P1_SESSION_CRC_KEY);
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

test('A5 no-parameter handshake stays a System 01/17 request', () => {
  const frame = packA5Frame(buildHandshakeNoParamsRequest());
  const parsed = parseA5Payload(parseA5Frame(frame));
  assert.equal(parsed.domain, A5.DOMAIN_SYSTEM);
  assert.equal(parsed.command, A5.SYS_SHAKE_HAND);
  assert.equal(parsed.kind, A5.TYPE_REQUEST);
  assert.equal(parsed.args.length, 0);
});

test('nested A5 auth envelope is flattened into four real fields', () => {
  const inner = Uint8Array.from([
    1,3,0,97,98,99,
    2,4,0,100,101,97,100,
    3,2,0,80,49,
    4,3,0,120,121,122,
  ]);
  const wrapped = new Uint8Array(3 + inner.length);
  wrapped.set([1, inner.length & 255, inner.length >>> 8], 0);
  wrapped.set(inner, 3);
  const parsed = parseTlvArgs(wrapped);
  assert.equal(parsed.nested, true);
  assert.deepEqual(parsed.values.map((v) => v.tag), [1,2,3,4]);
  assert.deepEqual(parsed.values.map((v) => v.text), ['abc','dead','P1','xyz']);
});

test('nested device-model response prefers printable model over numeric enum', () => {
  const wrapped = Uint8Array.from([1,9,0, 1,1,0,1, 2,2,0,80,49]);
  const parsed = parseTlvArgs(wrapped);
  assert.equal(parsed.nested, true);
  assert.equal(parsed.values[0].tag, 2);
  assert.equal(parsed.values[0].text, 'P1');
  assert.equal(parsed.values[1].tag, 1);
  assert.equal(parsed.values[1].bytes[0], 1);
});

test('A5 stream parser drops FF03 status records instead of keeping fake fragments', () => {
  const parser = new A5StreamParser();
  assert.equal(parser.push(Uint8Array.from([0x01,0x01])).length, 0);
  assert.equal(parser.buffer.length, 0);
  assert.equal(parser.push(Uint8Array.from([0x02,0xf4,0x00])).length, 0);
  assert.equal(parser.buffer.length, 0);
});
