# @mdslabs/wc-media-compressor-sdk

In-browser **MP4 video compression**, **best-frame thumbnail extraction**, and **image compression** powered by the WebCodecs API.

No server. No FFmpeg WASM runtime. No upload. The user's file never leaves their device.

```bash
npm install @mdslabs/wc-media-compressor-sdk
```

---

## Why

This SDK uses the browser's native **WebCodecs API** — hardware-accelerated encode/decode, no WASM bootstrap, no worker pool to spin up.

- **Tiny runtime** — ~310 KB minified (mp4box bundled in; oxipng WASM lazy-loaded only when PNG output is requested)
- **Hardware-accelerated** — `VideoEncoder` / `VideoDecoder` use the device GPU/VPU when available
- **Framework-agnostic** — three plain async functions, no React/Vue/Svelte coupling
- **ESM + CJS** — works in modern bundlers and Node-based tooling

## Browser support

| Feature                         | Chrome 94+ | Safari 16.4+ | Firefox |
| ------------------------------- | :--------: | :----------: | :-----: |
| `compressVideo` (H.264 in)      |     ✅     |      ✅      |   ❌    |
| `compressVideo` (HEVC in)       |    ❌¹     |      ✅      |   ❌    |
| `extractThumbnail`              |     ✅     |      ✅      |   ⚠️²   |
| `compressImage` (JPEG/PNG/WebP) |     ✅     |      ✅      |   ✅    |
| `compressImage` (HEIC/HEIF)     |     ✅     |      ✅      |   ❌³   |

¹ Chrome lacks an HEVC decode license — it throws on HEVC input. Re-export as H.264.
² Falls back to a `<video>`-only pipeline (keyframe-accurate, not frame-accurate).
³ HEIC requires `ImageDecoder`, which Firefox does not implement.

Video output is always **H.264 MP4**. The encoder picks the lowest H.264 level that fits the input resolution and framerate (Level 3.0 → 5.2), so 720p / 1080p / 4K all work as-is.

---

## Quick start

### Compress a video

```ts
import { compressVideo } from "@mdslabs/wc-media-compressor-sdk";

const result = await compressVideo(
  file, // File from <input type="file">
  { targetBitrate: 2_000_000, maxWidth: 1280 },
  (phase, percent) => {
    console.log(phase, percent); // 'decode' | 'encode' | 'mux'
  },
);

// result.blob — compressed MP4
// result.originalBytes, result.compressedBytes, result.durationMs
download(result.blob, "compressed.mp4");
```

### Extract the best-looking thumbnail

```ts
import { extractThumbnail } from "@mdslabs/wc-media-compressor-sdk";

const { blob, timestampSeconds } = await extractThumbnail(file, "balanced");
// Or pass a quality string: 'performance' | 'balanced' | 'quality' | 'best-quality'
```

The thumbnail pipeline does a **coarse scan + two frame-accurate refinement passes** using `VideoDecoder`. It scores every candidate frame on sharpness (Tenengrad) and exposure, then picks the winner — no "first keyframe is good enough" guessing.

### Compress images (including iPhone HEIC)

```ts
import { compressImage } from "@mdslabs/wc-media-compressor-sdk";

const out = await compressImage(file, {
  outputFormats: ["jpeg", "webp", "png"],
  preset: "balanced", // or 'lossless' | 'high' | 'small' | 'tiny'
  maxWidth: 2048,
});

// out is keyed by format: out.jpeg, out.webp, out.png — each is a File
```

For batch compression:

```ts
import { compressImages } from "@mdslabs/wc-media-compressor-sdk";

const results = await compressImages(
  files.map((file) => ({ file, options: { outputFormats: ["webp"] } })),
  5, // maxConcurrency
);

// results: { file, output?, error? }[] — never throws, errors are per-item
```

---

## API

### `compressVideo(file, options, onProgress?) => Promise<VideoCompressionResult>`

```ts
interface VideoCompressionOptions {
  targetBitrate: number; // bits/sec. e.g. 2_000_000 for 2 Mbps
  maxWidth?: number; // optional cap — height derived from aspect ratio
}

interface VideoCompressionResult {
  blob: Blob; // MP4 (H.264 video + original audio passthrough)
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
}

type VideoCompressionProgressCallback = (
  phase: "decode" | "encode" | "mux",
  percent: number,
) => void;
```

**Pipeline:** demux (mp4box.js) → `VideoDecoder` → `VideoEncoder` → mux (mp4box.js). Audio is copied straight from the input — no re-encode, no quality loss, no `AudioEncoder` codec headaches.

### `extractThumbnail(file, options?) => Promise<ThumbnailResult>`

```ts
interface ThumbnailResult {
  blob: Blob; // JPEG
  timestampSeconds: number; // where in the video this came from
}

type ThumbnailQuality =
  | "performance" // ~50 frames analyzed
  | "balanced" // ~150 frames (default)
  | "quality" // ~400 frames
  | "best-quality"; // ~800 frames

interface ThumbnailOptions {
  quality?: ThumbnailQuality;
  config?: Partial<ThumbnailConfig>; // fine-grained override
}
```

Falls back to a pure `<video>`-element pipeline if the file isn't a parseable MP4/MOV.

### `compressImage(file, options?, onProgress?) => Promise<CompressedImageOutput>`

```ts
type ImageOutputFormat = "jpeg" | "webp" | "png";
type ImageCompressionPreset = "lossless" | "high" | "balanced" | "small" | "tiny";

interface ImageCompressionOptions {
  outputFormats?: ImageOutputFormat[]; // default: ['webp']
  preset?: ImageCompressionPreset; // default: 'balanced'
  quality?: number; // 0–1, overrides preset for JPEG/WebP
  pngPreset?: ImageCompressionPreset; // override PNG-specific behaviour
  targetSizeKB?: number; // binary-search quality to fit
  maxWidth?: number;
  maxHeight?: number;
  width?: number;
  height?: number;
  outputFileName?: string;
}

type CompressedImageOutput = Record<ImageOutputFormat, File>;
```

**Preset → format behaviour:**

| Preset      | JPEG / WebP `quality` | PNG behaviour                            |
| ----------- | --------------------- | ---------------------------------------- |
| `lossless`  | 1.0                   | True lossless PNG-24/32 + oxipng         |
| `high`      | 0.90                  | PNG-24, mild WebP precondition           |
| `balanced`  | 0.80                  | **PNG-8 palette** (256 adaptive colours) |
| `small`     | 0.60                  | **PNG-8 palette** (128 colours)          |
| `tiny`      | 0.40                  | **PNG-8 palette** (32 colours)           |

If you pass `quality` directly it overrides the preset for JPEG/WebP and is bucketed into the equivalent PNG mode (≥ 0.95 → `lossless`, ≥ 0.85 → `high`, ≥ 0.70 → `balanced`, ≥ 0.50 → `small`, else `tiny`).

### `compressImages(items, maxConcurrency?) => Promise<BatchImageCompressionResult[]>`

Same as `compressImage`, but parallel and never throws — errors are captured per item.

---

## PNG behaviour

PNG is fundamentally a lossless format — `canvas.toBlob` ignores its quality argument. Naively re-encoding a photo as PNG balloons the output to 5–15× the source. To make PNG output actually useful the SDK runs a four-stage pipeline:

1. **WebP precondition** — round-trip the canvas through WebP at the preset's quality to strip photographic noise. Alpha is preserved (WebP supports it). Skipped for `lossless`.
2. **Adaptive palette quantisation** — for `balanced` and below, a median-cut quantiser (the same algorithm `pngquant` uses) reduces the image to N adaptive colours. The palette tracks the image's actual colour distribution, so quality at 256 colours is far better than uniform posterisation.
3. **PNG encode** — the browser writes a standard PNG via `canvas.toBlob`. With ≤ 256 unique colours, oxipng will convert this to **PNG-8 palette mode** automatically.
4. **oxipng optimisation** — runs as WebAssembly (loaded on demand, ~160 KB single-thread build). Picks the best DEFLATE filter combination and re-packs the file. Always lossless at this step.

**Inflation guard.** If the compressed output happens to be ≥ the original (common for already-optimised graphics, screenshots, icons), the SDK returns the **original file unchanged** under the requested output name. Only triggers when the output format matches the input format and the caller didn't request a resize.

**Alpha is preserved** through every preset. PNG-8 palette mode supports per-entry alpha via the `tRNS` chunk, so even `tiny` keeps transparent regions transparent. Smooth alpha gradients block oxipng's palette conversion (it requires ≤ 256 unique RGBA tuples), so the output stays as a quantised PNG-24 in those cases — still smaller than the original, just not palette-tiny.

---

## License

MIT
