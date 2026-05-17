import { demux } from './demux';
import { encodeVideo } from './encode';
import { mux } from './mux';
import { probeVideo } from './probe';
import type {
  VideoCompressionOptions,
  VideoCompressionResult,
  VideoCompressionProgressCallback,
  VideoTrackInfo,
} from './types';

export type {
  VideoCompressionOptions,
  VideoCompressionResult,
  VideoCompressionProgressCallback,
  VideoMetadata,
} from './types';

export { probeVideo };

/**
 * Compresses an MP4 / MOV video file using WebCodecs.
 *
 * Pipeline: demux (mp4box) → VideoDecoder → re-encode (VideoEncoder, H.264) → mux (mp4box).
 * Audio is passed through unchanged.
 *
 * The provided `options` are clamped against the source so they can never
 * accidentally upscale the video: `maxWidth ≤ source width`, `targetBitrate ≤
 * source bitrate`, `maxFps ≤ source fps`. Callers that want stricter or looser
 * defaults should call `probeVideo()` first and compute options from the result.
 */
export async function compressVideo(
  file: File,
  options: VideoCompressionOptions,
  onProgress?: VideoCompressionProgressCallback,
): Promise<VideoCompressionResult> {
  const t0 = performance.now();

  // 1. Demux
  onProgress?.('decode', 0);
  const demuxResult = await demux(file);

  const clamped = clampOptionsToSource(options, demuxResult.video, file.size);

  // 2. Encode video
  const encodeResult = await encodeVideo(
    demuxResult.video,
    clamped,
    (pct) => onProgress?.('encode', pct),
  );

  // 3. Mux
  onProgress?.('mux', 0);
  const buffer = mux(encodeResult, demuxResult.audio, demuxResult.mp4boxFile);
  onProgress?.('mux', 100);

  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    originalBytes: file.size,
    compressedBytes: buffer.byteLength,
    durationMs: performance.now() - t0,
  };
}

/**
 * Clamps caller-supplied options against the source video so we never try to
 * upscale dimensions, ask the encoder for a higher bitrate than the input had
 * (waste of CPU, no quality gain), or invent frames the input doesn't have.
 */
function clampOptionsToSource(
  options: VideoCompressionOptions,
  track: VideoTrackInfo,
  fileSize: number,
): VideoCompressionOptions {
  const durationSec = track.duration / track.timescale;
  const sourceBitrate =
    durationSec > 0 ? Math.round((fileSize * 8) / durationSec) : Number.POSITIVE_INFINITY;

  const targetBitrate = Math.min(options.targetBitrate, sourceBitrate);

  const maxWidth =
    options.maxWidth !== undefined
      ? Math.min(options.maxWidth, track.width)
      : undefined;

  const maxFps =
    options.maxFps !== undefined ? Math.min(options.maxFps, track.fps) : undefined;

  return { targetBitrate, maxWidth, maxFps };
}
