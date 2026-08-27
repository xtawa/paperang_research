export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function packBinaryPixels(binary, width, height) {
  if (width % 8 !== 0) throw new RangeError('Printer raster width must be divisible by 8');
  if (binary.length !== width * height) throw new RangeError('Binary pixel length mismatch');
  const rowBytes = width / 8;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    for (let bx = 0; bx < rowBytes; bx += 1) {
      let value = 0;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value << 1) | (binary[y * width + bx * 8 + bit] ? 1 : 0);
      }
      out[y * rowBytes + bx] = value;
    }
  }
  return out;
}

export function thresholdPixels(gray, threshold = 128, invert = false) {
  const t = clamp(Number(threshold), 0, 255);
  const out = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) {
    const black = gray[i] < t;
    out[i] = (invert ? !black : black) ? 1 : 0;
  }
  return out;
}

export function floydSteinberg(gray, width, height, threshold = 128, invert = false) {
  const work = new Float32Array(gray);
  const out = new Uint8Array(gray.length);
  const t = clamp(Number(threshold), 0, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const old = clamp(work[i], 0, 255);
      const quant = old < t ? 0 : 255;
      const black = quant === 0;
      out[i] = (invert ? !black : black) ? 1 : 0;
      const err = old - quant;
      if (x + 1 < width) work[i + 1] += err * 7 / 16;
      if (y + 1 < height) {
        if (x > 0) work[i + width - 1] += err * 3 / 16;
        work[i + width] += err * 5 / 16;
        if (x + 1 < width) work[i + width + 1] += err / 16;
      }
    }
  }
  return out;
}

export function atkinson(gray, width, height, threshold = 128, invert = false) {
  const work = new Float32Array(gray);
  const out = new Uint8Array(gray.length);
  const t = clamp(Number(threshold), 0, 255);
  const add = (x, y, err) => { if (x >= 0 && x < width && y >= 0 && y < height) work[y * width + x] += err / 8; };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const old = clamp(work[i], 0, 255);
      const quant = old < t ? 0 : 255;
      const black = quant === 0;
      out[i] = (invert ? !black : black) ? 1 : 0;
      const err = old - quant;
      add(x + 1, y, err); add(x + 2, y, err);
      add(x - 1, y + 1, err); add(x, y + 1, err); add(x + 1, y + 1, err);
      add(x, y + 2, err);
    }
  }
  return out;
}

export function imageDataToGray(imageData, contrast = 0, brightness = 0) {
  const src = imageData.data;
  const out = new Uint8Array(imageData.width * imageData.height);
  const c = clamp(Number(contrast), -100, 100);
  const b = clamp(Number(brightness), -100, 100) * 2.55;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0, p = 0; i < src.length; i += 4, p += 1) {
    const alpha = src[i + 3] / 255;
    const r = src[i] * alpha + 255 * (1 - alpha);
    const g = src[i + 1] * alpha + 255 * (1 - alpha);
    const bl = src[i + 2] * alpha + 255 * (1 - alpha);
    let v = 0.299 * r + 0.587 * g + 0.114 * bl;
    v = factor * (v - 128) + 128 + b;
    out[p] = clamp(Math.round(v), 0, 255);
  }
  return out;
}
