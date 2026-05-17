/**
 * sRGB ↔ OKLab colour-space conversions.
 *
 * OKLab is a perceptually-uniform colour space (Björn Ottosson, 2020). Euclidean
 * distances in OKLab approximate human-perceived colour differences, which makes
 * palette-quantization decisions match what the eye actually sees. The same
 * algorithm run in RGB versus OKLab produces dramatically different palettes:
 * OKLab concentrates entries around skin tones, sky gradients, and vegetation —
 * the regions where humans are most discriminating — instead of evenly tiling
 * the linear RGB cube.
 *
 * Spec / derivation: https://bottosson.github.io/posts/oklab/
 *
 * sRGB inputs are gamma-encoded 0–255 (the canvas pixel representation).
 * Conversion path: sRGB → linear sRGB → LMS (cone responses) → cube-rooted LMS
 * → OKLab. Roundtripping back follows the same chain in reverse.
 */

// 256-entry lookup for sRGB → linear (gamma 2.4 with the small linear segment).
// 12 MP × 3 channels × `Math.pow` would be slow; the table eliminates it.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function rgbToOklab(r: number, g: number, b: number, out: Float32Array, offset: number): void {
  const lr = SRGB_TO_LINEAR[r];
  const lg = SRGB_TO_LINEAR[g];
  const lb = SRGB_TO_LINEAR[b];

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  out[offset] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_; // L  (~0..1)
  out[offset + 1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_; // a (~-0.4..0.4)
  out[offset + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_; // b (~-0.4..0.4)
}

export function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  return [linearToSrgb255(lr), linearToSrgb255(lg), linearToSrgb255(lb)];
}

function linearToSrgb255(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 255;
  const v = c < 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(v * 255);
}
