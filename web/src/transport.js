import {
  A5, P1, buildA5PrintDataPayload, a5PrintChunkSize, packA5Frame,
  packP1Frame, p1RegistrationFrame, parseA5Frame, u16le,
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isIOSLike() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export class PaperangWebTransport extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.profile = null;
    this.writeChar = null;
    this.notifyChars = [];
    this.gattChunk = 237;
    this.sessionConnected = false;
    this.protocolReady = false;
    this.isIOS = isIOSLike();
    this.notificationWaiters = new Set();
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  get connected() { return Boolean(this.sessionConnected && this.writeChar); }
  get ready() { return Boolean(this.connected && (this.profile !== 'p2-a5' || this.protocolReady)); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async requestAndConnect() {
    if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth');
    this.reset(false);
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [UUIDS.P1_SERVICE, UUIDS.P2_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
    this.server = await this.device.gatt.connect();

    const detected = await this.detectProfile();
    this.profile = detected.profile;
    this.writeChar = detected.write;
    this.notifyChars = detected.notify;
    this.sessionConnected = true;

    for (const characteristic of this.notifyChars) {
      try {
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', (event) => {
          const bytes = new Uint8Array(event.target.value.buffer.slice(
            event.target.value.byteOffset,
            event.target.value.byteOffset + event.target.value.byteLength,
          ));
          this.handleNotification(characteristic.uuid, bytes);
        });
      } catch (error) {
        this.emit('log', `通知订阅失败 ${characteristic.uuid}: ${error.message}`);
      }
    }

    await sleep(this.isIOS ? 260 : 180);

    if (this.profile === 'p1') {
      await this.writeFrame(p1RegistrationFrame(), { preferResponse: this.isIOS });
      await sleep(this.isIOS ? 180 : 80);
      this.protocolReady = true;
    } else if (this.profile === 'p2-a5') {
      const response = await this.queryA5(A5.STATUS_PAYLOAD, { timeout: this.isIOS ? 1100 : 850 });
      this.protocolReady = Boolean(response);
      if (!this.protocolReady) this.emit('log', 'P2 GATT 已连接，但没有收到 A5 status 响应；暂不发送打印数据');
    }

    const detail = {
      name: this.device.name || 'Unknown',
      profile: this.profile,
      ready: this.ready,
      ios: this.isIOS,
    };
    this.emit('connected', detail);
    return detail;
  }

  handleNotification(uuid, bytes) {
    const item = { uuid, bytes };
    this.emit('notification', item);
    for (const waiter of [...this.notificationWaiters]) {
      let matched = false;
      try { matched = waiter.predicate(item); } catch (_) { matched = false; }
      if (!matched) continue;
      clearTimeout(waiter.timer);
      this.notificationWaiters.delete(waiter);
      waiter.resolve(item);
    }
  }

  waitForNotification(predicate, timeout = 900) {
    return new Promise((resolve) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.notificationWaiters.delete(waiter);
        resolve(null);
      }, timeout);
      this.notificationWaiters.add(waiter);
    });
  }

  async queryA5(payload, { timeout = 900, required = false } = {}) {
    if (!this.connected) throw new Error('打印机未连接');
    const wait = this.waitForNotification(({ bytes }) => Boolean(parseA5Frame(bytes)), timeout);
    await this.writeFrame(packA5Frame(payload), { preserveFrame: true, preferResponse: false });
    const item = await wait;
    if (!item) {
      if (required) throw new Error('打印机未响应 A5 控制命令');
      return null;
    }
    return parseA5Frame(item.bytes);
  }

  async ensureProtocolReady() {
    if (this.profile !== 'p2-a5') return this.ready;
    if (this.protocolReady) return true;
    const response = await this.queryA5(A5.STATUS_PAYLOAD, { timeout: this.isIOS ? 1200 : 900 });
    this.protocolReady = Boolean(response);
    return this.protocolReady;
  }

  async detectProfile() {
    try {
      const service = await this.server.getPrimaryService(UUIDS.P2_SERVICE);
      const write = await service.getCharacteristic(UUIDS.P2_WRITE);
      const notify = [];
      for (const uuid of [UUIDS.P2_NOTIFY, UUIDS.P2_STATUS_NOTIFY]) {
        try { notify.push(await service.getCharacteristic(uuid)); } catch (_) { /* optional */ }
      }
      return { profile: 'p2-a5', write, notify };
    } catch (_) { /* try P1 */ }

    const service = await this.server.getPrimaryService(UUIDS.P1_SERVICE);
    const chars = await service.getCharacteristics();
    const byUuid = new Map(chars.map((c) => [c.uuid.toLowerCase(), c]));
    let write = byUuid.get(UUIDS.P1_WRITE_8841) || byUuid.get(UUIDS.P1_WRITE_6DAA);
    if (!write) write = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
    if (!write) throw new Error('找到 Paperang service，但没有可写 characteristic');
    const notify = [];
    const known = byUuid.get(UUIDS.P1_NOTIFY);
    if (known) notify.push(known);
    for (const c of chars) {
      if ((c.properties.notify || c.properties.indicate) && !notify.includes(c)) notify.push(c);
    }
    return { profile: 'p1', write, notify };
  }

  async disconnect() {
    try {
      if (this.device?.gatt?.disconnect) this.device.gatt.disconnect();
    } finally {
      this.reset();
    }
  }

  onDisconnected() {
    this.emit('log', '设备已断开');
    this.reset();
    this.emit('disconnected', {});
  }

  reset(clearDevice = true) {
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.notificationWaiters.clear();
    this.server = null;
    this.profile = null;
    this.writeChar = null;
    this.notifyChars = [];
    this.sessionConnected = false;
    this.protocolReady = false;
    if (clearDevice) this.device = null;
  }

  async writeChunk(chunk, { preferResponse = false } = {}) {
    if (!this.connected) throw new Error('打印机未连接');
    const props = this.writeChar.properties || {};
    if (preferResponse && props.write && this.writeChar.writeValueWithResponse) {
      await this.writeChar.writeValueWithResponse(chunk);
      return;
    }
    if (props.writeWithoutResponse && this.writeChar.writeValueWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(chunk);
      return;
    }
    if (props.write && this.writeChar.writeValueWithResponse) {
      await this.writeChar.writeValueWithResponse(chunk);
      return;
    }
    await this.writeChar.writeValue(chunk);
  }

  async writeFrame(frame, { preserveFrame = false, preferResponse = false } = {}) {
    const configured = Math.max(20, Math.min(512, Number(this.gattChunk) || 237));
    if ((this.profile === 'p2-a5' || preserveFrame) && frame.length <= 237) {
      try {
        await this.writeChunk(frame, { preferResponse });
        return;
      } catch (error) {
        this.emit('log', `单帧写入失败，尝试保守分片：${error.message}`);
      }
    }
    if (this.profile === 'p1' && this.isIOS && frame.length <= 180) {
      await this.writeChunk(frame, { preferResponse: true });
      return;
    }
    const size = this.isIOS ? Math.min(configured, 180) : configured;
    for (let i = 0; i < frame.length; i += size) {
      await this.writeChunk(frame.slice(i, i + size), { preferResponse: this.isIOS || preferResponse });
      if (frame.length > size) await sleep(this.isIOS ? 10 : 4);
    }
  }

  async setDensity(value) {
    const density = Math.max(0, Math.min(100, Number(value) | 0));
    if (this.profile === 'p1') {
      await this.writeFrame(packP1Frame(P1.SET_DENSITY, new Uint8Array([density])), { preferResponse: this.isIOS });
      await sleep(this.isIOS ? 80 : 20);
    } else if (this.profile === 'p2-a5') {
      const payload = new Uint8Array([0x05, 0x11, 0x03, 0x02, 0x00, density, 0x00]);
      await this.queryA5(payload, { timeout: this.isIOS ? 1000 : 700 });
    } else throw new Error('未知打印协议');
  }

  async selfTest() {
    if (this.profile !== 'p1') throw new Error('P2 FF00/A5 自检命令尚未被可靠映射');
    await this.writeFrame(packP1Frame(P1.SELF_TEST, new Uint8Array([0])), { preferResponse: this.isIOS });
  }

  async feed(mm, widthBytes = null) {
    const amount = Math.max(0, Math.min(100, Number(mm) || 0));
    if (this.profile === 'p1') {
      const units = Math.round(amount * 56);
      await this.writeFrame(packP1Frame(P1.FEED_LINE, u16le(units)), { preferResponse: this.isIOS });
      return;
    }
    if (this.profile === 'p2-a5') {
      const rows = Math.max(0, Math.round(amount / 0.08472));
      if (!rows) return;
      const wb = widthBytes || 72;
      await this.printA5(new Uint8Array(rows * wb), wb, 0);
      return;
    }
    throw new Error('未知打印协议');
  }

  async printRaster(raster, widthBytes, feedMm = 5) {
    if (!this.connected) throw new Error('打印机未连接');
    if (this.profile === 'p1') return this.printP1(raster, widthBytes, feedMm);
    if (this.profile === 'p2-a5') {
      if (!await this.ensureProtocolReady()) throw new Error('P2 已连接 GATT，但协议握手未就绪，请重新连接后再试');
      return this.printA5(raster, widthBytes, feedMm);
    }
    throw new Error('未知打印协议');
  }

  async printP1(raster, widthBytes, feedMm) {
    if (widthBytes !== 48) throw new Error('P1 当前实现要求 384px / 48 bytes 每行');
    await this.writeFrame(packP1Frame(P1.DEFAULT_PARAMS, new Uint8Array([0])), { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 100 : 40);
    await this.writeFrame(packP1Frame(P1.SET_PAPER_TYPE, new Uint8Array([0])), { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 80 : 20);
    const rowsPerPacket = this.isIOS ? 3 : 10;
    const chunkSize = rowsPerPacket * widthBytes;
    let packetIndex = 0;
    for (let offset = 0; offset < raster.length; offset += chunkSize) {
      const chunk = raster.slice(offset, offset + chunkSize);
      await this.writeFrame(packP1Frame(P1.PRINT_DATA, chunk, packetIndex), { preferResponse: this.isIOS });
      packetIndex = (packetIndex + 1) & 0xff;
      this.emit('progress', { sent: Math.min(offset + chunk.length, raster.length), total: raster.length });
      await sleep(this.isIOS ? 18 : 8);
    }
    if (feedMm > 0) await this.feed(feedMm, widthBytes);
  }

  async printA5(raster, widthBytes, feedMm) {
    if (widthBytes !== 72) throw new Error('P2 FF00/A5 当前实现要求 576px / 72 bytes 每行');
    let data = raster;
    if (feedMm > 0) {
      const rows = Math.max(0, Math.round(feedMm / 0.08472));
      if (rows) {
        const merged = new Uint8Array(data.length + rows * widthBytes);
        merged.set(data); data = merged;
      }
    }
    await this.queryA5(A5.STATUS_PAYLOAD, { timeout: this.isIOS ? 1200 : 900, required: true });
    await this.queryA5(A5.START_RASTER_PAYLOAD, { timeout: this.isIOS ? 1200 : 900, required: true });
    const chunkSize = a5PrintChunkSize(widthBytes);
    let chunkNumber = 1;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.slice(offset, offset + chunkSize);
      const final = offset + chunk.length >= data.length;
      await this.writeFrame(
        packA5Frame(buildA5PrintDataPayload(chunk, chunkNumber, widthBytes, final)),
        { preserveFrame: true, preferResponse: false },
      );
      chunkNumber += 1;
      this.emit('progress', { sent: Math.min(offset + chunk.length, data.length), total: data.length });
      await sleep(this.isIOS ? 16 : 10);
    }
    const finish = await this.queryA5(A5.FINISH_RASTER_PAYLOAD, { timeout: this.isIOS ? 1400 : 1000 });
    if (!finish) {
      this.emit('log', '打印结束命令未收到 A5 ACK；已停止继续发送数据并等待设备处理');
      await sleep(this.isIOS ? 500 : 250);
    }
  }
}
