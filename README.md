# @mdslabs/webcodecs-media-compressor

In-browser **MP4 video compression**, **best-frame thumbnail extraction**, and **image compression** powered by the WebCodecs API.

No server. No FFmpeg WASM runtime. No upload. The user's file never leaves their device.

```bash
npm install @mdslabs/webcodecs-mp4
```

---

## Why

This SDK uses the browser's native **WebCodecs API** instead — hardware-accelerated encode/decode, no WASM, no worker bootstrap.

- **Tiny runtime** — ~300 KB minified (mp4box bundled in)
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

Output is always **H.264 MP4** (`avc1.4d001f` — Main Profile, Level 3.1).

---

## Quick start

### Compress a video

```ts
import { compressVideo } from "@mdslabs/webcodecs-mp4";

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
import { extractThumbnail } from "@mdslabs/webcodecs-mp4";

const { blob, timestampSeconds } = await extractThumbnail(file, "balanced");
// Or pass a quality string: 'performance' | 'balanced' | 'quality' | 'best-quality'
```

The thumbnail pipeline does a **coarse scan + two frame-accurate refinement passes** using `VideoDecoder`. It scores every candidate frame on sharpness (Tenengrad) and exposure, then picks the winner — no "first keyframe is good enough" guessing.

### Compress images (including iPhone HEIC)

```ts
import { compressImage } from "@mdslabs/webcodecs-mp4";

const out = await compressImage(file, {
  outputFormats: ["jpeg", "webp"],
  quality: 0.82,
  maxWidth: 2048,
});

// out is keyed by format: out.jpeg, out.webp — each is a File
```

For batch compression:

```ts
import { compressImages } from "@mdslabs/webcodecs-mp4";

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
interface ImageCompressionOptions {
  outputFormats?: ("jpeg" | "webp" | "png")[]; // default: ['jpeg']
  quality?: number; // 0–1, default 0.82
  targetSizeKB?: number; // binary-search quality to fit
  maxWidth?: number;
  maxHeight?: number;
  width?: number;
  height?: number;
  outputFileName?: string;
}

type CompressedImageOutput = Record<string, File>; // keyed by format
```

### `compressImages(items, maxConcurrency?) => Promise<BatchImageCompressionResult[]>`

Same as `compressImage`, but parallel and never throws — errors are captured per item.

## License

MIT
