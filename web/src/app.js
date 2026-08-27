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

function selectedWidth() {
  if (transport.profile === 'p2-a5') return 576;
  if (transport.profile === 'p1') return 384;
  return Number(ui.profile.value) === 576 ? 576 : 384;
}

function updateProfileUi() {
  const w = selectedWidth();
  outputWidth = w;
  ui.width.textContent = `${w}px (${w / 8} bytes/row)`;
  if (transport.profile === 'p1') ui.profileHint.textContent = '已探测：P1 / Protocol 02 / 49535343';
  else if (transport.profile === 'p2-a5') ui.profileHint.textContent = '已探测：P2 / FF00 / A5';
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
    ui.print.disabled = !transport.connected;
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
    ui.disconnect.disabled = false; ui.feed.disabled = false;
    ui.selfTest.disabled = result.profile !== 'p1';
    ui.profile.disabled = true;
    setStatus(`已连接 ${result.name}`, 'ok');
    log(`连接成功：${result.name} · ${result.profile}`);
    updateProfileUi();
    await transport.setDensity(ui.density.value);
    log(`已设置打印浓度 ${ui.density.value}`);
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
  } finally { ui.print.disabled = !transport.connected || !raster; }
}

transport.addEventListener('progress', (e) => { ui.progress.value = e.detail.total ? e.detail.sent / e.detail.total : 0; });
transport.addEventListener('notification', (e) => log(`RX ${e.detail.uuid}`, e.detail.bytes));
transport.addEventListener('log', (e) => log(e.detail));
transport.addEventListener('disconnected', () => {
  ui.connect.disabled = false; ui.disconnect.disabled = true; ui.print.disabled = true; ui.feed.disabled = true; ui.selfTest.disabled = true; ui.profile.disabled = false;
  setStatus('未连接'); updateProfileUi();
});

ui.file.addEventListener('change', () => loadFile(ui.file.files[0]).catch((e) => { setStatus(e.message, 'error'); log(e.message); }));
ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', () => transport.disconnect());
ui.print.addEventListener('click', print);
ui.feed.addEventListener('click', async () => { try { await transport.feed(ui.feedMm.value, outputWidth / 8); log(`走纸 ${ui.feedMm.value} mm`); } catch (e) { log(`走纸失败：${e.message}`); } });
ui.selfTest.addEventListener('click', async () => { try { await transport.selfTest(); log('已发送 P1 自检命令'); } catch (e) { log(`自检失败：${e.message}`); } });
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

if (!navigator.bluetooth) {
  setStatus('此浏览器不支持 Web Bluetooth', 'error');
  ui.connect.disabled = true;
  log('Web Bluetooth 不可用。请使用桌面 Chrome/Edge 或 Android Chrome/Samsung Internet。');
} else setStatus('未连接');
updateProfileUi();
