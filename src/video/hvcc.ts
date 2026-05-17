/**
 * Parser for HEVCDecoderConfigurationRecord (the body of the `hvcC` MP4 box).
 *
 * Spec: ISO/IEC 14496-15 §8.3.3.
 *
 * Layout (offsets in bytes):
 *   0       configurationVersion (always 1)
 *   1       profile_space(2) | tier_flag(1) | profile_idc(5)
 *   2..5    profile_compatibility_flags (32 bits)
 *   6..11   constraint_indicator_flags (48 bits)
 *   12      level_idc
 *   13..14  reserved(4) | min_spatial_segmentation_idc(12)
 *   15      reserved(6) | parallelismType(2)
 *   16      reserved(6) | chroma_format_idc(2)
 *   17      reserved(5) | bit_depth_luma_minus8(3)
 *   18      reserved(5) | bit_depth_chroma_minus8(3)
 *   19..20  avgFrameRate
 *   21      constantFrameRate(2) | numTemporalLayers(3) | temporalIdNested(1) | lengthSizeMinusOne(2)
 *   22      numOfArrays
 *   23..    for each array: nal_unit_type byte, num_nalus (16-bit), then num_nalus × (size16 + bytes)
 */

export interface HvcCInfo {
  /** 1 = Main (8-bit), 2 = Main10 (10-bit / HDR). Other values are rare profiles. */
  generalProfileIdc: number;
  /** Bit depth of luma channel. 8 = standard, 10+ = HDR. */
  bitDepthLuma: number;
  /** Bit depth of chroma channels. */
  bitDepthChroma: number;
  /** 0=mono, 1=4:2:0, 2=4:2:2, 3=4:4:4. Only 4:2:0 supports our I420 → VideoEncoder path. */
  chromaFormatIdc: number;
  /** Length-prefix size for AVCC NAL units within mdat samples (always 1, 2, or 4). */
  lengthSize: number;
  /** Parameter set NAL units (VPS + SPS + PPS) extracted from the arrays. */
  parameterSets: Uint8Array[];
}

export function parseHvcC(hvcC: Uint8Array): HvcCInfo {
  if (hvcC.length < 23) {
    throw new Error(`hvcC too short: ${hvcC.length} bytes (need ≥ 23).`);
  }

  const info: HvcCInfo = {
    generalProfileIdc: hvcC[1] & 0x1f,
    chromaFormatIdc: hvcC[16] & 0x03,
    bitDepthLuma: (hvcC[17] & 0x07) + 8,
    bitDepthChroma: (hvcC[18] & 0x07) + 8,
    lengthSize: (hvcC[21] & 0x03) + 1,
    parameterSets: [],
  };

  const numArrays = hvcC[22];
  let offset = 23;
  for (let i = 0; i < numArrays && offset + 3 <= hvcC.length; i++) {
    offset += 1; // skip array-completeness byte (contains NAL unit type, not needed for our pipeline)
    const numNalus = (hvcC[offset] << 8) | hvcC[offset + 1];
    offset += 2;

    for (let j = 0; j < numNalus && offset + 2 <= hvcC.length; j++) {
      const nalLen = (hvcC[offset] << 8) | hvcC[offset + 1];
      offset += 2;
      if (offset + nalLen > hvcC.length) break;
      info.parameterSets.push(hvcC.slice(offset, offset + nalLen));
      offset += nalLen;
    }
  }

  return info;
}

export function isMain10(info: HvcCInfo): boolean {
  return info.bitDepthLuma > 8 || info.generalProfileIdc === 2;
}

/**
 * Splits a length-prefixed (AVCC) sample blob into individual NAL units.
 * Each returned Uint8Array has its own ArrayBuffer (via `slice`) so the buffers
 * can be safely transferred to a Worker.
 */
export function splitAvccSample(sample: ArrayBuffer, lengthSize: number): Uint8Array[] {
  const view = new Uint8Array(sample);
  const nals: Uint8Array[] = [];
  let offset = 0;
  while (offset + lengthSize <= view.length) {
    let nalLen = 0;
    for (let i = 0; i < lengthSize; i++) {
      nalLen = (nalLen << 8) | view[offset + i];
    }
    offset += lengthSize;
    if (offset + nalLen > view.length || nalLen === 0) break;
    nals.push(view.slice(offset, offset + nalLen));
    offset += nalLen;
  }
  return nals;
}
