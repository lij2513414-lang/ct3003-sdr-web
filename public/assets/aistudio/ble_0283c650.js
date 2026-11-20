/* SPDX-License-Identifier: MIT */
/*
 * ble.js - Real-time BLE 1M Advertising Packet (GFSK) Decoder for CT3003 2.4 GHz IQ.
 *
 * Verified MT7981B Band 0 RF mapping (LO ~ 2437 MHz):
 *   - IQ baseband polarity: I - jQ (complex conjugate of lo + j*hi)
 *   - node=6 (RXFD, 14-bit): Fs = 40 Msps -> 204.8 us per 16384-word frame (Ch 38 @ 2426 MHz = -11 MHz)
 *   - node=15 (ADC, 12-bit): Fs = 80 Msps -> 102.4 us per 16384-word frame (Ch 37 @ 2402 MHz, Ch 38 @ 2426 MHz)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WmsdrBle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WSIQ_MAGIC = 0x51495357;
  const BLE_ADV_CHANNELS = [
    { ch: 37, freqMhz: 2402 },
    { ch: 38, freqMhz: 2426 },
    { ch: 39, freqMhz: 2480 }
  ];

  const PDU_TYPES = {
    0: 'ADV_IND',
    1: 'ADV_DIRECT_IND',
    2: 'ADV_NONCONN_IND',
    3: 'SCAN_REQ',
    4: 'SCAN_RSP',
    5: 'CONNECT_IND',
    6: 'ADV_SCAN_IND',
    7: 'ADV_EXT_IND'
  };

  const COMPANY_NAMES = {
    0x004C: 'Apple',
    0x0006: 'Microsoft',
    0x0075: 'Samsung',
    0x00E0: 'Google',
    0x038F: 'Xiaomi',
    0x0157: 'Huami',
    0x027D: 'Huawei',
    0x0822: 'Shenzhen Goodix'
  };

  // Precompute 32-bit BLE advertising Access Address 0x8E89BED6 LSB-first in {-1, +1}
  const AA_BYTES = [0xD6, 0xBE, 0x89, 0x8E];
  const AA_BITS = new Int8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 8; k++) {
      AA_BITS[i * 8 + k] = ((AA_BYTES[i] >> k) & 1) ? 1 : -1;
    }
  }
  // Preamble for AA starting with bit 0 (0xD6 LSB = 0) -> 0xAA = 0,1,0,1,0,1,0,1
  const PRE_BITS = new Int8Array([-1, 1, -1, 1, -1, 1, -1, 1]);

  // 17-tap Hamming LPF fc=0.85 MHz @ 8 Msps
  const LPF_TAPS = 17;
  const LPF_HALF = 8;
  const LPF_H = new Float32Array(LPF_TAPS);
  {
    const fc = 0.85 / 8.0;
    let sum = 0;
    for (let n = 0; n < LPF_TAPS; n++) {
      const k = n - LPF_HALF;
      const sinc = k === 0 ? (2.0 * fc) : (Math.sin(2.0 * Math.PI * fc * k) / (Math.PI * k));
      const win = 0.54 - 0.46 * Math.cos((2.0 * Math.PI * n) / (LPF_TAPS - 1));
      LPF_H[n] = sinc * win;
      sum += LPF_H[n];
    }
    for (let n = 0; n < LPF_TAPS; n++) LPF_H[n] /= sum;
  }

  function bleWhitenInPlace(bits, len, ch) {
    let s0 = 1;
    let s1 = (ch >> 5) & 1;
    let s2 = (ch >> 4) & 1;
    let s3 = (ch >> 3) & 1;
    let s4 = (ch >> 2) & 1;
    let s5 = (ch >> 1) & 1;
    let s6 = ch & 1;
    for (let i = 0; i < len; i++) {
      const w = s6;
      bits[i] = bits[i] ^ w;
      const n0 = w;
      const n4 = s3 ^ w;
      s6 = s5; s5 = s4; s4 = n4; s3 = s2; s2 = s1; s1 = s0; s0 = n0;
    }
  }

  function bitsToBytesLsb(bits, startBit, nBytes, out) {
    for (let i = 0; i < nBytes; i++) {
      let v = 0;
      const base = startBit + i * 8;
      for (let k = 0; k < 8; k++) {
        v |= (bits[base + k] & 1) << k;
      }
      out[i] = v;
    }
  }

  function bleCrc24Matches(pduBytes, pduByteLen, rxCrcBytes) {
    let state = 0x555555;
    for (let i = 0; i < pduByteLen; i++) {
      const b = pduBytes[i];
      for (let k = 0; k < 8; k++) {
        const bit = (b >> k) & 1;
        const fb = ((state >>> 23) & 1) ^ bit;
        state = ((state << 1) & 0xFFFFFF);
        if (fb) state ^= 0x00065B;
      }
    }
    for (let bidx = 0; bidx < 3; bidx++) {
      let expByte = 0;
      for (let k = 0; k < 8; k++) {
        const bitPos = 23 - (bidx * 8 + k);
        expByte |= ((state >>> bitPos) & 1) << k;
      }
      if (rxCrcBytes[bidx] !== expByte) return false;
    }
    return true;
  }

  function hexOf(bytes, len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += bytes[i].toString(16).padStart(2, '0');
    }
    return s;
  }

  function formatMacRev(bytes, off) {
    const parts = [];
    for (let i = 5; i >= 0; i--) {
      parts.push(bytes[off + i].toString(16).padStart(2, '0').toUpperCase());
    }
    return parts.join(':');
  }

  function parseAdStructs(bytes, start, len) {
    const end = start + len;
    const items = [];
    let name = '';
    let i = start;
    while (i < end) {
      const flen = bytes[i];
      if (flen === 0 || i + 1 + flen > end) break;
      const adType = bytes[i + 1];
      const vStart = i + 2;
      const vLen = flen - 1;
      if (adType === 0x08 || adType === 0x09) {
        let s = '';
        for (let j = 0; j < vLen; j++) {
          const c = bytes[vStart + j];
          s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
        }
        name = s;
        items.push('Name=' + JSON.stringify(s));
      } else if (adType === 0x01 && vLen >= 1) {
        items.push('Flags=0x' + bytes[vStart].toString(16).padStart(2, '0'));
      } else if (adType === 0xFF && vLen >= 2) {
        const cid = bytes[vStart] | (bytes[vStart + 1] << 8);
        const cname = COMPANY_NAMES[cid] || ('0x' + cid.toString(16).padStart(4, '0').toUpperCase());
        items.push('Mfg(' + cname + ')=' + hexOf(bytes.subarray(vStart + 2, vStart + vLen), vLen - 2));
      } else if (adType === 0x16 && vLen >= 2) {
        const u16 = bytes[vStart] | (bytes[vStart + 1] << 8);
        items.push('Svc(0x' + u16.toString(16).padStart(4, '0').toUpperCase() + ')');
      } else if (adType === 0x02 || adType === 0x03) {
        const uuids = [];
        for (let j = 0; j + 1 < vLen; j += 2) {
          const u16 = bytes[vStart + j] | (bytes[vStart + j + 1] << 8);
          uuids.push('0x' + u16.toString(16).padStart(4, '0').toUpperCase());
        }
        items.push('UUID16=' + uuids.join(','));
      } else {
        items.push('AD(0x' + adType.toString(16).padStart(2, '0') + ')=' +
          hexOf(bytes.subarray(vStart, vStart + vLen), vLen));
      }
      i += 1 + flen;
    }
    return { summary: items.join(' · '), name: name };
  }

  function resolveChannels(loMhz, fsMhz) {
    if (!Number.isFinite(loMhz) || loMhz < 2380 || loMhz > 2500) return [];
    const halfBw = (Number.isFinite(fsMhz) && fsMhz > 0 ? fsMhz : 40) * 0.5;
    // Allow channels cleanly inside passband (margin 1.5 MHz from Nyquist edge)
    const active = [];
    for (let i = 0; i < BLE_ADV_CHANNELS.length; i++) {
      const c = BLE_ADV_CHANNELS[i];
      const fOffMhz = c.freqMhz - loMhz;
      if (Math.abs(fOffMhz) <= halfBw - 1.5) {
        active.push({ ch: c.ch, freqMhz: c.freqMhz, fOffMhz: fOffMhz });
      }
    }
    return active;
  }

  class BleDecoder {
    constructor() {
      this.noiseFloor = 1e-6;
      this.noiseSamples = 0;
      this.mixCache = new Map();
      this.iSamp = new Float32Array(8192);
      this.qSamp = new Float32Array(8192);
      this.z8Re = new Float32Array(1700);
      this.z8Im = new Float32Array(1700);
      this.pwr = new Float32Array(1700);
      this.zfRe = new Float32Array(1700);
      this.zfIm = new Float32Array(1700);
      this.dphi = new Float32Array(1700);
      this.symFlt = new Float32Array(1700);
      this.symSlice = new Float32Array(256);
      this.rawBits = new Uint8Array(256);
      this.pduBytes = new Uint8Array(64);
      this.crcBytes = new Uint8Array(4);
    }

    resetNoiseFloor() {
      this.noiseFloor = 1e-6;
      this.noiseSamples = 0;
    }

    _getMixTable(nSamp, fsHz, fOffHz) {
      const key = nSamp + ':' + Math.round(fsHz) + ':' + Math.round(fOffHz);
      let entry = this.mixCache.get(key);
      if (entry) return entry;
      if (this.mixCache.size > 16) this.mixCache.clear();
      const cosT = new Float32Array(nSamp);
      const sinT = new Float32Array(nSamp);
      const w = (2.0 * Math.PI * (-fOffHz)) / fsHz;
      for (let n = 0; n < nSamp; n++) {
        cosT[n] = Math.cos(w * n);
        sinT[n] = Math.sin(w * n);
      }
      entry = { cosT: cosT, sinT: sinT };
      this.mixCache.set(key, entry);
      return entry;
    }

    _demod8Msps(n8, chInfo, seq, outHits) {
      const z8Re = this.z8Re;
      const z8Im = this.z8Im;
      const zfRe = this.zfRe;
      const zfIm = this.zfIm;
      const dphi = this.dphi;
      const symFlt = this.symFlt;
      const symSlice = this.symSlice;

      // 17-tap Hamming LPF (fc=0.85 MHz @ 8 Msps)
      let maxEnvSq = 0;
      for (let i = 0; i < n8; i++) {
        let ar = 0;
        let ai = 0;
        for (let t = 0; t < LPF_TAPS; t++) {
          const j = i + t - LPF_HALF;
          if (j >= 0 && j < n8) {
            const h = LPF_H[t];
            ar += z8Re[j] * h;
            ai += z8Im[j] * h;
          }
        }
        zfRe[i] = ar;
        zfIm[i] = ai;
        const e2 = ar * ar + ai * ai;
        if (e2 > maxEnvSq) maxEnvSq = e2;
      }
      if (maxEnvSq < 1e-7) return;

      // Reject spiky broadband Wi-Fi OFDM before atan2 and 8-phase sync search
      const gateSq = maxEnvSq * 0.25;
      let actCnt = 0;
      let actSum = 0;
      let actSqSum = 0;
      for (let i = 0; i < n8; i++) {
        const rr = zfRe[i];
        const ii = zfIm[i];
        const e2 = rr * rr + ii * ii;
        if (e2 >= gateSq) {
          actCnt++;
          actSum += Math.sqrt(e2);
          actSqSum += e2;
        }
      }
      if (actCnt < 192) return;
      const actMean = actSum / actCnt;
      const actVar = Math.max(0, (actSqSum / actCnt) - actMean * actMean);
      if (Math.sqrt(actVar) / (actMean + 1e-9) > 0.28) return;

      // Instantaneous frequency discriminator + 4-tap matched filter
      const nDiff = n8 - 1;
      for (let i = 0; i < nDiff; i++) {
        const rr = zfRe[i];
        const ii = zfIm[i];
        const nr = zfRe[i + 1];
        const ni = zfIm[i + 1];
        dphi[i] = Math.atan2(ni * rr - nr * ii, nr * rr + ni * ii);
      }
      for (let i = 0; i < nDiff; i++) {
        let sum = 0;
        let cnt = 0;
        for (let t = -1; t <= 2; t++) {
          const idx = i + t;
          if (idx >= 0 && idx < nDiff) {
            sum += dphi[idx];
            cnt++;
          }
        }
        symFlt[i] = sum / cnt;
      }

      let bestHit = null;
      // Scan all 8 symbol-timing phases
      for (let phase = 0; phase < 8; phase++) {
        let sLen = 0;
        for (let p = phase; p < nDiff && sLen < 256; p += 8) {
          symSlice[sLen++] = symFlt[p];
        }
        if (sLen < 56) continue;

        const maxPos = sLen - 48;
        for (let k = 0; k <= maxPos; k++) {
          // Bit-balanced CFO midpoint over the 32-bit AA window
          let sumPos = 0;
          let sumNeg = 0;
          for (let j = 0; j < 32; j++) {
            if (AA_BITS[j] > 0) sumPos += symSlice[k + j];
            else sumNeg += symSlice[k + j];
          }
          const cfo = 0.5 * ((sumPos / 18.0) + (sumNeg / 14.0));

          let matches = 0;
          for (let j = 0; j < 32; j++) {
            const bit = (symSlice[k + j] - cfo) >= 0 ? 1 : -1;
            if (bit === AA_BITS[j]) matches++;
            else break;
          }
          if (matches < 32) continue;

          // Verify preamble if present (require >=7/8)
          let preMatches = -1;
          if (k >= 8) {
            preMatches = 0;
            for (let j = 0; j < 8; j++) {
              const bit = (symSlice[k - 8 + j] - cfo) >= 0 ? 1 : -1;
              if (bit === PRE_BITS[j]) preMatches++;
            }
            if (preMatches < 7) continue;
          }

          // Envelope stability check across 32-bit AA window (rejects wideband Wi-Fi OFDM)
          const zStart = phase + k * 8;
          const zEnd = Math.min(n8, zStart + 32 * 8);
          let envSum = 0;
          let envSqSum = 0;
          let envCnt = 0;
          for (let zi = zStart; zi < zEnd; zi++) {
            const e = Math.hypot(zfRe[zi], zfIm[zi]);
            envSum += e;
            envSqSum += e * e;
            envCnt++;
          }
          if (envCnt < 64) continue;
          const envMean = envSum / envCnt;
          const envVar = Math.max(0, (envSqSum / envCnt) - envMean * envMean);
          const envCv = Math.sqrt(envVar) / (envMean + 1e-9);
          if (envCv > 0.25) continue;

          // Trim final 2 edge-padded LPF boundary symbols to avoid trailing bit flips
          const remBits = Math.max(0, sLen - (k + 32) - 2);
          if (remBits < 16) continue;
          for (let b = 0; b < remBits; b++) {
            this.rawBits[b] = (symSlice[k + 32 + b] - cfo) >= 0 ? 1 : 0;
          }
          bleWhitenInPlace(this.rawBits, remBits, chInfo.ch);

          bitsToBytesLsb(this.rawBits, 0, 2, this.pduBytes);
          const hdr0 = this.pduBytes[0];
          const pduType = hdr0 & 0x0F;
          const txAdd = (hdr0 >> 6) & 1;
          const rxAdd = (hdr0 >> 7) & 1;
          const pduLen = this.pduBytes[1] & 0xFF;

          if (!(pduType in PDU_TYPES) || pduLen < 6 || pduLen > 37) {
            continue;
          }

          const availBytes = Math.min(2 + pduLen, Math.floor(remBits / 8));
          if (availBytes > 2) {
            bitsToBytesLsb(this.rawBits, 16, availBytes - 2, this.pduBytes.subarray(2));
          }

          let mac = '';
          let extInfo = '';
          let advSummary = '';
          let devName = '';
          let dataHex = '';

          if (pduType === 7) {
            // BT 5.x ADV_EXT_IND common extended header
            const extLen = pduLen;
            dataHex = hexOf(this.pduBytes.subarray(2), Math.max(0, availBytes - 2));
            if (availBytes >= 3) {
              const extHdrFlags = this.pduBytes[2] & 0x3F;
              const advMode = (this.pduBytes[2] >> 6) & 0x03;
              extInfo = 'ExtHdr flags=0x' + extHdrFlags.toString(16).padStart(2, '0') + ' mode=' + advMode;
              if (extLen >= 7 && (extHdrFlags & 0x01) && availBytes >= 9) {
                mac = formatMacRev(this.pduBytes, 3);
              } else {
                mac = 'BT5-EXT(' + dataHex.slice(0, 12) + ')';
              }
            }
          } else if (availBytes >= 8) {
            mac = formatMacRev(this.pduBytes, 2);
            const advDataAvail = Math.max(0, Math.min(pduLen - 6, availBytes - 8));
            if (advDataAvail > 0) {
              dataHex = hexOf(this.pduBytes.subarray(8), advDataAvail);
              const parsed = parseAdStructs(this.pduBytes, 8, advDataAvail);
              advSummary = parsed.summary;
              devName = parsed.name;
            }
          } else {
            dataHex = hexOf(this.pduBytes.subarray(2), Math.max(0, availBytes - 2));
          }

          let crcOk = null;
          const needCrcBits = (2 + pduLen + 3) * 8;
          if (remBits >= needCrcBits) {
            bitsToBytesLsb(this.rawBits, (2 + pduLen) * 8, 3, this.crcBytes);
            crcOk = bleCrc24Matches(this.pduBytes, 2 + pduLen, this.crcBytes);
          }

          const rssiDbfs = 20.0 * Math.log10(envMean + 1e-9);
          const cfoKhz = (cfo * 8e6) / (2.0 * Math.PI * 1e3);
          const score = matches * 100 + (preMatches >= 0 ? preMatches * 10 : 0) + (crcOk === true ? 50 : 0) - envCv * 10;

          if (!bestHit || score > bestHit._score) {
            bestHit = {
              _score: score,
              seq: seq,
              ch: chInfo.ch,
              freqMhz: chInfo.freqMhz,
              symIdx: k,
              aaMatches: matches,
              preMatches: preMatches,
              pduType: pduType,
              pduName: PDU_TYPES[pduType],
              txAdd: txAdd,
              rxAdd: rxAdd,
              pduLen: pduLen,
              mac: mac,
              devName: devName,
              advSummary: advSummary || extInfo,
              dataHex: dataHex,
              rssiDbfs: rssiDbfs,
              envCv: envCv,
              cfoKhz: cfoKhz,
              crcOk: crcOk,
              remBits: remBits
            };
          }
        }
      }

      if (bestHit) {
        delete bestHit._score;
        outHits.push(bestHit);
      }
    }

    scanFrame(arrayBuffer, opts) {
      const o = opts || {};
      const dv = new DataView(arrayBuffer);
      let node = o.node || 6;
      let words = Math.floor(arrayBuffer.byteLength / 4);
      let payloadOff = 0;
      let seq = 0;

      if (arrayBuffer.byteLength >= 32 && dv.getUint32(0, true) === WSIQ_MAGIC) {
        seq = dv.getUint32(8, true);
        node = dv.getUint32(12, true);
        const wHdr = dv.getUint32(16, true);
        if (wHdr > 0 && 32 + wHdr * 4 <= arrayBuffer.byteLength) {
          words = wHdr;
        } else {
          words = Math.floor((arrayBuffer.byteLength - 32) / 4);
        }
        payloadOff = 32;
      }

      const bits = (node === 6 || node === 8) ? 14 : 12;
      const scale = bits === 14 ? 8192.0 : 2048.0;
      const shift = 32 - bits;
      const fsMhz = Number.isFinite(o.fsMhz) && o.fsMhz > 0 ? o.fsMhz : (node === 15 ? 80.0 : 40.0);
      const loMhz = Number.isFinite(o.loMhz) && o.loMhz > 0 ? o.loMhz : 2437.0;
      const channels = resolveChannels(loMhz, fsMhz);
      if (channels.length === 0) return [];

      // Choose decimator targeting ~8 Msps (decim=5 at 40M, decim=10 at 80M)
      const decim = Math.max(2, Math.round(fsMhz / 8.0));
      const stride = (o.streamMode === 'all') ? 1 : 2;
      const phaseOff = (o.streamMode === 'odd') ? 1 : 0;
      const nSamp = Math.min(8192, Math.floor((words - phaseOff + stride - 1) / stride));
      if (nSamp < 56 * decim) return [];

      const u32 = new Uint32Array(arrayBuffer, payloadOff, words);
      const iSamp = this.iSamp;
      const qSamp = this.qSamp;
      let sumI = 0;
      let sumQ = 0;
      for (let k = 0, p = phaseOff; k < nSamp; k++, p += stride) {
        const w = u32[p];
        const iv = ((w << shift) >> shift) / scale;
        const qv = (((w >>> 16) << shift) >> shift) / scale;
        iSamp[k] = iv;
        qSamp[k] = qv;
        sumI += iv;
        sumQ += qv;
      }
      const meanI = sumI / nSamp;
      const meanQ = sumQ / nSamp;
      for (let k = 0; k < nSamp; k++) {
        iSamp[k] -= meanI;
        qSamp[k] -= meanQ;
      }

      const n8 = Math.min(1700, Math.floor(nSamp / decim));
      const invDecim = 1.0 / decim;
      const hits = [];

      for (let ci = 0; ci < channels.length; ci++) {
        const chInfo = channels[ci];
        const mix = this._getMixTable(nSamp, fsMhz * 1e6, chInfo.fOffMhz * 1e6);
        const cosT = mix.cosT;
        const sinT = mix.sinT;
        const z8Re = this.z8Re;
        const z8Im = this.z8Im;
        const pwr = this.pwr;

        let maxPwr = 0;
        let pSum = 0;
        let minBlock = Infinity;
        for (let b = 0, src = 0; b < n8; b++, src += decim) {
          let sr = 0;
          let si = 0;
          for (let d = 0; d < decim; d++) {
            const idx = src + d;
            const iv = iSamp[idx];
            const qv = qSamp[idx];
            const c = cosT[idx];
            const s = sinT[idx];
            // conj((I + jQ) * (cos - j*sin)) = (I*cos + Q*sin) + j*(I*sin - Q*cos)
            sr += iv * c + qv * s;
            si += iv * s - qv * c;
          }
          const zr = sr * invDecim;
          const zi = si * invDecim;
          z8Re[b] = zr;
          z8Im[b] = zi;
          const pw = zr * zr + zi * zi;
          pwr[b] = pw;
          pSum += pw;
          if (pw > maxPwr) maxPwr = pw;
          if ((b & 15) === 15) {
            const avg16 = pSum * (1.0 / 16.0);
            if (avg16 < minBlock) minBlock = avg16;
            pSum = 0;
          }
        }

        // Update quiet floor estimate using quietest 16-sample segment
        if (minBlock < Infinity && minBlock > 0) {
          if (this.noiseSamples === 0) {
            this.noiseFloor = minBlock;
          } else if (minBlock < this.noiseFloor) {
            this.noiseFloor = this.noiseFloor * 0.7 + minBlock * 0.3;
          } else {
            this.noiseFloor = this.noiseFloor * 0.995 + minBlock * 0.005;
          }
          this.noiseSamples++;
        }

        // Trigger demod only when channel power exceeds quiet baseline by >= 6x
        if (maxPwr < Math.max(1e-7, this.noiseFloor * 6.0)) {
          continue;
        }

        this._demod8Msps(n8, chInfo, seq, hits);
      }

      return hits;
    }
  }

  return {
    PDU_TYPES: PDU_TYPES,
    resolveChannels: resolveChannels,
    BleDecoder: BleDecoder
  };
});
