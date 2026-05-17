/**
 * Adaptive palette quantizer for PNG-8 output.
 *
 * Three layered algorithm choices push perceived quality far past a textbook
 * median-cut implementation while keeping the code single-file and dependency-free:
 *
 *  1. **OKLab colour space.** All distance and centroid math runs in OKLab
 *     (perceptually uniform). The same 32-entry palette in OKLab spends its
 *     budget on colours the eye cares about (skin, sky, foliage) rather than
 *     evenly tiling the RGB cube. Roughly the gap between "obviously
 *     quantised" and "looks fine until you zoom in".
 *
 *  2. **Variance-weighted box selection.** Median-cut needs to pick which box
 *     to split next. The classic heuristic ("longest axis range") fires on
 *     outliers — one stray pixel in a corner of the cube wins. We instead
 *     split the box with the highest **sum-of-squared-deviations** (total
 *     within-cluster variance), which concentrates palette entries where the
 *     image actually has colour spread.
 *
 *  3. **K-means (Lloyd) refinement.** Once median-cut produces N centroids
 *     we run a few iterations of:
 *        a. assign each sample to its nearest centroid
 *        b. recompute centroid = mean of assigned samples
 *     Convergence is fast and visibly tightens the palette around real colour
 *     clusters that median-cut couldn't quite reach on its own.
 *
 * Floyd–Steinberg dithering runs in RGB at the end — perceptual dithering
 * would require per-pixel OKLab conversion in a tight loop (12 M cube roots
 * for a 12 MP image), and the palette-selection improvements above already
 * deliver most of the perceived quality win.
 *
 * Performance: palette construction samples ~32 k pixels regardless of input
 * size. Pixel mapping is O(N) over the full image via a 16³ RGB → palette
 * lookup grid (grid entries are decided in OKLab, lookup is RGB → constant
 * time). Typical 4–12 MP photo: 1.5–3 s.
 */

import { rgbToOklab, oklabToRgb } from "./oklab";

const SAMPLE_TARGET = 32_768;
const ALPHA_THRESHOLD = 128;
const KMEANS_ITERATIONS = 3;

interface OklabBox {
  /** Indices into the OKLab sample buffer (each index addresses a 3-stride entry). */
  indices: number[];
  /** Cached sum-of-squared-deviations from the box's mean. */
  variance: number;
}

export function medianCutQuantize(canvas: HTMLCanvasElement, maxColors: number): void {
  if (maxColors < 2) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = img.data;
  const totalPixels = data.length / 4;
  if (totalPixels === 0) return;

  // 1. Sample opaque pixels at a stride that targets ~SAMPLE_TARGET samples.
  //    Each sample is stored as a 3-stride OKLab triple in `samples`.
  const stride = Math.max(1, Math.floor(totalPixels / SAMPLE_TARGET));
  const sampleCap = Math.ceil(totalPixels / stride);
  const samples = new Float32Array(sampleCap * 3);
  let sampleCount = 0;
  for (let i = 0; i < data.length; i += 4 * stride) {
    if (data[i + 3] < ALPHA_THRESHOLD) continue;
    rgbToOklab(data[i], data[i + 1], data[i + 2], samples, sampleCount * 3);
    sampleCount++;
  }
  if (sampleCount === 0) return;

  // 2. Median-cut in OKLab. Boxes carry the cached within-cluster variance
  //    so split-selection is O(boxes) per step instead of recomputing.
  const initialIndices: number[] = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) initialIndices[i] = i;
  const boxes: OklabBox[] = [makeBox(initialIndices, samples)];

  while (boxes.length < maxColors) {
    let toSplit = -1;
    let bestVariance = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].indices.length < 2) continue;
      if (boxes[i].variance > bestVariance) {
        bestVariance = boxes[i].variance;
        toSplit = i;
      }
    }
    if (toSplit === -1 || bestVariance <= 0) break;

    const [a, c] = splitBox(boxes[toSplit], samples);
    boxes.splice(toSplit, 1, a, c);
  }

  // 3. Initial centroids: mean of each box (still in OKLab).
  const centroidsLab = new Float32Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const [L, a, b] = meanOfIndices(boxes[i].indices, samples);
    centroidsLab[i * 3] = L;
    centroidsLab[i * 3 + 1] = a;
    centroidsLab[i * 3 + 2] = b;
  }

  // 4. K-means refinement: reassign samples to nearest centroid, recompute means.
  refineCentroids(samples, sampleCount, centroidsLab);

  // 5. Convert centroids to an RGB palette for the output canvas.
  const palette = new Uint8Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const [r, g, b] = oklabToRgb(
      centroidsLab[i * 3],
      centroidsLab[i * 3 + 1],
      centroidsLab[i * 3 + 2],
    );
    palette[i * 3] = r;
    palette[i * 3 + 1] = g;
    palette[i * 3 + 2] = b;
  }

  // 6. Pre-compute a 16×16×16 RGB-cell → palette-index lookup grid. The
  //    nearest-palette decision per cell is made in OKLab, so the grid
  //    captures perceptual choice. The dither loop just walks the grid in RGB.
  const grid = buildLookupGrid(centroidsLab);

  // 7. Floyd–Steinberg dither pass through the image, writing palette colours.
  applyFloydSteinberg(data, canvas.width, canvas.height, palette, grid);

  ctx.putImageData(img, 0, 0);
}

function makeBox(indices: number[], samples: Float32Array): OklabBox {
  return { indices, variance: computeVariance(indices, samples) };
}

function computeVariance(indices: number[], samples: Float32Array): number {
  const n = indices.length;
  if (n < 2) return 0;
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (const idx of indices) {
    const off = idx * 3;
    sumL += samples[off];
    sumA += samples[off + 1];
    sumB += samples[off + 2];
  }
  const meanL = sumL / n;
  const meanA = sumA / n;
  const meanB = sumB / n;
  let variance = 0;
  for (const idx of indices) {
    const off = idx * 3;
    const dL = samples[off] - meanL;
    const dA = samples[off + 1] - meanA;
    const dB = samples[off + 2] - meanB;
    variance += dL * dL + dA * dA + dB * dB;
  }
  return variance;
}

function splitBox(box: OklabBox, samples: Float32Array): [OklabBox, OklabBox] {
  // Split along the axis with the largest range in OKLab (still using range
  // as the axis-picker — variance picks WHICH box, range picks WHICH AXIS).
  let lMin = Infinity;
  let lMax = -Infinity;
  let aMin = Infinity;
  let aMax = -Infinity;
  let bMin = Infinity;
  let bMax = -Infinity;
  for (const idx of box.indices) {
    const off = idx * 3;
    const L = samples[off];
    const A = samples[off + 1];
    const B = samples[off + 2];
    if (L < lMin) lMin = L;
    if (L > lMax) lMax = L;
    if (A < aMin) aMin = A;
    if (A > aMax) aMax = A;
    if (B < bMin) bMin = B;
    if (B > bMax) bMax = B;
  }
  const lRange = lMax - lMin;
  const aRange = aMax - aMin;
  const bRange = bMax - bMin;
  const axis = lRange >= aRange && lRange >= bRange ? 0 : aRange >= bRange ? 1 : 2;

  box.indices.sort((p, q) => samples[p * 3 + axis] - samples[q * 3 + axis]);
  const mid = Math.floor(box.indices.length / 2);
  const left = box.indices.slice(0, mid);
  const right = box.indices.slice(mid);
  return [makeBox(left, samples), makeBox(right, samples)];
}

function meanOfIndices(indices: number[], samples: Float32Array): [number, number, number] {
  const n = indices.length;
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (const idx of indices) {
    const off = idx * 3;
    sumL += samples[off];
    sumA += samples[off + 1];
    sumB += samples[off + 2];
  }
  return [sumL / n, sumA / n, sumB / n];
}

/**
 * Lloyd's algorithm. Reassign each sample to nearest centroid, then move each
 * centroid to the mean of its newly-assigned samples. A few iterations is
 * enough — convergence is fast and we don't need exact stationary points.
 */
function refineCentroids(
  samples: Float32Array,
  sampleCount: number,
  centroidsLab: Float32Array,
): void {
  const k = centroidsLab.length / 3;
  if (k < 2) return;

  const sumL = new Float32Array(k);
  const sumA = new Float32Array(k);
  const sumB = new Float32Array(k);
  const counts = new Uint32Array(k);

  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    sumL.fill(0);
    sumA.fill(0);
    sumB.fill(0);
    counts.fill(0);

    for (let i = 0; i < sampleCount; i++) {
      const off = i * 3;
      const sL = samples[off];
      const sA = samples[off + 1];
      const sB = samples[off + 2];

      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const co = c * 3;
        const dL = sL - centroidsLab[co];
        const dA = sA - centroidsLab[co + 1];
        const dB = sB - centroidsLab[co + 2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }

      sumL[best] += sL;
      sumA[best] += sA;
      sumB[best] += sB;
      counts[best]++;
    }

    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      const co = c * 3;
      centroidsLab[co] = sumL[c] / counts[c];
      centroidsLab[co + 1] = sumA[c] / counts[c];
      centroidsLab[co + 2] = sumB[c] / counts[c];
    }
  }
}

function buildLookupGrid(centroidsLab: Float32Array): Uint8Array {
  const k = centroidsLab.length / 3;
  const grid = new Uint8Array(16 * 16 * 16);
  const cellLab = new Float32Array(3);

  for (let r = 0; r < 16; r++) {
    for (let g = 0; g < 16; g++) {
      for (let b = 0; b < 16; b++) {
        rgbToOklab(r * 16 + 8, g * 16 + 8, b * 16 + 8, cellLab, 0);
        let best = 0;
        let bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const co = c * 3;
          const dL = cellLab[0] - centroidsLab[co];
          const dA = cellLab[1] - centroidsLab[co + 1];
          const dB = cellLab[2] - centroidsLab[co + 2];
          const d = dL * dL + dA * dA + dB * dB;
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
        grid[(r << 8) | (g << 4) | b] = best;
      }
    }
  }
  return grid;
}

function applyFloydSteinberg(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  palette: Uint8Array,
  grid: Uint8Array,
): void {
  const rowFloats = (width + 2) * 3;
  const errBuf = new Float32Array(rowFloats * 2);
  let curRow = 0;
  let nextRow = rowFloats;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      if (data[i + 3] < ALPHA_THRESHOLD) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
        continue;
      }

      const eOff = curRow + (x + 1) * 3;
      const r = clamp255(data[i] + errBuf[eOff]);
      const g = clamp255(data[i + 1] + errBuf[eOff + 1]);
      const b = clamp255(data[i + 2] + errBuf[eOff + 2]);

      const idx = grid[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)] * 3;
      const pr = palette[idx];
      const pg = palette[idx + 1];
      const pb = palette[idx + 2];

      data[i] = pr;
      data[i + 1] = pg;
      data[i + 2] = pb;

      const errR = r - pr;
      const errG = g - pg;
      const errB = b - pb;

      const c1 = curRow + (x + 2) * 3;
      errBuf[c1] += (errR * 7) / 16;
      errBuf[c1 + 1] += (errG * 7) / 16;
      errBuf[c1 + 2] += (errB * 7) / 16;

      const n0 = nextRow + x * 3;
      errBuf[n0] += (errR * 3) / 16;
      errBuf[n0 + 1] += (errG * 3) / 16;
      errBuf[n0 + 2] += (errB * 3) / 16;

      const n1 = nextRow + (x + 1) * 3;
      errBuf[n1] += (errR * 5) / 16;
      errBuf[n1 + 1] += (errG * 5) / 16;
      errBuf[n1 + 2] += (errB * 5) / 16;

      const n2 = nextRow + (x + 2) * 3;
      errBuf[n2] += errR / 16;
      errBuf[n2 + 1] += errG / 16;
      errBuf[n2 + 2] += errB / 16;
    }

    errBuf.fill(0, curRow, curRow + rowFloats);
    const tmp = curRow;
    curRow = nextRow;
    nextRow = tmp;
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
