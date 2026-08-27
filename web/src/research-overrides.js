let mobileSelfTestButton = null;

function normalizeUuid(value) {
  return String(value || '').toLowerCase();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function syncMobileSelfTest(transport = window.__paperangTransport) {
  if (!mobileSelfTestButton) return;
  const legacyP1 = Boolean(transport?.connected && transport?.profile === 'p1');
  mobileSelfTestButton.disabled = !legacyP1;
  mobileSelfTestButton.innerHTML = legacyP1
    ? '<span class="dock-icon">⚙</span><span>自检</span>'
    : '<span class="dock-icon">⚙</span><span>自检不可用</span>';
  mobileSelfTestButton.title = legacyP1
    ? '发送公开 Paperang P1 Protocol 02 的自检命令 27'
    : '当前 FF00/A5 自检尚无可靠公开映射；若设备同时提供 49535343，将自动优先切到老 P1 协议';
}

async function detectLegacyP1(instance, UUIDS) {
  const service = await instance.server.getPrimaryService(UUIDS.P1_SERVICE);
  const chars = await service.getCharacteristics();
  const byUuid = new Map(chars.map((c) => [normalizeUuid(c.uuid), c]));
  let write = byUuid.get(normalizeUuid(UUIDS.P1_WRITE_8841)) || byUuid.get(normalizeUuid(UUIDS.P1_WRITE_6DAA));
  if (!write) write = chars.find((c) => c.properties?.writeWithoutResponse || c.properties?.write || c.writeValueWithResponse || c.writeValueWithoutResponse);
  if (!write) throw new Error('49535343 service exists but has no writable characteristic');

  const notify = [];
  const known = byUuid.get(normalizeUuid(UUIDS.P1_NOTIFY));
  if (known) notify.push(known);
  for (const c of chars) {
    if ((c.properties?.notify || c.properties?.indicate) && !notify.includes(c)) notify.push(c);
  }
  return { profile: 'p1', write, notify };
}

export function installResearchOverrides(PaperangWebTransport, UUIDS, protocol) {
  const proto = PaperangWebTransport.prototype;
  if (proto.__paperangResearchOverridesInstalled) return;
  Object.defineProperty(proto, '__paperangResearchOverridesInstalled', { value: true });

  const originalDetectProfile = proto.detectProfile;
  const originalRequestAndConnect = proto.requestAndConnect;
  const originalDisconnect = proto.disconnect;
  const originalSetDensity = proto.setDensity;
  const originalFeed = proto.feed;
  const originalPrintP1 = proto.printP1;

  const p1Frame = (command, payload = new Uint8Array(), packetIndex = 0) =>
    protocol.packP1Frame(command, payload, packetIndex, protocol.P1_SESSION_CRC_KEY);

  // Existing public Paperang P1 work (ihciah/miaomiaoji-tool/Yrr0r paperang-web)
  // uses the 49535343 BLE service with Protocol 02. Prefer that proven path on a
  // device explicitly named Paperang_P1 and only fall back to FF00/A5 if absent.
  proto.detectProfile = async function detectProfileResearchAware() {
    const name = String(this.device?.name || '');
    if (/^Paperang[_ -]?P1$/i.test(name)) {
      try {
        const legacy = await detectLegacyP1(this, UUIDS);
        this.emit('log', '检测到 Paperang_P1：优先采用公开研究已验证的 49535343 / Protocol 02 WebBLE 路径');
        return legacy;
      } catch (error) {
        this.emit('log', `Paperang_P1 未暴露可用 49535343 service，回退 FF00/A5：${error.message}`);
      }
    }
    return originalDetectProfile.call(this);
  };

  // Once SET_CRC_KEY is sent, all later Protocol-02 packets must use the negotiated
  // session key. The previous browser implementation accidentally registered a new
  // key and then kept CRC'ing commands with the standard seed, so the printer could
  // silently discard self-test and raster packets.
  proto.setDensity = async function setDensityResearchAware(value) {
    if (this.profile !== 'p1') return originalSetDensity.call(this, value);
    const density = Math.max(0, Math.min(100, Number(value) | 0));
    await this.writeFrame(p1Frame(protocol.P1.SET_DENSITY, new Uint8Array([density])), { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 80 : 20);
  };

  proto.selfTest = async function selfTestResearchAware() {
    if (this.profile !== 'p1') {
      throw new Error('当前设备走 FF00/A5；内置自检命令尚无可靠公开映射。若设备同时提供 49535343，重新连接后会自动优先使用老 P1 协议。');
    }
    if (!this.connected) throw new Error('打印机未连接');
    const frame = p1Frame(protocol.P1.SELF_TEST, new Uint8Array([0]));
    this.emit('log', `P1 Protocol 02：发送自检 command 27，session CRC key=0x${protocol.P1_SESSION_CRC_KEY.toString(16).padStart(8, '0')}`);
    await this.writeFrame(frame, { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 180 : 80);
  };

  proto.feed = async function feedResearchAware(mm, widthBytes = null) {
    if (this.profile !== 'p1') return originalFeed.call(this, mm, widthBytes);
    const amount = Math.max(0, Math.min(100, Number(mm) || 0));
    await this.writeFrame(p1Frame(protocol.P1.FEED_LINE, protocol.u16le(Math.round(amount * 56))), { preferResponse: this.isIOS });
  };

  proto.printP1 = async function printP1ResearchAware(raster, widthBytes, feedMm) {
    if (this.profile !== 'p1') return originalPrintP1.call(this, raster, widthBytes, feedMm);
    if (widthBytes !== 48) throw new Error('P1 当前实现要求 384px / 48 bytes 每行');

    await this.writeFrame(p1Frame(protocol.P1.DEFAULT_PARAMS, new Uint8Array([0])), { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 100 : 40);
    await this.writeFrame(p1Frame(protocol.P1.SET_PAPER_TYPE, new Uint8Array([0])), { preferResponse: this.isIOS });
    await sleep(this.isIOS ? 80 : 20);

    const size = (this.isIOS ? 3 : 10) * widthBytes;
    let packetIndex = 0;
    for (let offset = 0; offset < raster.length; offset += size) {
      const chunk = raster.slice(offset, offset + size);
      await this.writeFrame(p1Frame(protocol.P1.PRINT_DATA, chunk, packetIndex), { preferResponse: this.isIOS });
      packetIndex = (packetIndex + 1) & 0xff;
      this.emit('progress', { sent: Math.min(offset + chunk.length, raster.length), total: raster.length });
      await sleep(this.isIOS ? 18 : 8);
    }
    if (feedMm > 0) await this.feed(feedMm, widthBytes);
  };

  proto.requestAndConnect = async function requestAndConnectResearchAware() {
    window.__paperangTransport = this;
    if (!this.__mobileSelfTestSyncBound) {
      Object.defineProperty(this, '__mobileSelfTestSyncBound', { value: true });
      this.addEventListener('disconnected', () => syncMobileSelfTest(this));
    }
    const result = await originalRequestAndConnect.call(this);
    if (result.profile === 'p1') {
      this.emit('log', `P1 CRC session 已初始化：0x${protocol.P1_SESSION_CRC_KEY.toString(16).padStart(8, '0')}；后续 Protocol 02 命令使用 session CRC`);
    }
    syncMobileSelfTest(this);
    return result;
  };

  proto.disconnect = async function disconnectResearchAware() {
    const result = await originalDisconnect.call(this);
    syncMobileSelfTest(this);
    return result;
  };
}

export function installMobileSelfTestButton() {
  const dock = document.querySelector('.mobile-dock');
  if (!dock || document.getElementById('mobileSelfTestProxy')) return;

  const button = document.createElement('button');
  button.id = 'mobileSelfTestProxy';
  button.className = 'dock-btn';
  button.type = 'button';
  button.disabled = true;
  button.innerHTML = '<span class="dock-icon">⚙</span><span>自检不可用</span>';
  const print = document.getElementById('mobilePrintProxy');
  dock.insertBefore(button, print || null);
  dock.style.gridTemplateColumns = '1fr 1fr 1.45fr';
  mobileSelfTestButton = button;

  button.addEventListener('click', async () => {
    const transport = window.__paperangTransport;
    if (!transport) return;
    try {
      await transport.selfTest();
      button.innerHTML = '<span class="dock-icon">✓</span><span>已发送自检</span>';
      setTimeout(() => syncMobileSelfTest(transport), 1200);
    } catch (error) {
      transport.emit?.('log', `自检失败：${error.message || error}`);
      button.innerHTML = '<span class="dock-icon">!</span><span>自检失败</span>';
      button.title = error.message || String(error);
      setTimeout(() => syncMobileSelfTest(transport), 1800);
    }
  });

  syncMobileSelfTest();
}
