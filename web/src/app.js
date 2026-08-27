import { PaperangWebTransport } from './transport.js';
import * as protocol from './protocol.js';
import { installP1A5Overrides } from './p1a5.js';

installP1A5Overrides(PaperangWebTransport, protocol);

const compatLabel = document.querySelector('[data-stage="compat"] span');
if (compatLabel) compatLabel.textContent = 'A5 打印通道';

import('./app-main.js').catch((error) => {
  console.error('Paperang app startup failed', error);
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `启动失败：${error.message || error}`;
    status.dataset.kind = 'error';
  }
});
