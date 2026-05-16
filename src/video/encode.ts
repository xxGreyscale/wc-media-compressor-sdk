import type { VideoTrackInfo, VideoCompressionOptions, EncodedVideoChunk_ } from './types';

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

  const chunks: EncodedVideoChunk_[] = [];
  let avcDecoderConfig: ArrayBuffer | undefined;
  let encoderError: Error | undefined;

  const codec = await pickSupportedH264Codec(width, height, track.fps, options.targetBitrate);
  if (!codec) {
    throw new Error(
      `VideoEncoder cannot encode ${width}x${height} @ ${track.fps.toFixed(1)}fps ` +
        `at ${options.targetBitrate} bps. The resolution/framerate combination exceeds ` +
        `every H.264 level the browser supports — try reducing maxWidth.`,
    );
  }

  const encoderConfig: VideoEncoderConfig = {
    codec,
    width,
    height,
    bitrate: options.targetBitrate,
    framerate: track.fps,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' }, // AVCC output (length-prefixed), not Annex B
  };

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description && !avcDecoderConfig) {
        // `description` is spec'd as BufferSource — Chrome returns Uint8Array,
        // others might return ArrayBuffer. Normalise to a tightly-sized
        // ArrayBuffer so mp4box reads exactly the AVCDecoderConfigurationRecord
        // bytes and nothing else.
        avcDecoderConfig = toArrayBuffer(metadata.decoderConfig.description);
      }
      chunks.push({ chunk, isKey: chunk.type === 'key' });
    },
    error: (e) => { encoderError = e; },
  });

  encoder.configure(encoderConfig);

  const decoder = new VideoDecoder({
    output: (frame) => {
      if (encoderError) { frame.close(); return; }

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
    },
    error: (e) => { encoderError = e; },
  });

  const decoderConfig: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.width,
    codedHeight: track.height,
    ...(track.description ? { description: track.description } : {}),
  };

  const decoderSupport = await VideoDecoder.isConfigSupported(decoderConfig);
  if (!decoderSupport.supported) {
    throw new Error(`VideoDecoder does not support codec: ${track.codec}`);
  }
  decoder.configure(decoderConfig);

  const total = track.samples.length;
  for (let i = 0; i < total; i++) {
    if (encoderError) throw encoderError;

    // Backpressure: yield until the decoder queue drains
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
  await encoder.flush();

  decoder.close();
  encoder.close();

  if (encoderError) throw encoderError;

  return { chunks, avcDecoderConfig, width, height, timescale: 90000 };
}

function resolveOutputDimensions(
  track: VideoTrackInfo,
  maxWidth: number | undefined,
): { width: number; height: number } {
  if (!maxWidth || maxWidth >= track.width) {
    return { width: track.width, height: track.height };
  }
  const ratio = maxWidth / track.width;
  // Height must be even for H.264
  const height = Math.round(track.height * ratio / 2) * 2;
  return { width: maxWidth, height };
}

function yieldMicrotask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * Copies a BufferSource into a fresh, tightly-sized ArrayBuffer. The encoder's
 * `decoderConfig.description` is typed as BufferSource — in practice Chrome
 * returns a Uint8Array view whose `.buffer` may be larger than the actual bytes.
 * Reading the underlying buffer directly would feed mp4box garbage tail bytes.
 */
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
 * the first codec string the browser's VideoEncoder will accept. The level is
 * selected from the spec's per-level limits on macroblocks-per-frame and
 * macroblocks-per-second — hardcoding any single level would either reject
 * 1080p+ inputs (level 3.1 caps at 720p) or fail to hardware-accelerate on
 * mobile (where higher levels often lack HW support).
 *
 * Returns null if no level supports the given resolution/framerate.
 */
async function pickSupportedH264Codec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string | null> {
  const mbsPerFrame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbsPerSecond = mbsPerFrame * Math.max(1, fps);

  // [codec-suffix, maxFS (macroblocks per frame), maxMBPS (macroblocks per second)]
  const levels: Array<[string, number, number]> = [
    ['1e', 1620, 40500],     // 3.0  — 720x480 @30
    ['1f', 3600, 108000],    // 3.1  — 1280x720 @30
    ['20', 5120, 216000],    // 3.2
    ['28', 8192, 245760],    // 4.0  — 1920x1080 @30
    ['29', 8192, 245760],    // 4.1
    ['2a', 8704, 522240],    // 4.2  — 1920x1080 @60
    ['32', 22080, 589824],   // 5.0
    ['33', 36864, 983040],   // 5.1  — 4K @30
    ['34', 36864, 2073600],  // 5.2  — 4K @60
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
