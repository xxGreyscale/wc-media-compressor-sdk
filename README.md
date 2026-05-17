# @mdslabs/wc-media-compressor-sdk

[![npm version](https://img.shields.io/npm/v/@mdslabs/wc-media-compressor-sdk.svg)](https://www.npmjs.com/package/@mdslabs/wc-media-compressor-sdk)
[![license: MIT](https://img.shields.io/npm/l/@mdslabs/wc-media-compressor-sdk.svg)](LICENSE)
[![bundle size](https://img.shields.io/badge/bundle-~328%20KB-blue.svg)](#runtime-size)

In-browser **MP4 video compression**, **image compression** (JPEG / PNG / WebP / HEIC), and **best-frame thumbnail extraction** powered by the browser's native WebCodecs API.

No server. No 25 MB FFmpeg-WASM runtime. No upload. The user's file never leaves their device.

```bash
npm install @mdslabs/wc-media-compressor-sdk
```

---

## Why

Most "compress in the browser" libraries ship a multi-megabyte FFmpeg-WASM bundle, run on a single CPU thread, and chew battery. This SDK uses the browser's **WebCodecs API** instead — hardware-accelerated encode/decode, no WASM bootstrap, no worker pool to warm up.

- **Tiny runtime** — ~328 KB minified. Specialised WASM blobs (oxipng for PNG, libheif for HEIC on Firefox, libde265 for HEVC on Chrome) are **lazy-loaded only when their format is touched**.
- **Hardware-accelerated** — `VideoEncoder` / `VideoDecoder` / `ImageDecoder` use the device GPU/VPU when available.
- **Framework-agnostic** — three plain async functions. Works in any frontend stack.
- **ESM + CJS** — modern bundlers (Vite, webpack 5, Rollup, Parcel) handle the lazy WASM imports automatically.

## Browser support

| Feature                         | Chrome 94+ | Safari 16.4+ | Firefox |
| ------------------------------- | :--------: | :----------: | :-----: |
| `compressVideo` (H.264 input)   |     ✅     |      ✅      |   ❌    |
| `compressVideo` (HEVC input)    |     ✅¹    |      ✅      |   ❌    |
| `extractThumbnail`              |     ✅     |      ✅      |   ⚠️²   |
| `compressImage` (JPEG/PNG/WebP) |     ✅     |      ✅      |   ✅    |
| `compressImage` (HEIC/HEIF)     |     ✅     |      ✅      |   ✅³   |

¹ Lazy-loaded libde265 WASM worker (~410 KB). 10-bit HDR HEVC is rejected with a clear error.
² Falls back to keyframe-accurate `<video>` seeking; refinement passes need WebCodecs.
³ Lazy-loaded libheif WASM (~1.4 MB) is downloaded on first HEIC use only.

Video output is always **H.264 MP4** (the encoder picks the H.264 level dynamically — Level 3.0 through 5.2, so 720p, 1080p, and 4K all work).

---

## Quick start

### Compress a video

```ts
import { compressVideo, probeVideo } from "@mdslabs/wc-media-compressor-sdk";

// Optional: inspect the source first so you can constrain your compression
// options against it (resolution / bitrate / fps you can't exceed).
const meta = await probeVideo(file);
// { width, height, fps, bitrate, durationSeconds, codec, hasAudio, ... }

const result = await compressVideo(
  file,                                        // File from <input type="file">
  {
    targetBitrate: 2_000_000,
    maxWidth: 1280,
    maxFps: 24,                                // drop high-fps source down to 24 fps
  },
  (phase, percent) => console.log(phase, percent), // 'decode' | 'encode' | 'mux'
);

// result.blob — compressed MP4
// result.originalBytes / result.compressedBytes / result.durationMs
```

All options are automatically clamped against the source — `compressVideo` will never upscale dimensions, raise bitrate above the input, or invent frames. Use `probeVideo()` if you want your UI to *show* only valid choices.

### Extract the best-looking thumbnail

```ts
import { extractThumbnail } from "@mdslabs/wc-media-compressor-sdk";

const { blob, timestampSeconds } = await extractThumbnail(file, "balanced");
// quality: 'performance' | 'balanced' | 'quality' | 'best-quality'
```

The pipeline scans coarse timestamps via `<video>` seeking, then refines with frame-accurate `VideoDecoder` passes. Frames are scored on sharpness (Tenengrad gradient magnitude) and exposure.

### Compress images (including iPhone HEIC)

```ts
import { compressImage } from "@mdslabs/wc-media-compressor-sdk";

const out = await compressImage(file, {
  outputFormats: ["jpeg", "webp", "png"],
  preset: "balanced", // 'lossless' | 'high' | 'balanced' | 'small' | 'tiny'
});

// out.jpeg, out.webp, out.png — each is a File
```

Batch:

```ts
import { compressImages } from "@mdslabs/wc-media-compressor-sdk";

const results = await compressImages(
  files.map((file) => ({ file, options: { outputFormats: ["webp"] } })),
  5, // maxConcurrency
);
// results: { file, output?, error? }[] — never throws, errors per-item
```

---

## API

### `compressVideo(file, options, onProgress?)`

```ts
interface VideoCompressionOptions {
  targetBitrate: number; // bits/sec; clamped to source bitrate
  maxWidth?: number;     // optional cap; clamped to source width, aspect ratio preserved
  maxFps?: number;       // optional cap; clamped to source fps; frames dropped to fit
}

interface VideoCompressionResult {
  blob: Blob; // H.264 MP4
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
}

type VideoCompressionProgressCallback = (
  phase: "decode" | "encode" | "mux",
  percent: number,
) => void;
```

All options are **automatically clamped against the source** — passing `maxWidth: 1920` to a 720p video uses 720p, passing `targetBitrate: 10_000_000` to a 4 Mbps source uses 4 Mbps, etc. The SDK never upscales.

**Pipeline:** demux (mp4box) → decode → re-encode H.264 → mux (mp4box). Audio is passed through unchanged — no AAC re-encode, no quality loss.

### `probeVideo(file)`

```ts
interface VideoMetadata {
  width: number;
  height: number;
  fps: number;
  bitrate: number;          // approximate, file size × 8 ÷ duration
  durationSeconds: number;
  codec: string;            // e.g. "avc1.640028" or "hvc1.1.6.L93.B0"
  hasAudio: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
}
```

Read the source's resolution / framerate / bitrate **without** running the full compression pipeline. Use it to build UIs that constrain user choices to values ≤ the source.

```ts
import { probeVideo, compressVideo } from "@mdslabs/wc-media-compressor-sdk";

const meta = await probeVideo(file);
// Show the user options ≤ meta.width, ≤ meta.bitrate, etc.
// Then:
const result = await compressVideo(file, {
  targetBitrate: 2_000_000,
  maxWidth: Math.min(720, meta.width),
  maxFps: 24,
});
```

Internally `probeVideo` streams the file into mp4box and resolves the moment the `moov` box is parsed — no sample extraction, low memory cost. For phone-default MP4s (moov at the start) this is typically the first 4 MB.

### `extractThumbnail(file, options?)`

```ts
type ThumbnailQuality = "performance" | "balanced" | "quality" | "best-quality";

interface ThumbnailOptions {
  quality?: ThumbnailQuality;
  config?: Partial<ThumbnailConfig>; // fine-grained override
}

interface ThumbnailResult {
  blob: Blob;              // JPEG
  timestampSeconds: number;
}
```

### `compressImage(file, options?, onProgress?)`

```ts
type ImageOutputFormat = "jpeg" | "webp" | "png";
type ImageCompressionPreset = "lossless" | "high" | "balanced" | "small" | "tiny";

interface ImageCompressionOptions {
  outputFormats?: ImageOutputFormat[];          // default: ['webp']
  preset?: ImageCompressionPreset;              // default: 'balanced'
  quality?: number;                             // overrides preset for JPEG/WebP
  pngPreset?: ImageCompressionPreset;           // force PNG-only mode independent of preset
  targetSizeKB?: number;                        // binary-search quality to fit
  maxWidth?: number;
  maxHeight?: number;
  width?: number;
  height?: number;
  outputFileName?: string;
}

type CompressedImageOutput = Record<ImageOutputFormat, File>;
```

**Preset behaviour:**

| Preset      | JPEG / WebP `quality` | PNG palette          | PNG longer-side cap |
| ----------- | --------------------- | -------------------- | ------------------- |
| `lossless`  | 1.0                   | none (PNG-24/32)     | none (original)     |
| `high`      | 0.90                  | none (PNG-24/32)     | 1080 px             |
| `balanced`  | 0.80                  | 256 adaptive colours | 720 px              |
| `small`     | 0.60                  | 256 adaptive colours | 480 px              |
| `tiny`      | 0.40                  | 128 adaptive colours | 240 px              |

JPEG and WebP outputs keep their original dimensions — the longer-side cap is **PNG-only**.

**Inflation guard.** If the matching-format output ends up ≥ input size, the slot is replaced with the original file's bytes under the configured output name. Cross-format conversions (e.g. JPEG → PNG) are never substituted (would mismatch mime type).

### `compressImages(items, maxConcurrency?)`

```ts
interface BatchImageCompressionItem {
  file: File;
  options?: ImageCompressionOptions;
  onProgress?: (progress: number) => void;
}

interface BatchImageCompressionResult {
  file: File;
  output?: CompressedImageOutput;
  error?: Error;                                // captured per-item; never throws
}
```

---

## How PNG output works

PNG is fundamentally lossless — `canvas.toBlob('image/png')` ignores its quality argument. Naively re-encoding a photo as PNG balloons the output to 5–15× the source. To make PNG output actually useful, the SDK runs a four-stage pipeline:

1. **Dimension cap** — the canvas is scaled so its longer side ≤ the preset's cap (`1080 / 720 / 480 / 240` for `high / balanced / small / tiny`). Aspect ratio is preserved. This is the single biggest size lever.
2. **Perceptual adaptive palette** — median-cut quantiser in **OKLab** colour space (perceptually uniform), boxes split by **variance** rather than longest axis, palette refined with 3 iterations of **k-means**. Quality at 256 colours is far above naïve median-cut because palette entries land where the eye actually discriminates (skin, sky, foliage). Floyd–Steinberg dithering completes the pass.
3. **PNG encode (raw)** — oxipng writes the file directly from raw pixel data via `optimise_raw`, skipping the browser's libpng encoder. With ≤ 256 unique RGBA tuples after step 2, oxipng auto-converts to **PNG-8 palette mode**.
4. **oxipng level 6** — exhaustive filter search + `optimiseAlpha: true` (strips uniformly-opaque alpha channels that block palette-mode conversion). WASM module is loaded on demand (~160 KB single-thread build).

## HEIC decoding

HEIC inputs use a two-tier decode path:

1. **WebCodecs `ImageDecoder`** (Chrome 94+, Safari 16.4+) — native, hardware-accelerated.
2. **libheif WASM** — automatically loaded when `ImageDecoder` is unavailable or rejects the file's HEIC variant. ~1.4 MB, downloaded only on first HEIC use.

## HEVC video on Chrome

Chrome ships without an HEVC decoder license, so iPhone HEVC video (`hvc1` / `hev1`) normally fails to decompress in the browser. The SDK transparently routes HEVC inputs through a **libde265 WASM worker** on Chrome:

- Codec sniffing in the demux step → dispatches HEVC to the worker, H.264 to native `VideoDecoder`.
- Worker decode runs on a dedicated thread; main thread stays responsive throughout.
- YUV planes are packed to I420 and fed straight to the hardware `VideoEncoder` (output is always H.264 MP4).
- 10-bit HEVC (Main10 / HDR) is rejected with a clear error rather than producing broken output. Workaround: in iPhone settings, switch to "Most Compatible".

**Vite users:** add `optimizeDeps: { exclude: ['@yume-chan/libde265'] }` to your `vite.config.ts`. The emscripten module shape confuses Vite's dependency pre-bundler.

---

## Runtime size

| What gets shipped       | When                              | Size      |
| ----------------------- | --------------------------------- | --------- |
| Main SDK bundle         | always                            | 328 KB    |
| HEVC decoder worker     | always (3 KB stub + lazy WASM)    | 3 KB      |
| `oxipng` WASM           | on first PNG output               | ~160 KB   |
| `libheif` WASM          | HEIC input + ImageDecoder absent  | ~1.4 MB   |
| `libde265` WASM         | HEVC input + no native HEVC       | ~410 KB   |

So a JPEG → WebP workflow pays only the 328 KB main bundle. iPhone-photo HEIC workflows on Chrome/Safari add ~160 KB (oxipng) if they also emit PNG. Firefox HEIC workflows add libheif. HEVC-on-Chrome adds libde265.

## Comparison

| | This SDK | FFmpeg WASM |
|---|---|---|
| Bundle size | ~330 KB main | 25–30 MB |
| Hardware acceleration | ✅ GPU/VPU | ❌ CPU only |
| Battery / heat impact | Low | High |
| HEIC decode | Native or 1.4 MB libheif | WASM port |
| HEVC decode (Chrome) | 410 KB libde265 worker | Bundled |
| Audio re-encode | Passthrough (no loss) | Re-encoded |
| Format breadth | MP4/MOV + JPEG/PNG/WebP/HEIC | Everything |

If you need MKV → WebM, AVI → anything, audio normalisation — use FFmpeg WASM. If you need **fast, lightweight compression of phone media for upload** — use this.

---

## Development

```bash
git clone https://github.com/xxGreyscale/wc-media-compressor-sdk.git
cd wc-media-compressor-sdk
npm install
npm run dev          # vite dev server for the bundled vanilla demo
npm run build        # tsup + tsc → dist/
npm run typecheck
npm run lint
```

Repository layout:

```
src/         # SDK source — published to npm
  video/     # MP4 compression pipeline + HEVC worker
  image/     # image compression (canvas + ImageDecoder + libheif paths)
  thumbnail/ # best-frame extraction
  shared/    # cross-module utilities
demo/        # vanilla TS playground (not published)
examples/    # framework examples (not published)
  react-vite/
```

## License

MIT
