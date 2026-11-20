/* SPDX-License-Identifier: MIT */
(function () {
  'use strict';

  const Dsp = window.WmsdrDsp;
  const Render = window.WmsdrRender;

  const $ = function (id) { return document.getElementById(id); };

  const els = {
    btnSidebar: $('btn-sidebar'),
    sidebar: $('sidebar'),
    selSource: $('sel-source'),
    btnStream: $('btn-stream'),
    btnOneshot: $('btn-oneshot'),
    btnBand0: $('btn-band-0'),
    btnBand1: $('btn-band-1'),
    selNodePreset: $('sel-node-preset'),
    inpNode: $('inp-node'),
    selLen: $('sel-len'),
    selMode: $('sel-mode'),
    selBw: $('sel-bw'),
    selFpsLimit: $('sel-fps-limit'),
    btnDownload: $('btn-download'),

    pillConn: $('pill-conn'),
    pillConnText: $('pill-conn-text'),
    pillFw: $('pill-fw'),
    pillTick: $('pill-tick'),
    pillCr: $('pill-cr'),
    pillFps: $('pill-fps'),

    inpRouterUrl: $('inp-router-url'),
    btnUseRouter: $('btn-use-router'),
    btnUseOrigin: $('btn-use-origin'),
    inpFile: $('inp-file'),
    fileInfo: $('file-info'),
    serverSamplesRow: $('server-samples-row'),
    selServerSample: $('sel-server-sample'),
    selSynth: $('sel-synth'),
    inpInterval: $('inp-interval'),
    filePlaybackBar: $('file-playback-bar'),
    rngFilePos: $('rng-file-pos'),
    outFilePos: $('out-file-pos'),
    btnFilePlay: $('btn-file-play'),
    btnFileStep: $('btn-file-step'),
    btnStatusRefresh: $('btn-status-refresh'),

    selFormat: $('sel-format'),
    selHeader: $('sel-header'),
    selStream: $('sel-stream'),
    inpFs: $('inp-fs'),
    inpLo: $('inp-lo'),
    chkSwap: $('chk-swap'),
    chkDc: $('chk-dc'),
    btnSyncRf: $('btn-sync-rf'),
    rfHwInfo: $('rf-hw-info'),

    selFftSize: $('sel-fft-size'),
    selWindow: $('sel-window'),
    selDetector: $('sel-detector'),
    selPalette: $('sel-palette'),
    paletteSwatch: $('palette-swatch'),
    rngEma: $('rng-ema'),
    outEma: $('out-ema'),
    rngDbMin: $('rng-db-min'),
    outDbMin: $('out-db-min'),
    rngDbMax: $('rng-db-max'),
    outDbMax: $('out-db-max'),
    rngWfContrast: $('rng-wf-contrast'),
    outWfContrast: $('out-wf-contrast'),
    rngConstPersist: $('rng-const-persist'),
    outConstPersist: $('out-const-persist'),
    chkFill: $('chk-fill'),
    chkPeakHold: $('chk-peak-hold'),
    chkWfEnv: $('chk-wf-env'),
    chkWfAuto: $('chk-wf-auto'),
    btnAutoDb: $('btn-auto-db'),
    btnResetZoom: $('btn-reset-zoom'),
    btnClearWf: $('btn-clear-wf'),

    stCount: $('st-count'),
    stNonzero: $('st-nonzero'),
    stTrans: $('st-trans'),
    stRangeI: $('st-range-i'),
    stRangeQ: $('st-range-q'),
    stDc: $('st-dc'),
    stRms: $('st-rms'),
    stPwr: $('st-pwr'),
    stAc1: $('st-ac1'),
    hexPreview: $('hex-preview'),

    plotsGrid: $('plots-grid'),
    cvSpectrum: $('cv-spectrum'),
    cvWaterfall: $('cv-waterfall'),
    cvTime: $('cv-time'),
    cvConstellation: $('cv-constellation'),
    metaSpectrum: $('meta-spectrum'),
    metaWaterfall: $('meta-waterfall'),
    metaTime: $('meta-time'),
    metaConst: $('meta-const'),
    selTimeWin: $('sel-time-win'),
    rngTimeOff: $('rng-time-off'),
    selConstGain: $('sel-const-gain'),
    chkBleEnable: $('chk-ble-enable'),
    btnBlePreset: $('btn-ble-preset'),
    btnBleClear: $('btn-ble-clear'),
    bleStatusNote: $('ble-status-note'),
    bleMiniList: $('ble-mini-list'),
    metaBle: $('meta-ble'),
    btnBlePanePreset: $('btn-ble-pane-preset'),
    btnBlePaneClear: $('btn-ble-pane-clear'),
    bleDevTbody: $('ble-dev-tbody'),
    blePktLog: $('ble-pkt-log'),

    dropOverlay: $('drop-overlay'),
    emptyPanes: $('empty-panes'),
    btnRestorePanes: $('btn-restore-panes'),
    toast: $('toast')
  };

  const waterfall = new Render.WaterfallRenderer(260);
  const constellation = new Render.ConstellationRenderer();

  const DEFAULT_ROUTER_URL = 'http://192.168.6.2:8088';

  const state = {
    isFileProtocol: window.location.protocol === 'file:',
    serverOnline: false,
    demoMode: false,
    directRouter: false,
    band: 0,
    bandsMeta: null,
    ws: null,
    wsLanes: [],
    wsSid: 0,
    activeLanes: 0,
    lastLiveSeq: -1,
    forceSingleLane: false,
    wsConnected: false,
    wsShouldReconnect: true,
    streaming: false,
    localPlaying: false,
    streamTimer: null,
    fileTimer: null,
    synthState: { phase: 0, frame: 0, seed: 0x13572468, sweepPhase: 0 },

    fileRawBuffer: null,
    fileBuffer: null,
    fileName: '',
    filePayloadMeta: null,
    fileTotalSamples: 0,
    fileSampleCursor: 0,

    lastRawBuffer: null,
    lastHeaderMeta: null,
    decoded: null,
    stats: null,
    binsDb: null,
    emaDb: null,
    peakDb: null,
    maxAbsNorm: 1,

    viewStart: 0,
    viewSpan: 1,
    markerNorm: null,
    hoverNorm: null,

    timeOffset: 0,
    timeWindow: 512,
    timeHoverFrac: null,

    rxFramesInWin: 0,
    rxBytesInWin: 0,
    rxWinStartMs: 0,
    rxFps: 0,
    rxMbps: 0,
    uiFramesInWin: 0,
    uiWinStartMs: 0,
    uiFps: 0,
    lastFpsTextMs: 0,
    fpsLimit: 0,
    nextUiRenderMs: 0,
    pendingRawBuffer: null,
    drainQueued: false,
    drainTimer: null,
    decodePool: {},
    rawBinsScratch: null,
    frameSeq: 0,
    lastStatsMs: 0,
    spectrumStale: false,
    panes: { spectrum: true, waterfall: true, time: true, constellation: true, ble: false },
    ble: {
      enabled: false,
      decoder: (window.WmsdrBle ? new window.WmsdrBle.BleDecoder() : null),
      scannedFrames: 0,
      totalHits: 0,
      crcPassCount: 0,
      devices: new Map(),
      recentPackets: [],
      dirty: false,
      lastDomMs: 0
    },
    nodeProfiles: {},
    lastRfInfo: null,
    rfManualOverride: false,
    streamManualOverride: false,
    redrawQueued: false,
    toastTimer: null
  };

  const DEFAULT_NODE_PROFILES = {
    '15': { format: 'u32_12', fs_mhz: 80, fs_mhz_5g: 160, interleaved: true, direct_stream_safe: false },
    '6':  { format: 'u32_14', fs_mhz: 40, fs_mhz_5g: 40,  interleaved: true, direct_stream_safe: true },
    '8':  { format: 'u32_14', fs_mhz: 40, fs_mhz_5g: 40,  interleaved: true, direct_stream_safe: true }
  };

  function readSavedRouterUrl() {
    try {
      const qs = new URLSearchParams(window.location.search || '');
      if (qs.get('router')) return qs.get('router').trim();
      return (window.localStorage && window.localStorage.getItem('wmsdr_router_url')) || '';
    } catch (_) {
      return '';
    }
  }

  function saveRouterUrl(url) {
    try {
      if (window.localStorage) {
        if (url) window.localStorage.setItem('wmsdr_router_url', url);
        else window.localStorage.removeItem('wmsdr_router_url');
      }
    } catch (_) {}
  }

  function normalizeHttpBase(raw) {
    const t = String(raw || '').trim().replace(/\/+$/, '');
    if (!t) return '';
    if (/^https?:\/\//i.test(t)) return t;
    return 'http://' + t;
  }

  function getRouterHttpBase() {
    const custom = els.inpRouterUrl ? normalizeHttpBase(els.inpRouterUrl.value) : '';
    if (custom) return custom;
    if (!state.isFileProtocol && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return '';
  }

  function getRouterWsUrl() {
    const httpBase = getRouterHttpBase();
    if (!httpBase) return '';
    return httpBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/ws';
  }

  function apiUrl(path) {
    const base = getRouterHttpBase();
    return base ? (base + path) : path;
  }

  function showToast(msg, ms) {
    els.toast.textContent = msg;
    els.toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.classList.remove('visible');
    }, ms || 3500);
  }

  function setConnPill(kind, text) {
    els.pillConn.className = 'pill' + (kind ? ' ' + kind : '');
    els.pillConnText.textContent = text;
  }

  function currentCaptureParams() {
    const rawIv = parseInt(els.inpInterval.value, 10);
    return {
      node: Math.max(0, Math.min(63, parseInt(els.inpNode.value, 10) || 15)),
      len: Math.max(256, Math.min(16384, parseInt(els.selLen.value, 10) || 8192)),
      bw: Math.max(0, Math.min(3, parseInt(els.selBw.value, 10) || 0)),
      band: state.band === 1 ? 1 : 0,
      direct: els.selMode.value === 'direct',
      intervalMs: Number.isNaN(rawIv) ? 0 : Math.max(0, Math.min(5000, rawIv)),
      preset: els.selSynth.value
    };
  }

  function currentFsHz() {
    const mhz = parseFloat(els.inpFs.value);
    return (Number.isFinite(mhz) && mhz > 0 ? mhz : 80) * 1e6;
  }

  function getNodeProfile(node) {
    const key = String(node);
    const def = DEFAULT_NODE_PROFILES[key] || null;
    const remote = (state.nodeProfiles && state.nodeProfiles[key]) || null;
    if (!def) return remote;
    if (!remote) return def;
    return Object.assign({}, def, remote);
  }

  function syncPresetSelect(node) {
    const key = String(node);
    if (!els.selNodePreset) return;
    els.selNodePreset.value = (key === '15' || key === '6' || key === '8') ? key : 'custom';
  }

  function syncStreamDefaultForSource() {
    if (state.streamManualOverride || !els.selStream) return;
    const src = els.selSource.value;
    const node = parseInt(els.inpNode.value, 10) || 15;
    const prof = getNodeProfile(node);
    const liveHw = (src === 'ws' || src === 'http') && state.serverOnline && !state.demoMode;
    const useEven = !prof || prof.streamMode === 'even' || prof.interleaved === true;
    els.selStream.value = (liveHw && useEven) ? 'even' : 'all';
  }

  function formatRfSummary(rf) {
    if (!rf) return 'RF: No ChInfo';
    const parts = [];
    if (rf.band0 && rf.band0.lo_mhz) {
      parts.push((state.band === 0 ? '[Active] ' : '') + '2.4G: ' + rf.band0.lo_mhz + ' MHz' + (rf.band0.bw_mhz ? (' (' + rf.band0.bw_mhz + 'M)') : ''));
    }
    if (rf.band1 && rf.band1.lo_mhz) {
      parts.push((state.band === 1 ? '[Active] ' : '') + '5G: ' + rf.band1.lo_mhz + ' MHz' + (rf.band1.bw_mhz ? (' (' + rf.band1.bw_mhz + 'M)') : ''));
    }
    return parts.length ? ('RF · ' + parts.join(' · ')) : 'RF: Channels inactive';
  }

  function updateBandButtons() {
    if (els.btnBand0) els.btnBand0.classList.toggle('active', state.band === 0);
    if (els.btnBand1) els.btnBand1.classList.toggle('active', state.band === 1);
  }

  function setBand(bandIdx, opts) {
    const o = opts || {};
    const next = Number(bandIdx) === 1 ? 1 : 0;
    const changed = state.band !== next;
    state.band = next;
    updateBandButtons();
    if (changed && !o.keepHistory) {
      state.rfManualOverride = false;
      state.emaDb = null;
      state.peakDb = null;
      waterfall.clear();
      constellation.clear();
    }
    const node = currentCaptureParams().node;
    applyNodeAndRfConfig(node, { forceRf: !state.rfManualOverride || !!o.forceRf, updateFormat: false });
    if (els.rfHwInfo && state.lastRfInfo) {
      els.rfHwInfo.textContent = formatRfSummary(state.lastRfInfo);
    }
    updateHeaders();
    scheduleRedraw();

    if (changed && els.selSource.value === 'synthetic' && !state.streaming) {
      const p = currentCaptureParams();
      const buf = Dsp.generateSyntheticFrame(p.preset, p.len, state.synthState);
      processRawFrame(buf, { pushWaterfall: true });
    }
    if (changed && state.streaming && els.selSource.value === 'ws' && !o.skipRestart) {
      sendWsStart();
    } else if (changed && !state.streaming && state.wsConnected && (els.selSource.value === 'ws' || els.selSource.value === 'http')) {
      triggerOneshot();
    }
  }

  function applyNodeAndRfConfig(node, opts) {
    const o = opts || {};
    const prof = getNodeProfile(node);
    const rf = state.lastRfInfo;
    if (prof) {
      if (prof.format && o.updateFormat !== false) {
        els.selFormat.value = prof.format;
      }
      if (prof.direct_stream_safe === false && els.selMode.value === 'direct' && o.guardMode !== false) {
        els.selMode.value = 'api';
      }
    }
    if (!state.rfManualOverride || o.forceRf) {
      const bandIdx = state.band === 1 ? 1 : 0;
      const bandInfo = rf && (bandIdx === 1 ? rf.band1 : rf.band0);
      const bandMeta = state.bandsMeta && state.bandsMeta[String(bandIdx)];
      let loMhz = bandInfo && bandInfo.lo_mhz
        ? bandInfo.lo_mhz
        : (bandMeta && bandMeta.default_lo_mhz ? bandMeta.default_lo_mhz : (bandIdx === 1 ? 5250 : 2462));
      let fsMhz = 80;
      if (node === 15) {
        if (bandIdx === 1) {
          fsMhz = (bandInfo && bandInfo.bw_idx != null && bandInfo.bw_idx < 2)
            ? 80
            : (bandMeta && bandMeta.adc_fs_mhz ? bandMeta.adc_fs_mhz : (prof && prof.fs_mhz_5g ? prof.fs_mhz_5g : 160));
        } else {
          fsMhz = (bandMeta && bandMeta.adc_fs_mhz) ? bandMeta.adc_fs_mhz : (prof && prof.fs_mhz ? prof.fs_mhz : 80);
        }
      } else if (prof) {
        fsMhz = bandInfo && bandInfo.bw_mhz ? Math.max(40, bandInfo.bw_mhz) : (prof.fs_mhz || 40);
      } else {
        fsMhz = parseFloat(els.inpFs.value) || 80;
      }
      els.inpFs.value = String(fsMhz);
      els.inpLo.value = String(loMhz);
    }
    syncStreamDefaultForSource();
  }

  function currentCenterHz() {
    const mhz = parseFloat(els.inpLo.value);
    return (Number.isFinite(mhz) && mhz >= 0 ? mhz : 0) * 1e6;
  }

  function updatePaletteSwatch() {
    els.paletteSwatch.style.background = Render.getPaletteCssGradient(els.selPalette.value);
  }

  function syncOutputs() {
    els.outEma.textContent = parseFloat(els.rngEma.value).toFixed(2);
    els.outDbMin.textContent = els.rngDbMin.value;
    els.outDbMax.textContent = els.rngDbMax.value;
    els.outWfContrast.textContent = els.rngWfContrast.value;
    els.outConstPersist.textContent = parseFloat(els.rngConstPersist.value).toFixed(2);
  }

  function resetRateCounters() {
    state.rxFramesInWin = 0;
    state.rxBytesInWin = 0;
    state.rxWinStartMs = 0;
    state.rxFps = 0;
    state.rxMbps = 0;
    state.uiFramesInWin = 0;
    state.uiWinStartMs = 0;
    state.uiFps = 0;
    state.nextUiRenderMs = 0;
  }

  function recordRxFrame(byteLength) {
    const now = performance.now();
    if (!state.rxWinStartMs) {
      state.rxWinStartMs = now;
      state.rxFramesInWin = 0;
      state.rxBytesInWin = 0;
    }
    state.rxFramesInWin++;
    state.rxBytesInWin += byteLength || 0;
    const dt = now - state.rxWinStartMs;
    if (dt >= 400) {
      state.rxFps = (state.rxFramesInWin * 1000) / dt;
      state.rxMbps = ((state.rxBytesInWin / (1024 * 1024)) * 1000) / dt;
      state.rxWinStartMs = now;
      state.rxFramesInWin = 0;
      state.rxBytesInWin = 0;
      updateFpsPill(now, false);
    }
  }

  function recordUiFrame(now) {
    if (!state.uiWinStartMs) {
      state.uiWinStartMs = now;
      state.uiFramesInWin = 0;
      return;
    }
    state.uiFramesInWin++;
    const dt = now - state.uiWinStartMs;
    if (dt >= 400) {
      state.uiFps = (state.uiFramesInWin * 1000) / dt;
      state.uiWinStartMs = now;
      state.uiFramesInWin = 0;
    }
  }

  function effectiveStepDelay(baseMs) {
    if (state.fpsLimit > 0) {
      return Math.max(baseMs, Math.round(1000 / state.fpsLimit));
    }
    return baseMs;
  }

  function updateFpsPill(now, force) {
    if (!force && now - state.lastFpsTextMs < 180) return;
    state.lastFpsTextMs = now;
    if (!state.streaming && !state.localPlaying) {
      els.pillFps.textContent = state.rxFps > 0 ? (state.rxFps.toFixed(1) + ' fps') : '0.0 fps';
      els.pillFps.title = state.fpsLimit > 0
        ? ('RX frame rate (UI limit: ' + state.fpsLimit + ' fps)')
        : 'RX frame rate';
      return;
    }
    const fps = state.rxFps || state.uiFps || 0;
    let baseText;
    if (fps >= 100 && state.rxMbps > 0.1) {
      baseText = fps.toFixed(0) + ' fps · ' + state.rxMbps.toFixed(1) + ' MB/s';
    } else if (state.rxMbps > 0.5) {
      baseText = fps.toFixed(1) + ' fps · ' + state.rxMbps.toFixed(1) + ' MB/s';
    } else {
      baseText = fps.toFixed(1) + ' fps';
    }
    if (state.fpsLimit > 0) {
      const uiStr = state.uiFps > 0 ? state.uiFps.toFixed(1) : ('<=' + state.fpsLimit);
      els.pillFps.textContent = baseText + ' · UI ' + uiStr + ' fps';
      els.pillFps.title = 'RX ' + state.rxFps.toFixed(1) + ' fps (' + state.rxMbps.toFixed(2) +
        ' MiB/s) · Sampled UI ' + state.uiFps.toFixed(1) + ' / ' + state.fpsLimit + ' fps';
    } else {
      els.pillFps.textContent = baseText;
      els.pillFps.title = 'RX ' + state.rxFps.toFixed(1) + ' fps (' + state.rxMbps.toFixed(2) +
        ' MiB/s) · UI render ' + state.uiFps.toFixed(1) + ' fps';
    }
    updateBleUi(now, false);
  }

  function formatBleActiveChannels() {
    if (!window.WmsdrBle) return [];
    return window.WmsdrBle.resolveChannels(currentCenterHz() / 1e6, currentFsHz() / 1e6);
  }

  function clearBleRecords() {
    state.ble.scannedFrames = 0;
    state.ble.totalHits = 0;
    state.ble.crcPassCount = 0;
    state.ble.devices.clear();
    state.ble.recentPackets = [];
    if (state.ble.decoder) state.ble.decoder.resetNoiseFloor();
    state.ble.dirty = true;
    updateBleUi(performance.now(), true);
  }

  function setBleEnabled(on, opts) {
    const o = opts || {};
    state.ble.enabled = !!on;
    if (els.chkBleEnable) els.chkBleEnable.checked = state.ble.enabled;
    if (state.ble.decoder) state.ble.decoder.resetNoiseFloor();
    if (state.ble.enabled && !o.keepPane && !state.panes.ble) {
      setPaneVisible('ble', true);
    }
    state.ble.dirty = true;
    updateBleUi(performance.now(), true);
  }

  function applyBlePreset() {
    state.ble.enabled = true;
    if (els.chkBleEnable) els.chkBleEnable.checked = true;
    state.panes.ble = true;
    syncPaneLayout();
    setBand(0, { skipRestart: true, forceRf: true });
    els.inpNode.value = '6';
    syncPresetSelect(6);
    els.selLen.value = '16384';
    els.selBw.value = '0';
    state.rfManualOverride = false;
    applyNodeAndRfConfig(6, { forceRf: true });
    if (state.ble.decoder) state.ble.decoder.resetNoiseFloor();
    updateHeaders();
    state.ble.dirty = true;
    updateBleUi(performance.now(), true);
    scheduleRedraw();
    if (state.streaming && els.selSource.value === 'ws') {
      sendWsStart();
    } else if (state.serverOnline && els.selSource.value !== 'ws') {
      els.selSource.value = 'ws';
    }
    showToast('Applied BLE preset: 2.4G · Node 6 · 16384 words', 2600);
  }

  function recordBleHits(hits) {
    const now = Date.now();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      state.ble.totalHits++;
      if (h.crcOk === true) state.ble.crcPassCount++;
      const macKey = (h.mac || ('trunc(' + h.pduLen + ')')) + '|' + h.ch + '|' + h.pduType;
      let dev = state.ble.devices.get(macKey);
      if (!dev) {
        dev = {
          mac: h.mac || ('(trunc len=' + h.pduLen + ')'),
          ch: h.ch,
          freqMhz: h.freqMhz,
          pduName: h.pduName,
          txAdd: h.txAdd,
          pduLen: h.pduLen,
          count: 0,
          bestRssi: -200,
          lastCfo: h.cfoKhz,
          devName: '',
          advSummary: '',
          dataHex: '',
          crcState: null,
          lastSeenMs: now
        };
        state.ble.devices.set(macKey, dev);
      }
      dev.count++;
      dev.lastSeenMs = now;
      dev.lastCfo = h.cfoKhz;
      if (h.rssiDbfs > dev.bestRssi) dev.bestRssi = h.rssiDbfs;
      if (h.devName) dev.devName = h.devName;
      if (h.advSummary && h.advSummary.length >= dev.advSummary.length) dev.advSummary = h.advSummary;
      if (h.dataHex && h.dataHex.length >= dev.dataHex.length) dev.dataHex = h.dataHex;
      if (h.crcOk === true) dev.crcState = true;
      else if (h.crcOk === false && dev.crcState !== true) dev.crcState = false;

      state.ble.recentPackets.unshift({
        time: new Date(now).toLocaleTimeString('en-GB', { hour12: false }),
        seq: h.seq,
        ch: h.ch,
        mac: dev.mac,
        pduName: h.pduName,
        pduLen: h.pduLen,
        rssi: h.rssiDbfs,
        cfo: h.cfoKhz,
        crcOk: h.crcOk,
        summary: h.advSummary || h.dataHex
      });
      if (state.ble.recentPackets.length > 40) {
        state.ble.recentPackets.length = 40;
      }
    }
    state.ble.dirty = true;
  }

  function runBleScan(arrayBuffer) {
    if (!state.ble.enabled || !state.ble.decoder || !arrayBuffer) return;
    const loMhz = currentCenterHz() / 1e6;
    const fsMhz = currentFsHz() / 1e6;
    const streamMode = els.selStream ? els.selStream.value : 'even';
    state.ble.scannedFrames++;
    state.ble.dirty = true;
    const hits = state.ble.decoder.scanFrame(arrayBuffer, {
      loMhz: loMhz,
      fsMhz: fsMhz,
      streamMode: streamMode
    });
    if (hits && hits.length > 0) {
      recordBleHits(hits);
    }
    updateBleUi(performance.now(), false);
  }

  function formatCrcBadge(crcState) {
    if (crcState === true) return { text: 'OK', cls: 'ble-badge-ok' };
    if (crcState === false) return { text: 'FAIL', cls: 'ble-badge-bad' };
    return { text: 'TRUNC', cls: 'ble-badge-trunc' };
  }

  function updateBleUi(now, force) {
    if (!force && (!state.ble.dirty || now - state.ble.lastDomMs < 180)) return;
    state.ble.dirty = false;
    state.ble.lastDomMs = now;

    const chList = formatBleActiveChannels();
    const chStr = state.band === 1
      ? 'No BLE on 5G'
      : (chList.length ? chList.map(function (c) { return 'Ch' + c.ch + '(' + c.freqMhz + 'M)'; }).join('+') : 'Out of passband');
    const summaryText = state.ble.enabled
      ? (chStr + ' · ' + state.ble.scannedFrames + ' frames · ' + state.ble.totalHits + ' pkts / ' +
        state.ble.devices.size + ' devs · CRC ' + state.ble.crcPassCount)
      : ('Disabled · Recommended: 2.4G + Node 6 + 16384 words (204.8us/frame covers Ch38 2426MHz)');

    if (els.bleStatusNote) els.bleStatusNote.textContent = summaryText;
    if (els.metaBle) {
      els.metaBle.textContent = state.ble.enabled
        ? (chStr + ' · ' + state.ble.devices.size + ' devs / ' + state.ble.totalHits + ' pkts (CRC ' + state.ble.crcPassCount + ')')
        : 'Disabled';
    }

    const sortedDevs = Array.from(state.ble.devices.values()).sort(function (a, b) {
      return b.count - a.count || b.bestRssi - a.bestRssi;
    });

    if (els.bleMiniList) {
      const frag = document.createDocumentFragment();
      const top = sortedDevs.slice(0, 6);
      for (let i = 0; i < top.length; i++) {
        const d = top[i];
        const card = document.createElement('div');
        card.className = 'ble-mini-item';
        const topRow = document.createElement('div');
        topRow.className = 'ble-mini-top';
        const macSpan = document.createElement('span');
        macSpan.textContent = d.mac + (d.devName ? (' ' + d.devName) : '');
        const rssiSpan = document.createElement('span');
        rssiSpan.textContent = d.bestRssi.toFixed(1) + 'dB ×' + d.count;
        topRow.appendChild(macSpan);
        topRow.appendChild(rssiSpan);
        const subRow = document.createElement('div');
        subRow.className = 'ble-mini-sub';
        subRow.textContent = 'Ch' + d.ch + ' ' + d.pduName + ' len=' + d.pduLen +
          (d.advSummary ? (' · ' + d.advSummary) : '');
        card.appendChild(topRow);
        card.appendChild(subRow);
        frag.appendChild(card);
      }
      els.bleMiniList.replaceChildren(frag);
    }

    if (els.bleDevTbody && state.panes.ble) {
      const tbFrag = document.createDocumentFragment();
      for (let i = 0; i < sortedDevs.length; i++) {
        const d = sortedDevs[i];
        const tr = document.createElement('tr');
        const crcInfo = formatCrcBadge(d.crcState);
        const cells = [
          { t: d.mac + (d.txAdd ? ' (R)' : ' (P)') },
          { t: String(d.ch) },
          { t: d.pduName },
          { t: String(d.pduLen) },
          { t: String(d.count) },
          { t: d.bestRssi.toFixed(1) + ' dB' },
          { t: (d.lastCfo >= 0 ? '+' : '') + d.lastCfo.toFixed(1) + 'k' },
          { t: crcInfo.text, cls: crcInfo.cls },
          { t: [d.advSummary, d.dataHex ? ('hex:' + d.dataHex) : ''].filter(Boolean).join(' · ') || '-', cls: 'ble-payload-cell' }
        ];
        for (let c = 0; c < cells.length; c++) {
          const td = document.createElement('td');
          if (cells[c].cls) td.className = cells[c].cls;
          td.textContent = cells[c].t;
          tr.appendChild(td);
        }
        tbFrag.appendChild(tr);
      }
      els.bleDevTbody.replaceChildren(tbFrag);
    }

    if (els.blePktLog && state.panes.ble) {
      const logFrag = document.createDocumentFragment();
      const pkts = state.ble.recentPackets;
      for (let i = 0; i < pkts.length; i++) {
        const p = pkts[i];
        const row = document.createElement('div');
        row.className = 'ble-log-row';
        const crcTag = p.crcOk === true ? 'CRC✓' : (p.crcOk === false ? 'CRC✗' : 'trunc');
        row.textContent = '[' + p.time + '] #' + p.seq + ' Ch' + p.ch + ' ' + p.pduName +
          ' ' + p.mac + ' ' + p.rssi.toFixed(1) + 'dB ' + crcTag +
          (p.summary ? (' | ' + p.summary) : '');
        logFrag.appendChild(row);
      }
      els.blePktLog.replaceChildren(logFrag);
    }
  }

  function formatStatusMeta(st) {
    if (!st) return;
    if (st.fw_state != null) {
      els.pillFw.textContent = 'fw: ' + st.fw_state;
      els.pillFw.className = 'pill ' + (st.fw_state === 3 || st.fw_state === 7 ? 'ok' : 'warn');
    }
    if (st.raw_tick != null) {
      els.pillTick.textContent = 'tick: ' + st.raw_tick;
      els.pillTick.className = st.magic_ok ? 'pill ok' : 'pill warn';
    }
    if (st.cr0 != null && st.cr9 != null) {
      const cr0Hex = typeof st.cr0 === 'number' ? '0x' + st.cr0.toString(16) : st.cr0;
      const cr9Hex = typeof st.cr9 === 'number' ? '0x' + st.cr9.toString(16) : st.cr9;
      els.pillCr.textContent = 'cr0/9: ' + cr0Hex + '/' + cr9Hex;
    }
    if (st.rf) {
      state.lastRfInfo = st.rf;
      if (els.rfHwInfo) els.rfHwInfo.textContent = formatRfSummary(st.rf);
      applyNodeAndRfConfig(currentCaptureParams().node, { updateFormat: false, guardMode: false });
      updateHeaders();
      scheduleRedraw();
    }
  }

  function updateStatsPanel() {
    const st = state.stats;
    const dec = state.decoded;
    if (!st || !dec) return;

    const fmtVal = function (v) {
      return Number.isInteger(v) ? String(v) : v.toFixed(3);
    };

    els.stCount.textContent = st.count + ' (' + (dec.spec.bits || 32) + 'b)';
    els.stNonzero.textContent = st.nonzero + '/' + st.count + ' (' + st.nonzeroPct.toFixed(1) + '%)';
    els.stTrans.textContent = st.transitionPct.toFixed(1) + '%';
    els.stRangeI.textContent = '[' + fmtVal(st.minI) + ' .. ' + fmtVal(st.maxI) + ']';
    els.stRangeQ.textContent = '[' + fmtVal(st.minQ) + ' .. ' + fmtVal(st.maxQ) + ']';
    els.stDc.textContent = st.meanI.toFixed(2) + ' / ' + st.meanQ.toFixed(2);
    els.stRms.textContent = st.rmsI.toFixed(1) + ' / ' + st.rmsQ.toFixed(1);
    els.stPwr.textContent = st.rmsDbfs.toFixed(1) + ' dBFS / ' + st.paprDb.toFixed(1) + ' dB';
    els.stAc1.textContent = st.clipCount + ' / ' + st.ac1Mag.toFixed(3);

    const previewLines = [];
    const lim = Math.min(6, dec.count);
    for (let i = 0; i < lim; i++) {
      const iv = fmtVal(dec.iRaw[i]).padStart(6, ' ');
      const qv = fmtVal(dec.qRaw[i]).padStart(6, ' ');
      const hex = dec.rawWords ? ('0x' + dec.rawWords[i].toString(16).padStart(8, '0') + ' ') : '';
      previewLines.push('[' + i + '] ' + hex + 'I=' + iv + ' Q=' + qv);
    }
    els.hexPreview.textContent = previewLines.join('\n') || 'empty frame';
  }

  function processRawFrame(arrayBuffer, opts) {
    if (!arrayBuffer || arrayBuffer.byteLength < 4) return;
    const o = opts || {};
    state.lastRawBuffer = arrayBuffer;

    const decoded = Dsp.decodeIqBuffer(arrayBuffer, {
      format: els.selFormat.value,
      swapIQ: els.chkSwap.checked,
      headerMode: o.headerModeOverride || els.selHeader.value,
      streamMode: o.streamModeOverride || (els.selStream ? els.selStream.value : 'all'),
      out: state.decodePool
    });
    if (decoded.count === 0) return;

    state.decoded = decoded;
    if (decoded.meta && decoded.meta.kind === 'wsiq') {
      state.lastHeaderMeta = decoded.meta;
    }

    const now = performance.now();
    const shouldUpdateStats = !state.streaming || o.resetHistory || o.forceStats ||
      (state.fpsLimit > 0 && state.fpsLimit <= 30) || (now - state.lastStatsMs >= 120);
    if (shouldUpdateStats) {
      if (decoded.meta && decoded.meta.kind === 'wsiq') {
        formatStatusMeta({
          cr0: decoded.meta.cr0,
          cr9: decoded.meta.cr9
        });
      }
      state.stats = Dsp.computeStats(decoded);
      state.lastStatsMs = now;
    }

    state.maxAbsNorm = decoded.maxAbsNorm || 1;

    // Synchronize time slider range (DOM update throttled when streaming)
    const count = decoded.count;
    const iNorm = decoded.iNorm;
    const qNorm = decoded.qNorm;
    state.timeWindow = Math.min(count, Math.max(32, parseInt(els.selTimeWin.value, 10) || 512));
    const maxOffset = Math.max(0, count - state.timeWindow);
    if (state.timeOffset > maxOffset) state.timeOffset = maxOffset;
    if (shouldUpdateStats) {
      els.rngTimeOff.max = String(maxOffset);
      els.rngTimeOff.value = String(state.timeOffset);
    }

    const needsSpectrum = state.panes.spectrum || state.panes.waterfall;
    if (needsSpectrum) {
      state.spectrumStale = false;
      const fftSize = parseInt(els.selFftSize.value, 10) || 2048;
      if (!state.rawBinsScratch || state.rawBinsScratch.length !== fftSize) {
        state.rawBinsScratch = new Float32Array(fftSize);
      }
      const rawBins = Dsp.computeSpectrum(iNorm, qNorm, {
        fftSize: fftSize,
        window: els.selWindow.value,
        dcRemove: els.chkDc.checked,
        detector: els.selDetector.value,
        outBins: state.rawBinsScratch,
        maxBlocks: (state.streaming && !o.resetHistory) ? 16 : 0
      });

      const alpha = Math.max(0, Math.min(0.95, parseFloat(els.rngEma.value) || 0));
      if (!state.emaDb || state.emaDb.length !== rawBins.length || alpha === 0 || o.resetHistory) {
        if (!state.emaDb || state.emaDb.length !== rawBins.length) {
          state.emaDb = new Float32Array(rawBins.length);
        }
        state.emaDb.set(rawBins);
      } else {
        const keep = alpha;
        const take = 1 - alpha;
        for (let i = 0; i < rawBins.length; i++) {
          state.emaDb[i] = state.emaDb[i] * keep + rawBins[i] * take;
        }
      }
      state.binsDb = state.emaDb;

      if (!state.peakDb || state.peakDb.length !== rawBins.length || o.resetHistory) {
        if (!state.peakDb || state.peakDb.length !== rawBins.length) {
          state.peakDb = new Float32Array(state.binsDb.length);
        }
        state.peakDb.set(state.binsDb);
      } else {
        for (let i = 0; i < rawBins.length; i++) {
          if (state.binsDb[i] > state.peakDb[i]) state.peakDb[i] = state.binsDb[i];
        }
      }

      if (o.pushWaterfall !== false && state.panes.waterfall) {
        waterfall.pushRow(state.binsDb, ++state.frameSeq);
      }
    } else {
      state.spectrumStale = true;
    }

    if (o.pushWaterfall !== false && !o.skipRxCount) {
      recordRxFrame(arrayBuffer.byteLength);
      recordUiFrame(now);
      updateFpsPill(now, false);
    }
    if (!o.skipBle && o.pushWaterfall !== false) {
      runBleScan(arrayBuffer);
    }

    if (shouldUpdateStats) {
      updateStatsPanel();
      updateHeaders();
    }
    if (o.directDraw) {
      drawAll();
    } else {
      scheduleRedraw();
    }
  }

  function updateHeaders() {
    const fsHz = currentFsHz();
    const fftSize = parseInt(els.selFftSize.value, 10) || 2048;
    const rbwKhz = (fsHz / fftSize) / 1e3;
    const metaTag = state.lastHeaderMeta ? ('node ' + state.lastHeaderMeta.node + ' · ') : '';
    const wfTag = state.decoded && state.decoded.streamMode === 'even'
      ? 'WF0 · '
      : (state.decoded && state.decoded.streamMode === 'odd' ? 'WF1 · ' : '');
    els.metaSpectrum.textContent = metaTag + wfTag + fftSize + 'pt · RBW ' + rbwKhz.toFixed(1) + ' kHz';
    els.metaWaterfall.textContent = waterfall.rowCount + ' rows';
    els.metaTime.textContent = (state.decoded ? state.decoded.count : 0) + 's · ' + state.timeWindow + '@' + state.timeOffset;
    els.metaConst.textContent = state.stats ? ('RMS ' + state.stats.rmsTotal.toFixed(1)) : '-';
    updateBleUi(performance.now(), true);
  }

  function drawAll() {
    state.redrawQueued = false;
    const dbMin = parseFloat(els.rngDbMin.value);
    const dbMax = Math.max(dbMin + 10, parseFloat(els.rngDbMax.value));
    const fsHz = currentFsHz();
    const centerHz = currentCenterHz();

    if (state.panes.spectrum) {
      Render.drawSpectrum(els.cvSpectrum, {
        binsDb: state.binsDb,
        peakDb: state.peakDb,
        showPeak: els.chkPeakHold.checked,
        showFill: els.chkFill.checked,
        dbMin: dbMin,
        dbMax: dbMax,
        fsHz: fsHz,
        centerHz: centerHz,
        viewStart: state.viewStart,
        viewSpan: state.viewSpan,
        markerNorm: state.markerNorm,
        hoverNorm: state.hoverNorm
      });
    }

    if (state.panes.waterfall) {
      waterfall.draw(els.cvWaterfall, {
        dbMin: dbMin,
        dbMax: dbMax,
        contrast: parseFloat(els.rngWfContrast.value) || 0,
        palette: els.selPalette.value,
        fsHz: fsHz,
        centerHz: centerHz,
        viewStart: state.viewStart,
        viewSpan: state.viewSpan,
        markerNorm: state.markerNorm,
        hoverNorm: state.hoverNorm,
        rowHeight: 2
      });
    }

    if (state.panes.time) {
      Render.drawWaveform(els.cvTime, {
        decoded: state.decoded,
        timeOffset: state.timeOffset,
        timeWindow: state.timeWindow,
        showEnvelope: els.chkWfEnv.checked,
        autoScaleY: els.chkWfAuto.checked,
        maxAbsNorm: state.maxAbsNorm,
        hoverFrac: state.timeHoverFrac
      });
    }

    if (state.panes.constellation) {
      constellation.draw(els.cvConstellation, {
        decoded: state.decoded,
        stats: state.stats,
        persistence: parseFloat(els.rngConstPersist.value) || 0,
        constGain: parseFloat(els.selConstGain.value) || 1
      });
    }
  }

  function scheduleRedraw() {
    if (state.redrawQueued) return;
    state.redrawQueued = true;
    requestAnimationFrame(drawAll);
  }

  function reprocessLastFrame() {
    if (state.lastRawBuffer) {
      processRawFrame(state.lastRawBuffer, { pushWaterfall: false, resetHistory: true });
    }
  }

  function syncPaneLayout() {
    const order = ['spectrum', 'time', 'waterfall', 'constellation', 'ble'];
    const visibleCards = [];

    order.forEach(function (name) {
      const on = !!state.panes[name];
      const btn = document.querySelector('[data-pane-toggle="' + name + '"]');
      if (btn) {
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      const card = els.plotsGrid.querySelector('.plot-card[data-pane="' + name + '"]');
      if (card) {
        card.hidden = !on;
        card.classList.remove('span-tall');
        if (!on && card.classList.contains('maximized')) {
          card.classList.remove('maximized');
          els.plotsGrid.classList.remove('has-maximized');
          document.querySelectorAll('.btn-max').forEach(function (b) { b.textContent = 'Max'; });
        }
        if (on) visibleCards.push(card);
      }
    });

    els.plotsGrid.dataset.visible = String(visibleCards.length);
    els.plotsGrid.classList.toggle(
      'only-freq-pair',
      visibleCards.length === 2 && state.panes.spectrum && state.panes.waterfall
    );
    if (visibleCards.length === 3) {
      visibleCards[0].classList.add('span-tall');
    }
    els.emptyPanes.hidden = visibleCards.length > 0;
  }

  function setPaneVisible(name, visible) {
    if (!Object.prototype.hasOwnProperty.call(state.panes, name)) return;
    state.panes[name] = !!visible;
    if (name === 'ble' && visible && !state.ble.enabled) {
      setBleEnabled(true, { keepPane: true });
    }
    syncPaneLayout();
    if (name === 'ble' && visible) {
      state.ble.dirty = true;
      updateBleUi(performance.now(), true);
    }
    if (state.panes[name] && state.spectrumStale && (name === 'spectrum' || name === 'waterfall')) {
      reprocessLastFrame();
    } else {
      scheduleRedraw();
    }
  }

  // ---- Data Acquisition Backends ----
  function refreshStatus() {
    if (!state.serverOnline || !getRouterHttpBase()) return Promise.resolve();
    return fetch(apiUrl('/api/status'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        if (st && st.ok) {
          formatStatusMeta(st);
          if (st.direct_router != null) state.directRouter = !!st.direct_router;
          if (st.demo) {
            state.demoMode = true;
            setConnPill('ok', state.wsConnected ? 'WS Demo Ready' : 'HTTP Demo Ready');
          }
        } else if (st && st.error) {
          els.pillFw.textContent = 'status err';
          els.pillFw.className = 'pill warn';
        }
      })
      .catch(function () {});
  }

  const WS_LANE_COUNT = 4;
  const WSIQ_MAGIC_LE = 0x51495357;

  function updateWsConnBadge() {
    if (!state.wsConnected) return;
    if (state.streaming && state.activeLanes > 0) {
      setConnPill('ok', 'WS Kernel Async · ' + state.activeLanes + ' Lanes');
    } else if (state.demoMode) {
      setConnPill('ok', 'WS Demo Connected');
    } else {
      setConnPill('ok', state.directRouter ? 'WS Direct Router' : 'WS Connected');
    }
  }

  function closeDataLanes() {
    state.wsSid = 0;
    state.activeLanes = 0;
    if (!state.wsLanes || state.wsLanes.length === 0) return;
    const lanes = state.wsLanes;
    state.wsLanes = [];
    for (let i = 0; i < lanes.length; i++) {
      const lws = lanes[i];
      if (!lws) continue;
      try { lws.onopen = null; lws.onclose = null; lws.onerror = null; lws.onmessage = null; lws.close(); } catch (_) {}
    }
  }

  function clearLiveDrain() {
    state.drainQueued = false;
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }
    state.pendingRawBuffer = null;
  }

  function closeWebSocketCleanly() {
    state.wsShouldReconnect = false;
    state.wsConnected = false;
    clearLiveDrain();
    closeDataLanes();
    if (state.ws) {
      const old = state.ws;
      state.ws = null;
      try { old.onclose = null; old.onerror = null; old.onmessage = null; old.close(); } catch (_) {}
    }
  }

  function pushLiveBinaryFrame(buf) {
    if (!buf) return;
    recordRxFrame(buf.byteLength);
    if (buf.byteLength >= 32) {
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) === WSIQ_MAGIC_LE) {
        const seq = dv.getUint32(8, true);
        if (state.lastLiveSeq >= 0 && ((seq - state.lastLiveSeq) | 0) <= 0) {
          return;
        }
        state.lastLiveSeq = seq;
      }
    }
    runBleScan(buf);
    const limit = state.fpsLimit || 0;
    if (limit > 60) {
      const now = performance.now();
      const intervalMs = 1000 / limit;
      if (!state.nextUiRenderMs || now - state.nextUiRenderMs > intervalMs * 2) {
        state.nextUiRenderMs = now + intervalMs;
      } else if (now + 0.15 < state.nextUiRenderMs) {
        state.pendingRawBuffer = buf;
        return;
      } else {
        state.nextUiRenderMs += intervalMs;
      }
      state.pendingRawBuffer = null;
      processRawFrame(buf, {
        pushWaterfall: true,
        skipRxCount: true,
        skipBle: true,
        directDraw: false,
        forceStats: false
      });
      recordUiFrame(now);
      updateFpsPill(now, false);
      return;
    }
    state.pendingRawBuffer = buf;
    scheduleLiveDrain();
  }

  function openDataLanes(sid) {
    const wsUrl = getRouterWsUrl();
    if (!wsUrl || !sid || !state.streaming || els.selSource.value !== 'ws') return;
    closeDataLanes();
    state.wsSid = sid;
    for (let i = 0; i < WS_LANE_COUNT; i++) {
      const lws = new WebSocket(wsUrl);
      let attached = false;
      lws.binaryType = 'arraybuffer';
      lws._sid = sid;
      state.wsLanes.push(lws);

      lws.onopen = function () {
        if (!state.streaming || state.wsSid !== sid || els.selSource.value !== 'ws') {
          try { lws.close(); } catch (_) {}
          return;
        }
        lws.send(JSON.stringify({ type: 'attach', sid: sid }));
      };

      lws.onmessage = function (ev) {
        if (ev.data instanceof ArrayBuffer) {
          if (state.streaming && state.wsSid === sid && els.selSource.value === 'ws') {
            pushLiveBinaryFrame(ev.data);
          }
          return;
        }
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'status' && msg.attached && !attached) {
              attached = true;
              state.activeLanes++;
              updateWsConnBadge();
            } else if (msg.type === 'error') {
              try { lws.close(); } catch (_) {}
            }
          } catch (_) {}
        }
      };

      const onDone = function () {
        if (attached) {
          attached = false;
          if (state.activeLanes > 0) state.activeLanes--;
          updateWsConnBadge();
        }
        const idx = state.wsLanes.indexOf(lws);
        if (idx >= 0) state.wsLanes.splice(idx, 1);
      };
      lws.onclose = onDone;
      lws.onerror = onDone;
    }
  }

  function drainLiveFrame() {
    state.drainQueued = false;
    const limit = state.fpsLimit || 0;
    if (limit > 60) return;
    const buf = state.pendingRawBuffer;
    if (!buf) return;
    const now = performance.now();
    if (limit > 0) {
      const intervalMs = 1000 / limit;
      if (state.nextUiRenderMs && now + 2.5 < state.nextUiRenderMs) {
        scheduleLiveDrain();
        return;
      }
      if (!state.nextUiRenderMs || now - state.nextUiRenderMs > intervalMs * 2) {
        state.nextUiRenderMs = now + intervalMs;
      } else {
        state.nextUiRenderMs += intervalMs;
      }
    } else {
      state.nextUiRenderMs = 0;
    }
    state.pendingRawBuffer = null;
    processRawFrame(buf, {
      pushWaterfall: true,
      skipRxCount: true,
      skipBle: true,
      directDraw: true,
      forceStats: limit > 0
    });
    recordUiFrame(now);
    updateFpsPill(now, limit > 0);
  }

  function scheduleLiveDrain() {
    if (state.drainQueued || !state.pendingRawBuffer) return;
    const limit = state.fpsLimit || 0;
    if (limit <= 0) {
      state.drainQueued = true;
      requestAnimationFrame(drainLiveFrame);
      return;
    }
    const intervalMs = 1000 / limit;
    const now = performance.now();
    if (!state.nextUiRenderMs || now - state.nextUiRenderMs > intervalMs * 2) {
      state.drainQueued = true;
      requestAnimationFrame(drainLiveFrame);
      return;
    }
    const waitMs = state.nextUiRenderMs - now;
    if (waitMs <= 18) {
      state.drainQueued = true;
      requestAnimationFrame(drainLiveFrame);
    } else {
      const leadMs = Math.min(12, intervalMs * 0.35);
      const sleepMs = Math.max(0, waitMs - leadMs);
      state.drainQueued = true;
      state.drainTimer = setTimeout(function () {
        state.drainTimer = null;
        if (!state.drainQueued) return;
        requestAnimationFrame(drainLiveFrame);
      }, sleepMs);
    }
  }

  function setFpsLimit(val) {
    state.fpsLimit = Math.max(0, Math.min(1000, parseInt(val, 10) || 0));
    state.nextUiRenderMs = 0;
    state.uiFramesInWin = 0;
    state.uiWinStartMs = 0;
    state.uiFps = 0;
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
      state.drainQueued = false;
    }
    if (state.pendingRawBuffer && state.streaming && els.selSource.value === 'ws') {
      if (state.fpsLimit > 60) {
        const buf = state.pendingRawBuffer;
        state.pendingRawBuffer = null;
        state.drainQueued = false;
        state.nextUiRenderMs = performance.now() + (1000 / state.fpsLimit);
        processRawFrame(buf, { pushWaterfall: true, skipRxCount: true, directDraw: false, forceStats: false });
        recordUiFrame(performance.now());
        updateFpsPill(performance.now(), true);
      } else {
        scheduleLiveDrain();
      }
    } else {
      updateFpsPill(performance.now(), true);
    }
  }

  function connectWebSocket() {
    const wsUrl = getRouterWsUrl();
    if (!wsUrl) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    state.wsShouldReconnect = true;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    setConnPill('warn', 'Connecting WS...');

    ws.onopen = function () {
      state.wsConnected = true;
      updateWsConnBadge();
      ws.send(JSON.stringify({ type: 'status' }));
      if (state.streaming && els.selSource.value === 'ws') {
        sendWsStart();
      }
    };

    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'status') {
            formatStatusMeta(msg);
            if (msg.streaming && msg.kernelNet && msg.controlOnly && msg.sid) {
              if (state.streaming && els.selSource.value === 'ws') {
                openDataLanes(msg.sid);
              }
            } else if (msg.streaming === false) {
              closeDataLanes();
              updateWsConnBadge();
            }
          } else if (msg.type === 'error') {
            if (!state.forceSingleLane && msg.message && msg.message.indexOf('Kernel net') !== -1 && state.streaming) {
              state.forceSingleLane = true;
              sendWsStart();
              return;
            }
            showToast('CT3003 Error: ' + msg.message, 4500);
            if (state.streaming) stopStreaming();
          }
        } catch (_) {}
      } else if (ev.data instanceof ArrayBuffer) {
        if (state.streaming && els.selSource.value === 'ws') {
          pushLiveBinaryFrame(ev.data);
        } else {
          processRawFrame(ev.data, { pushWaterfall: true });
        }
      }
    };

    ws.onclose = function () {
      state.wsConnected = false;
      state.ws = null;
      closeDataLanes();
      if (state.wsShouldReconnect && state.streaming && els.selSource.value === 'ws') {
        setConnPill('err', 'WS Disconnected, Reconnecting');
        setTimeout(connectWebSocket, 1500);
      } else {
        setConnPill('', state.serverOnline ? 'HTTP Ready' : 'Offline');
      }
    };

    ws.onerror = function () {
      state.wsConnected = false;
    };
  }

  function guardSafeStreamMode(p) {
    if (!state.demoMode && p.direct && (p.node === 15 || p.band === 1)) {
      els.selMode.value = 'api';
      p.direct = false;
      showToast(
        p.band === 1 ? '5G (Band 1) switched to API mode' : 'Node 15 (ADC) streaming switched to API mode to protect WM firmware',
        3200
      );
    }
    return p;
  }

  function sendWsStart() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
      return;
    }
    const p = guardSafeStreamMode(currentCaptureParams());
    const wantMulti = !state.forceSingleLane && p.intervalMs <= 20;
    closeDataLanes();
    clearLiveDrain();
    state.lastLiveSeq = -1;
    state.nextUiRenderMs = 0;
    state.ws.send(JSON.stringify({
      type: 'start',
      node: p.node,
      len: p.len,
      bw: p.bw,
      band: p.band,
      direct: p.direct,
      intervalMs: p.intervalMs,
      controlOnly: wantMulti,
      preset: p.preset
    }));
  }

  function captureHttpOneshot() {
    const p = guardSafeStreamMode(currentCaptureParams());
    const qs = '?node=' + p.node + '&len=' + p.len + '&bw=' + p.bw +
      '&band=' + p.band + '&direct=' + (p.direct ? 1 : 0) +
      '&preset=' + encodeURIComponent(p.preset);
    return fetch(apiUrl('/api/capture' + qs), { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (txt) {
            throw new Error(txt || ('HTTP ' + resp.status));
          });
        }
        const cr0 = resp.headers.get('X-IQ-CR0');
        const cr9 = resp.headers.get('X-IQ-CR9');
        const sampleCount = resp.headers.get('X-IQ-Sample-Count');
        if (cr0 || cr9) {
          formatStatusMeta({
            cr0: cr0 || '-',
            cr9: cr9 || '-',
            sample_count: sampleCount
          });
        }
        return resp.arrayBuffer();
      })
      .then(function (buf) {
        processRawFrame(buf, { pushWaterfall: true });
      })
      .catch(function (err) {
        showToast('HTTP capture failed: ' + err.message, 4500);
        if (state.streaming) stopStreaming();
      });
  }

  function triggerOneshot() {
    const src = els.selSource.value;
    if (src === 'synthetic') {
      const p = currentCaptureParams();
      const buf = Dsp.generateSyntheticFrame(p.preset, p.len, state.synthState);
      processRawFrame(buf, { pushWaterfall: true });
      return;
    }
    if (src === 'file') {
      stepFileFrame();
      return;
    }
    if (src === 'ws' && state.ws && state.ws.readyState === WebSocket.OPEN) {
      const p = guardSafeStreamMode(currentCaptureParams());
      state.ws.send(JSON.stringify({
        type: 'oneshot',
        node: p.node,
        len: p.len,
        bw: p.bw,
        band: p.band,
        direct: p.direct,
        preset: p.preset
      }));
      return;
    }
    captureHttpOneshot();
  }

  function startStreaming() {
    stopLocalPlayback();
    resetRateCounters();
    state.pendingRawBuffer = null;
    state.streaming = true;
    els.btnStream.classList.add('active');
    els.btnStream.innerHTML = '&#9632; Stop Streaming';

    const src = els.selSource.value;
    if (src === 'ws' || src === 'http') {
      guardSafeStreamMode(currentCaptureParams());
    }
    if (src === 'ws') {
      if (!state.serverOnline) {
        showToast('Not connected to server; switching to synthetic generator', 3000);
        els.selSource.value = 'synthetic';
        startStreaming();
        return;
      }
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        sendWsStart();
      } else {
        connectWebSocket();
      }
      return;
    }

    if (src === 'http') {
      let busy = false;
      const runPoll = function () {
        if (!state.streaming || els.selSource.value !== 'http') return;
        if (busy) {
          state.streamTimer = setTimeout(runPoll, 50);
          return;
        }
        busy = true;
        captureHttpOneshot().finally(function () {
          busy = false;
          if (state.streaming && els.selSource.value === 'http') {
            const delay = effectiveStepDelay(currentCaptureParams().intervalMs);
            state.streamTimer = setTimeout(runPoll, delay);
          }
        });
      };
      runPoll();
      return;
    }

    if (src === 'file') {
      startLocalPlayback();
      return;
    }

    // synthetic
    const tickSynth = function () {
      if (!state.streaming || els.selSource.value !== 'synthetic') return;
      const p = currentCaptureParams();
      const buf = Dsp.generateSyntheticFrame(p.preset, p.len, state.synthState);
      processRawFrame(buf, { pushWaterfall: true });
      const delay = effectiveStepDelay(p.intervalMs === 0 ? 16 : p.intervalMs);
      state.streamTimer = setTimeout(tickSynth, delay);
    };
    tickSynth();
  }

  function stopStreaming() {
    state.streaming = false;
    clearLiveDrain();
    state.lastLiveSeq = -1;
    clearTimeout(state.streamTimer);
    state.streamTimer = null;
    closeDataLanes();
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'stop' }));
    }
    updateWsConnBadge();
    stopLocalPlayback();
    els.btnStream.classList.remove('active');
    els.btnStream.innerHTML = '&#9654; Start Streaming';
    resetRateCounters();
    updateFpsPill(performance.now(), true);
    if (state.decoded) {
      state.stats = Dsp.computeStats(state.decoded);
      updateStatsPanel();
      updateHeaders();
    }
  }

  // ---- Local File Loading & Chunked Scrubbing ----
  function loadNamedBuffer(name, arrayBuffer, opts) {
    stopStreaming();
    const o = opts || {};
    if (!o.keepFormat) {
      els.selFormat.value = Dsp.inferFormatFromFilename(name);
    }

    const extracted = Dsp.extractPayloadBytes(arrayBuffer, els.selHeader.value);
    const bytes = extracted.payload;
    const spec = Dsp.FORMAT_SPECS[els.selFormat.value];
    const totalSamples = Math.floor(bytes.byteLength / spec.bytesPerSample);

    state.fileRawBuffer = arrayBuffer;
    state.fileBuffer = bytes;
    state.fileName = name;
    state.filePayloadMeta = extracted.meta;
    state.fileTotalSamples = totalSamples;
    state.fileSampleCursor = 0;

    els.selSource.value = 'file';
    els.filePlaybackBar.hidden = false;
    els.fileInfo.textContent = name + ' (' + bytes.byteLength + ' B, ' + totalSamples + ' samples)';

    const chunkLen = Math.min(totalSamples, parseInt(els.selLen.value, 10) || 8192);
    const maxStart = Math.max(0, totalSamples - chunkLen);
    els.rngFilePos.max = String(maxStart);
    els.rngFilePos.value = '0';
    els.outFilePos.textContent = '0';

    renderFileSlice(0, true);
  }

  function renderFileSlice(sampleStart, resetHistory) {
    if (!state.fileBuffer) return;
    const spec = Dsp.FORMAT_SPECS[els.selFormat.value];
    const len = parseInt(els.selLen.value, 10) || 8192;
    const byteStart = Math.max(0, sampleStart * spec.bytesPerSample);
    const byteLen = Math.min(state.fileBuffer.byteLength - byteStart, len * spec.bytesPerSample);
    if (byteLen <= 0) return;

    const slice = state.fileBuffer.slice(byteStart, byteStart + byteLen);
    state.fileSampleCursor = sampleStart;
    els.rngFilePos.value = String(sampleStart);
    els.outFilePos.textContent = String(sampleStart);
    processRawFrame(slice.buffer, {
      pushWaterfall: true,
      resetHistory: !!resetHistory,
      headerModeOverride: 'none'
    });
  }

  function stepFileFrame() {
    if (!state.fileBuffer) {
      showToast('Select or drop an IQ binary file first', 2500);
      return;
    }
    const len = parseInt(els.selLen.value, 10) || 8192;
    const step = Math.max(256, Math.min(len, parseInt(els.selFftSize.value, 10) || 2048));
    let next = state.fileSampleCursor + step;
    if (next >= state.fileTotalSamples) next = 0;
    renderFileSlice(next, false);
  }

  function startLocalPlayback() {
    if (!state.fileBuffer) {
      showToast('Select or drop an IQ file first', 2500);
      return;
    }
    stopLocalPlayback();
    state.localPlaying = true;
    els.btnFilePlay.textContent = 'Stop Playback';
    const loop = function () {
      if (!state.localPlaying) return;
      stepFileFrame();
      const p = currentCaptureParams();
      const delay = effectiveStepDelay(p.intervalMs === 0 ? 16 : p.intervalMs);
      state.fileTimer = setTimeout(loop, delay);
    };
    loop();
  }

  function stopLocalPlayback() {
    state.localPlaying = false;
    clearTimeout(state.fileTimer);
    state.fileTimer = null;
    els.btnFilePlay.innerHTML = '&#9654; Play File';
  }

  function loadFileObject(file) {
    if (!file) return;
    file.arrayBuffer().then(function (buf) {
      loadNamedBuffer(file.name, buf);
      showToast('Loaded ' + file.name + ' (' + buf.byteLength + ' B)');
    });
  }

  // ---- Interactive Canvas Mouse / Wheel Handlers ----
  function attachFreqInteractions(canvas, padTop, padBottom) {
    let dragging = false;
    let dragStartX = 0;
    let dragStartView = 0;

    function normFromClientX(clientX) {
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - Render.FREQ_PAD_L - Render.FREQ_PAD_R);
      const px = clientX - rect.left - Render.FREQ_PAD_L;
      const frac = Math.max(0, Math.min(1, px / plotW));
      return state.viewStart + frac * state.viewSpan;
    }

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const center = normFromClientX(e.clientX);
      const zoomFactor = e.deltaY < 0 ? 0.78 : 1.28;
      const newSpan = Math.max(0.015, Math.min(1, state.viewSpan * zoomFactor));
      const ratio = (center - state.viewStart) / state.viewSpan;
      let newStart = center - ratio * newSpan;
      newStart = Math.max(0, Math.min(1 - newSpan, newStart));
      state.viewStart = newStart;
      state.viewSpan = newSpan;
      scheduleRedraw();
    }, { passive: false });

    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      dragStartX = e.clientX;
      dragStartView = state.viewStart;
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - Render.FREQ_PAD_L - Render.FREQ_PAD_R);
      const dx = e.clientX - dragStartX;
      const shift = -(dx / plotW) * state.viewSpan;
      state.viewStart = Math.max(0, Math.min(1 - state.viewSpan, dragStartView + shift));
      scheduleRedraw();
    });

    window.addEventListener('mouseup', function (e) {
      if (!dragging) return;
      const moved = Math.abs(e.clientX - dragStartX);
      dragging = false;
      if (moved < 3 && e.target === canvas) {
        const rect = canvas.getBoundingClientRect();
        if (e.clientY - rect.top >= padTop && e.clientY - rect.top <= rect.height - padBottom) {
          state.markerNorm = normFromClientX(e.clientX);
          scheduleRedraw();
        }
      }
    });

    canvas.addEventListener('mousemove', function (e) {
      if (dragging) return;
      state.hoverNorm = normFromClientX(e.clientX);
      scheduleRedraw();
    });

    canvas.addEventListener('mouseleave', function () {
      state.hoverNorm = null;
      scheduleRedraw();
    });

    canvas.addEventListener('dblclick', function () {
      state.viewStart = 0;
      state.viewSpan = 1;
      state.markerNorm = null;
      scheduleRedraw();
    });
  }

  function attachTimeInteractions(canvas) {
    let dragging = false;
    let dragX = 0;
    let dragOff = 0;

    canvas.addEventListener('mousemove', function (e) {
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - 70);
      const px = e.clientX - rect.left - 54;
      state.timeHoverFrac = Math.max(0, Math.min(1, px / plotW));
      if (dragging && state.decoded) {
        const dx = e.clientX - dragX;
        const deltaSamples = Math.round(-(dx / plotW) * state.timeWindow);
        const maxOff = Math.max(0, state.decoded.count - state.timeWindow);
        state.timeOffset = Math.max(0, Math.min(maxOff, dragOff + deltaSamples));
        els.rngTimeOff.value = String(state.timeOffset);
        updateHeaders();
      }
      scheduleRedraw();
    });

    canvas.addEventListener('mouseleave', function () {
      state.timeHoverFrac = null;
      scheduleRedraw();
    });

    canvas.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      dragX = e.clientX;
      dragOff = state.timeOffset;
    });

    window.addEventListener('mouseup', function () {
      dragging = false;
    });
  }

  // ---- Wire Controls ----
  function bindEvents() {
    els.btnSidebar.addEventListener('click', function () {
      els.sidebar.classList.toggle('collapsed');
      setTimeout(scheduleRedraw, 20);
    });

    els.btnStream.addEventListener('click', function () {
      if (state.streaming) stopStreaming();
      else startStreaming();
    });

    els.btnOneshot.addEventListener('click', triggerOneshot);

    [els.btnBand0, els.btnBand1].forEach(function (btn) {
      if (!btn) return;
      btn.addEventListener('click', function () {
        setBand(parseInt(btn.getAttribute('data-band'), 10) || 0);
      });
    });

    if (els.btnUseRouter) {
      els.btnUseRouter.addEventListener('click', function () {
        const raw = els.inpRouterUrl ? els.inpRouterUrl.value.trim() : '';
        const target = normalizeHttpBase(raw || DEFAULT_ROUTER_URL);
        if (els.inpRouterUrl) els.inpRouterUrl.value = target;
        saveRouterUrl(target);
        probeAndConnectEndpoint();
      });
    }

    if (els.btnUseOrigin) {
      els.btnUseOrigin.addEventListener('click', function () {
        if (els.inpRouterUrl) els.inpRouterUrl.value = '';
        saveRouterUrl('');
        probeAndConnectEndpoint();
      });
    }

    if (els.inpRouterUrl) {
      els.inpRouterUrl.addEventListener('change', function () {
        const val = normalizeHttpBase(els.inpRouterUrl.value);
        els.inpRouterUrl.value = val;
        saveRouterUrl(val);
        if (val || !state.isFileProtocol) {
          probeAndConnectEndpoint();
        }
      });
    }

    els.btnDownload.addEventListener('click', function () {
      if (!state.lastRawBuffer) {
        showToast('No IQ data available to save', 2500);
        return;
      }
      const extracted = Dsp.extractPayloadBytes(state.lastRawBuffer, 'wsiq');
      const blob = new Blob([extracted.payload], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ct3003_iq_' + Date.now() + '.bin';
      a.click();
      URL.revokeObjectURL(url);
    });

    els.selSource.addEventListener('change', function () {
      if (state.streaming) stopStreaming();
      syncStreamDefaultForSource();
      if (els.selSource.value === 'ws') connectWebSocket();
    });

    if (els.selNodePreset) {
      els.selNodePreset.addEventListener('change', function () {
        if (els.selNodePreset.value === 'custom') return;
        const node = parseInt(els.selNodePreset.value, 10) || 15;
        els.inpNode.value = String(node);
        state.rfManualOverride = false;
        applyNodeAndRfConfig(node, { forceRf: true });
        updateHeaders();
        scheduleRedraw();
        if (state.streaming && els.selSource.value === 'ws') sendWsStart();
      });
    }

    if (els.btnSyncRf) {
      els.btnSyncRf.addEventListener('click', function () {
        state.rfManualOverride = false;
        state.streamManualOverride = false;
        const node = parseInt(els.inpNode.value, 10) || 15;
        applyNodeAndRfConfig(node, { forceRf: true });
        updateHeaders();
        reprocessLastFrame();
        refreshStatus();
        showToast('Synced hardware Fs / LO for Node ' + node, 2200);
      });
    }

    els.inpFile.addEventListener('change', function () {
      if (els.inpFile.files && els.inpFile.files[0]) {
        loadFileObject(els.inpFile.files[0]);
      }
    });

    els.selServerSample.addEventListener('change', function () {
      const name = els.selServerSample.value;
      if (!name) return;
      fetch(apiUrl('/samples/' + encodeURIComponent(name)), { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          loadNamedBuffer(name, buf);
          showToast('Loaded sample ' + name + ' (' + buf.byteLength + ' B)');
        })
        .catch(function (err) {
          showToast('Failed to load sample: ' + err.message, 3500);
        });
    });

    els.rngFilePos.addEventListener('input', function () {
      renderFileSlice(parseInt(els.rngFilePos.value, 10) || 0, false);
    });

    els.btnFilePlay.addEventListener('click', function () {
      if (state.localPlaying) stopLocalPlayback();
      else startLocalPlayback();
    });

    els.btnFileStep.addEventListener('click', stepFileFrame);
    els.btnStatusRefresh.addEventListener('click', refreshStatus);

    [els.selFormat, els.selHeader, els.selStream, els.selFftSize, els.selWindow, els.selDetector, els.chkSwap, els.chkDc].forEach(function (el) {
      if (!el) return;
      el.addEventListener('change', function () {
        if (el === els.selStream) {
          state.streamManualOverride = true;
        }
        if (el === els.selHeader && state.fileRawBuffer && els.selSource.value === 'file') {
          loadNamedBuffer(state.fileName, state.fileRawBuffer, { keepFormat: true });
        } else if (state.fileBuffer && els.selSource.value === 'file') {
          renderFileSlice(state.fileSampleCursor, true);
        } else {
          reprocessLastFrame();
        }
      });
    });

    [els.inpFs, els.inpLo].forEach(function (el) {
      el.addEventListener('change', function () {
        state.rfManualOverride = true;
        updateHeaders();
        scheduleRedraw();
      });
    });

    [els.inpNode, els.selLen, els.selMode, els.selBw, els.selSynth, els.inpInterval].forEach(function (el) {
      el.addEventListener('change', function () {
        if (el === els.inpNode) {
          const node = Math.max(0, Math.min(63, parseInt(els.inpNode.value, 10) || 15));
          els.inpNode.value = String(node);
          syncPresetSelect(node);
          applyNodeAndRfConfig(node, { forceRf: !state.rfManualOverride });
          updateHeaders();
          scheduleRedraw();
        } else if (el === els.selMode && !state.demoMode && currentCaptureParams().node === 15 && els.selMode.value === 'direct' && state.streaming) {
          els.selMode.value = 'api';
          showToast('Node 15 (ADC) streaming supports API mode only', 3000);
        }
        if (state.streaming && els.selSource.value === 'ws') {
          sendWsStart();
        }
      });
    });

    els.selPalette.addEventListener('change', function () {
      updatePaletteSwatch();
      scheduleRedraw();
    });

    if (els.selFpsLimit) {
      els.selFpsLimit.addEventListener('change', function () {
        setFpsLimit(els.selFpsLimit.value);
      });
    }

    [els.rngEma, els.rngDbMin, els.rngDbMax, els.rngWfContrast, els.rngConstPersist].forEach(function (el) {
      el.addEventListener('input', function () {
        syncOutputs();
        scheduleRedraw();
      });
    });

    [els.chkFill, els.chkPeakHold, els.chkWfEnv, els.chkWfAuto, els.selConstGain].forEach(function (el) {
      el.addEventListener('change', scheduleRedraw);
    });

    els.selTimeWin.addEventListener('change', function () {
      const total = state.decoded ? state.decoded.count : 8192;
      state.timeWindow = Math.min(total, parseInt(els.selTimeWin.value, 10) || 512);
      const maxOff = Math.max(0, total - state.timeWindow);
      els.rngTimeOff.max = String(maxOff);
      state.timeOffset = Math.min(state.timeOffset, maxOff);
      els.rngTimeOff.value = String(state.timeOffset);
      updateHeaders();
      scheduleRedraw();
    });

    els.rngTimeOff.addEventListener('input', function () {
      state.timeOffset = parseInt(els.rngTimeOff.value, 10) || 0;
      updateHeaders();
      scheduleRedraw();
    });

    els.btnAutoDb.addEventListener('click', function () {
      if (!state.binsDb || state.binsDb.length === 0) return;
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < state.binsDb.length; i++) {
        if (state.binsDb[i] < mn) mn = state.binsDb[i];
        if (state.binsDb[i] > mx) mx = state.binsDb[i];
      }
      const newMin = Math.max(-130, Math.min(-20, Math.floor((mn - 6) / 2) * 2));
      const newMax = Math.max(newMin + 20, Math.min(10, Math.ceil((mx + 8) / 2) * 2));
      els.rngDbMin.value = String(newMin);
      els.rngDbMax.value = String(newMax);
      syncOutputs();
      scheduleRedraw();
    });

    els.btnResetZoom.addEventListener('click', function () {
      state.viewStart = 0;
      state.viewSpan = 1;
      state.markerNorm = null;
      state.timeOffset = 0;
      els.rngTimeOff.value = '0';
      scheduleRedraw();
    });

    els.btnClearWf.addEventListener('click', function () {
      waterfall.clear();
      constellation.clear();
      if (state.binsDb) state.peakDb = new Float32Array(state.binsDb);
      updateHeaders();
      scheduleRedraw();
    });

    if (els.chkBleEnable) {
      els.chkBleEnable.addEventListener('change', function () {
        setBleEnabled(els.chkBleEnable.checked, { keepPane: !els.chkBleEnable.checked });
      });
    }
    if (els.btnBlePreset) els.btnBlePreset.addEventListener('click', applyBlePreset);
    if (els.btnBlePanePreset) els.btnBlePanePreset.addEventListener('click', applyBlePreset);
    if (els.btnBleClear) els.btnBleClear.addEventListener('click', clearBleRecords);
    if (els.btnBlePaneClear) els.btnBlePaneClear.addEventListener('click', clearBleRecords);

    // Maximize / restore individual panes and toggle switches
    document.querySelectorAll('[data-pane-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const name = btn.getAttribute('data-pane-toggle');
        setPaneVisible(name, !state.panes[name]);
      });
    });

    document.querySelectorAll('[data-close-pane]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const name = btn.getAttribute('data-close-pane');
        setPaneVisible(name, false);
      });
    });

    els.btnRestorePanes.addEventListener('click', function () {
      ['spectrum', 'waterfall', 'time', 'constellation'].forEach(function (name) {
        state.panes[name] = true;
      });
      syncPaneLayout();
      if (state.spectrumStale) reprocessLastFrame();
      else scheduleRedraw();
    });

    document.querySelectorAll('.btn-max').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const pane = btn.getAttribute('data-pane');
        const card = els.plotsGrid.querySelector('.plot-card[data-pane="' + pane + '"]');
        if (!card) return;
        const already = card.classList.contains('maximized');
        els.plotsGrid.querySelectorAll('.plot-card').forEach(function (c) {
          c.classList.remove('maximized');
        });
        document.querySelectorAll('.btn-max').forEach(function (b) { b.textContent = 'Max'; });
        if (already) {
          els.plotsGrid.classList.remove('has-maximized');
        } else {
          card.classList.add('maximized');
          els.plotsGrid.classList.add('has-maximized');
          btn.textContent = 'Restore';
        }
        setTimeout(scheduleRedraw, 20);
      });
    });

    // Drag-and-drop binary file anywhere
    let dragCounter = 0;
    window.addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragCounter++;
      els.dropOverlay.classList.add('visible');
    });
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    window.addEventListener('dragleave', function () {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) els.dropOverlay.classList.remove('visible');
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragCounter = 0;
      els.dropOverlay.classList.remove('visible');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadFileObject(e.dataTransfer.files[0]);
      }
    });

    // Keyboard shortcuts
    window.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        els.btnStream.click();
      } else if (e.key === 'r' || e.key === 'R') {
        els.btnResetZoom.click();
      } else if (e.key === 'm' || e.key === 'M') {
        els.btnClearWf.click();
      }
    });

    window.addEventListener('resize', scheduleRedraw);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(scheduleRedraw);
      ro.observe(els.plotsGrid);
    }

    attachFreqInteractions(els.cvSpectrum, 22, 24);
    attachFreqInteractions(els.cvWaterfall, 8, 22);
    attachTimeInteractions(els.cvTime);
  }

  function probeAndConnectEndpoint() {
    if (state.streaming) stopStreaming();
    closeWebSocketCleanly();
    state.serverOnline = false;
    state.directRouter = false;

    const httpBase = getRouterHttpBase();
    if (!httpBase) {
      setConnPill('', 'file:// Offline');
      els.selSource.value = 'synthetic';
      return;
    }

    setConnPill('warn', 'Connecting ' + httpBase + '...');
    fetch(apiUrl('/api/config'), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg || !cfg.ok) throw new Error('invalid config');
        state.serverOnline = true;
        state.demoMode = !!cfg.demo;
        state.directRouter = !!cfg.direct_router;
        if (cfg.bands) state.bandsMeta = cfg.bands;
        if (cfg.node_profiles) state.nodeProfiles = cfg.node_profiles;
        if (cfg.default_node != null) {
          els.inpNode.value = String(cfg.default_node);
          syncPresetSelect(cfg.default_node);
        }
        if (cfg.default_len != null) els.selLen.value = String(cfg.default_len);
        if (cfg.default_bw != null) els.selBw.value = String(cfg.default_bw);
        if (cfg.default_band != null) {
          state.band = Number(cfg.default_band) === 1 ? 1 : 0;
          updateBandButtons();
        }
        if (cfg.default_format) els.selFormat.value = String(cfg.default_format);
        if (cfg.default_fs_mhz != null) els.inpFs.value = String(cfg.default_fs_mhz);
        if (cfg.default_lo_mhz != null) els.inpLo.value = String(cfg.default_lo_mhz);
        if (cfg.default_stream_mode && els.selStream && !state.streamManualOverride) {
          els.selStream.value = String(cfg.default_stream_mode);
        }
        if (els.selSource.value === 'synthetic' || els.selSource.value === 'file') {
          els.selSource.value = 'ws';
        }
        applyNodeAndRfConfig(parseInt(els.inpNode.value, 10) || 15, { forceRf: false });
        updateHeaders();
        scheduleRedraw();

        if (Array.isArray(cfg.samples) && cfg.samples.length > 0) {
          els.serverSamplesRow.hidden = false;
          els.selServerSample.innerHTML = '<option value="">-- Select Sample --</option>' +
            cfg.samples.map(function (name) {
              return '<option value="' + name.replace(/"/g, '&quot;') + '">' + name + '</option>';
            }).join('');
        } else {
          els.serverSamplesRow.hidden = true;
        }

        connectWebSocket();
        if (typeof WebSocket === 'undefined') refreshStatus();
      })
      .catch(function () {
        state.serverOnline = false;
        setConnPill('', state.isFileProtocol ? 'file:// Offline' : 'Frontend Offline');
        els.selSource.value = 'synthetic';
        syncStreamDefaultForSource();
      });
  }

  function init() {
    updatePaletteSwatch();
    syncOutputs();
    syncPaneLayout();
    updateBandButtons();
    bindEvents();

    const savedRouter = readSavedRouterUrl();
    if (savedRouter && els.inpRouterUrl) {
      els.inpRouterUrl.value = savedRouter;
    }

    // Seed immediately with one clean synthetic preview so plots are never blank on first load
    const initBuf = Dsp.generateSyntheticFrame(els.selSynth.value, 8192, state.synthState);
    processRawFrame(initBuf, { pushWaterfall: true, resetHistory: true });

    if (state.isFileProtocol && !savedRouter) {
      setConnPill('', 'file:// Offline (Click Direct Router)');
      els.selSource.value = 'synthetic';
      return;
    }

    window.addEventListener('beforeunload', closeWebSocketCleanly);
    probeAndConnectEndpoint();
  }

  init();
})();
