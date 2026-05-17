export interface VideoCompressionOptions {
  /**
   * Target video bitrate in bits/second. Automatically clamped to the source
   * bitrate — passing a value higher than the source is meaningless (we
   * can't add quality we never had) so the SDK uses the source instead.
   */
  targetBitrate: number;
  /**
   * Optional max width — height is derived to keep aspect ratio. Clamped to
   * the source width (we never upscale).
   */
  maxWidth?: number;
  /**
   * Optional cap on the output frame rate. Frames are dropped from the encode
   * pipeline so the output runs at ≤ `maxFps` frames per second. Clamped to
   * the source fps (we never make up frames). Common value: `24` for typical
   * phone footage.
   */
  maxFps?: number;
}

/**
 * Metadata returned by `probeVideo()` — everything a UI needs to constrain
 * the user's bitrate / resolution / framerate choices to values that make
 * sense for the source.
 */
export interface VideoMetadata {
  width: number;
  height: number;
  /** Average frame rate, derived from sample count ÷ duration. */
  fps: number;
  /**
   * Approximate average bitrate in bits per second. Computed from the file's
   * byte size and the video duration, so it includes the audio track and
   * container overhead — usually within 5–10 % of the video-only bitrate.
   */
  bitrate: number;
  durationSeconds: number;
  /** Codec FourCC + profile string, e.g. `"avc1.640028"` or `"hvc1.1.6.L93.B0"`. */
  codec: string;
  hasAudio: boolean;
  audioCodec?: string;
  audioSampleRate?: number;
  audioChannels?: number;
}

export interface VideoCompressionResult {
  blob: Blob;
  originalBytes: number;
  compressedBytes: number;
  durationMs: number;
}

export type VideoCompressionPhase = 'decode' | 'encode' | 'mux';

export type VideoCompressionProgressCallback = (phase: VideoCompressionPhase, percent: number) => void;

/** A raw sample as extracted by mp4box. */
export interface RawSample {
  data: ArrayBuffer;
  dts: number;
  cts: number;
  duration: number;
  timescale: number;
  is_sync: boolean;
}

export interface VideoTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  /** AVCDecoderConfigurationRecord — needed by VideoDecoder. */
  description: Uint8Array | undefined;
  samples: RawSample[];
  fps: number;
}

export interface AudioTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  duration: number;
  sampleRate: number;
  channelCount: number;
  samples: RawSample[];
}

export interface DemuxResult {
  video: VideoTrackInfo;
  audio: AudioTrackInfo | null;
  /** Reference to the live mp4box ISOFile — needed to copy the audio esds box at mux time. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mp4boxFile: any;
}

export interface EncodedVideoChunk_ {
  chunk: EncodedVideoChunk;
  isKey: boolean;
}
