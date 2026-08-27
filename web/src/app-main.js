import { atkinson, floydSteinberg, imageDataToGray, packBinaryPixels, thresholdPixels } from './raster.js';
import { PaperangWebTransport } from './transport.js';
import { hex } from './protocol.js';

const $ = (id) => document.getElementById(id);
const ui = {
  file: $('imageFile'), source: $('sourceCanvas'), preview: $('previewCanvas'), connect: $('connectBtn'), disconnect: $('disconnectBtn'),
  print: $('printBtn'), feed: $('feedBtn'), selfTest: $('selfTestBtn'), status: $('status'), profile: $('profile'), profileHint: $('profileHint'),
  width: $('width'), threshold: $('threshold'), thresholdValue: $('thresholdValue'), contrast: $('contrast'), contrastValue: $('contrastValue'),
  brightness: $('brightness'), brightnessValue: $('brightnessValue'), dither: $('dither'), invert: $('invert'), rotate: $('rotate'), scale: $('scale'), scaleValue: $('scaleValue'),
  density: $('density'), densityValue: $('densityValue'), feedMm: $('feedMm'), gattChunk: $('gattChunk'), log: $('log'),
  meta: $('imageMeta'), progress: $('progress'), clearLog: $('clearLog'), exportRaster: $('exportRaster'),
  mobileConnect: $('mobileConnectProxy'), mobilePrint: $('mobilePrintProxy'), paperWidthLabel: $('paperWidthLabel'),
  diagSummary: $('diagSummary'), diagList: $('diagList'), deviceInfoPanel: $('deviceInfoPanel'), rerunDiag: $('rerunDiagBtn'), exportDiag: $('exportDiagBtn'),
};

const transport = new PaperangWebTransport();
let imageBitmap = null;
let raster = null;
let outputWidth = 384;
let outputHeight = 0;

function log(message, bytes = null) {
  const time = new Date().toLocaleTimeString();
  const line = `[${time}] ${message}${bytes ? `\n  ${hex(bytes)}` : ''}`;
  ui.log.textContent = `${line}\n${ui.log.textContent}`.slice(0, 30000);
}

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}

const diagLabels = { running: '进行中', ok: '成功', warn: '注意', error: '失败', idle: '待定' };
function resetDiagnostics() {
  for (const row of ui.diagList?.querySelectorAll('.diag-row') || []) {
    row.dataset.state = 'idle'; row.querySelector('strong').textContent = '等待'; row.title = '';
  }
  if (ui.diagSummary) ui.diagSummary.textContent = '等待连接';
  if (ui.deviceInfoPanel) ui.deviceInfoPanel.textContent = '尚未读取设备信息';
  if (ui.rerunDiag) ui.rerunDiag.disabled = true;
  if (ui.exportDiag) ui.exportDiag.disabled = true;
}

function modelName() {
  return String(transport.deviceInfo?.deviceType || '').replace(/[^\x20-\x7e]/g, '').trim();
}

function modelRasterWidth() {
  const model = modelName().toUpperCase();
  if (/^P1(?:\b|$)/.test(model)) return 384;
  if (/^P2(?:\b|$)/.test(model)) return 576;
  return null;
}

function formatDeviceValue(key, value) {
  if (key === 'battery' && Number.isFinite(Number(value))) {
    const raw = Number(value);
    const percent = raw > 100 ? raw / 10 : raw;
    return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
  }
  if (key === 'maxLen' && Number.isFinite(Number(value))) return `${Number(value)} B`;
  return value;
}

function renderDeviceInfo(info = {}, authState = '') {
  if (!ui.deviceInfoPanel) return;
  const lines = [];
  const labels = { softwareVersion: 'SW', deviceType: 'Type', sn: 'SN', battery: 'Battery', protocolVersion: 'Protocol', maxLen: 'MaxLen', maxCache: 'MaxCache' };
  for (const [key, label] of Object.entries(labels)) {
    if (info[key] !== undefined && info[key] !== null && String(info[key]) !== '') lines.push(`${label}: ${formatDeviceValue(key, info[key])}`);
  }
  if (authState) lines.push(`Auth: ${authState}`);
  lines.push(`Official ready: ${transport.officialReady ? 'yes' : 'no'}`);
  lines.push(`Compat ready: ${transport.compatReady ? 'yes' : 'no'}`);
  ui.deviceInfoPanel.textContent = lines.length ? lines.join('\n') : '设备已连接，尚未解析到 System 信息';
}
function updateDiagnostic(detail) {
  const row = ui.diagList?.querySelector(`[data-stage="${detail.stage}"]`);
  if (row) {
    row.dataset.state = detail.state;
    row.querySelector('strong').textContent = diagLabels[detail.state] || detail.state;
    row.title = detail.detail || '';
    const label = row.querySelector('span');
    if (label && detail.detail) label.title = detail.detail;
  }
  if (ui.diagSummary) ui.diagSummary.textContent = detail.detail || `${detail.stage}: ${diagLabels[detail.state] || detail.state}`;
  renderDeviceInfo(detail.deviceInfo || {}, detail.authState || '');
  if (ui.exportDiag) ui.exportDiag.disabled = false;
}

function selectedWidth() {
  const actual = modelRasterWidth();
  if (actual) return actual;
  if (transport.profile === 'p1') return 384;
  if (transport.profile === 'p2-a5') return 576;
  return Number(ui.profile.value) === 576 ? 576 : 384;
}

function updateProfileUi() {
  const w = selectedWidth();
  outputWidth = w;
  ui.width.textContent = `${w}px (${w / 8} bytes/row)`;
  if (ui.paperWidthLabel) ui.paperWidthLabel.textContent = `${w} DOTS`;
  const model = modelName();
  if (transport.profile === 'p1') ui.profileHint.textContent = '已探测：P1 / Protocol 02 / 49535343';
  else if (transport.profile === 'p2-a5') ui.profileHint.textContent = model ? `已探测：${model} · FF00 / A5 · ${w}px` : `已探测：FF00 / A5 · ${w}px`;
  else ui.profileHint.textContent = w === 384 ? '预览：P1 384px' : '预览：P2 576px';
  render();
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > 25 * 1024 * 1024) throw new Error('图片过大，请使用 25 MB 以下文件');
  if (imageBitmap) imageBitmap.close?.();
  imageBitmap = await createImageBitmap(file);
  ui.meta.textContent = `${file.name} · ${imageBitmap.width}×${imageBitmap.height} · ${(file.size / 1024).toFixed(0)} KB`;
  render();
}

function drawSource(width) {
  if (!imageBitmap) return null;
  const rotation = Number(ui.rotate.value);
  const rotated = rotation === 90 || rotation === 270;
  const iw = rotated ? imageBitmap.height : imageBitmap.width;
  const ih = rotated ? imageBitmap.width : imageBitmap.height;
  const scaleRatio = Math.max(0.1, Math.min(1, Number(ui.scale.value) / 100));
  const contentWidth = Math.max(8, Math.floor(width * scaleRatio / 8) * 8);
  const contentHeight = Math.max(1, Math.round(ih * (contentWidth / iw)));
  if (contentHeight > 12000) throw new Error('输出高度超过 12000px，请降低缩放或裁剪原图');
  const canvas = ui.source;
  canvas.width = width; canvas.height = contentHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, contentHeight);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const x = Math.round((width - contentWidth) / 2);
  ctx.save();
  if (rotation === 0) ctx.drawImage(imageBitmap, x, 0, contentWidth, contentHeight);
  else {
    ctx.translate(width / 2, contentHeight / 2);
    ctx.rotate(rotation * Math.PI / 180);
    const rw = rotation === 90 || rotation === 270 ? contentHeight : contentWidth;
    const rh = rotation === 90 || rotation === 270 ? contentWidth : contentHeight;
    ctx.drawImage(imageBitmap, -rw / 2, -rh / 2, rw, rh);
  }
  ctx.restore();
  return ctx.getImageData(0, 0, width, contentHeight);
}

function render() {
  if (!imageBitmap) { raster = null; ui.print.disabled = true; ui.exportRaster.disabled = true; return; }
  try {
    const width = selectedWidth();
    const imageData = drawSource(width);
    const gray = imageDataToGray(imageData, ui.contrast.value, ui.brightness.value);
    let binary;
    if (ui.dither.value === 'floyd') binary = floydSteinberg(gray, width, imageData.height, ui.threshold.value, ui.invert.checked);
    else if (ui.dither.value === 'atkinson') binary = atkinson(gray, width, imageData.height, ui.threshold.value, ui.invert.checked);
    else binary = thresholdPixels(gray, ui.threshold.value, ui.invert.checked);

    raster = packBinaryPixels(binary, width, imageData.height);
    outputWidth = width; outputHeight = imageData.height;
    const canvas = ui.preview; canvas.width = width; canvas.height = outputHeight;
    const ctx = canvas.getContext('2d');
    const out = ctx.createImageData(width, outputHeight);
    for (let i = 0; i < binary.length; i += 1) {
      const v = binary[i] ? 0 : 255;
      const p = i * 4; out.data[p] = v; out.data[p + 1] = v; out.data[p + 2] = v; out.data[p + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    ui.meta.textContent = `${ui.file.files?.[0]?.name || '图片'} · 输出 ${width}×${outputHeight}px · raster ${(raster.length / 1024).toFixed(1)} KB`;
    ui.print.disabled = !transport.ready;
    if (ui.mobilePrint) ui.mobilePrint.disabled = !transport.ready;
    ui.exportRaster.disabled = false;
  } catch (error) {
    setStatus(error.message, 'error'); log(`渲染失败：${error.message}`);
  }
}

async function connect() {
  try {
    ui.connect.disabled = true; setStatus('正在选择并连接设备…');
    transport.gattChunk = Number(ui.gattChunk.value);
    const result = await transport.requestAndConnect();
    ui.disconnect.disabled = false; ui.feed.disabled = !result.ready;
    if (ui.rerunDiag) ui.rerunDiag.disabled = result.profile !== 'p2-a5';
    if (ui.mobileConnect) ui.mobileConnect.innerHTML = result.compatReady
      ? '<span class="dock-icon">✓</span><span>兼容就绪</span>'
      : '<span class="dock-icon">!</span><span>仅 GATT</span>';
    ui.selfTest.disabled = result.profile !== 'p1' || !result.ready;
    ui.profile.disabled = true;
    renderDeviceInfo(result.deviceInfo || {}, result.authState || '');
    if (result.compatReady) {
      setStatus(`已连接 ${result.name} · 兼容打印通道就绪`, 'ok');
      log(`连接成功：${result.name} · ${result.profile} · compat ready · official=${Boolean(result.officialReady)}`);
    } else {
      setStatus(`已连接 ${result.name} · 仅 GATT / 查看诊断`, 'error');
      log(`GATT 已连接：${result.name} · ${result.profile}，官方/兼容初始化未完成；请导出诊断 JSON`);
    }
    updateProfileUi();
    if (result.ready) {
      await transport.setDensity(ui.density.value);
      log(`已设置打印浓度 ${ui.density.value}`);
    }
  } catch (error) {
    setStatus(`连接失败：${error.message}`, 'error'); log(`连接失败：${error.stack || error.message}`);
  } finally { ui.connect.disabled = transport.connected; }
}

async function print() {
  if (!raster) return;
  try {
    ui.print.disabled = true; ui.progress.value = 0;
    transport.gattChunk = Number(ui.gattChunk.value);
    await transport.setDensity(ui.density.value);
    log(`开始打印 ${outputWidth}×${outputHeight}px, ${raster.length} bytes`);
    await transport.printRaster(raster, outputWidth / 8, Number(ui.feedMm.value));
    ui.progress.value = 1; setStatus('打印数据发送完成', 'ok'); log('打印数据发送完成');
  } catch (error) {
    setStatus(`打印失败：${error.message}`, 'error'); log(`打印失败：${error.stack || error.message}`);
  } finally { ui.print.disabled = !transport.ready || !raster; if (ui.mobilePrint) ui.mobilePrint.disabled = !transport.ready || !raster; }
}

function showDiagnosticText(text) {
  document.getElementById('paperangDiagOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'paperangDiagOverlay';
  Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '9999', background: 'rgba(0,0,0,.72)', padding: 'max(16px, env(safe-area-inset-top)) 14px max(16px, env(safe-area-inset-bottom))', display: 'flex', alignItems: 'center', justifyContent: 'center' });
  const card = document.createElement('div');
  Object.assign(card.style, { width: 'min(760px,100%)', maxHeight: '88vh', display: 'grid', gridTemplateRows: 'auto minmax(0,1fr) auto', gap: '10px', background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '16px', padding: '14px' });
  const title = document.createElement('strong'); title.textContent = '诊断 JSON · 可长按全选复制';
  const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true;
  Object.assign(ta.style, { width: '100%', minHeight: '52vh', resize: 'none', border: '1px solid var(--border)', borderRadius: '10px', background: 'var(--code)', color: '#d7dae0', padding: '10px', font: '11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace' });
  const actions = document.createElement('div'); Object.assign(actions.style, { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' });
  const copy = document.createElement('button'); copy.className = 'btn primary'; copy.type = 'button'; copy.textContent = '复制 JSON';
  const close = document.createElement('button'); close.className = 'btn'; close.type = 'button'; close.textContent = '关闭';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text); copy.textContent = '✓ 已复制'; log('诊断 JSON 已复制到剪贴板');
    } catch (_) {
      ta.focus(); ta.select();
      try { document.execCommand('copy'); copy.textContent = '✓ 已复制'; log('诊断 JSON 已通过兼容方式复制'); }
      catch (_) { copy.textContent = '请长按文本复制'; }
    }
  });
  close.addEventListener('click', () => overlay.remove());
  actions.append(copy, close); card.append(title, ta, actions); overlay.append(card); document.body.append(overlay);
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); }, 0);
}

async function exportDiagnostic() {
  const report = transport.getDiagnosticReport();
  const text = JSON.stringify(report, null, 2);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `paperang-diagnostic-${stamp}.json`;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch (_) {}

  try {
    if (typeof File !== 'undefined' && navigator.share && navigator.canShare) {
      const file = new File([text], fileName, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Paperang diagnostic JSON' });
        log(`已通过系统分享导出诊断 JSON${copied ? '，同时已复制到剪贴板' : ''}`);
        return;
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') log(`系统分享不可用：${e.message || e}`);
  }

  if (!transport.isIOS) {
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      log(`已触发诊断 JSON 下载${copied ? '，同时已复制到剪贴板' : ''}`);
      return;
    } catch (_) {}
  }

  showDiagnosticText(text);
  log(copied ? 'Bluefy/iOS 下载受限：JSON 已复制到剪贴板，并已打开可复制文本' : 'Bluefy/iOS 下载受限：已打开完整 JSON，可长按全选复制');
}

transport.addEventListener('progress', (e) => { ui.progress.value = e.detail.total ? e.detail.sent / e.detail.total : 0; });
transport.addEventListener('notification', (e) => log(`RX ${e.detail.uuid}`, e.detail.bytes));
transport.addEventListener('log', (e) => log(e.detail));
transport.addEventListener('diagnostic', (e) => updateDiagnostic(e.detail));
transport.addEventListener('disconnected', () => {
  ui.connect.disabled = false; ui.disconnect.disabled = true; ui.print.disabled = true; ui.feed.disabled = true; ui.selfTest.disabled = true; ui.profile.disabled = false;
  if (ui.mobilePrint) ui.mobilePrint.disabled = true;
  if (ui.mobileConnect) ui.mobileConnect.innerHTML = '<span class="dock-icon">⌁</span><span>连接</span>';
  if (ui.rerunDiag) ui.rerunDiag.disabled = true;
  setStatus('设备已断开 · 可导出上次诊断', 'error');
  if (ui.diagSummary) ui.diagSummary.textContent = '设备已断开，诊断数据已保留';
  if (ui.exportDiag) ui.exportDiag.disabled = false;
  updateProfileUi();
});

ui.file.addEventListener('change', () => loadFile(ui.file.files[0]).catch((e) => { setStatus(e.message, 'error'); log(e.message); }));
ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', () => transport.disconnect());
ui.print.addEventListener('click', print);
ui.mobileConnect?.addEventListener('click', () => transport.connected ? transport.disconnect() : connect());
ui.mobilePrint?.addEventListener('click', print);
ui.feed.addEventListener('click', async () => { try { await transport.feed(ui.feedMm.value, outputWidth / 8); log(`走纸 ${ui.feedMm.value} mm`); } catch (e) { log(`走纸失败：${e.message}`); } });
ui.selfTest.addEventListener('click', async () => { try { await transport.selfTest(); log('已发送 P1 自检命令'); } catch (e) { log(`自检失败：${e.message}`); } });
ui.rerunDiag?.addEventListener('click', async () => {
  try {
    ui.rerunDiag.disabled = true; setStatus('正在重新执行官方连接诊断…');
    const result = await transport.rerunDiagnostics();
    renderDeviceInfo(result.deviceInfo || {}, result.authState || '');
    ui.feed.disabled = !result.ready;
    if (raster) { ui.print.disabled = !result.ready; if (ui.mobilePrint) ui.mobilePrint.disabled = !result.ready; }
    if (ui.mobileConnect) ui.mobileConnect.innerHTML = result.compatReady
      ? '<span class="dock-icon">✓</span><span>兼容就绪</span>'
      : '<span class="dock-icon">!</span><span>仅 GATT</span>';
    updateProfileUi();
    setStatus(result.compatReady ? '兼容 A5 打印通道已就绪 · 官方状态见诊断' : '诊断完成 · 打印通道仍未就绪', result.compatReady ? 'ok' : 'error');
  } catch (e) { setStatus(`诊断失败：${e.message}`, 'error'); log(`诊断失败：${e.stack || e.message}`); }
  finally { ui.rerunDiag.disabled = !transport.connected || transport.profile !== 'p2-a5'; }
});

ui.exportDiag?.addEventListener('click', () => { exportDiagnostic().catch((e) => log(`导出诊断失败：${e.message || e}`)); });
ui.clearLog.addEventListener('click', () => { ui.log.textContent = ''; });
ui.exportRaster.addEventListener('click', () => {
  if (!raster) return;
  const blob = new Blob([raster], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = `paperang-${outputWidth}x${outputHeight}.bin`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

for (const [control, valueNode] of [[ui.threshold, ui.thresholdValue], [ui.contrast, ui.contrastValue], [ui.brightness, ui.brightnessValue], [ui.scale, ui.scaleValue], [ui.density, ui.densityValue]]) {
  control.addEventListener('input', () => { valueNode.textContent = control.value; if (control !== ui.density) render(); });
}
for (const control of [ui.dither, ui.invert, ui.rotate]) control.addEventListener('change', render);
ui.profile.addEventListener('change', updateProfileUi);
ui.gattChunk.addEventListener('change', () => { transport.gattChunk = Number(ui.gattChunk.value); });

resetDiagnostics();

if (!navigator.bluetooth) {
  setStatus('此浏览器不支持 Web Bluetooth', 'error');
  ui.connect.disabled = true;
  if (ui.mobileConnect) ui.mobileConnect.disabled = true;
  log('Web Bluetooth 不可用。请使用桌面 Chrome/Edge 或 Android Chrome/Samsung Internet。');
} else setStatus('未连接');
updateProfileUi();