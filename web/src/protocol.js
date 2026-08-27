export const CRC_SEED = 0x35769521 >>> 0;
// Public Paperang P1 implementations (ihciah/miaomiaoji-tool and descendants)
// negotiate a per-session CRC key through command 0x18. Keep the same proven
// key so the browser path can be compared byte-for-byte with those clients.
export const P1_SESSION_CRC_KEY = 0x06b8ef59 >>> 0;

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

export function utf8(text) { return new TextEncoder().encode(String(text)); }
export function utf8Text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\0+$/g, '').trim(); }
  catch (_) { return ''; }
}

function readableTlvText(bytes) {
  const text = utf8Text(bytes);
  if (!text) return '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0xfffd || cp < 0x20 || cp === 0x7f) return '';
  }
  return text;
}

export const P1 = Object.freeze({
  HEAD: 0x02, TAIL: 0x03, PRINT_DATA: 0x00, GET_VERSION: 0x04, GET_SN: 0x0a,
  GET_BATTERY: 0x10, SET_CRC_KEY: 0x18, SET_DENSITY: 0x19, FEED_LINE: 0x1a,
  SELF_TEST: 0x1b, DEFAULT_PARAMS: 0x22, SET_PAPER_TYPE: 0x2c,
});

export function packP1Frame(command, payload = new Uint8Array(), packetIndex = 0, seed = CRC_SEED) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length > 0xffff) throw new RangeError('P1 payload exceeds uint16 length');
  return concatBytes(new Uint8Array([P1.HEAD, command & 0xff, packetIndex & 0xff]), u16le(data.length), data,
    u32le(crc32(data, seed)), new Uint8Array([P1.TAIL]));
}

/**
 * Parse one complete Protocol 02 frame.
 *
 * The CRC is over the payload only.  A structurally valid frame is returned
 * even when its CRC does not match so callers can log the frame and resync;
 * `crcOk` is the field that decides whether it may be used as a response.
 */
export function parseP1Frame(packet, seed = CRC_SEED) {
  const p = packet instanceof Uint8Array ? packet : new Uint8Array(packet);
  if (p.length < 10 || p[0] !== P1.HEAD || p[p.length - 1] !== P1.TAIL) return null;
  const payloadLength = p[3] | (p[4] << 8);
  const total = 10 + payloadLength;
  if (p.length !== total) return null;
  const payload = p.slice(5, 5 + payloadLength);
  const crcOffset = 5 + payloadLength;
  const crc = (p[crcOffset] | (p[crcOffset + 1] << 8) | (p[crcOffset + 2] << 16) | (p[crcOffset + 3] << 24)) >>> 0;
  const expectedCrc = crc32(payload, seed);
  return {
    raw: p,
    command: p[1],
    packetIndex: p[2],
    payloadLength,
    payload,
    crc,
    expectedCrc,
    crcSeed: seed >>> 0,
    crcOk: crc === expectedCrc,
  };
}

export function p1RegistrationFrame(sessionKey = P1_SESSION_CRC_KEY) {
  // The printer receives (sessionKey XOR standardKey), while this registration
  // packet itself is still CRC'd with the standard key. Subsequent packets must
  // use sessionKey. This matches ihciah/miaomiaoji-tool registerCrcKeyToBt().
  const encoded = (Number(sessionKey) ^ CRC_SEED) >>> 0;
  return packP1Frame(P1.SET_CRC_KEY, u32le(encoded), 0, CRC_SEED);
}

/**
 * Reassemble Protocol 02 notifications.  BLE notification boundaries are
 * transport boundaries, not Paperang frame boundaries: one notification may
 * contain half a frame or several frames.  The parser accepts a list of CRC
 * seeds during a transition so a caller can inspect a response while moving
 * from the standard key to a negotiated key.
 */
export class P1StreamParser {
  constructor(crcSeeds = [CRC_SEED]) {
    this.buffer = new Uint8Array();
    this.setCrcSeeds(crcSeeds);
  }

  setCrcSeeds(crcSeeds = [CRC_SEED]) {
    const seeds = Array.isArray(crcSeeds) ? crcSeeds : [crcSeeds];
    this.crcSeeds = [...new Set(seeds.map((seed) => Number(seed) >>> 0))];
    if (!this.crcSeeds.length) this.crcSeeds = [CRC_SEED];
    return this;
  }

  reset() { this.buffer = new Uint8Array(); }

  push(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buffer = concatBytes(this.buffer, data);
    const frames = [];

    while (this.buffer.length >= 2) {
      let start = -1;
      for (let i = 0; i < this.buffer.length; i += 1) {
        if (this.buffer[i] === P1.HEAD) { start = i; break; }
      }
      if (start < 0) {
        this.buffer = this.buffer[this.buffer.length - 1] === P1.HEAD ? this.buffer.slice(-1) : new Uint8Array();
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 5) break;

      const payloadLength = this.buffer[3] | (this.buffer[4] << 8);
      const total = 10 + payloadLength;
      if (total < 10 || total > 65545) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < total) break;

      const candidate = this.buffer.slice(0, total);
      const parsedBySeed = this.crcSeeds.map((seed) => parseP1Frame(candidate, seed)).filter(Boolean);
      if (!parsedBySeed.length) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const verified = parsedBySeed.find((parsed) => parsed.crcOk);
      frames.push(verified || parsedBySeed[0]);
      this.buffer = this.buffer.slice(total);
    }

    if (this.buffer.length === 1 && this.buffer[0] !== P1.HEAD) this.buffer = new Uint8Array();
    return frames;
  }
}

export const A5 = Object.freeze({
  PREFIX: new Uint8Array([0xa5, 0x01]), SUFFIX: 0x5a, MAX_FRAME_SIZE: 237, PRINT_DATA_OVERHEAD: 26,
  TYPE_REQUEST: 0x01, TYPE_RESPONSE: 0x02, TYPE_BROADCAST: 0x03,
  DOMAIN_SYSTEM: 0x01, DOMAIN_THERMAL: 0x05,
  SYS_DEVICE_INFO: 0x01, SYS_SN: 0x02, SYS_SW_VERSION: 0x07, SYS_PRODUCT_MODEL: 0x08,
  SYS_BATTERY: 0x0b, SYS_MAX_LEN: 0x14, SYS_PROTOCOL_VERSION: 0x15, SYS_SHAKE_HAND: 0x17,
  SYS_SET_DEVICE_KEY: 0x18, SYS_SHAKE_NOTICE: 0x1f, SYS_MAX_CACHE: 0x20,
  STATUS_PAYLOAD: new Uint8Array([0x05, 0x0f, 0x01, 0x00, 0x00, 0x00]),
  START_RASTER_PAYLOAD: new Uint8Array([0x05, 0x19, 0x01, 0x00, 0x00]),
  FINISH_RASTER_PAYLOAD: new Uint8Array([0x05, 0x22, 0x01, 0x02, 0x00, 0x00, 0x00]),
});

export function packA5Frame(payload) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length > 0xffff) throw new RangeError('A5 payload exceeds uint16 length');
  return concatBytes(A5.PREFIX, u16le(data.length), data, u32le(crc32(data)), new Uint8Array([A5.SUFFIX]));
}

export function buildA5Payload(domain, command, args = new Uint8Array(), kind = A5.TYPE_REQUEST) {
  const data = args instanceof Uint8Array ? args : new Uint8Array(args);
  return concatBytes(new Uint8Array([domain & 0xff, command & 0xff, kind & 0xff]), u16le(data.length), data);
}

export function buildTlv(tag, value) {
  const data = typeof value === 'string' ? utf8(value) : (value instanceof Uint8Array ? value : new Uint8Array(value));
  return concatBytes(new Uint8Array([tag & 0xff]), u16le(data.length), data);
}

export function parseTlvArgs(args, depth = 0) {
  const data = args instanceof Uint8Array ? args : new Uint8Array(args);
  const values = [];
  let off = 0;
  while (off + 3 <= data.length) {
    const tag = data[off];
    const len = data[off + 1] | (data[off + 2] << 8);
    off += 3;
    if (off + len > data.length) return { values, complete: false, trailing: data.slice(off - 3), nested: false };
    const bytes = data.slice(off, off + len);
    values.push({ tag, bytes, text: readableTlvText(bytes) });
    off += len;
  }
  const complete = off === data.length;

  if (complete && depth < 2 && values.length === 1 && values[0].bytes.length >= 6) {
    const inner = parseTlvArgs(values[0].bytes, depth + 1);
    if (inner.complete && inner.values.length >= 2) {
      const flattened = inner.values.map((value, index) => ({
        ...value, parentTag: values[0].tag, originalIndex: index,
      }));
      flattened.sort((a, b) => Number(Boolean(b.text)) - Number(Boolean(a.text)) || a.originalIndex - b.originalIndex);
      return { values: flattened, complete: true, trailing: new Uint8Array(), nested: true, containerTag: values[0].tag };
    }
  }

  return { values, complete, trailing: data.slice(off), nested: false };
}

export function buildSystemRequest(command, args = new Uint8Array()) {
  return buildA5Payload(A5.DOMAIN_SYSTEM, command, args, A5.TYPE_REQUEST);
}

export function buildHandshakeRequest(challenge) {
  const encoded = utf8(challenge);
  if (encoded.length !== 16) throw new RangeError('Paperang A5 handshake challenge must be exactly 16 UTF-8 bytes');
  return buildSystemRequest(A5.SYS_SHAKE_HAND, buildTlv(0x01, encoded));
}

export function buildHandshakeNoParamsRequest() { return buildSystemRequest(A5.SYS_SHAKE_HAND); }

export function buildA5PrintDataPayload(data, chunkNumber, widthBytes, final = false) {
  const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (chunk.length % widthBytes !== 0) throw new RangeError('A5 print chunk must contain whole raster rows');
  const args = concatBytes(u16le(chunkNumber), u16le(chunk.length + 8),
    new Uint8Array([0x01, widthBytes & 0xff, 0, 0, 0, 0]), u16le(chunk.length), chunk);
  return buildA5Payload(A5.DOMAIN_THERMAL, 0x1b, args, final ? 0x03 : 0x01);
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
  return got === expected ? { raw: p, payload, crc: got } : null;
}

export function parseA5Payload(payloadOrFrame) {
  const payload = payloadOrFrame?.payload instanceof Uint8Array ? payloadOrFrame.payload
    : (payloadOrFrame instanceof Uint8Array ? payloadOrFrame : new Uint8Array(payloadOrFrame || []));
  if (payload.length < 5) return null;
  const argsLen = payload[3] | (payload[4] << 8);
  if (payload.length !== 5 + argsLen) return null;
  const args = payload.slice(5);
  return { domain: payload[0], command: payload[1], kind: payload[2], args, tlv: parseTlvArgs(args) };
}

export class A5StreamParser {
  constructor() { this.buffer = new Uint8Array(); }
  reset() { this.buffer = new Uint8Array(); }
  push(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buffer = concatBytes(this.buffer, data);
    const frames = [];
    while (this.buffer.length >= 2) {
      let start = -1;
      for (let i = 0; i + 1 < this.buffer.length; i += 1) {
        if (this.buffer[i] === 0xa5 && this.buffer[i + 1] === 0x01) { start = i; break; }
      }
      if (start < 0) {
        this.buffer = this.buffer[this.buffer.length - 1] === 0xa5 ? this.buffer.slice(-1) : new Uint8Array();
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 4) break;
      const len = this.buffer[2] | (this.buffer[3] << 8);
      const total = 2 + 2 + len + 4 + 1;
      if (total > 65544) { this.buffer = this.buffer.slice(2); continue; }
      if (this.buffer.length < total) break;
      const candidate = this.buffer.slice(0, total);
      const parsed = parseA5Frame(candidate);
      if (parsed) {
        frames.push(parsed);
        this.buffer = this.buffer.slice(total);
      } else {
        this.buffer = this.buffer.slice(2);
      }
    }
    if (this.buffer.length === 1 && this.buffer[0] !== 0xa5) this.buffer = new Uint8Array();
    return frames;
  }
}
