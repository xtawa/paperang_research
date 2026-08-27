import {
  A5, P1, buildA5PrintDataPayload, a5PrintChunkSize, packA5Frame,
  packP1Frame, p1RegistrationFrame, u16le,
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

export class PaperangWebTransport extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.profile = null;
    this.writeChar = null;
    this.notifyChars = [];
    this.gattChunk = 237;
    this.onDisconnected = this.onDisconnected.bind(this);
  }

  get connected() { return Boolean(this.device?.gatt?.connected && this.writeChar); }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  async requestAndConnect() {
    if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth');
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
    for (const characteristic of this.notifyChars) {
      try {
        await characteristic.startNotifications();
        characteristic.addEventListener('characteristicvaluechanged', (event) => {
          const bytes = new Uint8Array(event.target.value.buffer.slice(
            event.target.value.byteOffset,
            event.target.value.byteOffset + event.target.value.byteLength,
          ));
          this.emit('notification', { uuid: characteristic.uuid, bytes });
        });
      } catch (error) {
        this.emit('log', `通知订阅失败 ${characteristic.uuid}: ${error.message}`);
      }
    }

    if (this.profile === 'p1') {
      await this.writeFrame(p1RegistrationFrame());
      await sleep(80);
    } else if (this.profile === 'p2-a5') {
      await this.writeFrame(packA5Frame(A5.STATUS_PAYLOAD));
      await sleep(250);
    }

    this.emit('connected', { name: this.device.name || 'Unknown', profile: this.profile });
    return { name: this.device.name || 'Unknown', profile: this.profile };
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
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.reset();
  }

  onDisconnected() {
    this.emit('log', '设备已断开');
    this.reset();
    this.emit('disconnected', {});
  }

  reset() {
    this.server = null; this.profile = null; this.writeChar = null; this.notifyChars = [];
  }

  async writeChunk(chunk) {
    if (!this.connected) throw new Error('打印机未连接');
    if (this.writeChar.properties.writeWithoutResponse && this.writeChar.writeValueWithoutResponse) {
      await this.writeChar.writeValueWithoutResponse(chunk);
    } else if (this.writeChar.writeValueWithResponse) {
      await this.writeChar.writeValueWithResponse(chunk);
    } else {
      await this.writeChar.writeValue(chunk);
    }
  }

  async writeFrame(frame) {
    const size = Math.max(20, Math.min(512, Number(this.gattChunk) || 237));
    // A5 was physically validated with complete frames up to 237 bytes per BLE write.
    // Preserve that boundary first; only fall back to smaller writes if the browser/backend rejects it.
    if (this.profile === 'p2-a5' && frame.length <= 237) {
      try {
        await this.writeChunk(frame);
        return;
      } catch (error) {
        this.emit('log', `A5 单帧写入失败，尝试按 ${size} bytes 分片：${error.message}`);
      }
    }
    for (let i = 0; i < frame.length; i += size) {
      await this.writeChunk(frame.slice(i, i + size));
      if (frame.length > size) await sleep(4);
    }
  }

  async setDensity(value) {
    const density = Math.max(0, Math.min(100, Number(value) | 0));
    if (this.profile === 'p1') {
      await this.writeFrame(packP1Frame(P1.SET_DENSITY, new Uint8Array([density])));
    } else if (this.profile === 'p2-a5') {
      await this.writeFrame(packA5Frame(new Uint8Array([0x05, 0x11, 0x03, 0x02, 0x00, density, 0x00])));
    } else throw new Error('未知打印协议');
  }

  async selfTest() {
    if (this.profile !== 'p1') throw new Error('P2 FF00/A5 自检命令尚未被可靠映射');
    await this.writeFrame(packP1Frame(P1.SELF_TEST, new Uint8Array([0])));
  }

  async feed(mm, widthBytes = null) {
    const amount = Math.max(0, Math.min(100, Number(mm) || 0));
    if (this.profile === 'p1') {
      const units = Math.round(amount * 56);
      await this.writeFrame(packP1Frame(P1.FEED_LINE, u16le(units)));
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
    if (this.profile === 'p1') return this.printP1(raster, widthBytes, feedMm);
    if (this.profile === 'p2-a5') return this.printA5(raster, widthBytes, feedMm);
    throw new Error('未知打印协议');
  }

  async printP1(raster, widthBytes, feedMm) {
    if (widthBytes !== 48) throw new Error('P1 当前实现要求 384px / 48 bytes 每行');
    await this.writeFrame(packP1Frame(P1.DEFAULT_PARAMS, new Uint8Array([0])));
    await sleep(40);
    await this.writeFrame(packP1Frame(P1.SET_PAPER_TYPE, new Uint8Array([0])));
    const chunkSize = 10 * widthBytes; // 480B = whole rows, widely cross-validated.
    let packetIndex = 0;
    for (let offset = 0; offset < raster.length; offset += chunkSize) {
      const chunk = raster.slice(offset, offset + chunkSize);
      await this.writeFrame(packP1Frame(P1.PRINT_DATA, chunk, packetIndex));
      packetIndex = (packetIndex + 1) & 0xff;
      this.emit('progress', { sent: Math.min(offset + chunk.length, raster.length), total: raster.length });
      await sleep(8);
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
    await this.writeFrame(packA5Frame(A5.STATUS_PAYLOAD));
    await sleep(300);
    await this.writeFrame(packA5Frame(A5.START_RASTER_PAYLOAD));
    await sleep(100);
    const chunkSize = a5PrintChunkSize(widthBytes);
    let chunkNumber = 1;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.slice(offset, offset + chunkSize);
      const final = offset + chunk.length >= data.length;
      await this.writeFrame(packA5Frame(buildA5PrintDataPayload(chunk, chunkNumber, widthBytes, final)));
      chunkNumber += 1;
      this.emit('progress', { sent: Math.min(offset + chunk.length, data.length), total: data.length });
      await sleep(10);
    }
    await this.writeFrame(packA5Frame(A5.FINISH_RASTER_PAYLOAD));
  }
}
