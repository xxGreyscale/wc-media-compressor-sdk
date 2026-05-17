import type { VideoTrackInfo, VideoCompressionOptions, EncodedVideoChunk_ } from './types';
import { parseHvcC, isMain10, splitAvccSample } from './hvcc';
import { HevcDecoderClient } from './hevc-decoder';

const BACKPRESSURE_LIMIT = 10;

export interface EncodeResult {
  chunks: EncodedVideoChunk_[];
  /** AVCDecoderConfigurationRecord emitted by the encoder — needed for mux. */
  avcDecoderConfig: ArrayBuffer | undefined;
  width: number;
  height: number;
  timescale: number;
}

export async function encodeVideo(
  track: VideoTrackInfo,
  options: VideoCompressionOptions,
  onProgress: (percent: number) => void,
): Promise<EncodeResult> {
  const { width, height } = resolveOutputDimensions(track, options.maxWidth);
  const needsResize = width !== track.width || height !== track.height;

  // Output framerate: capped to `maxFps` but never higher than the source.
  // Used both as a hint to the encoder (rate control) and as a target the
  // decoder-output loop drops frames against.
  const outputFps =
    options.maxFps !== undefined ? Math.min(options.maxFps, track.fps) : track.fps;
  const minFrameIntervalUs = outputFps < track.fps ? 1_000_000 / outputFps : 0;

  const chunks: EncodedVideoChunk_[] = [];
  let avcDecoderConfig: ArrayBuffer | undefined;
  let encoderError: Error | undefined;

  const codec = await pickSupportedH264Codec(width, height, outputFps, options.targetBitrate);
  if (!codec) {
    throw new Error(
      `VideoEncoder cannot encode ${width}x${height} @ ${outputFps.toFixed(1)}fps ` +
        `at ${options.targetBitrate} bps. The resolution/framerate combination exceeds ` +
        `every H.264 level the browser supports — try reducing maxWidth.`,
    );
  }

  const encoderConfig: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: options.targetBitrate,
    framerate: outputFps,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' },
  };

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description && !avcDecoderConfig) {
        avcDecoderConfig = toArrayBuffer(metadata.decoderConfig.description);
      }
      chunks.push({ chunk, isKey: chunk.type === 'key' });
    },
    error: (e) => { encoderError = e; },
  });

  encoder.configure(encoderConfig);

  // Per-frame handler: optional fps cap, optional resize, then encode.
  // Used by both the WebCodecs VideoDecoder path (H.264) and the libde265
  // worker path (HEVC) — both end up handing the encoder a VideoFrame.
  //
  // The fps cap is applied by dropping frames whose timestamp arrives before
  // the next target time. `nextEmitTargetUs` advances by `minFrameIntervalUs`
  // per emit, so the average output rate converges to exactly `outputFps`
  // regardless of source jitter.
  let nextEmitTargetUs = 0;
  let firstFrameEmitted = false;
  const handleFrame = (frame: VideoFrame): void => {
    if (encoderError) { frame.close(); return; }

    if (minFrameIntervalUs > 0) {
      if (!firstFrameEmitted) {
        firstFrameEmitted = true;
        nextEmitTargetUs = frame.timestamp + minFrameIntervalUs;
      } else if (frame.timestamp < nextEmitTargetUs) {
        frame.close();
        return;
      } else {
        nextEmitTargetUs += minFrameIntervalUs;
      }
    }

    if (needsResize) {
      const ts = frame.timestamp;
      const dur = frame.duration ?? undefined;
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d')!.drawImage(frame, 0, 0, width, height);
      frame.close();
      const resized = new VideoFrame(canvas, { timestamp: ts, duration: dur });
      encoder.encode(resized, { keyFrame: false });
      resized.close();
    } else {
      encoder.encode(frame, { keyFrame: false });
      frame.close();
    }
  };

  const isHevc = track.codec.startsWith('hvc1') || track.codec.startsWith('hev1');

  if (isHevc && !(await isVideoDecoderHevcSupported(track))) {
    await decodeHevcViaLibde265(track, handleFrame, onProgress, () => encoderError);
  } else {
    await decodeViaVideoDecoder(track, handleFrame, onProgress, () => encoderError);
  }

  await encoder.flush();
  encoder.close();

  if (encoderError) throw encoderError;

  return { chunks, avcDecoderConfig, width, height, timescale: 90000 };
}

async function isVideoDecoderHevcSupported(track: VideoTrackInfo): Promise<boolean> {
  try {
    const support = await VideoDecoder.isConfigSupported({
      codec: track.codec,
      codedWidth: track.width,
      codedHeight: track.height,
      ...(track.description ? { description: track.description } : {}),
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

async function decodeViaVideoDecoder(
  track: VideoTrackInfo,
  handleFrame: (frame: VideoFrame) => void,
  onProgress: (percent: number) => void,
  getEncoderError: () => Error | undefined,
): Promise<void> {
  let decoderError: Error | undefined;

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (getEncoderError() || decoderError) { frame.close(); return; }
      handleFrame(frame);
    },
    error: (e) => { decoderError = e; },
  });

  const decoderConfig: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    ...(track.description ? { description: track.description } : {}),
  };

  const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!decoderSupport.supported) {
    throw new Error(
      `VideoDecoder does not support codec "${track.codec}" in this browser. ` +
        `If this is an HEVC file on Chrome, the libde265 fallback should have been ` +
        `selected automatically — please report this as a bug.`,
    );
  }
  decoder.configure(decoderConfig);

  const total = track.samples.length;
  for (let i = 0; i < total; i++) {
    if (decoderError) throw decoderError;

    while (decoder.decodeQueueSize > BACKPRESSURE_LIMIT) {
      await yieldMicrotask();
    }

    const s = track.samples[i];
    decoder.decode(new EncodedVideoChunk({
      type: s.is_sync ? 'key' : 'delta',
      timestamp: Math.round((s.cts / s.timescale) * 1_000_000),
      duration: Math.round((s.duration / s.timescale) * 1_000_000),
      data: s.data,
    }));

    onProgress(Math.round(((i + 1) / total) * 100));
  }

  await decoder.flush();
  decoder.close();

  if (decoderError) throw decoderError;
}

async function decodeHevcViaLibde265(
  track: VideoTrackInfo,
  handleFrame: (frame: VideoFrame) => void,
  onProgress: (percent: number) => void,
  getEncoderError: () => Error | undefined,
): Promise<void> {
  if (!track.description) {
    throw new Error('HEVC track has no hvcC configuration — input file is malformed.');
  }

  const info = parseHvcC(track.description);

  if (isMain10(info)) {
    throw new Error(
      '10-bit HEVC (Main10 / HDR) is not supported by the libde265 fallback. ' +
        'Re-export this clip in your camera settings to "Most Compatible" / 8-bit.',
    );
  }
  if (info.chromaFormatIdc !== 1) {
    throw new Error(
      `Unsupported HEVC chroma format ${info.chromaFormatIdc} (only 4:2:0 is supported).`,
    );
  }
  if (info.parameterSets.length === 0) {
    throw new Error('HEVC hvcC contains no parameter sets (VPS/SPS/PPS).');
  }

  const client = new HevcDecoderClient();
  try {
    client.setOnFrame((yuv) => {
      if (getEncoderError()) return;
      const videoFrame = new VideoFrame(yuv.data, {
        format: 'I420',
        codedWidth: yuv.width,
        codedHeight: yuv.height,
        timestamp: Number(yuv.pts),
      });
      handleFrame(videoFrame);
    });

    await client.init(info.parameterSets);

    const total = track.samples.length;
    for (let i = 0; i < total; i++) {
      if (getEncoderError()) break;

      const s = track.samples[i];
      const nals = splitAvccSample(s.data, info.lengthSize);
      if (nals.length === 0) continue;

      const ptsUs = BigInt(Math.round((s.cts / s.timescale) * 1_000_000));
      client.feed(nals, ptsUs);

      onProgress(Math.round(((i + 1) / total) * 100));

      // Yield occasionally so the main thread can process worker messages
      // (decoded frames) and feed them to the encoder.
      if (i % 16 === 0) await yieldMicrotask();
    }

    await client.flush();
  } finally {
    client.close();
  }
}

function resolveOutputDimensions(
  track: VideoTrackInfo,
  maxWidth: number | undefined,
): { width: number; height: number } {
  if (!maxWidth || maxWidth >= track.width) {
    return { width: track.width, height: track.height };
  }
  const ratio = maxWidth / track.width;
  const height = Math.round(track.height * ratio / 2) * 2;
  return { width: maxWidth, height };
}

function yieldMicrotask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function toArrayBuffer(src: AllowSharedBufferSource): ArrayBuffer {
  const view: Uint8Array =
    src instanceof ArrayBuffer
      ? new Uint8Array(src)
      : ArrayBuffer.isView(src)
        ? new Uint8Array(src.buffer as ArrayBuffer, src.byteOffset, src.byteLength)
        : new Uint8Array(src as ArrayBufferLike);
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

/**
 * Probes H.264 Main Profile levels from lowest viable to highest and returns
 * the first codec string the browser's VideoEncoder will accept. Selecting
 * the lowest viable level maximises hardware-acceleration coverage on mobile.
 */
async function pickSupportedH264Codec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string | null> {
  const mbsPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbsPerSecond = mbsPerFrame * Math.max(1, fps);

  const levels: Array<[string, number, number]> = [
    ['1e', 1620, 40500],
    ['1f', 3600, 108000],
    ['20', 5120, 216000],
    ['28', 8192, 245760],
    ['29', 8192, 245760],
    ['2a', 8704, 522240],
    ['32', 22080, 589824],
    ['33', 36864, 983040],
    ['34', 36864, 2073600],
  ];

  for (const [suffix, maxFS, maxMBPS] of levels) {
    if (mbsPerFrame > maxFS || mbsPerSecond > maxMBPS) continue;
    const codec = `avc1.4d00${suffix}`;
    const probe = await VideoEncoder.isConfigSupported({
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
      avc: { format: 'avc' },
    });
    if (probe.supported) return codec;
  }

  return null;
}
