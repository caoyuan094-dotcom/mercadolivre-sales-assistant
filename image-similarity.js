(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MLSAImageSimilarity = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const HASH_WIDTH = 9;
  const HASH_HEIGHT = 8;
  const HISTOGRAM_BINS = 4;

  async function createSignature(source) {
    const image = await loadImage(source);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContained(context, image, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    return {
      hash: createDifferenceHash(pixels, canvas.width, canvas.height),
      histogram: createColorHistogram(pixels),
      mask: createForegroundMask(pixels, canvas.width, canvas.height),
      aspect: image.naturalWidth / Math.max(1, image.naturalHeight)
    };
  }

  function compareSignatures(reference, candidate) {
    if (!reference?.hash?.length || !candidate?.hash?.length) return 0;
    const hashLength = Math.min(reference.hash.length, candidate.hash.length);
    let equalBits = 0;
    for (let index = 0; index < hashLength; index += 1) {
      if (reference.hash[index] === candidate.hash[index]) equalBits += 1;
    }
    const textureScore = equalBits / hashLength;
    const maskScore = compareMasks(reference.mask, candidate.mask);
    const histogramLength = Math.min(reference.histogram?.length || 0, candidate.histogram?.length || 0);
    let colorScore = 0;
    for (let index = 0; index < histogramLength; index += 1) {
      colorScore += Math.min(reference.histogram[index], candidate.histogram[index]);
    }
    const aspectScore = Math.min(reference.aspect || 1, candidate.aspect || 1)
      / Math.max(reference.aspect || 1, candidate.aspect || 1);
    return clamp(textureScore * 0.25 + maskScore * 0.35 + colorScore * 0.35 + aspectScore * 0.05);
  }

  function createDifferenceHash(pixels, width, height) {
    const values = [];
    for (let y = 0; y < HASH_HEIGHT; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / HASH_HEIGHT));
      for (let x = 0; x < HASH_WIDTH; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / HASH_WIDTH));
        const offset = (sourceY * width + sourceX) * 4;
        values.push(pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114);
      }
    }
    const hash = [];
    for (let y = 0; y < HASH_HEIGHT; y += 1) {
      for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
        const offset = y * HASH_WIDTH + x;
        hash.push(values[offset] > values[offset + 1] ? 1 : 0);
      }
    }
    return hash;
  }

  function createColorHistogram(pixels) {
    const histogram = new Array(HISTOGRAM_BINS ** 3).fill(0);
    let count = 0;
    for (let offset = 0; offset < pixels.length; offset += 16) {
      if (pixels[offset + 3] < 32) continue;
      if (isNearWhite(pixels[offset], pixels[offset + 1], pixels[offset + 2])) continue;
      const r = Math.min(HISTOGRAM_BINS - 1, Math.floor(pixels[offset] / (256 / HISTOGRAM_BINS)));
      const g = Math.min(HISTOGRAM_BINS - 1, Math.floor(pixels[offset + 1] / (256 / HISTOGRAM_BINS)));
      const b = Math.min(HISTOGRAM_BINS - 1, Math.floor(pixels[offset + 2] / (256 / HISTOGRAM_BINS)));
      histogram[r * HISTOGRAM_BINS * HISTOGRAM_BINS + g * HISTOGRAM_BINS + b] += 1;
      count += 1;
    }
    return histogram.map((value) => value / Math.max(1, count));
  }

  function createForegroundMask(pixels, width, height) {
    const mask = [];
    for (let y = 0; y < 16; y += 1) {
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / 16));
      for (let x = 0; x < 16; x += 1) {
        const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / 16));
        const offset = (sourceY * width + sourceX) * 4;
        mask.push(pixels[offset + 3] >= 32 && !isNearWhite(pixels[offset], pixels[offset + 1], pixels[offset + 2]) ? 1 : 0);
      }
    }
    return mask;
  }

  function compareMasks(a, b) {
    const length = Math.min(a?.length || 0, b?.length || 0);
    if (!length) return 0;
    let intersection = 0;
    let union = 0;
    for (let index = 0; index < length; index += 1) {
      if (a[index] || b[index]) union += 1;
      if (a[index] && b[index]) intersection += 1;
    }
    return union ? intersection / union : 1;
  }

  function isNearWhite(red, green, blue) {
    return red > 235 && green > 235 && blue > 235;
  }

  function drawContained(context, image, width, height) {
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("图片无法读取"));
      image.src = source;
    });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("图片文件读取失败"));
      reader.readAsDataURL(file);
    });
  }

  function clamp(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  return { createSignature, compareSignatures, fileToDataUrl };
});
