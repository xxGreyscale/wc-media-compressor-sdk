import { demux } from './demux';
import { encodeVideo } from './encode';
import { mux } from './mux';
import type {
  VideoCompressionOptions,
  VideoCompressionResult,
  VideoCompressionProgressCallback,
} from './types';

export type {
  VideoCompressionOptions,
  VideoCompressionResult,
  VideoCompressionProgressCallback,
};

/**
 * Compresses an MP4 / MOV video file using WebCodecs.
 *
 * Pipeline: demux (mp4box) → VideoDecoder → re-encode (VideoEncoder, H.264) → mux (mp4box).
 * Audio is passed through unchanged.
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

  // 2. Encode video
  const encodeResult = await encodeVideo(
    demuxResult.video,
    options,
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
