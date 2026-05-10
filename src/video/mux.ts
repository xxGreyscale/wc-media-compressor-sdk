import MP4Box from 'mp4box';
import type { AudioTrackInfo } from './types';
import type { EncodeResult } from './encode';

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
  const VIDEO_TIMESCALE = 90000;

  const videoTrackId: number = outFile.addTrack({
    type: 'video',
    width: encodeResult.width,
    height: encodeResult.height,
    timescale: VIDEO_TIMESCALE,
    hdlr: 'vide',
    name: 'VideoHandler',
    language: 'und',
    avcDecoderConfigRecord: encodeResult.avcDecoderConfig,
  });

  for (const { chunk, isKey } of encodeResult.chunks) {
    const data = new ArrayBuffer(chunk.byteLength);
    chunk.copyTo(data);

    const dts = Math.round((chunk.timestamp / 1_000_000) * VIDEO_TIMESCALE);
    const dur = chunk.duration != null
      ? Math.round((chunk.duration / 1_000_000) * VIDEO_TIMESCALE)
      : Math.round((1 / 30) * VIDEO_TIMESCALE); // fallback to ~33ms if no duration

    outFile.addSample(videoTrackId, data, {
      duration: dur,
      dts,
      cts: dts,
      is_sync: isKey,
    });
  }

  // --- Audio track (passthrough) ---
  if (audio && audio.samples.length > 0) {
    const audioTrackId: number = outFile.addTrack({
      type: 'audio',
      timescale: audio.timescale,
      samplerate: audio.sampleRate,
      channel_count: audio.channelCount,
      hdlr: 'soun',
      name: 'SoundHandler',
      language: 'und',
    });

    // Copy the esds box from the input file so the audio codec config is preserved.
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
