export const P1_A5_PRINT_END_PAYLOAD = new Uint8Array([0x05, 0x1a, 0x01, 0x00, 0x00]);
export const P1_A5_SELF_TEST_PAYLOAD = new Uint8Array([0x05, 0x17, 0x01, 0x00, 0x00]);

export function normalizedA5Model(instance) {
  return String(instance?.deviceInfo?.deviceType || '').replace(/[^\x20-\x7e]/g, '').trim().toUpperCase();
}

export function isP1A5Device(instance) {
  return instance?.profile === 'p2-a5' && /^P1(?:\b|$)/.test(normalizedA5Model(instance));
}

export function decodeA5ResponseEnvelope(result) {
  const parsed = result?.parsed;
  if (!parsed || parsed.kind !== 0x02) return { state: 'unknown', code: null, data: new Uint8Array() };
  const args = parsed.args instanceof Uint8Array ? parsed.args : new Uint8Array(parsed.args || []);
  if (args.length < 3) return { state: 'unknown', code: null, data: args };
  const code = args[0];
  const len = args[1] | (args[2] << 8);
  if (len !== args.length - 3) return { state: 'unknown', code, data: args.slice(3) };
  // APK static constants confirm response envelope types:
  // 01 = OK, 02 = ERROR, 03 = INVALID.
  if (code === 0x01) return { state: 'ok', code, data: args.slice(3) };
  if (code === 0x02) return { state: 'error', code, data: args.slice(3) };
  if (code === 0x03) return { state: 'invalid', code, data: args.slice(3) };
  return { state: 'unknown', code, data: args.slice(3) };
}

function assertA5Accepted(result, label) {
  const status = decodeA5ResponseEnvelope(result);
  if (status.state === 'ok') return status;
  const code = status.code == null ? '??' : `0x${status.code.toString(16).padStart(2, '0')}`;
  if (status.state === 'error') {
    throw new Error(`${label} 被设备拒绝（response envelope ${code} / ERROR）。System 已连接，但该操作尚未获准；优先检查官方 Auth/onDevConnSuccess 状态。`);
  }
  if (status.state === 'invalid') {
    throw new Error(`${label} 被设备判定为 INVALID（response envelope ${code}）。`);
  }
  throw new Error(`${label} 返回未知 A5 响应（code=${code}）`);
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
  const originalSelfTest = proto.selfTest;

  proto.probeCompatibilityThermal = async function probeCompatibilityThermalP1Aware() {
    if (!isP1A5Device(this)) return originalProbe.call(this);

    this.diag('compat', 'running', 'P1+A5：用 05/19 PrintStart 探测打印通道（05/0F 是 report event，不作状态查询）');
    const start = await this.queryA5(A5.START_RASTER_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x19,
      timeout: this.isIOS ? 1500 : 1050,
    });

    const startStatus = decodeA5ResponseEnvelope(start);
    const accepted = startStatus.state === 'ok';

    // A response frame is not automatically an ACK. Real P1 FF00/A5 captures show
    // 01 0000 for accepted commands (e.g. density) and 02 0000 for rejected print
    // commands. Only close an actually accepted probe.
    if (accepted) {
      const end = await this.queryA5(P1_A5_PRINT_END_PAYLOAD, {
        domain: A5.DOMAIN_THERMAL,
        command: 0x1a,
        timeout: this.isIOS ? 900 : 650,
      });
      const endStatus = decodeA5ResponseEnvelope(end);
      if (endStatus.state !== 'ok') this.emit('log', `P1+A5 探测：05/1A PrintEnd 未被确认（state=${endStatus.state}, code=${endStatus.code ?? 'n/a'}）`);
    }

    this.compatReady = accepted;
    this.protocolReady = this.compatReady;
    if (accepted) this.diag('compat', 'ok', 'P1+A5 05/19 PrintStart 返回 OK(01)；384px 打印会话可用');
    else if (startStatus.state === 'error') this.diag('compat', 'error', 'P1+A5 05/19 返回 ERROR(02 0000)：命令格式可识别，但设备拒绝开始打印；优先检查 Auth/onDevConnSuccess');
    else if (startStatus.state === 'invalid') this.diag('compat', 'error', 'P1+A5 05/19 返回 INVALID(03)：当前 PrintStart 请求不适用于设备状态/协议');
    else if (start) this.diag('compat', 'error', `P1+A5 05/19 有响应但状态未知（code=${startStatus.code ?? 'n/a'}）`);
    else this.diag('compat', 'error', 'P1+A5 05/19 无 A5 响应；打印通道未就绪');
    return this.compatReady;
  };

  proto.ensureProtocolReady = async function ensureProtocolReadyP1Aware() {
    if (!isP1A5Device(this)) return originalEnsure.call(this);
    if (this.compatReady) return true;
    return this.probeCompatibilityThermal();
  };

  // APK Protocol_A5 has data_thermal_child_self_test_page = 0x17 and selfTest()
  // takes no arguments. Keep this diagnostic available whenever GATT is connected,
  // even when PrintStart is auth-gated, so P1 FF00/A5 users can test the device
  // without falsely marking the entire print pipeline ready.
  proto.selfTest = async function selfTestP1A5Aware() {
    if (!isP1A5Device(this)) return originalSelfTest.call(this);
    if (!this.connected) throw new Error('打印机未连接');

    this.emit('log', 'P1+A5：发送 05/17 SelfTestPage');
    const response = await this.queryA5(P1_A5_SELF_TEST_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x17,
      timeout: this.isIOS ? 1500 : 1050,
      required: true,
    });
    const status = assertA5Accepted(response, 'P1+A5 05/17 SelfTestPage');
    this.emit('log', 'P1+A5：05/17 SelfTestPage 返回 OK(01)');
    return status;
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
    const start = await this.queryA5(A5.START_RASTER_PAYLOAD, {
      domain: A5.DOMAIN_THERMAL,
      command: 0x19,
      timeout: this.isIOS ? 1500 : 1050,
      required: true,
    });
    assertA5Accepted(start, 'P1+A5 05/19 PrintStart');

    // For P1+A5 we keep every 05/1B data packet as TYPE_REQUEST and close the job
    // explicitly with 05/1A. This follows the APK's printStart/printData/printFinish
    // method family instead of P2's final-chunk/05/22 behavior.
    const size = a5PrintChunkSize(widthBytes);
    let packetNumber = 1;
    for (let offset = 0; offset < data.length; offset += size) {
      const chunk = data.slice(offset, offset + size);
      const payload = buildA5PrintDataPayload(chunk, packetNumber, widthBytes, false);
      const wait = this.waitForA5(({ parsed }) => Boolean(parsed && parsed.domain === A5.DOMAIN_THERMAL && parsed.command === 0x1b), this.isIOS ? 1000 : 700);
      await this.writeFrame(packA5Frame(payload), { preserveFrame: true, preferResponse: false });
      const ack = await wait;
      if (!ack) throw new Error(`P1+A5 05/1B 第 ${packetNumber} 包未收到响应`);
      assertA5Accepted(ack, `P1+A5 05/1B 第 ${packetNumber} 包`);
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
    if (!finish) throw new Error('P1+A5：05/1A PrintEnd 未收到 A5 响应');
    assertA5Accepted(finish, 'P1+A5 05/1A PrintEnd');
  };
}
