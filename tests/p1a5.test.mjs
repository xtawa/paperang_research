import test from 'node:test';
import assert from 'node:assert/strict';
import { P1_A5_PRINT_END_PAYLOAD, isP1A5Device, p1A5ChunkSize } from '../web/src/p1a5.js';

test('P1+A5 detection uses reported model, not FF00 alone', () => {
  assert.equal(isP1A5Device({ profile: 'p2-a5', deviceInfo: { deviceType: 'P1' } }), true);
  assert.equal(isP1A5Device({ profile: 'p2-a5', deviceInfo: { deviceType: 'P2' } }), false);
  assert.equal(isP1A5Device({ profile: 'p1', deviceInfo: { deviceType: 'P1' } }), false);
});

test('P1+A5 print end is Thermal 05/1A request with zero args', () => {
  assert.deepEqual([...P1_A5_PRINT_END_PAYLOAD], [0x05, 0x1a, 0x01, 0x00, 0x00]);
});

test('P1+A5 384px raster chunk is row aligned and under A5 budget', () => {
  assert.equal(p1A5ChunkSize(48), 192);
  assert.equal(192 % 48, 0);
  assert.ok(192 + 26 <= 237);
});
