export const P1_A5_PRINT_END_PAYLOAD = new Uint8Array([0x05, 0x1a, 0x01, 0x00, 0x00]);

export function normalizedA5Model(instance) {
  return String(instance?.deviceInfo?.deviceType || '').replace(/[^\x20-\x7e]/g, '').trim().toUpperCase();
}

export function isP1A5Device(instance) {
  return instance?.profile === 'p2-a5' && /^P1(?:\b|$)/.test(normalizedA5Model(instance));
}

export function p1A5ChunkSize(widthBytes = 48, maxFrameSize = 237, overhead = 26) {
  if (!Number.isInteger(widthBytes) || widthBytes <= 0) throw new RangeError('widthBytes must be positive');
  const maxData = maxFrameSize - overhead;
  return Math.max(1, Math.floor(maxData / widthBytes)) * widthBytes;
}

export function installP1A5Overrides(PaperangWebTransport, protocol) {
  const { A5, a5PrintChunkSize, buildA5PrintDataPayload, packA5Frame } = protocol;
  const proto = PaperangWebTransport.prototype;
  if (proto.__paperangP1A5Installed) return;
  Object.defineProperty(proto, '__paperangP1A5Installed', { value: true });

  const originalProbe = proto.probeCompatibilityThermal;
  const originalEnsure = proto.ensureProtocolReady;
  const originalPrintA5 = proto.printA5;

  proto.probeCompatibilityThermal = async function probeCompatibilityThermalP1Aware() {
    if (!isP1A5Device(this)) return originalProbe.call(this);

    this.diag('compat', 'running', 'P1+A5：用 05/19 PrintStart 探测打印通道（05/0F 是 report event，不作状态查询）');
    const start = await this.queryA5(A5.START_RASTER_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x19,
      timeout: this.isIOS ? 1500 : 1050,
    });

    if (start) {
      const end = await this.queryA5(P1_A5_PRINT_END_PAYLOAD, {
        domain: A5.DOMAIN_THERMAL,
        command: 0x1a,
        timeout: this.isIOS ? 900 : 650,
      });
      if (!end) this.emit('log', 'P1+A5 探测：05/19 已接受，但 05/1A PrintEnd 未收到 A5 ACK');
    }

    this.compatReady = Boolean(start);
    this.protocolReady = this.compatReady;
    if (start) this.diag('compat', 'ok', 'P1+A5 05/19 PrintStart 有响应；384px 打印通道可尝试');
    else this.diag('compat', 'error', 'P1+A5 05/19 PrintStart 无 A5 响应；此时更可能是 Auth/设备状态门控');
    return this.compatReady;
  };

  proto.ensureProtocolReady = async function ensureProtocolReadyP1Aware() {
    if (!isP1A5Device(this)) return originalEnsure.call(this);
    if (this.compatReady) return true;
    return this.probeCompatibilityThermal();
  };

  proto.printA5 = async function printA5P1Aware(raster, widthBytes, feedMm) {
    if (!isP1A5Device(this)) return originalPrintA5.call(this, raster, widthBytes, feedMm);
    if (widthBytes !== 48) throw new Error('P1 + FF00/A5 要求 384px / 48 bytes 每行');
    if (!this.compatReady && !await this.probeCompatibilityThermal()) {
      throw new Error('P1+A5 PrintStart 未被设备接受；打印通道尚未就绪');
    }

    let data = raster;
    if (feedMm > 0) {
      const rows = Math.max(0, Math.round(Number(feedMm) / 0.08472));
      if (rows) {
        const merged = new Uint8Array(data.length + rows * widthBytes);
        merged.set(data);
        data = merged;
      }
    }

    this.emit('log', 'P1+A5：发送 05/19 PrintStart');
    await this.queryA5(A5.START_RASTER_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x19,
      timeout: this.isIOS ? 1500 : 1050,
      required: true,
    });

    const size = a5PrintChunkSize(widthBytes);
    let packetNumber = 1;
    for (let offset = 0; offset < data.length; offset += size) {
      const chunk = data.slice(offset, offset + size);
      const payload = buildA5PrintDataPayload(chunk, packetNumber, widthBytes, false);
      await this.writeFrame(packA5Frame(payload), { preserveFrame: true, preferResponse: false });
      packetNumber += 1;
      this.emit('progress', { sent: Math.min(offset + chunk.length, data.length), total: data.length });
      await new Promise((resolve) => setTimeout(resolve, this.isIOS ? 18 : 10));
    }

    this.emit('log', 'P1+A5：发送 05/1A PrintEnd');
    const finish = await this.queryA5(P1_A5_PRINT_END_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x1a,
      timeout: this.isIOS ? 1400 : 1000,
    });
    if (!finish) this.emit('log', 'P1+A5：05/1A PrintEnd 未收到 A5 ACK；不再继续发送');
  };
}
