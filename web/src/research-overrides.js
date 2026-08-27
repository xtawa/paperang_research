let mobileSelfTestButton = null;

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

export function installResearchOverrides(PaperangWebTransport) {
  const proto = PaperangWebTransport.prototype;
  if (proto.__paperangResearchOverridesInstalled) return;
  Object.defineProperty(proto, '__paperangResearchOverridesInstalled', { value: true });

  const originalRequestAndConnect = proto.requestAndConnect;
  const originalDisconnect = proto.disconnect;
  // The P1 implementation now lives in the transport so it can keep one
  // negotiated CRC state for probing, diagnostics, and printing. This wrapper
  // only keeps the mobile dock synchronized; it must not reintroduce an
  // unconditional SET_CRC_KEY or overwrite the selected write characteristic.
  proto.requestAndConnect = async function requestAndConnectResearchAware() {
    if (typeof window !== 'undefined') window.__paperangTransport = this;
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
      transport.emit?.('log', `自检失败：${error.message || error}`);
      button.innerHTML = '<span class="dock-icon">!</span><span>自检失败</span>';
      button.title = error.message || String(error);
      setTimeout(() => syncMobileSelfTest(transport), 1800);
    }
  });

  syncMobileSelfTest();
}
