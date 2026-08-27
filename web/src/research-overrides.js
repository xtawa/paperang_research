let mobileSelfTestButton = null;

function normalizeUuid(value) {
  return String(value || '').toLowerCase();
}

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

  // Existing public Paperang P1 work (ihciah/python-paperang/Yrr0r paperang-web)
  // uses the 49535343 BLE service with Protocol 02 and does not require the newer
  // FF00/A5 auth lifecycle. Our previous detector always tried FF00 first, which
  // could hide a simultaneously exposed legacy P1 service. For devices advertising
  // themselves explicitly as Paperang_P1, prefer that proven path and fall back to
  // FF00/A5 only when the legacy service is genuinely absent.
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

  // Do not present an unvalidated A5 command as a self-test. Public FF00/A5
  // implementations still mark built-in self-test as unmapped. Keep the known
  // command 27 only for the legacy P1 Protocol 02 profile.
  proto.selfTest = async function selfTestResearchAware() {
    if (this.profile !== 'p1') {
      throw new Error('当前设备走 FF00/A5；内置自检命令尚无可靠公开映射。若设备同时提供 49535343，重新连接后会自动优先使用老 P1 协议。');
    }
    if (!this.connected) throw new Error('打印机未连接');
    await this.writeFrame(protocol.packP1Frame(protocol.P1.SELF_TEST, new Uint8Array([0])), { preferResponse: this.isIOS });
  };

  proto.requestAndConnect = async function requestAndConnectResearchAware() {
    window.__paperangTransport = this;
    if (!this.__mobileSelfTestSyncBound) {
      Object.defineProperty(this, '__mobileSelfTestSyncBound', { value: true });
      this.addEventListener('disconnected', () => syncMobileSelfTest(this));
    }
    const result = await originalRequestAndConnect.call(this);
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
      button.innerHTML = '<span class="dock-icon">!</span><span>自检失败</span>';
      button.title = error.message || String(error);
      setTimeout(() => syncMobileSelfTest(transport), 1800);
    }
  });

  syncMobileSelfTest();
}
