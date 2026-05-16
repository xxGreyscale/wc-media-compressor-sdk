import MP4Box from 'mp4box';
import type { AudioTrackInfo } from './types';
import type { EncodeResult } from './encode';

const VIDEO_TIMESCALE = 90000;

interface VideoSampleEntry {
  chunk: EncodedVideoChunk;
  isKey: boolean;
  dts: number;
  dur: number;
}

/**
 * Muxes encoded video chunks (and optional passthrough audio) into an MP4 ArrayBuffer.
 *
 * Video timescale is fixed at 90000 (standard for H.264 in MP4).
 * Audio samples are copied verbatim from the demuxed input — no transcode.
 */
export function mux(
  encodeResult: EncodeResult,
  audio: AudioTrackInfo | null,
  // The live mp4box ISOFile from demux — used to copy the audio esds box.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputMp4: any,
): ArrayBuffer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const outFile: any = MP4Box.createFile();

  // --- Video track ---
  const sampleEntries = buildVideoSampleEntries(encodeResult.chunks);
  const totalVideoDuration =
    sampleEntries.length === 0
      ? 0
      : sampleEntries[sampleEntries.length - 1].dts + sampleEntries[sampleEntries.length - 1].dur;

  // mp4box's addTrack expects `type` to be a sample-entry FourCC ("avc1",
  // "mp4a", "hvc1", …), not a media kind. The handler kind ("vide"/"soun")
  // is controlled by the `hdlr` field below. Passing "video" makes mp4box
  // bail silently at sample-entry construction and produce a stub track
  // that accepts no samples.
  const videoTrackId: number = outFile.addTrack({
    type: 'avc1',
    width: encodeResult.width,
    height: encodeResult.height,
    timescale: VIDEO_TIMESCALE,
    duration: totalVideoDuration,
    media_duration: totalVideoDuration,
    hdlr: 'vide',
    name: 'VideoHandler',
    language: 'und',
    avcDecoderConfigRecord: encodeResult.avcDecoderConfig,
  });

  for (const entry of sampleEntries) {
    const data = new ArrayBuffer(entry.chunk.byteLength);
    entry.chunk.copyTo(data);
    outFile.addSample(videoTrackId, data, {
      duration: entry.dur,
      dts: entry.dts,
      cts: entry.dts,
      is_sync: entry.isKey,
    });
  }

  // --- Audio track (passthrough) ---
  if (audio && audio.samples.length > 0) {
    const lastAudio = audio.samples[audio.samples.length - 1];
    const totalAudioDuration = lastAudio.dts + lastAudio.duration;

    const audioTrackId: number = outFile.addTrack({
      type: 'mp4a',
      timescale: audio.timescale,
      duration: totalAudioDuration,
      media_duration: totalAudioDuration,
      samplerate: audio.sampleRate,
      channel_count: audio.channelCount,
      hdlr: 'soun',
      name: 'SoundHandler',
      language: 'und',
    });

    copyAudioEsds(inputMp4, audio.id, outFile, audioTrackId);

    for (const s of audio.samples) {
      outFile.addSample(audioTrackId, s.data, {
        duration: s.duration,
        dts: s.dts,
        cts: s.cts,
        is_sync: s.is_sync,
      });
    }
  }

  return outFile.getBuffer();
}

/**
 * Encoder output may arrive slightly out of order and `chunk.duration` is
 * frequently 0 or null in Chrome — neither value can be trusted directly.
 *
 * We sort by timestamp, then derive each sample's duration from the gap to
 * the next sample. For the final sample we reuse the previous gap (close
 * enough), with a 30 fps fallback for single-sample edge cases. This gives
 * monotonic, gap-free DTS values that pass muxer + player validation.
 */
function buildVideoSampleEntries(
  chunks: { chunk: EncodedVideoChunk; isKey: boolean }[],
): VideoSampleEntry[] {
  if (chunks.length === 0) return [];

  const sorted = [...chunks].sort((a, b) => a.chunk.timestamp - b.chunk.timestamp);
  const entries: VideoSampleEntry[] = new Array(sorted.length);
  const fallbackUs = 1_000_000 / 30;

  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const next = sorted[i + 1];

    let durUs: number;
    if (next) {
      durUs = next.chunk.timestamp - cur.chunk.timestamp;
    } else if (i > 0) {
      // Last sample: reuse the previous frame's gap rather than the encoder's
      // unreliable chunk.duration.
      durUs = cur.chunk.timestamp - sorted[i - 1].chunk.timestamp;
    } else if (cur.chunk.duration) {
      durUs = cur.chunk.duration;
    } else {
      durUs = fallbackUs;
    }

    if (durUs <= 0) durUs = fallbackUs;

    entries[i] = {
      chunk: cur.chunk,
      isKey: cur.isKey,
      dts: Math.round((cur.chunk.timestamp / 1_000_000) * VIDEO_TIMESCALE),
      dur: Math.round((durUs / 1_000_000) * VIDEO_TIMESCALE),
    };
  }

  return entries;
}

/**
 * Patches the output audio stsd entry's esds box with the one from the input file.
 * This ensures the AudioSpecificConfig (codec initialisation data) is preserved
 * without having to decode/re-encode the audio.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function copyAudioEsds(inputMp4: any, inputTrackId: number, outFile: any, outTrackId: number) {
  try {
    const inputEsds = inputMp4
      .getTrackById(inputTrackId)
      ?.mdia?.minf?.stbl?.stsd?.entries?.[0]?.esds;

    const outEntry = outFile
      .getTrackById(outTrackId)
      ?.mdia?.minf?.stbl?.stsd?.entries?.[0];

    if (inputEsds && outEntry) {
      outEntry.esds = inputEsds;
    }
  } catch {
    // Non-fatal — audio will play but may lack codec init data in rare cases.
  }
}
