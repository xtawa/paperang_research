import test from 'node:test';
import assert from 'node:assert/strict';
import { CRC_SEED, P1, P1_SESSION_CRC_KEY, hex, packP1Frame, parseP1Frame } from '../web/src/protocol.js';
import { PaperangWebTransport, UUIDS } from '../web/src/transport.js';

class FakeCharacteristic extends EventTarget {
  constructor(uuid, properties, onWrite = null) {
    super();
    this.uuid = uuid;
    this.properties = properties;
    this.writes = [];
    this.onWrite = onWrite;
  }

  async startNotifications() { return this; }

  async writeValueWithResponse(data) { return this.write('writeValueWithResponse', data); }
  async writeValueWithoutResponse(data) { return this.write('writeValueWithoutResponse', data); }
  async writeValue(data) { return this.write('writeValue', data); }

  async write(method, data) {
    const bytes = Uint8Array.from(data);
    this.writes.push({ method, bytes });
    if (this.onWrite) await this.onWrite(this, method, bytes);
  }

  notify(bytes) {
    const value = Uint8Array.from(bytes);
    this.dispatchEvent(new Event('characteristicvaluechanged', { bubbles: false }));
    // EventTarget's Event cannot carry a target override, so dispatch a small
    // compatible event object through the listeners registered by the test.
    for (const listener of this._listeners || []) listener({ target: { value: new DataView(value.buffer) } });
  }

  addEventListener(type, listener, options) {
    if (type === 'characteristicvaluechanged') {
      this._listeners ||= [];
      this._listeners.push(listener);
      return;
    }
    return super.addEventListener(type, listener, options);
  }
}

function makeP1Harness() {
  let notify;
  const respond = async (characteristic, _method, bytes) => {
    const request = parseP1Frame(bytes, CRC_SEED);
    if (!request || request.command === P1.PRINT_DATA) return;
    const payloads = new Map([
      [P1.GET_VERSION, new TextEncoder().encode('P1-test-1.0')],
      [P1.GET_SN, new TextEncoder().encode('SN-TEST')],
      [P1.GET_BATTERY, Uint8Array.from([87])],
    ]);
    const payload = payloads.get(request.command);
    if (!payload) return;
    const response = packP1Frame(request.command, payload, request.packetIndex, CRC_SEED);
    notify.notify(response);
  };

  const write = new FakeCharacteristic(UUIDS.P1_WRITE_8841, {
    write: true,
    writeWithoutResponse: true,
  }, respond);
  const alternate = new FakeCharacteristic(UUIDS.P1_WRITE_6DAA, {
    read: true,
    write: true,
    writeWithoutResponse: false,
  });
  notify = new FakeCharacteristic(UUIDS.P1_NOTIFY, { notify: true });
  const transport = new PaperangWebTransport();
  transport.profile = 'p1';
  transport.sessionConnected = true;
  transport.writeChar = write;
  transport.p1WriteCandidates = [write, alternate];
  transport.p1Characteristics = [
    { uuid: write.uuid, properties: write.properties },
    { uuid: alternate.uuid, properties: alternate.properties },
    { uuid: notify.uuid, properties: notify.properties },
  ];
  notify.addEventListener('characteristicvaluechanged', (event) => {
    const value = event.target.value;
    transport.handleNotification(notify.uuid, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  });
  return { transport, write, alternate, notify };
}

test('P1 short status notification does not poison the Protocol 02 parser buffer', () => {
  const { transport, notify } = makeP1Harness();
  const logs = [];
  transport.addEventListener('log', (event) => logs.push(event.detail));

  transport.handleNotification(notify.uuid, Uint8Array.from([0x00, 0x02, 0x00, 0xf7, 0x01]));

  assert.equal(transport.p1Parser.buffer.length, 0);
  assert.equal(transport.p1History.length, 0);
  assert.equal(transport.p1ShortStatusObserved, true);
  assert.equal(transport.p1StatusHistory.length, 1);
  assert.equal(transport.p1StatusHistory[0].returnId, 0x02);
  assert.match(logs.at(-1), /short-status/);
});

test('P1 initialization probes standard CRC without automatic registration', async () => {
  const { transport, write } = makeP1Harness();
  const result = await transport.initializeP1Connection();

  assert.equal(result, undefined);
  assert.equal(transport.ready, true);
  assert.equal(transport.p1Probe.responseVerified, true);
  assert.equal(transport.writeChar.uuid, UUIDS.P1_WRITE_8841);
  assert.equal(transport.p1CrcMode, 'standard-direct');
  assert.equal(transport.p1RegistrationSent, false);
  assert.deepEqual(transport.deviceInfo, { softwareVersion: 'P1-test-1.0', sn: 'SN-TEST', battery: 87 });
  assert.equal(write.writes[0].method, 'writeValueWithoutResponse');
  assert.equal(transport.p1Probe.method, 'writeValueWithoutResponse');
  assert.deepEqual(transport.p1Probe.attempts.map(({ uuid, method, writeOk, responseVerified }) => ({ uuid, method, writeOk, responseVerified })), [{
    uuid: UUIDS.P1_WRITE_8841,
    method: 'writeValueWithoutResponse',
    writeOk: true,
    responseVerified: true,
  }]);

  const requests = write.writes.map(({ bytes }) => parseP1Frame(bytes, CRC_SEED)).filter(Boolean);
  assert.deepEqual(requests.map((frame) => frame.command), [P1.GET_VERSION, P1.GET_SN, P1.GET_BATTERY]);
  assert.ok(requests.every((frame) => frame.crcOk));
  assert.equal(requests.some((frame) => frame.command === P1.SET_CRC_KEY), false);
  assert.equal(transport.p1History.length, 3);
  assert.ok(transport.p1History.every((frame) => frame.crcOk));
});

test('P1 full frame write preserves a 480-byte raster payload and records the method', async () => {
  const { transport, write } = makeP1Harness();
  await transport.initializeP1Connection();
  write.writes.length = 0;
  transport.p1TxHistory.length = 0;
  transport.gattChunk = 237;

  const frame = packP1Frame(P1.PRINT_DATA, new Uint8Array(480).fill(0xff), 7, CRC_SEED);
  await transport.writeFrame(frame);

  assert.equal(write.writes.length, 1);
  assert.equal(write.writes[0].method, 'writeValueWithoutResponse');
  assert.equal(write.writes[0].bytes.length, 490);
  assert.equal(hex(write.writes[0].bytes), hex(frame));
  assert.deepEqual(transport.p1TxHistory.at(-1), {
    at: transport.p1TxHistory.at(-1).at,
    command: P1.PRINT_DATA,
    packetIndex: 7,
    payloadHex: 'ff'.repeat(480),
    payloadLength: 480,
    crcSeed: CRC_SEED,
    raw: hex(frame),
    writeCharacteristic: UUIDS.P1_WRITE_8841,
    writeProperties: { broadcast: false, read: false, writeWithoutResponse: true, write: true, notify: false, indicate: false, authenticatedSignedWrites: false, reliableWrite: false, writableAuxiliaries: false },
    writeMethod: 'writeValueWithoutResponse',
    writes: 1,
    framePreserved: true,
  });
});

test('P1 explicit session registration is opt-in and changes subsequent CRC state', async () => {
  const { transport, write } = makeP1Harness();
  await transport.initializeP1Connection();
  write.writes.length = 0;
  transport.p1TxHistory.length = 0;

  await transport.registerP1SessionCrc(0x06b8ef59);

  const registration = parseP1Frame(write.writes[0].bytes, CRC_SEED);
  assert.equal(registration.command, P1.SET_CRC_KEY);
  assert.equal(hex(write.writes[0].bytes), '0218000400787ace332c8980f003');
  assert.equal(transport.p1RegistrationSent, true);
  assert.equal(transport.p1CrcMode, 'session-registered-unverified');
  assert.equal(transport.p1CrcSeed, 0x06b8ef59);
  assert.equal(transport.p1Parser.crcSeeds[0], 0x06b8ef59);
});

test('P1 probe falls back from write-without-response to write-with-response on the same UUID', async () => {
  let notify;
  const payloads = new Map([
    [P1.GET_VERSION, new TextEncoder().encode('P1-method-fallback')],
    [P1.GET_SN, new TextEncoder().encode('SN-FALLBACK')],
    [P1.GET_BATTERY, Uint8Array.from([64])],
  ]);
  const respond = async (_characteristic, method, bytes) => {
    if (method === 'writeValueWithoutResponse') throw new Error('simulated unsupported ATT write mode');
    if (method !== 'writeValueWithResponse') return;
    const request = parseP1Frame(bytes, CRC_SEED);
    const payload = request && payloads.get(request.command);
    if (!request || !payload) return;
    notify.notify(packP1Frame(request.command, payload, request.packetIndex, CRC_SEED));
  };
  const write = new FakeCharacteristic(UUIDS.P1_WRITE_6DAA, { write: true, writeWithoutResponse: true }, respond);
  notify = new FakeCharacteristic(UUIDS.P1_NOTIFY, { notify: true });
  const transport = new PaperangWebTransport();
  transport.isIOS = false;
  transport.profile = 'p1';
  transport.sessionConnected = true;
  transport.writeChar = write;
  transport.p1WriteCandidates = [write];
  notify.addEventListener('characteristicvaluechanged', (event) => {
    const value = event.target.value;
    transport.handleNotification(notify.uuid, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  });

  await transport.initializeP1Connection();

  assert.deepEqual(write.writes.slice(0, 2).map(({ method }) => method), ['writeValueWithoutResponse', 'writeValueWithResponse']);
  assert.equal(transport.p1Probe.selected, UUIDS.P1_WRITE_6DAA);
  assert.equal(transport.p1Probe.method, 'writeValueWithResponse');
  assert.equal(transport.p1Probe.attempts[0].writeOk, false);
  assert.match(transport.p1Probe.attempts[0].error, /simulated unsupported ATT write mode/);
  assert.equal(transport.p1Probe.attempts[0].responseVerified, false);
  assert.equal(transport.p1Probe.attempts[1].responseVerified, true);
  assert.equal(transport.p1WriteMethod, 'writeValueWithResponse');
  assert.deepEqual(transport.deviceInfo, { softwareVersion: 'P1-method-fallback', sn: 'SN-FALLBACK', battery: 64 });
});

test('P1 prefers the transparent 8841 path and does not probe 6DAA when it is present', async () => {
  const write = new FakeCharacteristic(UUIDS.P1_WRITE_6DAA, { write: true, writeWithoutResponse: true });
  const alternate = new FakeCharacteristic(UUIDS.P1_WRITE_8841, { write: true, writeWithoutResponse: true });
  const fallback = new FakeCharacteristic('49535343-ACA3-481C-91EC-D85E28A60318', { write: true, notify: true });
  const transport = new PaperangWebTransport();
  transport.profile = 'p1';
  transport.sessionConnected = true;
  transport.writeChar = write;
  transport.p1WriteCandidates = [write, alternate, fallback];
  const calls = [];
  transport.queryP1 = async (_command, _payload, options) => {
    calls.push({ uuid: transport.writeChar.uuid, method: options.writeMethod });
    return null;
  };

  await transport.initializeP1Connection();

  assert.equal(transport.p1Probe.responseVerified, false);
  assert.equal(transport.p1Probe.writeOnly, true);
  assert.equal(transport.p1Probe.selected, UUIDS.P1_WRITE_8841);
  assert.equal(transport.p1Probe.dataPath, 'ISSC_TRANS_RX / Protocol 02 data');
  assert.equal(transport.p1Probe.sessionRegistrationAttempted, true);
  assert.equal(transport.p1RegistrationSent, true);
  assert.equal(transport.p1CrcMode, 'session-registered-unverified');
  assert.equal(transport.p1Probe.method, 'writeValueWithoutResponse');
  assert.equal(transport.p1WriteMethod, 'writeValueWithoutResponse');
  assert.deepEqual(calls.slice(0, 3).map(({ uuid, method }) => ({ uuid, method })), [
    { uuid: UUIDS.P1_WRITE_8841, method: 'writeValueWithoutResponse' },
    { uuid: UUIDS.P1_WRITE_8841, method: 'writeValueWithResponse' },
    { uuid: UUIDS.P1_WRITE_8841, method: 'writeValue' },
  ]);
  assert.equal(calls.some(({ uuid }) => uuid === UUIDS.P1_WRITE_6DAA), false);
  assert.ok(calls.some(({ uuid }) => uuid === fallback.uuid));

  const registration = alternate.writes.find(({ bytes }) => parseP1Frame(bytes, CRC_SEED)?.command === P1.SET_CRC_KEY);
  assert.ok(registration);
  assert.equal(hex(registration.bytes), '0218000400787ace332c8980f003');

  await transport.writeFrame(packP1Frame(P1.SELF_TEST, Uint8Array.from([0]), 0, transport.p1CrcSeed));
  assert.equal(alternate.writes.at(-1).method, 'writeValueWithoutResponse');
});

test('P1 direct 8841 adapter never registers a session CRC', async () => {
  const { transport, write } = makeP1Harness();
  transport.setP1Adapter('8841-direct');
  transport.queryP1 = async () => null;

  await transport.initializeP1Connection();

  assert.equal(transport.p1Probe.adapter, '8841-direct');
  assert.equal(transport.p1Probe.selected, UUIDS.P1_WRITE_8841);
  assert.equal(transport.p1RegistrationAttempted, false);
  assert.equal(transport.p1RegistrationSent, false);
  assert.equal(transport.p1CrcMode, 'standard-direct-unverified');
  assert.equal(write.writes.some(({ bytes }) => parseP1Frame(bytes, CRC_SEED)?.command === P1.SET_CRC_KEY), false);
});

test('P1 legacy adapter explicitly selects 6DAA even when 8841 exists', async () => {
  const { transport, write, alternate } = makeP1Harness();
  const calls = [];
  transport.setP1Adapter('legacy-6daa');
  transport.queryP1 = async (_command, _payload, options) => {
    calls.push({ uuid: transport.writeChar.uuid, method: options.writeMethod });
    return null;
  };

  await transport.initializeP1Connection();

  assert.equal(transport.p1Probe.adapter, 'legacy-6daa');
  assert.equal(transport.p1Probe.selected, UUIDS.P1_WRITE_6DAA);
  assert.ok(calls.length > 0);
  assert.ok(calls.every(({ uuid }) => uuid === UUIDS.P1_WRITE_6DAA));
  assert.equal(transport.p1RegistrationSent, false);
  assert.equal(write.writes.length, 0);
  assert.equal(alternate.writes.length, 0);
});

test('P1 public WebBLE adapter skips probes and mirrors 6DAA writeValue printing', async () => {
  const { transport, write, alternate } = makeP1Harness();
  transport.isIOS = true;
  transport.setP1Adapter('public-webble');

  await transport.initializeP1Connection();

  assert.equal(transport.ready, true);
  assert.equal(transport.compatReady, false);
  assert.equal(transport.p1Probe.directPath, 'public-webble');
  assert.equal(transport.p1Probe.skipWarmup, true);
  assert.equal(transport.p1Probe.selected, UUIDS.P1_WRITE_6DAA);
  assert.equal(transport.p1WriteMethod, 'writeValue');
  assert.equal(transport.p1CrcMode, 'standard-direct-public-webble');
  assert.equal(transport.p1RegistrationSent, false);
  assert.equal(write.writes.length, 0);
  assert.equal(alternate.writes.length, 0);

  await transport.printP1(new Uint8Array(8 * 48).fill(0xff), 48, 5);

  const frames = alternate.writes.map(({ bytes }) => parseP1Frame(bytes, CRC_SEED)).filter(Boolean);
  assert.deepEqual(frames.map((frame) => frame.command), [
    P1.PRINT_DATA,
    P1.PRINT_DATA,
    P1.PRINT_DATA,
    P1.FEED_LINE,
  ]);
  assert.deepEqual(frames.map((frame) => frame.payloadLength), [144, 144, 96, 1]);
  assert.equal(hex(frames.at(-1).payload), 'd2');
  assert.ok(alternate.writes.every(({ method }) => method === 'writeValue'));
  assert.ok(frames.every((frame) => frame.crcOk));
});

test('P1 forced write mode uses only the selected ATT method', async () => {
  const { transport, write } = makeP1Harness();
  transport.setP1WriteMode('writeValueWithResponse');

  await transport.initializeP1Connection();

  assert.equal(transport.p1Probe.writeMode, 'writeValueWithResponse');
  assert.equal(transport.p1Probe.method, 'writeValueWithResponse');
  assert.equal(write.writes[0].method, 'writeValueWithResponse');
  assert.equal(transport.p1Probe.attempts.length, 1);
});

test('P1 transparent write-only fallback verifies the automatic session CRC path', async () => {
  let notify;
  let sessionRegistered = false;
  const payloads = new Map([
    [P1.GET_VERSION, new TextEncoder().encode('P1-session')],
    [P1.GET_SN, new TextEncoder().encode('SN-SESSION')],
    [P1.GET_BATTERY, Uint8Array.from([73])],
  ]);
  const respond = async (_characteristic, method, bytes) => {
    const registration = parseP1Frame(bytes, CRC_SEED);
    if (registration?.command === P1.SET_CRC_KEY) { sessionRegistered = true; return; }
    if (!sessionRegistered || method !== 'writeValue') return;
    const request = parseP1Frame(bytes, P1_SESSION_CRC_KEY);
    const payload = request && payloads.get(request.command);
    if (!request || !payload) return;
    notify.notify(packP1Frame(request.command, payload, request.packetIndex, P1_SESSION_CRC_KEY));
  };
  const write = new FakeCharacteristic(UUIDS.P1_WRITE_8841, { write: true, writeWithoutResponse: true }, respond);
  notify = new FakeCharacteristic(UUIDS.P1_NOTIFY, { notify: true });
  const transport = new PaperangWebTransport();
  transport.isIOS = false;
  transport.profile = 'p1';
  transport.sessionConnected = true;
  transport.writeChar = write;
  transport.p1WriteCandidates = [write];
  notify.addEventListener('characteristicvaluechanged', (event) => {
    const value = event.target.value;
    transport.handleNotification(notify.uuid, new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  });

  await transport.initializeP1Connection();

  assert.equal(transport.ready, true);
  assert.equal(transport.compatReady, true);
  assert.equal(transport.p1Probe.responseVerified, true);
  assert.equal(transport.p1Probe.sessionRegistrationAttempted, true);
  assert.equal(transport.p1CrcMode, 'session-registered');
  assert.equal(transport.p1CrcSeed, P1_SESSION_CRC_KEY);
  assert.deepEqual(transport.deviceInfo, { softwareVersion: 'P1-session', sn: 'SN-SESSION', battery: 73 });
  const registrations = write.writes
    .map(({ bytes }) => parseP1Frame(bytes, CRC_SEED))
    .filter((frame) => frame?.command === P1.SET_CRC_KEY);
  assert.equal(registrations.length, 3);
  const sessionVersion = write.writes
    .map(({ bytes }) => parseP1Frame(bytes, P1_SESSION_CRC_KEY))
    .find((frame) => frame?.command === P1.GET_VERSION && frame.crcOk);
  assert.ok(sessionVersion);
});

test('P1 print path mirrors the public WebBLE minimal raster sequence', async () => {
  const { transport, write } = makeP1Harness();
  transport.isIOS = true;
  transport.p1WriteMethod = 'writeValueWithoutResponse';
  transport.p1TxHistory.length = 0;

  await transport.printP1(new Uint8Array(8 * 48).fill(0xff), 48, 5);

  const frames = write.writes.map(({ bytes }) => parseP1Frame(bytes, CRC_SEED)).filter(Boolean);
  assert.deepEqual(frames.map((frame) => frame.command), [
    P1.PRINT_DATA,
    P1.PRINT_DATA,
    P1.PRINT_DATA,
    P1.FEED_LINE,
  ]);
  assert.deepEqual(frames.map((frame) => frame.packetIndex), [0, 1, 2, 0]);
  assert.deepEqual(frames.map((frame) => frame.payloadLength), [144, 144, 96, 1]);
  assert.equal(hex(frames.at(-1).payload), 'd2');
  assert.equal(frames.some((frame) => frame.command === P1.DEFAULT_PARAMS || frame.command === P1.SET_PAPER_TYPE), false);
  assert.ok(frames.every((frame) => frame.crcOk));
});

test('P1 session CRC print path keeps the minimal raster sequence', async () => {
  const { transport, write } = makeP1Harness();
  await transport.initializeP1Connection();
  await transport.registerP1SessionCrc();
  write.writes.length = 0;
  transport.isIOS = false;

  await transport.printP1(new Uint8Array(8 * 48).fill(0xff), 48, 5);

  const frames = write.writes.map(({ bytes }) => parseP1Frame(bytes, P1_SESSION_CRC_KEY)).filter((frame) => frame?.crcOk);
  assert.deepEqual(frames.map((frame) => frame.command), [P1.PRINT_DATA, P1.FEED_LINE]);
  assert.deepEqual(frames.map((frame) => frame.payloadLength), [384, 1]);
  assert.equal(hex(frames.at(-1).payload), 'd2');
  assert.equal(frames.some((frame) => frame.command === P1.DEFAULT_PARAMS || frame.command === P1.SET_PAPER_TYPE), false);
});
