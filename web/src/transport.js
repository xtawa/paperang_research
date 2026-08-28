import {
  A5, A5StreamParser, CRC_SEED, P1, P1_SESSION_CRC_KEY, P1StreamParser, a5PrintChunkSize, buildA5PrintDataPayload,
  buildHandshakeNoParamsRequest, buildHandshakeRequest, buildSystemRequest,
  hex, packA5Frame, packP1Frame, p1RegistrationFrame, parseA5Payload, parseP1ShortStatus, u16le, utf8Text,
} from './protocol.js';

export const UUIDS = Object.freeze({
  P1_SERVICE: '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  P1_WRITE_6DAA: '49535343-6daa-4d02-abf6-19569aca69fe',
  P1_WRITE_8841: '49535343-8841-43f4-a8d4-ecbe34729bb3',
  P1_NOTIFY: '49535343-1e4d-4bd9-ba61-23c647249616',
  P2_SERVICE: '0000ff00-0000-1000-8000-00805f9b34fb',
  P2_NOTIFY: '0000ff01-0000-1000-8000-00805f9b34fb',
  P2_WRITE: '0000ff02-0000-1000-8000-00805f9b34fb',
  P2_STATUS_NOTIFY: '0000ff03-0000-1000-8000-00805f9b34fb',
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function isIOSLike() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function randomChallenge16() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
function scalarFromA5(parsed) {
  const first = parsed?.tlv?.values?.[0];
  if (!first) return parsed?.args?.length ? utf8Text(parsed.args) || hex(parsed.args) : '';
  if (first.text) return first.text;
  const b = first.bytes;
  if (b.length === 1) return b[0];
  if (b.length === 2) return b[0] | (b[1] << 8);
  if (b.length === 4) return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  return hex(b);
}

const P1_WRITE_ORDER = Object.freeze(['P1_WRITE_6DAA', 'P1_WRITE_8841']);
const P1_WRITE_METHOD_ORDER = Object.freeze(['writeValueWithoutResponse', 'writeValueWithResponse', 'writeValue']);
const P1_PROTOCOL_FRAME_LIMIT = 512;

function normalizeUuid(value) { return String(value || '').toLowerCase(); }

function characteristicProperties(characteristic) {
  const properties = characteristic?.properties || {};
  const names = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate', 'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];
  return Object.fromEntries(names.map((name) => [name, Boolean(properties[name])]));
}

function characteristicInfo(characteristic) {
  return {
    uuid: characteristic?.uuid || null,
    properties: characteristicProperties(characteristic),
    methods: {
      writeValue: typeof characteristic?.writeValue === 'function',
      writeValueWithResponse: typeof characteristic?.writeValueWithResponse === 'function',
      writeValueWithoutResponse: typeof characteristic?.writeValueWithoutResponse === 'function',
    },
  };
}

function p1ProbeMethods(characteristic) {
  const info = characteristicInfo(characteristic);
  const properties = characteristicProperties(characteristic);
  const uuid = normalizeUuid(characteristic?.uuid);
  const knownP1Write = [UUIDS.P1_WRITE_6DAA, UUIDS.P1_WRITE_8841].includes(uuid);
  return P1_WRITE_METHOD_ORDER.filter((method) => {
    if (!info.methods[method]) return false;
    // Bluefy may expose all three methods even when its properties object is
    // incomplete. The two known P1 write UUIDs are therefore probed explicitly
    // in both ATT modes. For non-standard fallback characteristics, trust the
    // reported property before attempting the method.
    if (knownP1Write) return true;
    if (method === 'writeValueWithoutResponse') return properties.writeWithoutResponse;
    if (method === 'writeValueWithResponse') return properties.write;
    return true;
  });
}

function p1Text(payload) {
  const text = utf8Text(payload);
  return text && [...text].every((char) => {
    const code = char.codePointAt(0);
    return code >= 0x20 && code < 0x7f;
  }) ? text : '';
}

export class PaperangWebTransport extends EventTarget {
  constructor() {
    super();
    this.device = null; this.server = null; this.profile = null; this.writeChar = null; this.notifyChars = [];
    this.gattChunk = 237; this.sessionConnected = false; this.protocolReady = false; this.compatReady = false; this.officialReady = false; this.isIOS = isIOSLike();
    this.a5Parser = new A5StreamParser(); this.a5Waiters = new Set();
    this.p1Parser = new P1StreamParser([CRC_SEED, P1_SESSION_CRC_KEY]); this.p1Waiters = new Set();
    this.p1WriteCandidates = []; this.p1Characteristics = []; this.p1Probe = null; this.p1WriteMethod = null; this.p1CrcMode = 'standard-direct';
    this.p1CrcSeed = CRC_SEED; this.p1SessionCrcKey = P1_SESSION_CRC_KEY; this.p1RegistrationSent = false;
    this.deviceInfo = {}; this.handshake = null;
    this.authState = 'unknown'; this.diagnostics = {}; this.rxHistory = []; this.a5History = []; this.p1History = []; this.p1StatusHistory = []; this.p1ShortStatusObserved = false; this.p1TxHistory = []; this.lastDiagnosticReport = null;
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  get connected() { return Boolean(this.sessionConnected && this.writeChar); }
  get ready() { return Boolean(this.connected && (this.profile === 'p2-a5' ? this.compatReady : this.protocolReady)); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  diag(stage, state, detail = '') {
    const item = { stage, state, detail, at: new Date().toISOString() };
    this.diagnostics[stage] = item;
    this.emit('diagnostic', { ...item, deviceInfo: { ...this.deviceInfo }, authState: this.authState, officialReady: this.officialReady, compatReady: this.compatReady });
  }

  currentDiagnosticReport(reason = '') {
    return {
      schema: 'paperang-web-diagnostic-v1', generatedAt: new Date().toISOString(), reason,
      browser: { userAgent: navigator.userAgent || '', platform: navigator.platform || '', maxTouchPoints: navigator.maxTouchPoints || 0, iosLike: this.isIOS },
      connection: { connected: this.connected, ready: this.ready, officialReady: this.officialReady, compatReady: this.compatReady, profile: this.profile, name: this.device?.name || null,
        writeCharacteristic: this.writeChar?.uuid || null, writeProperties: characteristicProperties(this.writeChar),
        writeMethods: characteristicInfo(this.writeChar).methods, lastWriteMethod: this.lastWriteMethod || null,
        notifyCharacteristics: this.notifyChars.map((c) => c.uuid) },
      authState: this.authState, deviceInfo: { ...this.deviceInfo }, handshake: this.handshake ? JSON.parse(JSON.stringify(this.handshake)) : null,
      p1: { crcMode: this.p1CrcMode, crcSeed: this.p1CrcSeed, sessionCrcKey: this.p1SessionCrcKey,
        registrationSent: this.p1RegistrationSent, preferredWriteMethod: this.p1WriteMethod || null, probe: this.p1Probe || null, characteristics: this.p1Characteristics,
        writeCandidates: this.p1WriteCandidates.map((c) => characteristicInfo(c)), parserBufferLength: this.p1Parser.buffer.length,
        shortStatusObserved: this.p1ShortStatusObserved, shortStatusCount: this.p1StatusHistory.length,
        shortStatusHistory: this.p1StatusHistory.slice(-120), history: this.p1History.slice(-120), txHistory: this.p1TxHistory.slice(-120) },
      diagnostics: JSON.parse(JSON.stringify(this.diagnostics)), rxHistory: this.rxHistory.slice(-120), a5History: this.a5History.slice(-80),
      note: 'No Paperang account token, app secret, or extracted proprietary credential is included. Device responses may contain a device serial number.'
    };
  }

  getDiagnosticReport() {
    if (!this.connected && this.lastDiagnosticReport) return this.lastDiagnosticReport;
    return this.currentDiagnosticReport();
  }

  async requestAndConnect() {
    if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth');
    this.reset(false);
    if (typeof window !== 'undefined') window.__paperangTransport = this;
    this.diag('gatt', 'running', '等待选择 BLE 设备');
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [UUIDS.P1_SERVICE, UUIDS.P2_SERVICE] });
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.server = await this.device.gatt.connect();
    this.diag('gatt', 'ok', this.device.name || 'Unknown');

    const detected = await this.detectProfile();
    this.profile = detected.profile; this.writeChar = detected.write; this.notifyChars = detected.notify; this.sessionConnected = true;
    this.p1WriteCandidates = detected.writeCandidates || (detected.write ? [detected.write] : []);
    this.p1Characteristics = detected.characteristics || [];
    this.diag('profile', 'ok', this.profile === 'p2-a5' ? 'FF00 / FF02' : '49535343 / Protocol 02');
    if (this.profile === 'p1') {
      const selected = this.writeChar ? characteristicInfo(this.writeChar) : null;
      this.emit('log', `P1 写特征值候选：${this.p1WriteCandidates.map((c) => c.uuid).join(', ') || '无'}${selected ? `；初始=${selected.uuid}` : ''}`);
      this.emit('log', `P1 Notify：${this.notifyChars.map((c) => c.uuid).join(', ') || '无'}`);
      this.emit('log', `P1 初始写属性：${JSON.stringify(characteristicProperties(this.writeChar))}`);
    }

    let notifyCount = 0;
    for (const characteristic of this.notifyChars) {
      try {
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', (event) => {
          const bytes = new Uint8Array(event.target.value.buffer.slice(event.target.value.byteOffset, event.target.value.byteOffset + event.target.value.byteLength));
          this.handleNotification(characteristic.uuid, bytes);
        });
        notifyCount += 1;
      } catch (error) { this.emit('log', `通知订阅失败 ${characteristic.uuid}: ${error.message}`); }
    }
    this.diag('notify', notifyCount ? 'ok' : 'warn', notifyCount ? `已订阅 ${notifyCount} 个 characteristic` : '未能订阅通知');
    await sleep(this.isIOS ? 300 : 180);

    if (this.profile === 'p1') {
      await this.initializeP1Connection();
    } else if (this.profile === 'p2-a5') {
      await this.initializeA5Connection();
    }

    const detail = { name: this.device.name || 'Unknown', profile: this.profile, ready: this.ready, ios: this.isIOS,
      officialReady: this.officialReady, compatReady: this.compatReady, authState: this.authState, deviceInfo: { ...this.deviceInfo },
      p1: this.profile === 'p1' ? { ...this.p1Probe, crcMode: this.p1CrcMode, crcSeed: this.p1CrcSeed, writeCharacteristic: this.writeChar?.uuid || null } : null };
    this.emit('connected', detail);
    return detail;
  }

  handleNotification(uuid, bytes) {
    this.rxHistory.push({ at: new Date().toISOString(), uuid, hex: hex(bytes), length: bytes.length });
    if (this.rxHistory.length > 240) this.rxHistory.splice(0, this.rxHistory.length - 240);
    this.emit('notification', { uuid, bytes });
    if (this.profile === 'p1') {
      const shortStatus = parseP1ShortStatus(bytes);
      if (shortStatus) {
        this.handleP1ShortStatus(uuid, shortStatus);
        return;
      }
      const frames = this.p1Parser.push(bytes);
      if (!frames.length) {
        if (bytes.length && (bytes[0] === 0x02 || this.p1Parser.buffer.length)) this.emit('log', `P1 stream fragment ${bytes.length}B (buffer ${this.p1Parser.buffer.length}B)`);
        return;
      }
      for (const frame of frames) this.handleP1Frame(uuid, frame);
      return;
    }
    if (this.profile !== 'p2-a5') return;
    const frames = this.a5Parser.push(bytes);
    if (!frames.length) {
      if (bytes.length && (bytes[0] === 0xa5 || this.a5Parser.buffer.length)) this.emit('log', `A5 stream fragment ${bytes.length}B (buffer ${this.a5Parser.buffer.length}B)`);
      return;
    }
    for (const frame of frames) {
      const parsed = parseA5Payload(frame);
      this.a5History.push({ at: new Date().toISOString(), raw: hex(frame.raw), domain: parsed?.domain ?? null, command: parsed?.command ?? null, kind: parsed?.kind ?? null, argsHex: parsed ? hex(parsed.args) : null, tlv: parsed?.tlv?.values?.map((v) => ({ tag: v.tag, text: v.text, hex: hex(v.bytes) })) || [] });
      if (this.a5History.length > 160) this.a5History.splice(0, this.a5History.length - 160);
      this.emit('a5frame', { frame, parsed });
      if (parsed) this.emit('log', `A5 RX domain=0x${parsed.domain.toString(16).padStart(2, '0')} cmd=0x${parsed.command.toString(16).padStart(2, '0')} type=${parsed.kind} args=${parsed.args.length}B`);
      for (const waiter of [...this.a5Waiters]) {
        let matched = false;
        try { matched = waiter.predicate({ frame, parsed }); } catch (_) { matched = false; }
        if (!matched) continue;
        clearTimeout(waiter.timer); this.a5Waiters.delete(waiter); waiter.resolve({ frame, parsed });
      }
    }
  }

  handleP1ShortStatus(uuid, status) {
    const item = {
      at: new Date().toISOString(), uuid, kind: status.kind, raw: hex(status.raw), length: status.raw.length,
      status: status.status, returnId: status.returnId, parameterHex: hex(status.parameters), code: status.code,
      value: status.value, pattern: status.pattern,
    };
    this.p1ShortStatusObserved = true;
    this.p1StatusHistory.push(item);
    if (this.p1StatusHistory.length > 240) this.p1StatusHistory.splice(0, this.p1StatusHistory.length - 240);
    if (this.p1Probe) {
      this.p1Probe.shortStatusObserved = true;
      this.p1Probe.shortStatusCount = this.p1StatusHistory.length;
    }
    this.emit('p1status', { status, uuid });
    this.emit('log', `P1 RX short-status ${item.raw} status=0x${item.status.toString(16).padStart(2, '0')} returnId=0x${item.returnId.toString(16).padStart(2, '0')} params=${item.parameterHex}（非 Protocol 02 frame）`);
  }

  handleP1Frame(uuid, frame) {
    const item = {
      at: new Date().toISOString(), uuid, raw: hex(frame.raw), command: frame.command,
      packetIndex: frame.packetIndex, payloadHex: hex(frame.payload), payloadLength: frame.payloadLength,
      crc: frame.crc, expectedCrc: frame.expectedCrc, crcOk: frame.crcOk, crcSeed: frame.crcSeed,
    };
    this.p1History.push(item);
    if (this.p1History.length > 240) this.p1History.splice(0, this.p1History.length - 240);
    this.emit('p1frame', { frame, uuid });
    const command = `0x${frame.command.toString(16).padStart(2, '0')}`;
    this.emit('log', `P1 RX cmd=${command} index=${frame.packetIndex} payload=${frame.payloadLength}B crc=${frame.crcOk ? 'ok' : 'BAD'}${frame.crcOk ? ` seed=0x${frame.crcSeed.toString(16).padStart(8, '0')}` : ''} raw=${hex(frame.raw)}`);
    for (const waiter of [...this.p1Waiters]) {
      let matched = false;
      try { matched = waiter.predicate({ frame, uuid }); } catch (_) { matched = false; }
      if (!matched) continue;
      clearTimeout(waiter.timer); this.p1Waiters.delete(waiter); waiter.resolve({ frame, uuid });
    }
  }

  waitForP1(predicate, timeout = 1000) {
    let cancel = () => {};
    const promise = new Promise((resolve) => {
      const waiter = { predicate, resolve: null, timer: null };
      const finish = (value) => { clearTimeout(waiter.timer); this.p1Waiters.delete(waiter); resolve(value); };
      waiter.resolve = finish;
      cancel = () => finish(null);
      waiter.timer = setTimeout(() => finish(null), timeout);
      this.p1Waiters.add(waiter);
    });
    promise.cancel = cancel;
    return promise;
  }

  async queryP1(command, payload = new Uint8Array(), {
    responseCommands = [command, (command + 1) & 0xff], timeout = 1000, label = '', writeMethod = '', allowFallback = true,
  } = {}) {
    if (!this.connected) throw new Error('打印机未连接');
    const expected = new Set(responseCommands);
    const wait = this.waitForP1(({ frame }) => expected.has(frame.command) && frame.crcOk, timeout);
    try {
      await this.writeFrame(packP1Frame(command, payload, 0, this.p1CrcSeed), {
        preferResponse: this.isIOS, methodOverride: writeMethod, allowFallback,
      });
    } catch (error) {
      wait.cancel?.();
      throw error;
    }
    const response = await wait;
    if (!response && label) this.emit('log', `P1 ${label} 无已验证回包（等待 ${timeout}ms）`);
    return response;
  }

  async initializeP1Connection() {
    this.protocolReady = false; this.compatReady = false; this.officialReady = false;
    this.authState = 'legacy-not-required'; this.deviceInfo = {};
    this.p1CrcMode = 'standard-direct'; this.p1CrcSeed = CRC_SEED; this.p1RegistrationSent = false; this.p1WriteMethod = null;
    this.p1Parser.reset(); this.p1Parser.setCrcSeeds([CRC_SEED]); this.p1StatusHistory = []; this.p1ShortStatusObserved = false;
    this.diag('handshake', 'running', 'Protocol 02 WebBLE：标准 CRC 直连探测（不发送 SET_CRC_KEY）');

    const candidates = this.p1WriteCandidates.length ? this.p1WriteCandidates : (this.writeChar ? [this.writeChar] : []);
    let selected = null;
    let writeOnlyCandidate = null;
    let writeOnlyMethod = null;
    const attempts = [];
    const probeTimeout = this.isIOS ? 900 : 650;
    this.p1Probe = { selected: null, method: null, responseVerified: false, writeOnly: false, shortStatusObserved: false, shortStatusCount: 0, attempts };

    // Candidate order is meaningful: 6DAA is the public direct-WebBLE path,
    // 8841 is the known alternate, and other writable characteristics are only
    // fallbacks. Probe the ATT write method explicitly so a successful JS
    // Promise cannot hide a write-mode mismatch.
    probeLoop:
    for (const candidate of candidates) {
      const info = characteristicInfo(candidate);
      const methods = p1ProbeMethods(candidate);
      if (!methods.length) {
        attempts.push({ uuid: info.uuid, method: null, properties: info.properties, writeOk: false, responseVerified: false, error: '没有可用的写入方法' });
        continue;
      }
      for (const method of methods) {
        this.writeChar = candidate;
        this.p1Parser.reset();
        const attempt = { uuid: info.uuid, method, properties: info.properties, writeOk: false, responseVerified: false };
        attempts.push(attempt);
        this.emit('log', `P1 GET_VERSION probe：char=${info.uuid} method=${method} properties=${JSON.stringify(info.properties)} payload=01 crcSeed=0x${CRC_SEED.toString(16).padStart(8, '0')}`);
        try {
          const response = await this.queryP1(P1.GET_VERSION, Uint8Array.from([1]), {
            responseCommands: [P1.GET_VERSION, (P1.GET_VERSION + 1) & 0xff],
            timeout: probeTimeout,
            label: 'GET_VERSION',
            writeMethod: method,
            allowFallback: false,
          });
          attempt.writeOk = true;
          if (!writeOnlyCandidate) { writeOnlyCandidate = candidate; writeOnlyMethod = method; }
          if (!response) continue;
          attempt.responseVerified = true;
          selected = candidate;
          this.p1WriteMethod = method;
          this.p1CrcMode = 'standard-direct'; this.p1CrcSeed = response.frame.crcSeed;
          this.p1Parser.setCrcSeeds([this.p1CrcSeed]);
          const version = p1Text(response.frame.payload);
          if (version) this.deviceInfo.softwareVersion = version;
          this.emit('log', `P1 GET_VERSION 已验证：char=${info.uuid} method=${method} payload=${hex(response.frame.payload)}${version ? ` text=${version}` : ''}`);
          break probeLoop;
        } catch (error) {
          attempt.error = error.message || String(error);
          this.emit('log', `P1 GET_VERSION probe 写入失败：char=${info.uuid} method=${method} error=${attempt.error}`);
        }
      }
    }

    if (selected) {
      this.writeChar = selected;
      this.p1Probe = { selected: selected.uuid, method: this.p1WriteMethod, responseVerified: true, writeOnly: false, shortStatusObserved: this.p1ShortStatusObserved, shortStatusCount: this.p1StatusHistory.length, attempts };
      this.protocolReady = true; this.compatReady = true;
      this.diag('handshake', 'ok', `Protocol 02 标准 CRC 已验证；write=${selected.uuid}；method=${this.p1WriteMethod}`);
      this.diag('compat', 'ok', 'P1 GET_VERSION 收到 CRC 校验通过的 Protocol 02 回包');
      await this.queryP1Metadata();
      this.diag('ready', 'ok', 'P1 兼容打印就绪（标准 CRC 直连）');
      return;
    }

    if (writeOnlyCandidate) {
      this.writeChar = writeOnlyCandidate;
      this.p1WriteMethod = writeOnlyMethod;
      this.p1CrcMode = 'standard-direct-unverified'; this.p1CrcSeed = CRC_SEED;
      this.p1Parser.setCrcSeeds([CRC_SEED]);
      this.p1Probe = { selected: writeOnlyCandidate.uuid, method: writeOnlyMethod, responseVerified: false, writeOnly: true, shortStatusObserved: this.p1ShortStatusObserved, shortStatusCount: this.p1StatusHistory.length, attempts };
      this.protocolReady = true; this.compatReady = false;
      const shortStatusDetail = this.p1ShortStatusObserved ? `；已收到 ${this.p1StatusHistory.length} 个 5B 短状态包（非完整 Protocol 02 回包）` : '';
      this.diag('handshake', 'warn', `Protocol 02 写入成功但无已验证回包；write=${writeOnlyCandidate.uuid}；method=${writeOnlyMethod}${shortStatusDetail}`);
      this.diag('compat', 'warn', `P1 WebBLE 可写但 GET_VERSION 未收到完整回包；已保留首个成功候选 ${writeOnlyCandidate.uuid} / ${writeOnlyMethod}；自检/8 行黑条仍会记录完整 TX/RX${shortStatusDetail}`);
      this.diag('ready', 'warn', 'P1 已进入未验证打印状态；物理输出仍需真机确认');
      return;
    }

    this.p1Probe = { selected: null, method: null, responseVerified: false, writeOnly: false, shortStatusObserved: this.p1ShortStatusObserved, shortStatusCount: this.p1StatusHistory.length, attempts };
    this.diag('handshake', 'error', '所有 P1 写特征值探测均失败');
    this.diag('compat', 'error', 'P1 service 存在，但没有成功写入 GET_VERSION');
    this.diag('ready', 'error', 'GATT 已连接，但 Protocol 02 未就绪');
  }

  async queryP1Metadata() {
    const queries = [
      [P1.GET_SN, '设备 SN', 'sn', (P1.GET_SN + 1) & 0xff],
      [P1.GET_BATTERY, '电量', 'battery', (P1.GET_BATTERY + 1) & 0xff],
    ];
    let count = this.deviceInfo.softwareVersion ? 1 : 0;
    this.diag('info', 'running', 'Protocol 02：GET_VERSION → GET_SN → GET_BATTERY');
    for (const [command, label, key, responseCommand] of queries) {
      const response = await this.queryP1(command, Uint8Array.from([1]), {
        responseCommands: [command, responseCommand],
        timeout: this.isIOS ? 1100 : 750,
        label,
      });
      if (response) {
        const payload = response.frame.payload;
        const value = key === 'battery' ? (payload[0] ?? null) : (p1Text(payload) || hex(payload));
        if (value !== null && value !== '') { this.deviceInfo[key] = value; count += 1; }
        this.emit('log', `P1 ${label}: ${hex(payload)}${key === 'battery' ? ` raw=${String(value)}` : ''}`);
      }
      await sleep(this.isIOS ? 80 : 30);
    }
    this.diag('info', count ? 'ok' : 'warn', `读取到 ${count}/3 项 P1 基础信息`);
  }

  waitForA5(predicate, timeout = 1000) {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => { this.a5Waiters.delete(waiter); resolve(null); }, timeout);
      this.a5Waiters.add(waiter);
    });
  }

  async queryA5(payload, { domain = payload[0], command = payload[1], timeout = 1000, required = false } = {}) {
    if (!this.connected) throw new Error('打印机未连接');
    const wait = this.waitForA5(({ parsed }) => Boolean(parsed && parsed.domain === domain && parsed.command === command), timeout);
    await this.writeFrame(packA5Frame(payload), { preserveFrame: true, preferResponse: false });
    const response = await wait;
    if (!response && required) throw new Error(`A5 0x${domain.toString(16)}/0x${command.toString(16)} 未收到响应`);
    return response;
  }

  async querySystem(command, label, timeout = null) {
    this.diag('info', 'running', `查询 ${label}`);
    const response = await this.queryA5(buildSystemRequest(command), { domain: A5.DOMAIN_SYSTEM, command, timeout: timeout || (this.isIOS ? 1200 : 850) });
    if (!response) { this.emit('log', `System 0x${command.toString(16)} (${label}) 无响应`); return null; }
    const value = scalarFromA5(response.parsed);
    this.emit('log', `${label}: ${String(value).slice(0, 240)}`);
    return { value, response };
  }

  async probeCompatibilityThermal() {
    this.diag('compat', 'running', '探测兼容 Thermal 05/0F（不发送打印数据）');
    const thermal = await this.queryA5(A5.STATUS_PAYLOAD, { domain: A5.DOMAIN_THERMAL, command: 0x0f, timeout: this.isIOS ? 1500 : 1050 });
    this.compatReady = Boolean(thermal); this.protocolReady = this.compatReady;
    if (thermal) this.diag('compat', 'ok', '05/0F 有 A5 响应，兼容打印通道可用');
    else this.diag('compat', 'error', '05/0F 无 A5 响应；不发送 raster');
    return this.compatReady;
  }

  async initializeA5Connection() {
    this.protocolReady = false; this.compatReady = false; this.officialReady = false; this.authState = 'unknown'; this.deviceInfo = {}; this.handshake = null;
    this.diag('handshake', 'running', '发送 SDK System 01/17 ShakeHand');
    const challenge = randomChallenge16();
    let shake = await this.queryA5(buildHandshakeRequest(challenge), { domain: A5.DOMAIN_SYSTEM, command: A5.SYS_SHAKE_HAND, timeout: this.isIOS ? 1700 : 1200 });
    let mode = 'challenge';
    if (!shake) {
      this.emit('log', '01/17 带参握手无响应，尝试 APK 中 getSystemDeviceShakeHand_NoParams() 路径');
      mode = 'no-params';
      shake = await this.queryA5(buildHandshakeNoParamsRequest(), { domain: A5.DOMAIN_SYSTEM, command: A5.SYS_SHAKE_HAND, timeout: this.isIOS ? 1600 : 1100 });
    }

    if (!shake) {
      this.authState = 'not-reached';
      this.diag('handshake', 'error', '01/17 两种握手均无 A5 响应');
      this.diag('sw', 'idle', '握手未完成'); this.diag('auth', 'idle', '未进入鉴权'); this.diag('info', 'idle', '未进入设备信息阶段');
      this.diag('official', 'error', '未达到官方 SDK onDevConnSuccess 状态');
      await this.probeCompatibilityThermal();
      this.diag('ready', this.compatReady ? 'warn' : 'error', this.compatReady ? '官方握手失败，但兼容打印通道可用' : 'GATT 已连接，但官方/兼容通道均未就绪');
      return;
    }

    const fields = shake.parsed?.tlv?.values || [];
    this.handshake = {
      mode, challenge, responseCommand: shake.parsed?.command ?? null,
      fields: fields.map((x, index) => ({ index, tag: x.tag, text: x.text, hex: hex(x.bytes), length: x.bytes.length })),
      mappingConfidence: 'unknown-order',
      note: 'APK log mentions randomCode+MD5+SN+authCode, while callback parameter names are unavailable after packing. Positional labels are intentionally not assigned.'
    };
    this.diag('handshake', 'ok', `${mode}; 收到 ${fields.length} 个 TLV 字段（保留原始顺序，不猜字段名）`);

    this.diag('sw', 'running', '按 BleManager$6 顺序查询软件版本');
    const sw = await this.querySystem(A5.SYS_SW_VERSION, '软件版本');
    if (sw) { this.deviceInfo.softwareVersion = sw.value; this.diag('sw', 'ok', String(sw.value)); }
    else this.diag('sw', 'warn', '01/07 无响应');

    // APK-confirmed: afterShakeHand -> SW version callback -> deviceAuth/authInServer.
    // DeviceAuthRequest contains deviceSN/rcode/sign/code and server can also answer
    // onNoAuthorizationRequired(). We intentionally do not replay proprietary account/app credentials.
    const authMaterialLikely = fields.length >= 4;
    this.authState = authMaterialLikely ? 'official-server-or-cache-check-required' : 'official-skip-path-undetermined';
    this.diag('auth', authMaterialLikely ? 'warn' : 'idle', authMaterialLikely
      ? '握手返回 4+ 字段；官方 App 接下来进行缓存判断 / deviceAuth / authInServer，并将 code+sign 回写设备'
      : '未观察到典型四字段 Auth 材料；官方 canSkippAuth 分支仍需实机确认');

    // APK debug metadata places queryInfoNecessary after afterAuthSuccess. We only issue
    // read-only diagnostics here, in the same observed order; success does NOT imply auth bypass.
    const queries = [
      [A5.SYS_PROTOCOL_VERSION, '协议版本', 'protocolVersion'],
      [A5.SYS_PRODUCT_MODEL, '设备类型', 'deviceType'],
      [A5.SYS_MAX_LEN, '最大包长', 'maxLen'],
      [A5.SYS_MAX_CACHE, '最大缓存', 'maxCache'],
      [A5.SYS_SN, '设备 SN', 'sn'],
      [A5.SYS_BATTERY, '电量', 'battery'],
    ];
    let infoResponses = 0;
    this.diag('info', 'running', '只读诊断：Protocol → Type → MaxLen → MaxCache → SN → Battery');
    for (const [cmd, label, key] of queries) {
      const result = await this.querySystem(cmd, label);
      if (result) { this.deviceInfo[key] = result.value; infoResponses += 1; }
      await sleep(this.isIOS ? 90 : 40);
    }
    this.diag('info', infoResponses ? 'ok' : 'warn', `读取到 ${infoResponses}/${queries.length} 项；这些查询不代表 Auth 已通过`);

    this.officialReady = false;
    this.diag('official', 'warn', '尚未复现 deviceAuth → server response(code/sign) → 01/1F device verification → doConnSuccess → heartbeat 闭环');
    await this.probeCompatibilityThermal();
    this.diag('ready', this.compatReady ? 'warn' : 'error', this.compatReady
      ? '兼容打印通道就绪；官方 onDevConnSuccess 尚未验证'
      : '官方握手可达，但 Auth/打印兼容通道尚未就绪');
  }

  async rerunDiagnostics() {
    if (!this.connected) throw new Error('打印机未连接');
    if (this.profile !== 'p2-a5') return { ready: this.ready, profile: this.profile };
    this.a5Parser.reset();
    await this.initializeA5Connection();
    return { ready: this.ready, profile: this.profile, officialReady: this.officialReady, compatReady: this.compatReady, authState: this.authState, deviceInfo: { ...this.deviceInfo } };
  }

  async ensureProtocolReady() {
    if (this.profile !== 'p2-a5') return this.ready;
    if (this.compatReady) return true;
    return this.probeCompatibilityThermal();
  }

  async detectLegacyP1() {
    const service = await this.server.getPrimaryService(UUIDS.P1_SERVICE);
    const chars = await service.getCharacteristics();
    const byUuid = new Map(chars.map((c) => [normalizeUuid(c.uuid), c]));
    const isWritable = (characteristic) => {
      const rawProperties = characteristic?.properties || {};
      const properties = characteristicProperties(characteristic);
      const methods = characteristicInfo(characteristic).methods;
      if (properties.write || properties.writeWithoutResponse) return true;
      const hasReportedWriteProperties = 'write' in rawProperties || 'writeWithoutResponse' in rawProperties;
      return !hasReportedWriteProperties && (!Object.keys(rawProperties).length) && (
        methods.writeValueWithResponse || methods.writeValueWithoutResponse || methods.writeValue
      );
    };
    const candidates = [];
    for (const name of P1_WRITE_ORDER) {
      const characteristic = byUuid.get(normalizeUuid(UUIDS[name]));
      // Some WebBLE stacks expose the known ISSC UUID but report an incomplete
      // or all-false properties object. The UUID is stronger evidence than that
      // metadata for these two public P1 variants, so probe it when a write API
      // exists and let the probe result decide whether it is usable.
      const knownWriteApi = characteristic && (characteristicInfo(characteristic).methods.writeValueWithResponse
        || characteristicInfo(characteristic).methods.writeValueWithoutResponse
        || characteristicInfo(characteristic).methods.writeValue);
      if (characteristic && (isWritable(characteristic) || knownWriteApi)) candidates.push(characteristic);
    }
    for (const characteristic of chars) {
      if (isWritable(characteristic) && !candidates.includes(characteristic)) candidates.push(characteristic);
    }
    if (!candidates.length) throw new Error('找到 Paperang service，但没有可写 characteristic');

    const notify = [];
    const known = byUuid.get(normalizeUuid(UUIDS.P1_NOTIFY));
    if (known && (characteristicProperties(known).notify || characteristicProperties(known).indicate || typeof known.startNotifications === 'function')) notify.push(known);
    for (const characteristic of chars) {
      const properties = characteristicProperties(characteristic);
      if ((properties.notify || properties.indicate) && !notify.includes(characteristic)) notify.push(characteristic);
    }
    return {
      profile: 'p1', write: candidates[0], writeCandidates: candidates, notify,
      characteristics: chars.map((characteristic) => characteristicInfo(characteristic)),
    };
  }

  async detectProfile() {
    const name = String(this.device?.name || '');
    if (/^Paperang[_ -]?P1$/i.test(name)) {
      try {
        const legacy = await this.detectLegacyP1();
        this.emit('log', '检测到 Paperang_P1：优先采用 49535343 / Protocol 02 WebBLE 路径');
        return legacy;
      } catch (error) {
        this.emit('log', `Paperang_P1 未暴露可用 49535343 service，继续探测 FF00/A5：${error.message || error}`);
      }
    }
    try {
      const service = await this.server.getPrimaryService(UUIDS.P2_SERVICE);
      const write = await service.getCharacteristic(UUIDS.P2_WRITE); const notify = [];
      for (const uuid of [UUIDS.P2_NOTIFY, UUIDS.P2_STATUS_NOTIFY]) try { notify.push(await service.getCharacteristic(uuid)); } catch (_) {}
      return { profile: 'p2-a5', write, notify };
    } catch (_) {}
    return this.detectLegacyP1();
  }

  async disconnect() {
    this.lastDiagnosticReport = this.currentDiagnosticReport('manual-disconnect');
    try { if (this.device?.gatt?.disconnect) this.device.gatt.disconnect(); } finally { this.reset(true, true); }
  }
  onDisconnected() {
    this.lastDiagnosticReport = this.currentDiagnosticReport('gatt-disconnected');
    this.emit('log', '设备已断开'); this.reset(true, true); this.emit('disconnected', { diagnosticAvailable: true });
  }
  reset(clearDevice = true, preserveDiagnostic = false) {
    for (const w of this.a5Waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.a5Waiters.clear(); this.a5Parser.reset(); this.server = null; this.profile = null; this.writeChar = null; this.notifyChars = [];
    for (const w of this.p1Waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.p1Waiters.clear(); this.p1Parser.reset(); this.p1WriteCandidates = []; this.p1Characteristics = [];
    this.p1CrcMode = 'standard-direct'; this.p1CrcSeed = CRC_SEED; this.p1RegistrationSent = false; this.p1Probe = null; this.p1WriteMethod = null; this.lastWriteMethod = null;
    this.sessionConnected = false; this.protocolReady = false; this.compatReady = false; this.officialReady = false; this.deviceInfo = {}; this.handshake = null; this.authState = 'unknown';
    if (!preserveDiagnostic) { this.diagnostics = {}; this.rxHistory = []; this.a5History = []; this.p1History = []; this.p1StatusHistory = []; this.p1ShortStatusObserved = false; this.p1TxHistory = []; this.lastDiagnosticReport = null; }
    if (clearDevice) this.device = null;
  }

  async writeChunk(chunk, { preferResponse = false, methodOverride = '' } = {}) {
    if (!this.connected) throw new Error('打印机未连接');
    const characteristic = this.writeChar;
    const properties = characteristic.properties || {};
    const canWithResponse = typeof characteristic.writeValueWithResponse === 'function';
    const canWithoutResponse = typeof characteristic.writeValueWithoutResponse === 'function';
    let method = methodOverride;
    if (!method) {
      if (preferResponse && canWithResponse && (properties.write || (!properties.write && !properties.writeWithoutResponse))) method = 'writeValueWithResponse';
      else if ((properties.writeWithoutResponse || !properties.write) && canWithoutResponse) method = 'writeValueWithoutResponse';
      else if (properties.write && canWithResponse) method = 'writeValueWithResponse';
      else if (canWithoutResponse) method = 'writeValueWithoutResponse';
      else if (canWithResponse) method = 'writeValueWithResponse';
      else if (typeof characteristic.writeValue === 'function') method = 'writeValue';
    }
    if (!method || typeof characteristic[method] !== 'function') throw new Error('当前 characteristic 没有可用写入方法');
    this.lastWriteMethod = method;
    this.lastWriteAt = new Date().toISOString();
    await characteristic[method](chunk);
    return method;
  }

  async writeFrame(frame, { preserveFrame = false, preferResponse = false, methodOverride = '', allowFallback = true } = {}) {
    const configured = Math.max(20, Math.min(512, Number(this.gattChunk) || 237));
    const isP1 = this.profile === 'p1';
    const selectedMethod = methodOverride || (isP1 ? this.p1WriteMethod || '' : '');
    const wholeFrameLimit = isP1 ? P1_PROTOCOL_FRAME_LIMIT : 237;
    const shouldPreserve = isP1 || this.profile === 'p2-a5' || preserveFrame;
    if (shouldPreserve && frame.length <= wholeFrameLimit) {
      try {
        const method = await this.writeChunk(frame, { preferResponse, methodOverride: selectedMethod });
        if (isP1) this.recordP1Tx(frame, { method, writes: 1, preserved: true });
        return;
      } catch (error) {
        if (!allowFallback) throw error;
        this.emit('log', `${isP1 ? 'P1' : '单帧'}写入失败，尝试保守分片：${error.message}`);
      }
    }
    const size = this.isIOS ? Math.min(configured, 180) : configured;
    const methods = [];
    for (let i = 0; i < frame.length; i += size) {
      methods.push(await this.writeChunk(frame.slice(i, i + size), {
        preferResponse: this.isIOS || preferResponse, methodOverride: selectedMethod,
      }));
      if (frame.length > size) await sleep(this.isIOS ? 10 : 4);
    }
    if (isP1) this.recordP1Tx(frame, { method: [...new Set(methods)].join(','), writes: methods.length, preserved: false });
  }

  recordP1Tx(frame, { method = this.lastWriteMethod, writes = 1, preserved = true } = {}) {
    const data = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
    const payloadLength = data.length >= 5 ? data[3] | (data[4] << 8) : null;
    const payload = payloadLength !== null && data.length >= 5 + payloadLength ? data.slice(5, 5 + payloadLength) : new Uint8Array();
    const item = {
      at: new Date().toISOString(), command: data[1] ?? null, packetIndex: data[2] ?? null,
      payloadHex: hex(payload), payloadLength, crcSeed: this.p1CrcSeed, raw: hex(data),
      writeCharacteristic: this.writeChar?.uuid || null, writeProperties: characteristicProperties(this.writeChar),
      writeMethod: method || null, writes, framePreserved: Boolean(preserved),
    };
    this.p1TxHistory.push(item);
    if (this.p1TxHistory.length > 240) this.p1TxHistory.splice(0, this.p1TxHistory.length - 240);
    const command = item.command == null ? '??' : `0x${item.command.toString(16).padStart(2, '0')}`;
    this.emit('log', `P1 TX cmd=${command} index=${item.packetIndex ?? '??'} payload=${item.payloadHex} crcSeed=0x${Number(item.crcSeed).toString(16).padStart(8, '0')} frame=${item.raw}`);
    this.emit('log', `P1 write char=${item.writeCharacteristic || 'unknown'} properties=${JSON.stringify(item.writeProperties)} method=${item.writeMethod || 'unknown'} writes=${writes} frame-preserved=${preserved ? 'yes' : 'no'}`);
  }

  async setDensity(value) {
    const d = Math.max(0, Math.min(100, Number(value) | 0));
    if (this.profile === 'p1') { await this.writeFrame(packP1Frame(P1.SET_DENSITY, new Uint8Array([d]), 0, this.p1CrcSeed), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 80 : 20); }
    else if (this.profile === 'p2-a5') await this.queryA5(new Uint8Array([0x05, 0x11, 0x03, 0x02, 0x00, d, 0x00]), { domain: 0x05, command: 0x11, timeout: this.isIOS ? 1000 : 700 });
    else throw new Error('未知打印协议');
  }
  async selfTest() { if (this.profile !== 'p1') throw new Error('P2 FF00/A5 自检命令尚未被可靠映射'); await this.writeFrame(packP1Frame(P1.SELF_TEST, new Uint8Array([0]), 0, this.p1CrcSeed), { preferResponse: this.isIOS }); }
  async feed(mm, widthBytes = null) {
    const a = Math.max(0, Math.min(100, Number(mm) || 0));
    if (this.profile === 'p1') { await this.writeFrame(packP1Frame(P1.FEED_LINE, u16le(Math.round(a * 56)), 0, this.p1CrcSeed), { preferResponse: this.isIOS }); return; }
    if (this.profile === 'p2-a5') { const rows = Math.max(0, Math.round(a / 0.08472)); if (!rows) return; await this.printA5(new Uint8Array(rows * (widthBytes || 72)), widthBytes || 72, 0); return; }
    throw new Error('未知打印协议');
  }
  async printRaster(r, w, f = 5) {
    if (!this.connected) throw new Error('打印机未连接');
    if (this.profile === 'p1') return this.printP1(r, w, f);
    if (this.profile === 'p2-a5') { if (!await this.ensureProtocolReady()) throw new Error('A5 System 已连接，但 Thermal 打印通道未就绪'); return this.printA5(r, w, f); }
    throw new Error('未知打印协议');
  }
  async printP1(r, w, f) {
    if (w !== 48) throw new Error('P1 当前实现要求 384px / 48 bytes 每行');
    if (!(r instanceof Uint8Array)) r = new Uint8Array(r);
    if (r.length % w !== 0) throw new RangeError('P1 raster length must contain whole rows');
    await this.writeFrame(packP1Frame(P1.DEFAULT_PARAMS, new Uint8Array([0]), 0, this.p1CrcSeed), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 100 : 40);
    await this.writeFrame(packP1Frame(P1.SET_PAPER_TYPE, new Uint8Array([0]), 0, this.p1CrcSeed), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 80 : 20);
    const size = (this.isIOS ? 3 : 10) * w; let idx = 0;
    for (let o = 0; o < r.length; o += size) { const c = r.slice(o, o + size); await this.writeFrame(packP1Frame(P1.PRINT_DATA, c, idx, this.p1CrcSeed), { preferResponse: this.isIOS }); idx = (idx + 1) & 255; this.emit('progress', { sent: Math.min(o + c.length, r.length), total: r.length }); await sleep(this.isIOS ? 18 : 8); }
    if (f > 0) await this.feed(f, w);
  }

  async printP1DiagnosticRows(rows = 8, feedMm = 5) {
    if (this.profile !== 'p1' || !this.connected) throw new Error('P1 打印机未就绪');
    const count = Math.max(1, Math.min(64, Number(rows) | 0));
    const raster = new Uint8Array(count * 48).fill(0xff);
    this.emit('log', `P1 诊断：准备打印 ${count} 行纯黑条（384px × ${count} rows）`);
    await this.printP1(raster, 48, feedMm);
  }

  async registerP1SessionCrc(sessionKey = this.p1SessionCrcKey) {
    if (this.profile !== 'p1' || !this.connected) throw new Error('P1 打印机未连接');
    const key = Number(sessionKey) >>> 0;
    this.p1CrcSeed = CRC_SEED;
    this.p1CrcMode = 'session-registration-pending';
    this.p1Parser.setCrcSeeds([CRC_SEED]);
    this.emit('log', `P1 Protocol 02：显式发送 SET_CRC_KEY，newSessionKey=0x${key.toString(16).padStart(8, '0')}（WebBLE 默认路径不会自动发送此命令）`);
    await this.writeFrame(p1RegistrationFrame(key), { preferResponse: this.isIOS });
    this.p1RegistrationSent = true;
    this.p1CrcSeed = key;
    this.p1CrcMode = 'session-registered-unverified';
    this.p1Parser.setCrcSeeds([key]);
    await sleep(this.isIOS ? 180 : 80);
  }
  async printA5(r, w, f) {
    if (w !== 72) throw new Error('P2 FF00/A5 当前实现要求 576px / 72 bytes 每行');
    let d = r; if (f > 0) { const rows = Math.max(0, Math.round(f / 0.08472)); if (rows) { const m = new Uint8Array(d.length + rows * w); m.set(d); d = m; } }
    await this.queryA5(A5.STATUS_PAYLOAD, { domain: 0x05, command: 0x0f, timeout: this.isIOS ? 1200 : 900, required: true });
    await this.queryA5(A5.START_RASTER_PAYLOAD, { domain: 0x05, command: 0x19, timeout: this.isIOS ? 1200 : 900, required: true });
    const size = a5PrintChunkSize(w); let num = 1;
    for (let o = 0; o < d.length; o += size) { const c = d.slice(o, o + size), final = o + c.length >= d.length; await this.writeFrame(packA5Frame(buildA5PrintDataPayload(c, num, w, final)), { preserveFrame: true, preferResponse: false }); num += 1; this.emit('progress', { sent: Math.min(o + c.length, d.length), total: d.length }); await sleep(this.isIOS ? 16 : 10); }
    const finish = await this.queryA5(A5.FINISH_RASTER_PAYLOAD, { domain: 0x05, command: 0x22, timeout: this.isIOS ? 1400 : 1000 });
    if (!finish) { this.emit('log', '打印结束命令未收到 A5 ACK；停止继续发送'); await sleep(this.isIOS ? 500 : 250); }
  }
}
