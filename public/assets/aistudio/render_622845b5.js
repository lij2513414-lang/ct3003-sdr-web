/* SPDX-License-Identifier: MIT */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.WmsdrRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PALETTE_STOPS = {
    sdrsharp: ['000000', '000020', '000046', '0b256e', '1e90ff', '38bdf8', 'fde047', 'fb923c', 'ef4444', '991b1b'],
    turbo:    ['30123b', '4145ab', '4675ed', '39a2fc', '1bcfd4', '24eca6', '61fc6c', 'a4fc3b', 'd1e834', 'f3c63a', 'fe9b2d', 'f36315', 'd93806', '7a0402'],
    viridis:  ['440154', '482878', '3e4989', '31688e', '26828e', '1f9e89', '35b779', '6dcd59', 'b4de2c', 'fde725'],
    classic:  ['020617', '0a1633', '0e3a73', '1e90ff', '93c5fd', 'f8fafc'],
    gray:     ['05070b', '525866', 'aeb7c4', 'f8fafc']
  };

  const paletteCache = new Map();

  function parseHexRgb(hex) {
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16)
    ];
  }

  function getPaletteLut(name) {
    const key = PALETTE_STOPS[name] ? name : 'sdrsharp';
    let lut = paletteCache.get(key);
    if (lut) return lut;

    const stops = PALETTE_STOPS[key].map(parseHexRgb);
    lut = new Uint8ClampedArray(256 * 3);
    const maxIdx = stops.length - 1;
    for (let i = 0; i < 256; i++) {
      const pos = (i / 255) * maxIdx;
      const lo = Math.floor(pos);
      const hi = Math.min(maxIdx, lo + 1);
      const frac = pos - lo;
      lut[i * 3]     = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * frac);
      lut[i * 3 + 1] = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * frac);
      lut[i * 3 + 2] = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * frac);
    }
    paletteCache.set(key, lut);
    return lut;
  }

  function getPaletteCssGradient(name) {
    const stops = PALETTE_STOPS[name] || PALETTE_STOPS.sdrsharp;
    return 'linear-gradient(90deg, ' + stops.map(function (c) { return '#' + c; }).join(', ') + ')';
  }

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(160, Math.floor(rect.width));
    const h = Math.max(110, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h, dpr };
  }

  function niceStep(range, targetCount) {
    if (range <= 0) return 1;
    const raw = range / Math.max(2, targetCount);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let nice = 10;
    if (norm <= 1.2) nice = 1;
    else if (norm <= 2.2) nice = 2;
    else if (norm <= 5.2) nice = 5;
    return nice * mag;
  }

  function formatFreqValue(hz, spanHz, withUnit) {
    const absSpan = Math.abs(spanHz);
    if (absSpan >= 2e6 || Math.abs(hz) >= 1e6) {
      const mhz = hz / 1e6;
      const dec = absSpan >= 20e6 ? 1 : absSpan >= 2e6 ? 2 : 3;
      return mhz.toFixed(dec) + (withUnit ? ' MHz' : '');
    }
    if (absSpan >= 2e3 || Math.abs(hz) >= 1e3) {
      return (hz / 1e3).toFixed(1) + (withUnit ? ' kHz' : '');
    }
    return Math.round(hz) + (withUnit ? ' Hz' : '');
  }

  function getFreqTicks(viewStartHz, viewEndHz, centerHz, plotW) {
    const span = viewEndHz - viewStartHz;
    const targetTicks = Math.max(4, Math.min(10, Math.floor(plotW / 90)));
    const step = niceStep(span, targetTicks);
    const first = Math.ceil((viewStartHz + centerHz) / step) * step - centerHz;
    const ticks = [];
    for (let f = first; f <= viewEndHz + step * 1e-6; f += step) {
      if (f < viewStartHz - step * 1e-6) continue;
      const frac = (f - viewStartHz) / span;
      ticks.push({
        relHz: f,
        absHz: f + centerHz,
        frac,
        label: formatFreqValue(f + centerHz, span, false)
      });
    }
    return { ticks, unit: Math.abs(centerHz) >= 1e6 || span >= 2e6 ? 'MHz' : span >= 2e3 ? 'kHz' : 'Hz' };
  }

  const FREQ_PAD_L = 54;
  const FREQ_PAD_R = 16;
  let specColY = null;
  let specColDb = null;

  function ensureSpecScratch(plotW) {
    if (!specColY || specColY.length < plotW) {
      specColY = new Float32Array(plotW);
      specColDb = new Float32Array(plotW);
    }
  }

  function drawSpectrum(canvas, state) {
    const { ctx, w, h } = fitCanvas(canvas);
    const padT = 22;
    const padB = 24;
    const plotW = Math.max(20, w - FREQ_PAD_L - FREQ_PAD_R);
    const plotH = Math.max(20, h - padT - padB);

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    const dbMin = state.dbMin;
    const dbMax = Math.max(dbMin + 10, state.dbMax);
    const dbSpan = dbMax - dbMin;
    const fsHz = state.fsHz || 40e6;
    const centerHz = state.centerHz || 0;
    const viewStart = Math.max(0, Math.min(0.99, state.viewStart || 0));
    const viewSpan = Math.max(0.01, Math.min(1 - viewStart, state.viewSpan || 1));

    const viewStartHz = (viewStart - 0.5) * fsHz;
    const viewEndHz = (viewStart + viewSpan - 0.5) * fsHz;

    function dbToY(db) {
      const t = (db - dbMin) / dbSpan;
      return padT + plotH * (1 - Math.max(0, Math.min(1, t)));
    }

    // Horizontal dB grid
    const dbStep = niceStep(dbSpan, Math.max(3, Math.floor(plotH / 34)));
    const firstDb = Math.ceil(dbMin / dbStep) * dbStep;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (let db = firstDb; db <= dbMax + 1e-6; db += dbStep) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.strokeStyle = Math.abs(db) < 1e-6 ? 'rgba(148, 163, 184, 0.35)' : 'rgba(148, 163, 184, 0.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(FREQ_PAD_L, y);
      ctx.lineTo(FREQ_PAD_L + plotW, y);
      ctx.stroke();

      ctx.fillStyle = '#94a3b8';
      ctx.fillText(db.toFixed(0), FREQ_PAD_L - 6, y);
    }

    // Vertical frequency grid
    const { ticks, unit } = getFreqTicks(viewStartHz, viewEndHz, centerHz, plotW);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i < ticks.length; i++) {
      const tk = ticks[i];
      const x = Math.round(FREQ_PAD_L + tk.frac * plotW) + 0.5;
      const isDc = Math.abs(tk.relHz) < (viewEndHz - viewStartHz) * 1e-4;
      ctx.strokeStyle = isDc ? 'rgba(56, 189, 248, 0.28)' : 'rgba(148, 163, 184, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = isDc ? '#7dd3fc' : '#94a3b8';
      ctx.fillText(tk.label, x, padT + plotH + 5);
    }

    // Unit tag cleanly placed in top header gutter
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('dBFS / ' + unit, FREQ_PAD_L + 4, 4);

    const bins = state.binsDb;
    if (bins && bins.length > 1) {
      const n = bins.length;
      const startBin = Math.max(0, Math.floor(viewStart * (n - 1)));
      const endBin = Math.min(n - 1, Math.ceil((viewStart + viewSpan) * (n - 1)));

      ctx.save();
      ctx.beginPath();
      ctx.rect(FREQ_PAD_L, padT, plotW, plotH);
      ctx.clip();

      // Column-aggregated peak per pixel column preserves narrow carriers when zoomed out
      ensureSpecScratch(plotW);
      const colY = specColY;
      const colDb = specColDb;
      for (let px = 0; px < plotW; px++) {
        const b0 = Math.floor((viewStart + (px / plotW) * viewSpan) * (n - 1));
        const b1 = Math.max(b0, Math.floor((viewStart + ((px + 1) / plotW) * viewSpan) * (n - 1)));
        let maxV = -Infinity;
        for (let b = b0; b <= b1 && b < n; b++) {
          if (bins[b] > maxV) maxV = bins[b];
        }
        colDb[px] = maxV > -Infinity ? maxV : dbMin;
        colY[px] = dbToY(colDb[px]);
      }

      if (state.showFill) {
        const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        grad.addColorStop(0, 'rgba(56, 189, 248, 0.36)');
        grad.addColorStop(0.65, 'rgba(30, 144, 255, 0.14)');
        grad.addColorStop(1, 'rgba(15, 23, 42, 0.02)');
        ctx.beginPath();
        ctx.moveTo(FREQ_PAD_L, padT + plotH);
        for (let px = 0; px < plotW; px++) {
          ctx.lineTo(FREQ_PAD_L + px + 0.5, colY[px]);
        }
        ctx.lineTo(FREQ_PAD_L + plotW - 0.5, padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
      }

      if (state.showPeak && state.peakDb && state.peakDb.length === n) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
        ctx.lineWidth = 1.25;
        ctx.setLineDash([4, 3]);
        for (let px = 0; px < plotW; px++) {
          const b0 = Math.floor((viewStart + (px / plotW) * viewSpan) * (n - 1));
          const b1 = Math.max(b0, Math.floor((viewStart + ((px + 1) / plotW) * viewSpan) * (n - 1)));
          let pk = -Infinity;
          for (let b = b0; b <= b1 && b < n; b++) {
            if (state.peakDb[b] > pk) pk = state.peakDb[b];
          }
          const py = dbToY(pk > -Infinity ? pk : dbMin);
          if (px === 0) ctx.moveTo(FREQ_PAD_L + 0.5, py);
          else ctx.lineTo(FREQ_PAD_L + px + 0.5, py);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Main spectrum trace (linear interpolation if bins <= plotW, peak-per-column otherwise)
      ctx.beginPath();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      if (endBin - startBin + 1 < plotW) {
        let started = false;
        for (let b = startBin; b <= endBin; b++) {
          const frac = ((b / (n - 1)) - viewStart) / viewSpan;
          const x = FREQ_PAD_L + frac * plotW;
          const y = dbToY(bins[b]);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
      } else {
        for (let px = 0; px < plotW; px++) {
          if (px === 0) ctx.moveTo(FREQ_PAD_L + 0.5, colY[px]);
          else ctx.lineTo(FREQ_PAD_L + px + 0.5, colY[px]);
        }
      }
      ctx.stroke();

      // Marker line
      if (typeof state.markerNorm === 'number') {
        const mf = (state.markerNorm - viewStart) / viewSpan;
        if (mf >= 0 && mf <= 1) {
          const mx = Math.round(FREQ_PAD_L + mf * plotW) + 0.5;
          ctx.strokeStyle = 'rgba(251, 113, 133, 0.9)';
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, padT);
          ctx.lineTo(mx, padT + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Hover crosshair + pill
      if (state.hoverNorm != null) {
        const hf = (state.hoverNorm - viewStart) / viewSpan;
        if (hf >= 0 && hf <= 1) {
          const hx = FREQ_PAD_L + hf * plotW;
          const hb = Math.max(0, Math.min(n - 1, Math.round(state.hoverNorm * (n - 1))));
          const hDb = bins[hb];
          const hy = dbToY(hDb);

          ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(hx, padT);
          ctx.lineTo(hx, padT + plotH);
          ctx.moveTo(FREQ_PAD_L, hy);
          ctx.lineTo(FREQ_PAD_L + plotW, hy);
          ctx.stroke();

          ctx.fillStyle = '#f8fafc';
          ctx.beginPath();
          ctx.arc(hx, hy, 3, 0, Math.PI * 2);
          ctx.fill();

          const hFreq = (state.hoverNorm - 0.5) * fsHz + centerHz;
          const label = formatFreqValue(hFreq, viewEndHz - viewStartHz, true) + ' | ' + hDb.toFixed(1) + ' dBFS';
          ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          const tw = ctx.measureText(label).width + 12;
          const bx = Math.min(FREQ_PAD_L + plotW - tw - 4, Math.max(FREQ_PAD_L + 4, hx + 8));
          const by = Math.max(padT + 4, hy - 24);
          ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
          ctx.fillRect(bx, by, tw, 18);
          ctx.strokeRect(bx + 0.5, by + 0.5, tw - 1, 17);
          ctx.fillStyle = '#e2e8f0';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, bx + 6, by + 9);
        }
      }

      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.strokeRect(FREQ_PAD_L + 0.5, padT + 0.5, plotW - 1, plotH - 1);
  }

  class WaterfallRenderer {
    constructor(maxRows) {
      this.maxRows = maxRows || 260;
      this.rows = new Array(this.maxRows);
      this.head = 0;
      this.count = 0;
      this.imgData = null;
      this.offscreen = null;
      this.offCtx = null;
      this.rowScratch = null;
      this.pushSeq = 0;
      this.renderedSeq = 0;
      this.lastParamsKey = '';
    }

    get rowCount() {
      return this.count;
    }

    clear() {
      this.head = 0;
      this.count = 0;
      this.pushSeq = 0;
      this.renderedSeq = 0;
      this.lastParamsKey = '';
    }

    pushRow(binsDb) {
      if (!binsDb || binsDb.length === 0) return;
      let idx;
      if (this.count < this.maxRows) {
        idx = (this.head + this.count) % this.maxRows;
        this.count++;
      } else {
        idx = this.head;
        this.head = (this.head + 1) % this.maxRows;
      }
      let slot = this.rows[idx];
      if (!slot || slot.length !== binsDb.length) {
        slot = new Float32Array(binsDb.length);
        this.rows[idx] = slot;
      }
      slot.set(binsDb);
      this.pushSeq++;
    }

    _recentRow(age) {
      const idx = (this.head + this.count - 1 - age + this.maxRows) % this.maxRows;
      return this.rows[idx];
    }

    _paintRow(srcRow, rTop, plotW, plotH, rowHeight, viewStart, viewSpan, dbMin, invSpan, contrast, lut, stride) {
      const n = srcRow.length;
      const scratch = this.rowScratch;
      const data = this.imgData.data;
      for (let px = 0; px < plotW; px++) {
        const b0 = Math.floor((viewStart + (px / plotW) * viewSpan) * (n - 1));
        const b1 = Math.max(b0, Math.floor((viewStart + ((px + 1) / plotW) * viewSpan) * (n - 1)));
        let val = -Infinity;
        for (let b = b0; b <= b1 && b < n; b++) {
          if (srcRow[b] > val) val = srcRow[b];
        }
        let norm = (val - dbMin) * invSpan + contrast;
        if (norm < 0) norm = 0;
        else if (norm > 1) norm = 1;
        const idx = ((norm * 255) | 0) * 3;
        const dst = px * 4;
        scratch[dst]     = lut[idx];
        scratch[dst + 1] = lut[idx + 1];
        scratch[dst + 2] = lut[idx + 2];
        scratch[dst + 3] = 255;
      }
      const y0 = rTop * rowHeight;
      for (let ry = 0; ry < rowHeight && y0 + ry < plotH; ry++) {
        data.set(scratch, (y0 + ry) * stride);
      }
    }

    draw(canvas, state) {
      const { ctx, w, h } = fitCanvas(canvas);
      const padT = 8;
      const padB = 22;
      const plotW = Math.max(20, w - FREQ_PAD_L - FREQ_PAD_R);
      const plotH = Math.max(20, h - padT - padB);

      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, w, h);

      const dbMin = state.dbMin;
      const dbMax = Math.max(dbMin + 10, state.dbMax);
      const contrast = (state.contrast || 0) * 0.01;
      const invSpan = 1 / (dbMax - dbMin);
      const paletteName = state.palette || 'sdrsharp';
      const lut = getPaletteLut(paletteName);
      const viewStart = Math.max(0, Math.min(0.99, state.viewStart || 0));
      const viewSpan = Math.max(0.01, Math.min(1 - viewStart, state.viewSpan || 1));
      const rowHeight = Math.max(1, state.rowHeight || 2);

      if (!this.imgData || this.imgData.width !== plotW || this.imgData.height !== plotH) {
        this.imgData = ctx.createImageData(plotW, plotH);
        this.offscreen = document.createElement('canvas');
        this.offscreen.width = plotW;
        this.offscreen.height = plotH;
        this.offCtx = this.offscreen.getContext('2d');
        this.rowScratch = new Uint8ClampedArray(plotW * 4);
        this.lastParamsKey = '';
      }

      const data = this.imgData.data;
      const totalRows = this.count;
      const maxVisibleRows = Math.ceil(plotH / rowHeight);
      const drawRows = Math.min(totalRows, maxVisibleRows);
      const stride = plotW * 4;

      const paramsKey = [plotW, plotH, dbMin, dbMax, contrast.toFixed(3), paletteName,
        viewStart.toFixed(5), viewSpan.toFixed(5), rowHeight].join(':');
      const delta = this.pushSeq - this.renderedSeq;

      if (this.lastParamsKey === paramsKey && this.renderedSeq > 0 && delta === 0) {
        // Hover/axis-only redraw: pixel buffer already up to date
      } else if (
        this.lastParamsKey === paramsKey &&
        this.renderedSeq > 0 &&
        delta > 0 &&
        delta * rowHeight < plotH
      ) {
        const shiftPx = delta * rowHeight;
        data.copyWithin(shiftPx * stride, 0, (plotH - shiftPx) * stride);
        for (let r = 0; r < delta && r < totalRows; r++) {
          this._paintRow(
            this._recentRow(r),
            r, plotW, plotH, rowHeight, viewStart, viewSpan, dbMin, invSpan, contrast, lut, stride
          );
        }
        this.renderedSeq = this.pushSeq;
      } else {
        for (let i = 0; i < data.length; i += 4) {
          data[i] = 6;
          data[i + 1] = 9;
          data[i + 2] = 15;
          data[i + 3] = 255;
        }
        for (let r = 0; r < drawRows; r++) {
          this._paintRow(
            this._recentRow(r),
            r, plotW, plotH, rowHeight, viewStart, viewSpan, dbMin, invSpan, contrast, lut, stride
          );
        }
        this.lastParamsKey = paramsKey;
        this.renderedSeq = this.pushSeq;
      }

      this.offCtx.putImageData(this.imgData, 0, 0);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.offscreen, FREQ_PAD_L, padT, plotW, plotH);
      ctx.restore();

      // Left row depth / age ticks
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText('now', FREQ_PAD_L - 6, padT + 7);
      if (drawRows > 10) {
        ctx.fillText('-' + drawRows + 'f', FREQ_PAD_L - 6, padT + Math.min(plotH - 7, drawRows * rowHeight - 5));
      }

      // Synchronized frequency axis ticks
      const fsHz = state.fsHz || 40e6;
      const centerHz = state.centerHz || 0;
      const viewStartHz = (viewStart - 0.5) * fsHz;
      const viewEndHz = (viewStart + viewSpan - 0.5) * fsHz;
      const { ticks } = getFreqTicks(viewStartHz, viewEndHz, centerHz, plotW);

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < ticks.length; i++) {
        const tk = ticks[i];
        const x = Math.round(FREQ_PAD_L + tk.frac * plotW) + 0.5;
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.12)';
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();
        ctx.fillStyle = '#94a3b8';
        ctx.fillText(tk.label, x, padT + plotH + 4);
      }

      // Marker & Hover guide line
      if (typeof state.markerNorm === 'number') {
        const mf = (state.markerNorm - viewStart) / viewSpan;
        if (mf >= 0 && mf <= 1) {
          const mx = Math.round(FREQ_PAD_L + mf * plotW) + 0.5;
          ctx.strokeStyle = 'rgba(251, 113, 133, 0.9)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(mx, padT);
          ctx.lineTo(mx, padT + plotH);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (typeof state.hoverNorm === 'number') {
        const hf = (state.hoverNorm - viewStart) / viewSpan;
        if (hf >= 0 && hf <= 1) {
          const hx = Math.round(FREQ_PAD_L + hf * plotW) + 0.5;
          ctx.strokeStyle = 'rgba(248, 250, 252, 0.35)';
          ctx.beginPath();
          ctx.moveTo(hx, padT);
          ctx.lineTo(hx, padT + plotH);
          ctx.stroke();
        }
      }

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.strokeRect(FREQ_PAD_L + 0.5, padT + 0.5, plotW - 1, plotH - 1);
    }
  }

  function drawWaveform(canvas, state) {
    const { ctx, w, h } = fitCanvas(canvas);
    const padL = 54;
    const padR = 16;
    const padT = 16;
    const padB = 24;
    const plotW = Math.max(20, w - padL - padR);
    const plotH = Math.max(20, h - padT - padB);

    ctx.fillStyle = '#090d16';
    ctx.fillRect(0, 0, w, h);

    const decoded = state.decoded;
    const total = decoded ? decoded.count : 0;
    const offset = Math.max(0, Math.min(Math.max(0, total - 1), state.timeOffset || 0));
    const winLen = Math.max(16, Math.min(Math.max(16, total - offset), state.timeWindow || 512));
    const yScaleMode = state.autoScaleY && state.maxAbsNorm > 0 ? Math.min(1, state.maxAbsNorm * 1.15) : 1;
    const midY = padT + plotH * 0.5;
    const halfH = plotH * 0.46;

    function valToY(normVal) {
      return midY - (normVal / yScaleMode) * halfH;
    }

    // Horizontal zero & +/- scale ticks
    const fullRaw = decoded ? decoded.fullScale : 2048;
    const maxRawLabel = fullRaw === 1 ? yScaleMode.toFixed(2) : Math.round(fullRaw * yScaleMode);
    const halfRawLabel = fullRaw === 1 ? (yScaleMode * 0.5).toFixed(2) : Math.round(fullRaw * yScaleMode * 0.5);
    const yLevels = [
      { frac: 1, label: '+' + maxRawLabel },
      { frac: 0.5, label: '+' + halfRawLabel },
      { frac: 0, label: '0' },
      { frac: -0.5, label: '-' + halfRawLabel },
      { frac: -1, label: '-' + maxRawLabel }
    ];

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < yLevels.length; i++) {
      const y = Math.round(midY - yLevels[i].frac * halfH) + 0.5;
      ctx.strokeStyle = yLevels[i].frac === 0 ? 'rgba(148, 163, 184, 0.35)' : 'rgba(148, 163, 184, 0.13)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(yLevels[i].label, padL - 6, y);
    }

    // Sample index X ticks
    const xStep = niceStep(winLen, Math.max(4, Math.floor(plotW / 85)));
    const firstSample = Math.ceil(offset / xStep) * xStep;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = firstSample; s <= offset + winLen; s += xStep) {
      const frac = (s - offset) / Math.max(1, winLen - 1);
      if (frac < 0 || frac > 1) continue;
      const x = Math.round(padL + frac * plotW) + 0.5;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(String(Math.round(s)), x, padT + plotH + 5);
    }

    if (decoded && total > 0) {
      const { iNorm, qNorm, iRaw, qRaw, rawWords } = decoded;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, padT, plotW, plotH);
      ctx.clip();

      const drawSeries = function (arr, color, showDots) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.45;
        ctx.beginPath();
        if (winLen <= plotW) {
          for (let k = 0; k < winLen; k++) {
            const idx = offset + k;
            const x = padL + (k / Math.max(1, winLen - 1)) * plotW;
            const y = valToY(arr[idx]);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          if (showDots && winLen <= 200) {
            for (let k = 0; k < winLen; k++) {
              const x = padL + (k / Math.max(1, winLen - 1)) * plotW;
              const y = valToY(arr[offset + k]);
              ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
            }
          }
        } else {
          // Min-max envelope per pixel column prevents sample peaks disappearing
          for (let px = 0; px < plotW; px++) {
            const s0 = offset + Math.floor((px / plotW) * winLen);
            const s1 = Math.min(offset + winLen - 1, offset + Math.floor(((px + 1) / plotW) * winLen));
            let mn = Infinity;
            let mx = -Infinity;
            for (let s = s0; s <= s1; s++) {
              const v = arr[s];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            const x = padL + px + 0.5;
            const yHi = valToY(mx);
            const yLo = valToY(mn);
            ctx.moveTo(x, yHi);
            ctx.lineTo(x, Math.abs(yLo - yHi) < 1 ? yHi + 1 : yLo);
          }
          ctx.stroke();
        }
      };

      if (state.showEnvelope) {
        ctx.strokeStyle = 'rgba(192, 132, 252, 0.72)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        if (winLen <= plotW) {
          for (let k = 0; k < winLen; k++) {
            const idx = offset + k;
            const mag = Math.hypot(iNorm[idx], qNorm[idx]);
            const x = padL + (k / Math.max(1, winLen - 1)) * plotW;
            const y = valToY(mag);
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        } else {
          for (let px = 0; px < plotW; px++) {
            const s0 = offset + Math.floor((px / plotW) * winLen);
            const s1 = Math.min(offset + winLen - 1, offset + Math.floor(((px + 1) / plotW) * winLen));
            let mx = 0;
            for (let s = s0; s <= s1; s++) {
              const mag = Math.hypot(iNorm[s], qNorm[s]);
              if (mag > mx) mx = mag;
            }
            const x = padL + px + 0.5;
            const y = valToY(mx);
            if (px === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      if (state.showQ !== false) drawSeries(qNorm, '#f59e0b', true);
      if (state.showI !== false) drawSeries(iNorm, '#38bdf8', true);

      // Legend badges
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#38bdf8';
      ctx.fillText('I', padL + 8, padT + 4);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('Q', padL + 22, padT + 4);
      if (state.showEnvelope) {
        ctx.fillStyle = '#c084fc';
        ctx.fillText('|z|', padL + 36, padT + 4);
      }

      // Hover readout
      if (typeof state.hoverFrac === 'number' && state.hoverFrac >= 0 && state.hoverFrac <= 1) {
        const sIdx = Math.max(offset, Math.min(total - 1, Math.round(offset + state.hoverFrac * (winLen - 1))));
        const x = padL + ((sIdx - offset) / Math.max(1, winLen - 1)) * plotW;
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.4)';
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.stroke();

        const iv = iRaw[sIdx];
        const qv = qRaw[sIdx];
        const deg = (Math.atan2(qNorm[sIdx], iNorm[sIdx]) * 180) / Math.PI;
        const hex = rawWords ? (' 0x' + rawWords[sIdx].toString(16).padStart(8, '0')) : '';
        const text = '#' + sIdx + ' I=' + (typeof iv === 'number' && !Number.isInteger(iv) ? iv.toFixed(3) : iv) +
          ' Q=' + (typeof qv === 'number' && !Number.isInteger(qv) ? qv.toFixed(3) : qv) +
          ' (' + deg.toFixed(0) + '°)' + hex;
        const tw = ctx.measureText(text).width + 12;
        const bx = Math.min(padL + plotW - tw - 4, Math.max(padL + 4, x + 8));
        ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)';
        ctx.fillRect(bx, padT + 4, tw, 18);
        ctx.strokeRect(bx + 0.5, padT + 4.5, tw - 1, 17);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(text, bx + 6, padT + 7);
      }

      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
  }

  class ConstellationRenderer {
    constructor() {
      this.persistCanvas = null;
      this.lastW = 0;
      this.lastH = 0;
    }

    clear() {
      if (this.persistCanvas) {
        const pctx = this.persistCanvas.getContext('2d');
        pctx.clearRect(0, 0, this.persistCanvas.width, this.persistCanvas.height);
      }
    }

    draw(canvas, state) {
      const { ctx, w, h } = fitCanvas(canvas);
      const pad = 26;
      const side = Math.max(60, Math.min(w - pad * 2, h - pad * 2));
      const ox = Math.floor((w - side) * 0.5);
      const oy = Math.floor((h - side) * 0.5);
      const cx = ox + side * 0.5;
      const cy = oy + side * 0.5;
      const radius = side * 0.46;

      if (!this.persistCanvas) {
        this.persistCanvas = document.createElement('canvas');
      }
      if (this.lastW !== side || this.lastH !== side) {
        this.persistCanvas.width = side;
        this.persistCanvas.height = side;
        this.lastW = side;
        this.lastH = side;
      }

      const pctx = this.persistCanvas.getContext('2d');
      const persist = Math.max(0, Math.min(0.95, state.persistence || 0));
      if (persist <= 0.01) {
        pctx.clearRect(0, 0, side, side);
      } else {
        pctx.globalCompositeOperation = 'destination-out';
        pctx.fillStyle = 'rgba(0, 0, 0, ' + (1 - persist).toFixed(3) + ')';
        pctx.fillRect(0, 0, side, side);
        pctx.globalCompositeOperation = 'source-over';
      }

      const decoded = state.decoded;
      const gain = Math.max(0.25, state.constGain || 1);
      if (decoded && decoded.count > 0) {
        const { iNorm, qNorm, count } = decoded;
        const maxDots = Math.min(count, state.maxPoints || 8192);
        const step = Math.max(1, Math.floor(count / maxDots));
        const halfSide = side * 0.5;
        const dotR = side * 0.46 * gain;

        pctx.fillStyle = state.heatColor ? 'rgba(56, 189, 248, 0.28)' : 'rgba(56, 189, 248, 0.58)';
        for (let k = 0; k < count; k += step) {
          const x = halfSide + iNorm[k] * dotR;
          const y = halfSide - qNorm[k] * dotR;
          if (x < 0 || x >= side || y < 0 || y >= side) continue;
          pctx.fillRect(x - 0.75, y - 0.75, 1.8, 1.8);
        }
      }

      ctx.fillStyle = '#090d16';
      ctx.fillRect(0, 0, w, h);

      // Reference circles & square box
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);

      // Axes
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.beginPath();
      ctx.moveTo(ox, cy + 0.5);
      ctx.lineTo(ox + side, cy + 0.5);
      ctx.moveTo(cx + 0.5, oy);
      ctx.lineTo(cx + 0.5, oy + side);
      ctx.stroke();

      // Blit persistence layer
      ctx.drawImage(this.persistCanvas, ox, oy);

      // DC centroid crosshair
      if (state.stats && decoded && decoded.fullScale > 0) {
        const dcX = cx + (state.stats.meanI / decoded.fullScale) * radius * gain;
        const dcY = cy - (state.stats.meanQ / decoded.fullScale) * radius * gain;
        ctx.strokeStyle = '#fb7185';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(dcX - 5, dcY);
        ctx.lineTo(dcX + 5, dcY);
        ctx.moveTo(dcX, dcY - 5);
        ctx.lineTo(dcX, dcY + 5);
        ctx.stroke();
      }

      // Labels
      const fs = decoded ? decoded.fullScale : 2048;
      const dispMax = gain === 1 ? fs : (fs / gain);
      const maxStr = dispMax === 1 ? '1.0' : (dispMax >= 100 ? Math.round(dispMax) : dispMax.toFixed(1));
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.fillStyle = '#94a3b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('+Q (' + maxStr + ')', cx, oy - 4);
      ctx.textBaseline = 'top';
      ctx.fillText('-Q', cx, oy + side + 4);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('+I', ox + side + 5, cy);
      ctx.textAlign = 'right';
      ctx.fillText('-I', ox - 5, cy);

      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.strokeRect(ox + 0.5, oy + 0.5, side - 1, side - 1);
    }
  }

  return {
    PALETTE_STOPS,
    FREQ_PAD_L,
    FREQ_PAD_R,
    getPaletteLut,
    getPaletteCssGradient,
    drawSpectrum,
    WaterfallRenderer,
    drawWaveform,
    ConstellationRenderer
  };
});
