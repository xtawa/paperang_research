import { PaperangWebTransport } from './transport.js';
import * as protocol from './protocol.js';
import { installP1A5Overrides } from './p1a5.js';

installP1A5Overrides(PaperangWebTransport, protocol);

const compatLabel = document.querySelector('[data-stage="compat"] span');
if (compatLabel) compatLabel.textContent = 'A5 打印通道';

// app-main owns the transport instance and historically enables Self Test only for
// the legacy 49535343/Protocol-02 profile. P1 devices that report themselves over
// FF00/A5 still have an APK-confirmed A5 SelfTestPage command (Thermal 05/17).
// Re-enable that button when the live diagnostics identify a connected P1+A5 device.
function installP1A5SelfTestUiBridge() {
  const button = document.getElementById('selfTestBtn');
  const info = document.getElementById('deviceInfoPanel');
  const hint = document.getElementById('profileHint');
  if (!button || !info || !hint) return;

  const sync = () => {
    const p1a5 = /(?:^|\n)Type:\s*P1(?:\s|$)/i.test(info.textContent || '')
      && /FF00\s*\/\s*A5/i.test(hint.textContent || '');
    if (p1a5) {
      button.disabled = false;
      button.textContent = 'P1 A5 自检';
      button.title = '发送 APK Protocol_A5 的 Thermal 05/17 SelfTestPage；即使打印会话未 ready 也可用于诊断';
    } else if (/Protocol 02/i.test(hint.textContent || '')) {
      button.textContent = 'P1 自检';
      button.title = '';
    }
  };

  new MutationObserver(sync).observe(info, { childList: true, subtree: true, characterData: true });
  new MutationObserver(sync).observe(hint, { childList: true, subtree: true, characterData: true });
  sync();
}

import('./app-main.js').then(() => {
  installP1A5SelfTestUiBridge();
}).catch((error) => {
  console.error('Paperang app startup failed', error);
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `启动失败：${error.message || error}`;
    status.dataset.kind = 'error';
  }
});
