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

  const encoderConfig: VideoEncoderConfig = {
    codec: 'avc1.4d001f', // H.264 Main Profile Level 3.1
    width,
    height,
    bitrate: options.targetBitrate,
    framerate: track.fps,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' }, // AVCC output (length-prefixed), not Annex B
  };

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (metadata?.decoderConfig?.description) {
        avcDecoderConfig = metadata.decoderConfig.description as ArrayBuffer;
      }
      chunks.push({ chunk, isKey: chunk.type === 'key' });
    },
    error: (e) => { encoderError = e; },
  });

  const support = await VideoEncoder.isConfigSupported(encoderConfig);
  if (!support.supported) {
    throw new Error(`VideoEncoder does not support config: ${JSON.stringify(encoderConfig)}`);
  }
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
