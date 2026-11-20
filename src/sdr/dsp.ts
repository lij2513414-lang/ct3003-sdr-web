/* SPDX-License-Identifier: MIT */
/* High-performance IQ buffer decoder, Welch FFT spectrum, stats, and synthetic generator. */

export const WSIQ_MAGIC = 0x51495357; // "WSIQ" little-endian
export const ICAP_MAGIC = 0x49434150; // "ICAP" big-endian
export const IQUD_MAGIC = 0x49515544; // "IQUD" big-endian
const IS_LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export type IqFormatKey = 'u32_12' | 'u32_14' | 'u32_16' | 's16le' | 's32le' | 'cf32';
export type HeaderMode = 'auto' | 'none' | 'wsiq' | 'icap' | 'iqud';
export type StreamMode = 'all' | 'even' | 'odd';
export type WindowKind = 'blackmanharris' | 'hann' | 'hamming' | 'rect';
export type DetectorKind = 'avg' | 'peak';
export type SynthPreset = 'ofdm_wifi' | 'multitone' | 'qpsk_burst' | 'sweep';

export interface FormatSpec {
  label: string;
  bytesPerSample: number;
  bits: number;
  fullScale: number;
}

export const FORMAT_SPECS: Record<IqFormatKey, FormatSpec> = {
  u32_12: { label: 'CT3003 Packed u32 (12-bit signed)', bytesPerSample: 4, bits: 12, fullScale: 2048 },
  u32_14: { label: 'Packed u32 (14-bit signed)', bytesPerSample: 4, bits: 14, fullScale: 8192 },
  u32_16: { label: 'Packed u32 (16-bit signed)', bytesPerSample: 4, bits: 16, fullScale: 32768 },
  s16le:  { label: 'Interleaved s16le (cs16)', bytesPerSample: 4, bits: 16, fullScale: 32768 },
  s32le:  { label: 'Interleaved s32le (cs32)', bytesPerSample: 8, bits: 32, fullScale: 2147483648 },
  cf32:   { label: 'Interleaved float32 (cf32)', bytesPerSample: 8, bits: 0, fullScale: 1 },
};

export interface WsiqHeaderMeta {
  kind: 'wsiq';
  version: number;
  seq: number;
  node: number;
  words: number;
  cr0: number;
  cr9: number;
  flags: number;
  direct: boolean;
  demo: boolean;
  bw: number;
  band: number;
  headerBytes: number;
}

export interface IcapHeaderMeta {
  kind: 'icap';
  frames: number;
  headerBytes: number;
}

export interface IqudHeaderMeta {
  kind: 'iqud';
  headerBytes: number;
}

export type PayloadMeta = WsiqHeaderMeta | IcapHeaderMeta | IqudHeaderMeta | null;

export interface DecodeScratchPool {
  capacity?: number;
  iNorm?: Float32Array;
  qNorm?: Float32Array;
  iRawF?: Float32Array | null;
  qRawF?: Float32Array | null;
  iRawI?: Int32Array | null;
  qRawI?: Int32Array | null;
  rawWords?: Uint32Array | null;
}

export interface DecodeIqOptions {
  format?: IqFormatKey;
  swapIQ?: boolean;
  headerMode?: HeaderMode;
  streamMode?: StreamMode;
  offsetSamples?: number;
  maxSamples?: number;
  out?: DecodeScratchPool;
}

export interface DecodedIqFrame {
  format: IqFormatKey;
  spec: FormatSpec;
  streamMode: StreamMode;
  count: number;
  totalAvailableSamples: number;
  fullScale: number;
  maxAbsNorm: number;
  iNorm: Float32Array;
  qNorm: Float32Array;
  iRaw: Float32Array | Int32Array;
  qRaw: Float32Array | Int32Array;
  rawWords: Uint32Array | null;
  meta: PayloadMeta;
}

export interface IqStats {
  count: number;
  nonzero: number;
  nonzeroPct: number;
  transitions: number;
  transitionPct: number;
  minI: number;
  maxI: number;
  minQ: number;
  maxQ: number;
  meanI: number;
  meanQ: number;
  rmsI: number;
  rmsQ: number;
  rmsTotal: number;
  rmsDbfs: number;
  paprDb: number;
  clipCount: number;
  ac1Mag: number;
}

export interface ComputeSpectrumOptions {
  fftSize?: number;
  window?: WindowKind;
  dcRemove?: boolean;
  detector?: DetectorKind;
  outBins?: Float32Array;
  maxBlocks?: number;
}

export interface SynthState {
  phase: number;
  frame: number;
  seed: number;
  sweepPhase: number;
}

export function sext(v: number, bits: number): number {
  if (bits >= 32) return v | 0;
  const mask = (1 << bits) - 1;
  const sign = 1 << (bits - 1);
  const x = v & mask;
  return (x ^ sign) - sign;
}

export function inferFormatFromFilename(name: string): IqFormatKey {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.s32le') || lower.endsWith('.cs32')) return 's32le';
  if (lower.endsWith('.s16le') || lower.endsWith('.cs16')) return 's16le';
  if (lower.endsWith('.cf32') || lower.endsWith('.fc32')) return 'cf32';
  return 'u32_12';
}

export function extractPayloadBytes(
  arrayBuffer: ArrayBuffer | Uint8Array,
  headerMode: HeaderMode = 'auto'
): { payload: Uint8Array; meta: PayloadMeta } {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (headerMode === 'none' || bytes.byteLength < 28) {
    return { payload: bytes, meta: null };
  }

  const leMagic = bytes.byteLength >= 32 ? dv.getUint32(0, true) : 0;
  const beMagic = bytes.byteLength >= 28 ? dv.getUint32(0, false) : 0;

  if ((headerMode === 'auto' || headerMode === 'wsiq') && leMagic === WSIQ_MAGIC && bytes.byteLength >= 32) {
    const version = dv.getUint32(4, true);
    const seq = dv.getUint32(8, true);
    const node = dv.getUint32(12, true);
    const words = dv.getUint32(16, true);
    const cr0 = dv.getUint32(20, true);
    const cr9 = dv.getUint32(24, true);
    const flags = dv.getUint32(28, true);
    const meta: WsiqHeaderMeta = {
      kind: 'wsiq',
      version,
      seq,
      node,
      words,
      cr0,
      cr9,
      flags,
      direct: (flags & 1) !== 0,
      demo: (flags & 2) !== 0,
      bw: (flags >>> 8) & 0xff,
      band: (flags >>> 16) & 1,
      headerBytes: 32,
    };
    const avail = bytes.byteLength - 32;
    const take = words > 0 && words * 4 <= avail ? words * 4 : avail;
    return { payload: bytes.subarray(32, 32 + take), meta };
  }

  if ((headerMode === 'auto' || headerMode === 'icap') && beMagic === ICAP_MAGIC) {
    const chunks: Uint8Array[] = [];
    let off = 0;
    let total = 0;
    let frames = 0;
    while (off + 28 <= bytes.byteLength) {
      if (dv.getUint32(off, false) !== ICAP_MAGIC) break;
      const size = dv.getUint32(off + 16, false);
      if (off + 28 + size > bytes.byteLength) break;
      chunks.push(bytes.subarray(off + 28, off + 28 + size));
      total += size;
      off += 28 + size;
      frames++;
    }
    if (chunks.length > 0) {
      const merged = new Uint8Array(total);
      let pos = 0;
      for (let i = 0; i < chunks.length; i++) {
        merged.set(chunks[i], pos);
        pos += chunks[i].byteLength;
      }
      return { payload: merged, meta: { kind: 'icap', frames, headerBytes: 28 } };
    }
  }

  if ((headerMode === 'auto' || headerMode === 'iqud') && beMagic === IQUD_MAGIC && bytes.byteLength >= 44) {
    return { payload: bytes.subarray(44), meta: { kind: 'iqud', headerBytes: 44 } };
  }

  return { payload: bytes, meta: null };
}

function ensureDecodeScratch(
  scratch: DecodeScratchPool,
  count: number,
  isFloat: boolean,
  needRawWords: boolean
): Required<Pick<DecodeScratchPool, 'capacity' | 'iNorm' | 'qNorm'>> & DecodeScratchPool {
  if (!scratch.capacity || scratch.capacity < count) {
    const cap = Math.max(count, scratch.capacity || 0);
    scratch.capacity = cap;
    scratch.iNorm = new Float32Array(cap);
    scratch.qNorm = new Float32Array(cap);
    scratch.iRawF = isFloat ? new Float32Array(cap) : null;
    scratch.qRawF = isFloat ? new Float32Array(cap) : null;
    scratch.iRawI = isFloat ? null : new Int32Array(cap);
    scratch.qRawI = isFloat ? null : new Int32Array(cap);
    scratch.rawWords = needRawWords ? new Uint32Array(cap) : null;
    return scratch as Required<Pick<DecodeScratchPool, 'capacity' | 'iNorm' | 'qNorm'>> & DecodeScratchPool;
  }
  if (isFloat && (!scratch.iRawF || !scratch.qRawF)) {
    scratch.iRawF = new Float32Array(scratch.capacity);
    scratch.qRawF = new Float32Array(scratch.capacity);
  }
  if (!isFloat && (!scratch.iRawI || !scratch.qRawI)) {
    scratch.iRawI = new Int32Array(scratch.capacity);
    scratch.qRawI = new Int32Array(scratch.capacity);
  }
  if (needRawWords && !scratch.rawWords) {
    scratch.rawWords = new Uint32Array(scratch.capacity);
  }
  return scratch as Required<Pick<DecodeScratchPool, 'capacity' | 'iNorm' | 'qNorm'>> & DecodeScratchPool;
}

export function decodeIqBuffer(
  arrayBuffer: ArrayBuffer | Uint8Array,
  opts: DecodeIqOptions = {}
): DecodedIqFrame {
  const format: IqFormatKey = opts.format && FORMAT_SPECS[opts.format] ? opts.format : 'u32_12';
  const spec = FORMAT_SPECS[format];
  const swapIQ = !!opts.swapIQ;
  const headerMode: HeaderMode = opts.headerMode || 'auto';
  const streamMode: StreamMode = opts.streamMode === 'even' || opts.streamMode === 'odd' ? opts.streamMode : 'all';
  const stride = streamMode === 'all' ? 1 : 2;
  const phaseOff = streamMode === 'odd' ? 1 : 0;

  const extracted = extractPayloadBytes(arrayBuffer, headerMode);
  const payload = extracted.payload;
  const isFloat = format === 'cf32';
  const needRawWords = spec.bytesPerSample === 4;

  const startSample = Math.max(0, opts.offsetSamples || 0) + phaseOff;
  const startByte = startSample * spec.bytesPerSample;
  const availBytes = Math.max(0, payload.byteLength - startByte);
  const availRawSamples = Math.floor(availBytes / spec.bytesPerSample);
  const availSamples = stride === 1 ? availRawSamples : Math.floor((availRawSamples + stride - 1) / stride);
  const count = opts.maxSamples && opts.maxSamples > 0 ? Math.min(availSamples, opts.maxSamples) : availSamples;

  let iNorm: Float32Array;
  let qNorm: Float32Array;
  let iRaw: Float32Array | Int32Array;
  let qRaw: Float32Array | Int32Array;
  let rawWords: Uint32Array | null;

  if (opts.out) {
    const pool = ensureDecodeScratch(opts.out, count, isFloat, needRawWords);
    iNorm = pool.iNorm.subarray(0, count);
    qNorm = pool.qNorm.subarray(0, count);
    iRaw = (isFloat ? pool.iRawF! : pool.iRawI!).subarray(0, count);
    qRaw = (isFloat ? pool.qRawF! : pool.qRawI!).subarray(0, count);
    rawWords = needRawWords ? pool.rawWords!.subarray(0, count) : null;
  } else {
    iNorm = new Float32Array(count);
    qNorm = new Float32Array(count);
    iRaw = isFloat ? new Float32Array(count) : new Int32Array(count);
    qRaw = isFloat ? new Float32Array(count) : new Int32Array(count);
    rawWords = needRawWords ? new Uint32Array(count) : null;
  }

  let scale = spec.fullScale;
  let absPeak = 0;
  const invScale = 1 / scale;
  const byteOff = payload.byteOffset + startByte;
  const fastAligned32 = IS_LE && (byteOff & 3) === 0;

  if (format === 'u32_12' || format === 'u32_14' || format === 'u32_16') {
    const bits = spec.bits;
    const shift = 32 - bits;
    if (fastAligned32) {
      const u32 = new Uint32Array(payload.buffer, byteOff, count > 0 ? (count - 1) * stride + 1 : 0);
      for (let k = 0, p = 0; k < count; k++, p += stride) {
        const w = u32[p];
        rawWords![k] = w;
        const lo = (w << shift) >> shift;
        const hi = ((w >>> 16) << shift) >> shift;
        const iv = swapIQ ? hi : lo;
        const qv = swapIQ ? lo : hi;
        iRaw[k] = iv;
        qRaw[k] = qv;
        const inr = iv * invScale;
        const qnr = qv * invScale;
        iNorm[k] = inr;
        qNorm[k] = qnr;
        const ai = inr < 0 ? -inr : inr;
        const aq = qnr < 0 ? -qnr : qnr;
        if (ai > absPeak) absPeak = ai;
        if (aq > absPeak) absPeak = aq;
      }
    } else {
      const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      for (let k = 0; k < count; k++) {
        const w = dv.getUint32(startByte + k * stride * 4, true);
        rawWords![k] = w;
        const lo = sext(w & 0xffff, bits);
        const hi = sext((w >>> 16) & 0xffff, bits);
        const iv = swapIQ ? hi : lo;
        const qv = swapIQ ? lo : hi;
        iRaw[k] = iv;
        qRaw[k] = qv;
        const inr = iv * invScale;
        const qnr = qv * invScale;
        iNorm[k] = inr;
        qNorm[k] = qnr;
        const ai = inr < 0 ? -inr : inr;
        const aq = qnr < 0 ? -qnr : qnr;
        if (ai > absPeak) absPeak = ai;
        if (aq > absPeak) absPeak = aq;
      }
    }
  } else if (format === 's16le') {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const u32 = fastAligned32
      ? new Uint32Array(payload.buffer, byteOff, count > 0 ? (count - 1) * stride + 1 : 0)
      : null;
    for (let k = 0, p = 0; k < count; k++, p += stride) {
      const w = u32 ? u32[p] : dv.getUint32(startByte + p * 4, true);
      rawWords![k] = w;
      const a = (w << 16) >> 16;
      const b = w >> 16;
      const iv = swapIQ ? b : a;
      const qv = swapIQ ? a : b;
      iRaw[k] = iv;
      qRaw[k] = qv;
      const inr = iv * invScale;
      const qnr = qv * invScale;
      iNorm[k] = inr;
      qNorm[k] = qnr;
      const ai = inr < 0 ? -inr : inr;
      const aq = qnr < 0 ? -qnr : qnr;
      if (ai > absPeak) absPeak = ai;
      if (aq > absPeak) absPeak = aq;
    }
  } else if (format === 's32le') {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let k = 0; k < count; k++) {
      const off = startByte + k * stride * 8;
      const a = dv.getInt32(off, true);
      const b = dv.getInt32(off + 4, true);
      const iv = swapIQ ? b : a;
      const qv = swapIQ ? a : b;
      iRaw[k] = iv;
      qRaw[k] = qv;
      const m = Math.max(Math.abs(iv), Math.abs(qv));
      if (m > absPeak) absPeak = m;
    }
    scale = absPeak <= 2048 ? 2048 : absPeak <= 8192 ? 8192 : absPeak <= 32768 ? 32768 : 2147483648;
    const invS32 = 1 / scale;
    absPeak *= invS32;
    for (let k = 0; k < count; k++) {
      iNorm[k] = iRaw[k] * invS32;
      qNorm[k] = qRaw[k] * invS32;
    }
  } else {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (let k = 0; k < count; k++) {
      const off = startByte + k * stride * 8;
      const a = dv.getFloat32(off, true);
      const b = dv.getFloat32(off + 4, true);
      const iv = swapIQ ? b : a;
      const qv = swapIQ ? a : b;
      iRaw[k] = iv;
      qRaw[k] = qv;
      iNorm[k] = iv;
      qNorm[k] = qv;
      const m = Math.max(Math.abs(iv), Math.abs(qv));
      if (m > absPeak) absPeak = m;
    }
    scale = absPeak > 1 ? absPeak : 1;
  }

  return {
    format,
    spec,
    streamMode,
    count,
    totalAvailableSamples: availSamples,
    fullScale: scale,
    maxAbsNorm: absPeak || 1,
    iNorm,
    qNorm,
    iRaw,
    qRaw,
    rawWords,
    meta: extracted.meta,
  };
}

export function computeStats(decoded: DecodedIqFrame): IqStats {
  const n = decoded.count;
  if (n <= 0) {
    return {
      count: 0,
      nonzero: 0,
      nonzeroPct: 0,
      transitions: 0,
      transitionPct: 0,
      minI: 0,
      maxI: 0,
      minQ: 0,
      maxQ: 0,
      meanI: 0,
      meanQ: 0,
      rmsI: 0,
      rmsQ: 0,
      rmsTotal: 0,
      rmsDbfs: -120,
      paprDb: 0,
      clipCount: 0,
      ac1Mag: 0,
    };
  }

  const { iNorm, qNorm, iRaw, qRaw, rawWords, fullScale, format } = decoded;
  let nonzero = 0;
  let transitions = 0;
  let minI = Infinity;
  let maxI = -Infinity;
  let minQ = Infinity;
  let maxQ = -Infinity;
  let sumI = 0;
  let sumQ = 0;
  let sumI2 = 0;
  let sumQ2 = 0;
  let sumMag2 = 0;
  let peakMag2 = 0;
  let clipCount = 0;
  let acRe = 0;
  let acIm = 0;

  const clipThresh = format === 'cf32' ? 0.995 : Math.max(1, fullScale - 4);

  for (let k = 0; k < n; k++) {
    const iv = iRaw[k];
    const qv = qRaw[k];
    const inr = iNorm[k];
    const qnr = qNorm[k];

    if (rawWords) {
      if (rawWords[k] !== 0) nonzero++;
      if (k > 0 && rawWords[k] !== rawWords[k - 1]) transitions++;
    } else {
      if (iv !== 0 || qv !== 0) nonzero++;
      if (k > 0 && (iv !== iRaw[k - 1] || qv !== qRaw[k - 1])) transitions++;
    }

    if (iv < minI) minI = iv;
    if (iv > maxI) maxI = iv;
    if (qv < minQ) minQ = qv;
    if (qv > maxQ) maxQ = qv;

    sumI += iv;
    sumQ += qv;
    sumI2 += iv * iv;
    sumQ2 += qv * qv;

    const mag2 = inr * inr + qnr * qnr;
    sumMag2 += mag2;
    if (mag2 > peakMag2) peakMag2 = mag2;

    if (Math.abs(iv) >= clipThresh || Math.abs(qv) >= clipThresh) {
      clipCount++;
    }

    if (k > 0) {
      const pi = iNorm[k - 1];
      const pq = qNorm[k - 1];
      acRe += pi * inr + pq * qnr;
      acIm += pi * qnr - pq * inr;
    }
  }

  const meanI = sumI / n;
  const meanQ = sumQ / n;
  const rmsI = Math.sqrt(sumI2 / n);
  const rmsQ = Math.sqrt(sumQ2 / n);
  const rmsTotal = Math.sqrt((sumI2 + sumQ2) / n);
  const meanMag2 = sumMag2 / n;
  const rmsDbfs = 10 * Math.log10(meanMag2 + 1e-12);
  const paprDb = peakMag2 > 0 && meanMag2 > 0 ? 10 * Math.log10(peakMag2 / meanMag2) : 0;
  const ac1Mag = sumMag2 > 0 ? Math.hypot(acRe, acIm) / sumMag2 : 0;

  return {
    count: n,
    nonzero,
    nonzeroPct: (nonzero * 100) / n,
    transitions,
    transitionPct: n > 1 ? (transitions * 100) / (n - 1) : 0,
    minI,
    maxI,
    minQ,
    maxQ,
    meanI,
    meanQ,
    rmsI,
    rmsQ,
    rmsTotal,
    rmsDbfs,
    paprDb,
    clipCount,
    ac1Mag,
  };
}

// ---- FFT & Windowing ----
interface FftPlan {
  n: number;
  bitrev: Uint32Array;
  cosT: Float64Array;
  sinT: Float64Array;
}

interface WindowTable {
  w: Float32Array;
  winSum: number;
}

interface SpectrumScratch {
  re: Float64Array;
  im: Float64Array;
  accPower: Float64Array;
}

const fftPlanCache = new Map<number, FftPlan>();
const windowCache = new Map<string, WindowTable>();
const spectrumScratchCache = new Map<number, SpectrumScratch>();

function getFftPlan(n: number): FftPlan {
  let plan = fftPlanCache.get(n);
  if (plan) return plan;

  if ((n & (n - 1)) !== 0 || n < 2) {
    throw new Error('FFT size must be power of 2 >= 2, got ' + n);
  }
  const levels = Math.log2(n) | 0;
  const bitrev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let r = 0;
    for (let b = 0; b < levels; b++) {
      r = (r << 1) | (x & 1);
      x >>>= 1;
    }
    bitrev[i] = r;
  }

  const half = n >>> 1;
  const cosT = new Float64Array(half);
  const sinT = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const ang = (-2 * Math.PI * k) / n;
    cosT[k] = Math.cos(ang);
    sinT[k] = Math.sin(ang);
  }

  plan = { n, bitrev, cosT, sinT };
  fftPlanCache.set(n, plan);
  return plan;
}

function getWindow(kind: WindowKind, n: number): WindowTable {
  const key = kind + ':' + n;
  let cached = windowCache.get(key);
  if (cached) return cached;

  const w = new Float32Array(n);
  const denom = Math.max(1, n - 1);
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / denom;
    let v = 1;
    if (kind === 'hann') {
      v = 0.5 * (1 - Math.cos(t));
    } else if (kind === 'hamming') {
      v = 0.54 - 0.46 * Math.cos(t);
    } else if (kind === 'blackmanharris') {
      v = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
    }
    w[i] = v;
    sum += v;
  }

  cached = { w, winSum: sum > 0 ? sum : n };
  windowCache.set(key, cached);
  return cached;
}

export function fftComplex(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const { bitrev, cosT, sinT } = getFftPlan(n);

  for (let i = 0; i < n; i++) {
    const j = bitrev[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >>> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      let idx = 0;
      for (let k = 0; k < half; k++) {
        const wr = cosT[idx];
        const wi = sinT[idx];
        const even = i + k;
        const odd = even + half;
        const tr = re[odd] * wr - im[odd] * wi;
        const ti = re[odd] * wi + im[odd] * wr;
        re[odd] = re[even] - tr;
        im[odd] = im[even] - ti;
        re[even] += tr;
        im[even] += ti;
        idx += step;
      }
    }
  }
}

function getSpectrumScratch(fftSize: number): SpectrumScratch {
  let sc = spectrumScratchCache.get(fftSize);
  if (!sc) {
    sc = {
      re: new Float64Array(fftSize),
      im: new Float64Array(fftSize),
      accPower: new Float64Array(fftSize),
    };
    spectrumScratchCache.set(fftSize, sc);
  } else {
    sc.accPower.fill(0);
  }
  return sc;
}

export function computeSpectrum(
  iNorm: Float32Array,
  qNorm: Float32Array,
  opts: ComputeSpectrumOptions = {}
): Float32Array {
  const n = iNorm.length;
  const fftSize = opts.fftSize || 1024;
  const winKind: WindowKind = opts.window || 'hann';
  const dcRemove = !!opts.dcRemove;
  const detector: DetectorKind = opts.detector === 'peak' ? 'peak' : 'avg';
  const outDb = opts.outBins && opts.outBins.length === fftSize ? opts.outBins : new Float32Array(fftSize);

  if (n === 0) {
    outDb.fill(-120);
    return outDb;
  }

  const { w, winSum } = getWindow(winKind, fftSize);
  const invGainSq = 1 / (winSum * winSum);
  const sc = getSpectrumScratch(fftSize);
  const re = sc.re;
  const im = sc.im;
  const accPower = sc.accPower;

  let step = Math.max(1, fftSize >>> 1); // 50% Welch overlap
  if (n > fftSize && opts.maxBlocks && opts.maxBlocks > 0) {
    const estBlocks = Math.floor((n - fftSize) / step) + 1;
    if (estBlocks > opts.maxBlocks && opts.maxBlocks > 1) {
      step = Math.max(step, Math.floor((n - fftSize) / (opts.maxBlocks - 1)));
    }
  }

  let blocks = 0;
  const maxStart = n < fftSize ? 0 : n - fftSize;
  for (let base = 0; blocks === 0 || base <= maxStart; base += step) {
    const avail = Math.min(fftSize, n - base);
    let meanR = 0;
    let meanI = 0;
    if (dcRemove && avail > 0) {
      for (let k = 0; k < avail; k++) {
        meanR += iNorm[base + k];
        meanI += qNorm[base + k];
      }
      meanR /= avail;
      meanI /= avail;
    }

    for (let k = 0; k < avail; k++) {
      const wk = w[k];
      re[k] = (iNorm[base + k] - meanR) * wk;
      im[k] = (qNorm[base + k] - meanI) * wk;
    }
    if (avail < fftSize) {
      re.fill(0, avail);
      im.fill(0, avail);
    }

    fftComplex(re, im);

    if (detector === 'peak') {
      for (let k = 0; k < fftSize; k++) {
        const p = (re[k] * re[k] + im[k] * im[k]) * invGainSq;
        if (blocks === 0 || p > accPower[k]) accPower[k] = p;
      }
    } else {
      for (let k = 0; k < fftSize; k++) {
        accPower[k] += (re[k] * re[k] + im[k] * im[k]) * invGainSq;
      }
    }
    blocks++;
    if (n < fftSize) break;
  }

  const half = fftSize >>> 1;
  const invBlocks = detector === 'avg' && blocks > 0 ? 1 / blocks : 1;

  for (let k = 0; k < fftSize; k++) {
    const src = (k + half) & (fftSize - 1);
    const p = accPower[src] * invBlocks;
    outDb[k] = 10 * Math.log10(p + 1e-12);
  }
  return outDb;
}

// ---- Synthetic IQ Generator (CT3003 u32_12 format) ----
function packI12Q12(iVal: number, qVal: number): number {
  const ic = Math.max(-2048, Math.min(2047, Math.round(iVal)));
  const qc = Math.max(-2048, Math.min(2047, Math.round(qVal)));
  return (((qc & 0x0fff) << 16) | (ic & 0x0fff)) >>> 0;
}

function gaussianPair(state: SynthState): [number, number] {
  state.seed = (Math.imul(1664525, state.seed) + 1013904223) >>> 0;
  const u1 = Math.max(1e-7, state.seed / 4294967296);
  state.seed = (Math.imul(1664525, state.seed) + 1013904223) >>> 0;
  const u2 = state.seed / 4294967296;
  const mag = Math.sqrt(-2 * Math.log(u1));
  const ang = 2 * Math.PI * u2;
  return [mag * Math.cos(ang), mag * Math.sin(ang)];
}

export function generateSyntheticFrame(
  preset: SynthPreset,
  count: number,
  stateObj?: SynthState
): ArrayBuffer {
  const st: SynthState = stateObj || { phase: 0, frame: 0, seed: 0x13572468, sweepPhase: 0 };
  const buf = new ArrayBuffer(count * 4);
  const view = new DataView(buf);
  const frame = st.frame++;

  let symI = 1;
  let symQ = 1;

  for (let n = 0; n < count; n++) {
    const t = st.phase + n;
    const [ni, nq] = gaussianPair(st);
    let iv = ni * 22;
    let qv = nq * 22;

    if (preset === 'multitone') {
      const f1 = -0.18 * 2 * Math.PI;
      const f2 = 0.085 * 2 * Math.PI;
      const f3 = 0.31 * 2 * Math.PI;
      const pulse = n % 2048 < 1400 ? 1 : 0.05;
      iv += 520 * Math.cos(f1 * t) + 280 * Math.cos(f2 * t) * pulse + 160 * Math.cos(f3 * t + frame * 0.2);
      qv += 520 * Math.sin(f1 * t) + 280 * Math.sin(f2 * t) * pulse + 160 * Math.sin(f3 * t + frame * 0.2);
    } else if (preset === 'qpsk_burst') {
      if (n % 16 === 0) {
        st.seed = (Math.imul(1664525, st.seed) + 1013904223) >>> 0;
        symI = st.seed & 1 ? 1 : -1;
        symQ = st.seed & 2 ? 1 : -1;
      }
      const env = 0.55 + 0.45 * Math.sin((2 * Math.PI * (n % 16)) / 16 - Math.PI / 2);
      const cfo = 0.0007 * 2 * Math.PI * t;
      const bi = symI * 760 * (0.6 + 0.4 * env);
      const bq = symQ * 760 * (0.6 + 0.4 * env);
      iv += bi * Math.cos(cfo) - bq * Math.sin(cfo);
      qv += bi * Math.sin(cfo) + bq * Math.cos(cfo);
    } else if (preset === 'sweep') {
      const normPos = ((frame * 0.05 + n / count) % 1.0) - 0.5;
      st.sweepPhase = (st.sweepPhase || 0) + normPos * 0.85 * Math.PI;
      iv += 650 * Math.cos(st.sweepPhase) + 90 * Math.cos(-0.27 * 2 * Math.PI * t);
      qv += 650 * Math.sin(st.sweepPhase) + 90 * Math.sin(-0.27 * 2 * Math.PI * t);
    } else {
      // ofdm_wifi: occupied baseband -0.22..+0.22 Fs band + pilot lines
      for (let c = -6; c <= 6; c++) {
        if (c === 0) continue;
        const w = c * 0.032 * 2 * Math.PI;
        const ph = ((c * 13 + frame * 7) % 11) * 0.57;
        const amp = Math.abs(c) === 2 || Math.abs(c) === 5 ? 135 : 85;
        iv += amp * Math.cos(w * t + ph);
        qv += amp * Math.sin(w * t + ph);
      }
    }

    view.setUint32(n * 4, packI12Q12(iv, qv), true);
  }

  st.phase += count;
  return buf;
}
