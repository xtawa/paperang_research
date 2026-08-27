export const CRC_SEED = 0x35769521 >>> 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, seed = CRC_SEED) {
  // Python zlib.crc32(data, seed) compatible.
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function u16le(value) {
  const v = Math.max(0, Math.min(0xffff, Number(value) | 0));
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
}

export function u32le(value) {
  const v = Number(value) >>> 0;
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

export function concatBytes(...parts) {
  const normalized = parts.map((p) => p instanceof Uint8Array ? p : new Uint8Array(p));
  const total = normalized.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of normalized) { out.set(p, offset); offset += p.length; }
  return out;
}

export function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const P1 = Object.freeze({
  HEAD: 0x02,
  TAIL: 0x03,
  PRINT_DATA: 0x00,
  GET_VERSION: 0x04,
  GET_SN: 0x0a,
  GET_BATTERY: 0x10,
  SET_CRC_KEY: 0x18,
  SET_DENSITY: 0x19,
  FEED_LINE: 0x1a,
  SELF_TEST: 0x1b,
  DEFAULT_PARAMS: 0x22,
  SET_PAPER_TYPE: 0x2c,
});

export function packP1Frame(command, payload = new Uint8Array(), packetIndex = 0, seed = CRC_SEED) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length > 0xffff) throw new RangeError('P1 payload exceeds uint16 length');
  return concatBytes(
    new Uint8Array([P1.HEAD, command & 0xff, packetIndex & 0xff]),
    u16le(data.length),
    data,
    u32le(crc32(data, seed)),
    new Uint8Array([P1.TAIL]),
  );
}

export function p1RegistrationFrame() {
  // APK/public-prior-art compatible fixed CRC key registration.
  return packP1Frame(P1.SET_CRC_KEY, u32le(CRC_SEED), 0, CRC_SEED);
}

export const A5 = Object.freeze({
  PREFIX: new Uint8Array([0xa5, 0x01]),
  SUFFIX: 0x5a,
  MAX_FRAME_SIZE: 237,
  PRINT_DATA_OVERHEAD: 26,
  STATUS_PAYLOAD: new Uint8Array([0x05, 0x0f, 0x01, 0x00, 0x00, 0x00]),
  START_RASTER_PAYLOAD: new Uint8Array([0x05, 0x19, 0x01, 0x00, 0x00]),
  FINISH_RASTER_PAYLOAD: new Uint8Array([0x05, 0x22, 0x01, 0x02, 0x00, 0x00, 0x00]),
});

export function packA5Frame(payload) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length > 0xffff) throw new RangeError('A5 payload exceeds uint16 length');
  return concatBytes(A5.PREFIX, u16le(data.length), data, u32le(crc32(data)), new Uint8Array([A5.SUFFIX]));
}

export function buildA5Payload(domain, command, args = new Uint8Array(), kind = 0x01) {
  const data = args instanceof Uint8Array ? args : new Uint8Array(args);
  return concatBytes(new Uint8Array([domain & 0xff, command & 0xff, kind & 0xff]), u16le(data.length), data);
}

export function buildA5PrintDataPayload(data, chunkNumber, widthBytes, final = false) {
  const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (chunk.length % widthBytes !== 0) throw new RangeError('A5 print chunk must contain whole raster rows');
  const args = concatBytes(
    u16le(chunkNumber),
    u16le(chunk.length + 8),
    new Uint8Array([0x01, widthBytes & 0xff, 0, 0, 0, 0]),
    u16le(chunk.length),
    chunk,
  );
  return buildA5Payload(0x05, 0x1b, args, final ? 0x03 : 0x01);
}

export function a5PrintChunkSize(widthBytes) {
  if (!Number.isInteger(widthBytes) || widthBytes <= 0) throw new RangeError('widthBytes must be positive');
  const maxData = A5.MAX_FRAME_SIZE - A5.PRINT_DATA_OVERHEAD;
  return Math.max(1, Math.floor(maxData / widthBytes)) * widthBytes;
}

export function parseA5Frame(packet) {
  const p = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (p.length < 9 || p[0] !== 0xa5 || p[1] !== 0x01 || p[p.length - 1] !== 0x5a) return null;
  const len = p[2] | (p[3] << 8);
  if (p.length !== 2 + 2 + len + 4 + 1) return null;
  const payload = p.slice(4, 4 + len);
  const off = 4 + len;
  const got = (p[off] | (p[off + 1] << 8) | (p[off + 2] << 16) | (p[off + 3] << 24)) >>> 0;
  const expected = crc32(payload);
  return got === expected ? { payload, crc: got } : null;
}
