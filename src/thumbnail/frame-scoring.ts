import type { ThumbnailConfig } from "./types";

export function extractGrayAndSat(
  data: Uint8ClampedArray,
  pixelCount: number,
): { gray: Float32Array; sat: Float32Array } {
  const gray = new Float32Array(pixelCount);
  const sat = new Float32Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const r = data[i * 4] / 255;
    const g = data[i * 4 + 1] / 255;
    const b = data[i * 4 + 2] / 255;
    gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b; // Rec. 709 luminance
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    sat[i] = hi > 0 ? (hi - lo) / hi : 0;
  }

  return { gray, sat };
}

export function scoreFrame(
  gray: Float32Array,
  sat: Float32Array,
  width: number,
  height: number,
  config: ThumbnailConfig,
): number {
  const n = gray.length;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;

  if (mean < config.minMeanLum || mean > config.maxMeanLum) return -Infinity;

  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (gray[i] - mean) ** 2;
  const stdDev = Math.sqrt(varSum / n);

  if (stdDev < config.minStdDev) return -Infinity;

  const brightnessScore = Math.max(
    0,
    1 - Math.abs(mean - config.brightnessPeak) * config.brightnessPenaltyFactor,
  );

  let satSum = 0;
  for (let i = 0; i < n; i++) satSum += sat[i];
  const meanSat = satSum / n;

  const cx0 = Math.floor(width * config.centerRegionPercent);
  const cx1 = Math.ceil(width * (1 - config.centerRegionPercent));
  const cy0 = Math.floor(height * config.centerRegionPercent);
  const cy1 = Math.ceil(height * (1 - config.centerRegionPercent));

  let tenAll = 0;
  let tenCenter = 0;
  let cntAll = 0;
  let cntCenter = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const gx =
        -gray[idx - width - 1] + gray[idx - width + 1] +
        -2 * gray[idx - 1] + 2 * gray[idx + 1] +
        -gray[idx + width - 1] + gray[idx + width + 1];
      const gy =
        -gray[idx - width - 1] - 2 * gray[idx - width] - gray[idx - width + 1] +
        gray[idx + width - 1] + 2 * gray[idx + width] + gray[idx + width + 1];
      const mag2 = gx * gx + gy * gy;

      tenAll += mag2;
      cntAll++;

      if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
        tenCenter += mag2;
        cntCenter++;
      }
    }
  }

  const sharpAll = cntAll > 0 ? tenAll / cntAll : 0;
  const sharpCenter = cntCenter > 0 ? tenCenter / cntCenter : 0;
  const sharpness = config.fullSharpnessWeight * sharpAll + config.centerSharpnessWeight * sharpCenter;

  return sharpness * 1000 + meanSat * 0.5 + stdDev * 0.2 + brightnessScore * 0.1;
}
