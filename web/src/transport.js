import {
  A5, A5StreamParser, P1, a5PrintChunkSize, buildA5PrintDataPayload,
  buildHandshakeNoParamsRequest, buildHandshakeRequest, buildSystemRequest,
  hex, packA5Frame, packP1Frame, p1RegistrationFrame, parseA5Payload, u16le, utf8Text,
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

export class PaperangWebTransport extends EventTarget {
  constructor() {
    super();
    this.device = null; this.server = null; this.profile = null; this.writeChar = null; this.notifyChars = [];
    this.gattChunk = 237; this.sessionConnected = false; this.protocolReady = false; this.isIOS = isIOSLike();
    this.a5Parser = new A5StreamParser(); this.a5Waiters = new Set(); this.deviceInfo = {}; this.handshake = null;
    this.authState = 'unknown'; this.onDisconnected = this.onDisconnected.bind(this);
  }

  get connected() { return Boolean(this.sessionConnected && this.writeChar); }
  get ready() { return Boolean(this.connected && (this.profile !== 'p2-a5' || this.protocolReady)); }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  diag(stage, state, detail = '') { this.emit('diagnostic', { stage, state, detail, deviceInfo: { ...this.deviceInfo }, authState: this.authState }); }

  async requestAndConnect() {
    if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth');
    this.reset(false);
    this.diag('gatt', 'running', '等待选择 BLE 设备');
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [UUIDS.P1_SERVICE, UUIDS.P2_SERVICE] });
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.server = await this.device.gatt.connect();
    this.diag('gatt', 'ok', this.device.name || 'Unknown');

    const detected = await this.detectProfile();
    this.profile = detected.profile; this.writeChar = detected.write; this.notifyChars = detected.notify; this.sessionConnected = true;
    this.diag('profile', 'ok', this.profile === 'p2-a5' ? 'FF00 / FF02' : '49535343 / Protocol 02');

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
      this.diag('handshake', 'running', 'Protocol 02 CRC key registration');
      await this.writeFrame(p1RegistrationFrame(), { preferResponse: this.isIOS });
      await sleep(this.isIOS ? 180 : 80);
      this.protocolReady = true; this.authState = 'legacy-not-required';
      this.diag('handshake', 'ok', 'Protocol 02 registration sent');
      this.diag('ready', 'ok', 'P1 兼容打印就绪');
    } else if (this.profile === 'p2-a5') {
      await this.initializeA5Connection();
    }

    const detail = { name: this.device.name || 'Unknown', profile: this.profile, ready: this.ready, ios: this.isIOS,
      authState: this.authState, deviceInfo: { ...this.deviceInfo } };
    this.emit('connected', detail);
    return detail;
  }

  handleNotification(uuid, bytes) {
    this.emit('notification', { uuid, bytes });
    if (this.profile !== 'p2-a5') return;
    const frames = this.a5Parser.push(bytes);
    if (!frames.length) {
      if (bytes.length && (bytes[0] === 0xa5 || this.a5Parser.buffer.length)) this.emit('log', `A5 stream fragment ${bytes.length}B (buffer ${this.a5Parser.buffer.length}B)`);
      return;
    }
    for (const frame of frames) {
      const parsed = parseA5Payload(frame);
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

  async initializeA5Connection() {
    this.protocolReady = false; this.authState = 'unknown'; this.deviceInfo = {};
    this.diag('handshake', 'running', '发送官方 SDK System 01/17 ShakeHand');
    const challenge = randomChallenge16();
    let shake = await this.queryA5(buildHandshakeRequest(challenge), { domain: A5.DOMAIN_SYSTEM, command: A5.SYS_SHAKE_HAND, timeout: this.isIOS ? 1500 : 1100 });
    let mode = 'challenge';
    if (!shake) {
      this.emit('log', '01/17 challenge handshake 无响应，尝试 APK 中的 getSystemDeviceShakeHand_NoParams() 路径');
      mode = 'no-params';
      shake = await this.queryA5(buildHandshakeNoParamsRequest(), { domain: A5.DOMAIN_SYSTEM, command: A5.SYS_SHAKE_HAND, timeout: this.isIOS ? 1400 : 1000 });
    }
    if (!shake) {
      this.diag('handshake', 'error', '01/17 两种握手均无响应');
      this.diag('auth', 'idle', '未进入鉴权'); this.diag('ready', 'error', 'GATT 已连接，但官方 System 握手未完成');
      return;
    }

    const fields = shake.parsed?.tlv?.values || [];
    this.handshake = { mode, challenge, fields: fields.map((x) => ({ tag: x.tag, text: x.text, hex: hex(x.bytes) })) };
    if (fields.length >= 4) {
      this.handshake.deviceSN = fields[0].text; this.handshake.randomCode = fields[1].text;
      this.handshake.md5 = fields[2].text; this.handshake.authCode = fields[3].text;
      if (this.handshake.deviceSN) this.deviceInfo.snHandshake = this.handshake.deviceSN;
    }
    this.diag('handshake', 'ok', `${mode}; ${fields.length} TLV field(s)`);

    const sw = await this.querySystem(A5.SYS_SW_VERSION, '软件版本');
    if (sw) this.deviceInfo.softwareVersion = sw.value;

    this.authState = fields.length >= 4 ? 'server-auth-not-reproduced' : 'not-indicated-by-response';
    this.diag('auth', fields.length >= 4 ? 'warn' : 'idle', fields.length >= 4 ? '设备返回了 Auth 材料；官方 App 下一步会调用 /api/device/auth' : '握手回包未暴露四字段 Auth 材料');

    const queries = [
      [A5.SYS_PRODUCT_MODEL, '设备类型', 'deviceType'], [A5.SYS_MAX_LEN, '最大包长', 'maxLen'],
      [A5.SYS_SN, '设备 SN', 'sn'], [A5.SYS_BATTERY, '电量', 'battery'],
      [A5.SYS_PROTOCOL_VERSION, '协议版本', 'protocolVersion'], [A5.SYS_MAX_CACHE, '最大缓存', 'maxCache'],
    ];
    let infoResponses = 0;
    for (const [cmd, label, key] of queries) {
      const result = await this.querySystem(cmd, label);
      if (result) { this.deviceInfo[key] = result.value; infoResponses += 1; }
      await sleep(this.isIOS ? 80 : 35);
    }
    this.diag('info', infoResponses ? 'ok' : 'warn', `读取到 ${infoResponses}/${queries.length} 项设备信息`);

    this.diag('protocol', 'running', '检查 Thermal 05/0F');
    const thermal = await this.queryA5(A5.STATUS_PAYLOAD, { domain: A5.DOMAIN_THERMAL, command: 0x0f, timeout: this.isIOS ? 1400 : 1000 });
    this.protocolReady = Boolean(thermal);
    if (thermal) {
      this.diag('protocol', 'ok', 'A5 System + Thermal 均有响应');
      this.diag('ready', 'ok', this.authState === 'server-auth-not-reproduced' ? '兼容打印通道就绪；官方服务器鉴权未复现' : 'A5 兼容打印就绪');
    } else {
      this.diag('protocol', 'warn', 'System 握手成功，但 Thermal 05/0F 无响应');
      this.diag('ready', 'error', '暂不发送打印数据');
    }
  }

  async rerunDiagnostics() {
    if (!this.connected) throw new Error('打印机未连接');
    if (this.profile !== 'p2-a5') return { ready: this.ready, profile: this.profile };
    this.a5Parser.reset();
    await this.initializeA5Connection();
    return { ready: this.ready, profile: this.profile, authState: this.authState, deviceInfo: { ...this.deviceInfo } };
  }

  async ensureProtocolReady() {
    if (this.profile !== 'p2-a5') return this.ready;
    if (this.protocolReady) return true;
    const response = await this.queryA5(A5.STATUS_PAYLOAD, { domain: A5.DOMAIN_THERMAL, command: 0x0f, timeout: this.isIOS ? 1300 : 900 });
    this.protocolReady = Boolean(response); return this.protocolReady;
  }

  async detectProfile() {
    try {
      const service = await this.server.getPrimaryService(UUIDS.P2_SERVICE);
      const write = await service.getCharacteristic(UUIDS.P2_WRITE); const notify = [];
      for (const uuid of [UUIDS.P2_NOTIFY, UUIDS.P2_STATUS_NOTIFY]) try { notify.push(await service.getCharacteristic(uuid)); } catch (_) {}
      return { profile: 'p2-a5', write, notify };
    } catch (_) {}
    const service = await this.server.getPrimaryService(UUIDS.P1_SERVICE); const chars = await service.getCharacteristics();
    const byUuid = new Map(chars.map((c) => [c.uuid.toLowerCase(), c]));
    let write = byUuid.get(UUIDS.P1_WRITE_8841) || byUuid.get(UUIDS.P1_WRITE_6DAA);
    if (!write) write = chars.find((c) => c.properties?.writeWithoutResponse || c.properties?.write || c.writeValueWithResponse || c.writeValueWithoutResponse);
    if (!write) throw new Error('找到 Paperang service，但没有可写 characteristic');
    const notify = []; const known = byUuid.get(UUIDS.P1_NOTIFY); if (known) notify.push(known);
    for (const c of chars) if ((c.properties?.notify || c.properties?.indicate) && !notify.includes(c)) notify.push(c);
    return { profile: 'p1', write, notify };
  }

  async disconnect() { try { if (this.device?.gatt?.disconnect) this.device.gatt.disconnect(); } finally { this.reset(); } }
  onDisconnected() { this.emit('log', '设备已断开'); this.reset(); this.emit('disconnected', {}); }
  reset(clearDevice = true) {
    for (const w of this.a5Waiters) { clearTimeout(w.timer); w.resolve(null); }
    this.a5Waiters.clear(); this.a5Parser.reset(); this.server = null; this.profile = null; this.writeChar = null; this.notifyChars = [];
    this.sessionConnected = false; this.protocolReady = false; this.deviceInfo = {}; this.handshake = null; this.authState = 'unknown';
    if (clearDevice) this.device = null;
  }

  async writeChunk(chunk, { preferResponse = false } = {}) {
    if (!this.connected) throw new Error('打印机未连接'); const p = this.writeChar.properties || {};
    if (preferResponse && this.writeChar.writeValueWithResponse) { await this.writeChar.writeValueWithResponse(chunk); return; }
    if ((p.writeWithoutResponse || !p.write) && this.writeChar.writeValueWithoutResponse) { await this.writeChar.writeValueWithoutResponse(chunk); return; }
    if (this.writeChar.writeValueWithResponse) { await this.writeChar.writeValueWithResponse(chunk); return; }
    await this.writeChar.writeValue(chunk);
  }

  async writeFrame(frame, { preserveFrame = false, preferResponse = false } = {}) {
    const configured = Math.max(20, Math.min(512, Number(this.gattChunk) || 237));
    if ((this.profile === 'p2-a5' || preserveFrame) && frame.length <= 237) {
      try { await this.writeChunk(frame, { preferResponse }); return; }
      catch (error) { this.emit('log', `单帧写入失败，尝试保守分片：${error.message}`); }
    }
    if (this.profile === 'p1' && this.isIOS && frame.length <= 180) { await this.writeChunk(frame, { preferResponse: true }); return; }
    const size = this.isIOS ? Math.min(configured, 180) : configured;
    for (let i = 0; i < frame.length; i += size) { await this.writeChunk(frame.slice(i, i + size), { preferResponse: this.isIOS || preferResponse }); if (frame.length > size) await sleep(this.isIOS ? 10 : 4); }
  }

  async setDensity(value) {
    const d = Math.max(0, Math.min(100, Number(value) | 0));
    if (this.profile === 'p1') { await this.writeFrame(packP1Frame(P1.SET_DENSITY, new Uint8Array([d])), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 80 : 20); }
    else if (this.profile === 'p2-a5') await this.queryA5(new Uint8Array([0x05, 0x11, 0x03, 0x02, 0x00, d, 0x00]), { domain: 0x05, command: 0x11, timeout: this.isIOS ? 1000 : 700 });
    else throw new Error('未知打印协议');
  }
  async selfTest() { if (this.profile !== 'p1') throw new Error('P2 FF00/A5 自检命令尚未被可靠映射'); await this.writeFrame(packP1Frame(P1.SELF_TEST, new Uint8Array([0])), { preferResponse: this.isIOS }); }
  async feed(mm, widthBytes = null) {
    const a = Math.max(0, Math.min(100, Number(mm) || 0));
    if (this.profile === 'p1') { await this.writeFrame(packP1Frame(P1.FEED_LINE, u16le(Math.round(a * 56))), { preferResponse: this.isIOS }); return; }
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
    await this.writeFrame(packP1Frame(P1.DEFAULT_PARAMS, new Uint8Array([0])), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 100 : 40);
    await this.writeFrame(packP1Frame(P1.SET_PAPER_TYPE, new Uint8Array([0])), { preferResponse: this.isIOS }); await sleep(this.isIOS ? 80 : 20);
    const size = (this.isIOS ? 3 : 10) * w; let idx = 0;
    for (let o = 0; o < r.length; o += size) { const c = r.slice(o, o + size); await this.writeFrame(packP1Frame(P1.PRINT_DATA, c, idx), { preferResponse: this.isIOS }); idx = (idx + 1) & 255; this.emit('progress', { sent: Math.min(o + c.length, r.length), total: r.length }); await sleep(this.isIOS ? 18 : 8); }
    if (f > 0) await this.feed(f, w);
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
