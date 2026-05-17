/**
 * HEVC decoder worker — runs `@yume-chan/libde265` off the main thread.
 *
 * Protocol (main → worker):
 *   { type: 'init', parameterSets: Uint8Array[] }     // VPS/SPS/PPS from hvcC
 *   { type: 'sample', nals: Uint8Array[], pts: bigint }
 *   { type: 'flush' }
 *
 * Protocol (worker → main):
 *   { type: 'ready' }                                  // after init succeeds
 *   { type: 'frame', pts: bigint, width, height, data: ArrayBuffer }
 *                                                      // I420-packed (Y | U | V), no stride padding
 *   { type: 'done' }                                   // after flush completes
 *   { type: 'error', message: string }
 *
 * Each frame is emitted as a single I420 buffer with planes packed back-to-back.
 * Strides are removed so the main thread can feed the buffer straight into a
 * `new VideoFrame(buffer, { format: 'I420', ... })`.
 */

import initLibde265 from "@yume-chan/libde265";

type LibheifModule = Awaited<ReturnType<typeof initLibde265>>;

type IncomingMessage =
  | { type: "init"; parameterSets: Uint8Array[] }
  | { type: "sample"; nals: Uint8Array[]; pts: bigint }
  | { type: "flush" };

let modulePromise: Promise<LibheifModule> | undefined;
let mod: LibheifModule | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let decoder: any;

async function ensureDecoder(): Promise<void> {
  if (!modulePromise) modulePromise = initLibde265();
  mod = await modulePromise;
  if (!decoder) decoder = new mod.Decoder();
}

function feedParameterSets(parameterSets: Uint8Array[]): void {
  for (const ps of parameterSets) {
    decoder.pushNal(ps, 0n);
  }
  decoder.pushEndOfNal();
}

function feedSample(nals: Uint8Array[], pts: bigint): void {
  for (const nal of nals) {
    decoder.pushNal(nal, pts);
  }
  decoder.pushEndOfNal();
  decoder.pushEndOfFrame();
}

function copyPlane(
  src: Uint8Array,
  srcStride: number,
  width: number,
  height: number,
  dst: Uint8Array,
  dstOffset: number,
): void {
  if (srcStride === width) {
    dst.set(src.subarray(0, width * height), dstOffset);
    return;
  }
  for (let row = 0; row < height; row++) {
    const srcStart = row * srcStride;
    dst.set(src.subarray(srcStart, srcStart + width), dstOffset + row * width);
  }
}

function emitImage(): boolean {
  const image = decoder.getNextPicture();
  if (!image) return false;

  try {
    if (image.chromaFormat !== mod!.Chroma["420"]) {
      throw new Error(
        `Unsupported HEVC chroma format ${image.chromaFormat}. Only 4:2:0 is supported.`,
      );
    }

    const yPlane = image.getImagePlane(0);
    const uPlane = image.getImagePlane(1);
    const vPlane = image.getImagePlane(2);

    const width = yPlane.width;
    const height = yPlane.height;
    const uvWidth = uPlane.width;
    const uvHeight = uPlane.height;

    const ySize = width * height;
    const uvSize = uvWidth * uvHeight;
    const buffer = new Uint8Array(ySize + 2 * uvSize);

    copyPlane(yPlane.bytes, yPlane.stride, width, height, buffer, 0);
    copyPlane(uPlane.bytes, uPlane.stride, uvWidth, uvHeight, buffer, ySize);
    copyPlane(vPlane.bytes, vPlane.stride, uvWidth, uvHeight, buffer, ySize + uvSize);

    (self as unknown as Worker).postMessage(
      {
        type: "frame",
        pts: image.pts,
        width,
        height,
        data: buffer.buffer,
      },
      [buffer.buffer],
    );
  } finally {
    image.delete();
  }
  return true;
}

function drainFrames(): void {
  for (;;) {
    const result = decoder.decode();
    if (!mod!.isOk(result.error)) {
      if (result.error === mod!.Error.ERROR_WAITING_FOR_INPUT_DATA) return;
      throw new Error(`libde265: ${mod!.getErrorText(result.error)}`);
    }
    emitImage();
    if (!result.more) return;
  }
}

self.addEventListener("message", async (e: MessageEvent<IncomingMessage>) => {
  try {
    const msg = e.data;

    if (msg.type === "init") {
      await ensureDecoder();
      feedParameterSets(msg.parameterSets);
      (self as unknown as Worker).postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "sample") {
      feedSample(msg.nals, msg.pts);
      drainFrames();
      return;
    }

    if (msg.type === "flush") {
      decoder.flushData();
      // Keep draining until libde265 reports no more pictures.
      let progressed = true;
      while (progressed) {
        const result = decoder.decode();
        if (!mod!.isOk(result.error) && result.error !== mod!.Error.ERROR_WAITING_FOR_INPUT_DATA) {
          throw new Error(`libde265 flush: ${mod!.getErrorText(result.error)}`);
        }
        progressed = emitImage();
        if (!result.more && !progressed) break;
      }
      (self as unknown as Worker).postMessage({ type: "done" });
      return;
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
