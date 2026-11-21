/* SPDX-License-Identifier: MIT */
/* Decoupled high-performance SDR engine: runs DSP, WS/HTTP/File/Synth ingestion,
 * BLE decoding, and 60-400 fps Canvas2D rendering completely outside React's render cycle,
 * pushing throttled UI telemetry snapshots to React shadcn controls. */

import {
  computeSpectrum,
  computeStats,
  decodeIqBuffer,
  extractPayloadBytes,
  FORMAT_SPECS,
  generateSyntheticFrame,
  inferFormatFromFilename,
  type DecodedIqFrame,
  type DecodeScratchPool,
  type DetectorKind,
  type HeaderMode,
  type IqFormatKey,
  type IqStats,
  type PayloadMeta,
  type StreamMode,
  type SynthPreset,
  type SynthState,
  type WindowKind,
  type WsiqHeaderMeta,
} from './dsp';
import {
  ConstellationRenderer,
  drawSpectrum,
  drawWaveform,
  FREQ_PAD_L,
  FREQ_PAD_R,
  WaterfallRenderer,
  type PaletteName,
} from './render';
import { BleDecoder, resolveChannels, type BlePacketHit } from './ble';
import { computeRfSampleRateMhz, type RfApplyPayload, type Rf7976State } from './rf7976';

export type SourceKind = 'ws' | 'http' | 'file' | 'synthetic';
export type CaptureMode = 'api' | 'direct';
export type PaneName = 'spectrum' | 'waterfall' | 'time' | 'constellation' | 'ble';
export type ConnKind = '' | 'ok' | 'warn' | 'err';

export interface BandRfInfo {
  lo_khz?: number;
  lo_mhz?: number | null;
  bw_idx?: number;
  bw_mhz?: number | null;
  pri?: number;
  rx_n?: number;
  tx_n?: number;
}

export interface RfHwInfo {
  band0?: BandRfInfo;
  band1?: BandRfInfo;
}

export interface NodeProfile {
  format?: IqFormatKey;
  fs_mhz?: number;
  fs_mhz_5g?: number;
  interleaved?: boolean;
  streamMode?: StreamMode;
  direct_stream_safe?: boolean;
}

export interface BandMeta {
  band: number;
  name: string;
  label?: string;
  adc_fs_mhz?: number;
  rxfd_fs_mhz?: number;
  default_lo_mhz?: number;
}

export interface BleDeviceRecord {
  mac: string;
  ch: number;
  freqMhz: number;
  pduName: string;
  txAdd: number;
  pduLen: number;
  count: number;
  bestRssi: number;
  lastCfo: number;
  devName: string;
  advSummary: string;
  dataHex: string;
  crcState: boolean | null;
  lastSeenMs: number;
}

export interface BleRecentPacket {
  time: string;
  seq: number;
  ch: number;
  mac: string;
  pduName: string;
  pduLen: number;
  rssi: number;
  cfo: number;
  crcOk: boolean | null;
  summary: string;
}

export interface SdrSettings {
  source: SourceKind;
  band: 0 | 1;
  node: number;
  len: number;
  mode: CaptureMode;
  bw: number;
  fpsLimit: number;

  routerUrl: string;
  synthPreset: SynthPreset;
  intervalMs: number;

  format: IqFormatKey;
  headerMode: HeaderMode;
  streamMode: StreamMode;
  fsMhz: number;
  loMhz: number;
  swapIQ: boolean;
  dcRemove: boolean;

  fftSize: number;
  window: WindowKind;
  detector: DetectorKind;
  palette: PaletteName;
  ema: number;
  dbMin: number;
  dbMax: number;
  wfContrast: number;
  constPersist: number;
  showFill: boolean;
  showPeakHold: boolean;
  showEnvelope: boolean;
  autoTimeScale: boolean;

  timeWindow: number;
  timeOffset: number;
  constGain: number;
  bleEnabled: boolean;
  panes: Record<PaneName, boolean>;
}

export interface SdrTelemetrySnapshot {
  settings: SdrSettings;
  streaming: boolean;
  localPlaying: boolean;
  serverOnline: boolean;
  demoMode: boolean;

  connKind: ConnKind;
  connText: string;
  fwText: string;
  fwKind: ConnKind;
  tickText: string;
  tickKind: ConnKind;
  crText: string;
  fpsText: string;
  fpsTitle: string;

  serverSamples: string[];
  selectedSample: string;
  fileLoaded: boolean;
  fileInfoText: string;
  fileTotalSamples: number;
  fileMaxStart: number;
  fileSampleCursor: number;

  rfSummaryText: string;
  rfControlV2: boolean;
  rfWf: 0 | 1;
  rfSyncChInfo: boolean;
  rfHwState: Rf7976State | null;
  rfBusy: boolean;
  rfError: string;
  timeMaxOffset: number;

  metaSpectrum: string;
  metaWaterfall: string;
  metaTime: string;
  metaConst: string;
  metaBle: string;

  stats: IqStats | null;
  statsBits: number;
  hexPreview: string;

  bleStatusNote: string;
  bleDevices: BleDeviceRecord[];
  bleRecentPackets: BleRecentPacket[];
}

export interface CanvasRefs {
  spectrum: HTMLCanvasElement | null;
  waterfall: HTMLCanvasElement | null;
  time: HTMLCanvasElement | null;
  constellation: HTMLCanvasElement | null;
}

export const DEFAULT_ROUTER_URL = 'http://192.168.6.2:8088';

const WS_LANE_COUNT = 4;
const WSIQ_MAGIC_LE = 0x51495357;

const DEFAULT_NODE_PROFILES: Record<string, NodeProfile> = {
  '15': { format: 'u32_12', fs_mhz: 80, fs_mhz_5g: 160, interleaved: true, direct_stream_safe: false },
  '6':  { format: 'u32_14', fs_mhz: 40, fs_mhz_5g: 40,  interleaved: true, direct_stream_safe: true },
  '8':  { format: 'u32_14', fs_mhz: 40, fs_mhz_5g: 40,  interleaved: true, direct_stream_safe: true },
};

function readSavedRouterUrl(): string {
  try {
    const qs = new URLSearchParams(window.location.search || '');
    const fromQs = qs.get('router');
    if (fromQs) return fromQs.trim();
    return (window.localStorage && window.localStorage.getItem('wmsdr_router_url')) || '';
  } catch {
    return '';
  }
}

function saveRouterUrl(url: string): void {
  try {
    if (window.localStorage) {
      if (url) window.localStorage.setItem('wmsdr_router_url', url);
      else window.localStorage.removeItem('wmsdr_router_url');
    }
  } catch {
    // ignore storage errors
  }
}

export function normalizeHttpBase(raw: string): string {
  const t = String(raw || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  return 'http://' + t;
}

export function createInitialSettings(): SdrSettings {
  return {
    source: 'synthetic',
    band: 0,
    node: 15,
    len: 8192,
    mode: 'api',
    bw: 0,
    fpsLimit: 0,

    routerUrl: readSavedRouterUrl(),
    synthPreset: 'ofdm_wifi',
    intervalMs: 0,

    format: 'u32_12',
    headerMode: 'auto',
    streamMode: 'all',
    fsMhz: 80,
    loMhz: 2462,
    swapIQ: false,
    dcRemove: false,

    fftSize: 2048,
    window: 'blackmanharris',
    detector: 'avg',
    palette: 'sdrsharp',
    ema: 0.25,
    dbMin: -100,
    dbMax: 0,
    wfContrast: 0,
    constPersist: 0.35,
    showFill: true,
    showPeakHold: true,
    showEnvelope: false,
    autoTimeScale: false,

    timeWindow: 512,
    timeOffset: 0,
    constGain: 1,
    bleEnabled: false,
    panes: {
      spectrum: true,
      waterfall: true,
      time: true,
      constellation: true,
      ble: false,
    },
  };
}

interface AttachedWebSocket extends WebSocket {
  _sid?: number;
}

export class SdrEngine {
  private settings: SdrSettings = createInitialSettings();
  private waterfall = new WaterfallRenderer(260);
  private constellation = new ConstellationRenderer();
  private bleDecoder = new BleDecoder();

  private canvases: CanvasRefs = {
    spectrum: null,
    waterfall: null,
    time: null,
    constellation: null,
  };
  private canvasCleanups: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  private isFileProtocol = typeof window !== 'undefined' && window.location.protocol === 'file:';
  private serverOnline = false;
  private demoMode = false;
  private directRouter = false;
  private bandsMeta: Record<string, BandMeta> | null = null;
  private nodeProfiles: Record<string, NodeProfile> = {};
  private lastRfInfo: RfHwInfo | null = null;
  private rfManualOverride = false;
  private bwManualOverride = false;
  private streamManualOverride = false;
  private rfControlV2 = false;
  private rfWf: 0 | 1 = 0;
  private rfSyncChInfo = true;
  private rfHwState: Rf7976State | null = null;
  private rfBusy = false;
  private rfError = '';

  private ws: WebSocket | null = null;
  private wsLanes: AttachedWebSocket[] = [];
  private wsSid = 0;
  private activeLanes = 0;
  private lastLiveSeq = -1;
  private forceSingleLane = false;
  private wsConnected = false;
  private wsShouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private streaming = false;
  private localPlaying = false;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  private fileTimer: ReturnType<typeof setTimeout> | null = null;
  private synthState: SynthState = { phase: 0, frame: 0, seed: 0x13572468, sweepPhase: 0 };

  private fileRawBuffer: ArrayBuffer | null = null;
  private fileBuffer: Uint8Array | null = null;
  private fileName = '';
  private fileTotalSamples = 0;
  private fileSampleCursor = 0;
  private serverSamples: string[] = [];
  private selectedSample = '';

  private lastRawBuffer: ArrayBuffer | null = null;
  private lastHeaderMeta: WsiqHeaderMeta | null = null;
  private decoded: DecodedIqFrame | null = null;
  private stats: IqStats | null = null;
  private binsDb: Float32Array | null = null;
  private emaDb: Float32Array | null = null;
  private peakDb: Float32Array | null = null;
  private maxAbsNorm = 1;

  // Interactive plot viewport state (mutated directly at 120Hz without triggering React renders)
  private viewStart = 0;
  private viewSpan = 1;
  private markerNorm: number | null = null;
  private hoverNorm: number | null = null;
  private timeHoverFrac: number | null = null;

  // Rate & throttle state
  private rxFramesInWin = 0;
  private rxBytesInWin = 0;
  private rxWinStartMs = 0;
  private rxFps = 0;
  private rxMbps = 0;
  private uiFramesInWin = 0;
  private uiWinStartMs = 0;
  private uiFps = 0;
  private nextUiRenderMs = 0;
  private pendingRawBuffer: ArrayBuffer | null = null;
  private drainQueued = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  private decodePool: DecodeScratchPool = {};
  private rawBinsScratch: Float32Array | null = null;
  private lastStatsMs = 0;
  private lastSnapshotEmitMs = 0;
  private spectrumStale = false;
  private redrawQueued = false;
  private rafId: number | null = null;

  // Status display strings
  private connKind: ConnKind = '';
  private connText = 'Disconnected';
  private fwText = 'fw: -';
  private fwKind: ConnKind = '';
  private tickText = 'tick: -';
  private tickKind: ConnKind = '';
  private crText = 'cr0/9: -';
  private fpsText = '0.0 fps';
  private fpsTitle = 'RX frame rate';
  private hexPreview = 'Waiting for IQ frames...';

  // BLE telemetry state
  private bleScannedFrames = 0;
  private bleTotalHits = 0;
  private bleCrcPassCount = 0;
  private bleDevices = new Map<string, BleDeviceRecord>();
  private bleRecentPackets: BleRecentPacket[] = [];
  private bleDirty = false;

  private onSnapshot: (snap: SdrTelemetrySnapshot) => void;
  private onNotify: (msg: string, level?: 'info' | 'warning' | 'error' | 'success') => void;
  private destroyed = false;

  constructor(
    onSnapshot: (snap: SdrTelemetrySnapshot) => void,
    onNotify: (msg: string, level?: 'info' | 'warning' | 'error' | 'success') => void
  ) {
    this.onSnapshot = onSnapshot;
    this.onNotify = onNotify;
  }

  public init(): void {
    this.destroyed = false;
    // Seed immediately with a clean synthetic preview so canvases are never blank on first load
    const initBuf = generateSyntheticFrame(this.settings.synthPreset, 8192, this.synthState);
    this.processRawFrame(initBuf, { pushWaterfall: true, resetHistory: true, forceStats: true });

    if (this.isFileProtocol && !this.settings.routerUrl) {
      this.setConnPill('', 'file:// Offline');
      this.settings = { ...this.settings, source: 'synthetic' };
      this.emitSnapshot(true);
      return;
    }

    // Only auto-probe if a router URL is saved or if running against a real backend origin
    if (this.settings.routerUrl) {
      this.probeAndConnectEndpoint();
    } else {
      this.probeAndConnectEndpoint(true);
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.stopStreaming();
    this.closeWebSocketCleanly();
    this.detachCanvases();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  public getSnapshot(): SdrTelemetrySnapshot {
    const fsHz = this.currentFsHz();
    const fftSize = this.settings.fftSize || 2048;
    const rbwKhz = fsHz / fftSize / 1e3;
    const metaTag = this.lastHeaderMeta ? 'node ' + this.lastHeaderMeta.node + ' · ' : '';
    const wfTag =
      this.decoded && this.decoded.streamMode === 'even'
        ? 'WF0 · '
        : this.decoded && this.decoded.streamMode === 'odd'
          ? 'WF1 · '
          : '';
    const totalCount = this.decoded ? this.decoded.count : 0;
    const timeMaxOffset = Math.max(0, totalCount - this.settings.timeWindow);

    const chList = resolveChannels(this.settings.loMhz, this.settings.fsMhz);
    const chStr =
      this.settings.band === 1
        ? 'No BLE on 5G'
        : chList.length
          ? chList.map((c) => 'Ch' + c.ch + '(' + c.freqMhz + 'M)').join('+')
          : `Out of passband (${this.settings.loMhz.toFixed(1)}M ± ${(this.settings.fsMhz * 0.5).toFixed(0)}M · Click BLE Preset)`;

    const bleStatusNote = this.settings.bleEnabled
      ? `${chStr} · ${this.bleScannedFrames} frames · ${this.bleTotalHits} pkts / ${this.bleDevices.size} devs · CRC ${this.bleCrcPassCount}`
      : 'Disabled · Recommended: 2.4G + Node 6 + 16384 words (204.8us/frame covers Ch38 2426MHz)';

    const metaBle = this.settings.bleEnabled
      ? `${chStr} · ${this.bleDevices.size} devs / ${this.bleTotalHits} pkts (CRC ${this.bleCrcPassCount})`
      : 'Disabled';

    const sortedDevs = Array.from(this.bleDevices.values()).sort(
      (a, b) => b.count - a.count || b.bestRssi - a.bestRssi
    );

    const chunkLen = Math.min(this.fileTotalSamples, this.settings.len || 8192);
    const fileMaxStart = Math.max(0, this.fileTotalSamples - chunkLen);

    return {
      settings: {
        ...this.settings,
        panes: { ...this.settings.panes },
      },
      streaming: this.streaming,
      localPlaying: this.localPlaying,
      serverOnline: this.serverOnline,
      demoMode: this.demoMode,

      connKind: this.connKind,
      connText: this.connText,
      fwText: this.fwText,
      fwKind: this.fwKind,
      tickText: this.tickText,
      tickKind: this.tickKind,
      crText: this.crText,
      fpsText: this.fpsText,
      fpsTitle: this.fpsTitle,

      serverSamples: this.serverSamples,
      selectedSample: this.selectedSample,
      fileLoaded: this.fileBuffer !== null,
      fileInfoText: this.fileBuffer
        ? `${this.fileName} (${this.fileBuffer.byteLength} B, ${this.fileTotalSamples} samples)`
        : 'Drop .bin / .s16le / .s32le / .cf32 onto page',
      fileTotalSamples: this.fileTotalSamples,
      fileMaxStart,
      fileSampleCursor: this.fileSampleCursor,

      rfSummaryText: this.formatRfSummary(this.lastRfInfo),
      rfControlV2: this.rfControlV2,
      rfWf: this.rfWf,
      rfSyncChInfo: this.rfSyncChInfo,
      rfHwState: this.rfHwState,
      rfBusy: this.rfBusy,
      rfError: this.rfError,
      timeMaxOffset,

      metaSpectrum: `${metaTag}${wfTag}${fftSize}pt · RBW ${rbwKhz.toFixed(1)} kHz`,
      metaWaterfall: `${this.waterfall.rowCount} rows`,
      metaTime: `${totalCount}s · ${this.settings.timeWindow}@${this.settings.timeOffset}`,
      metaConst: this.stats ? `RMS ${this.stats.rmsTotal.toFixed(1)}` : '-',
      metaBle,

      stats: this.stats,
      statsBits: this.decoded ? this.decoded.spec.bits || 32 : 32,
      hexPreview: this.hexPreview,

      bleStatusNote,
      bleDevices: sortedDevs,
      bleRecentPackets: this.bleRecentPackets.slice(),
    };
  }

  private emitSnapshot(force = false): void {
    if (this.destroyed) return;
    const now = performance.now();
    if (!force && now - this.lastSnapshotEmitMs < 120) return;
    this.lastSnapshotEmitMs = now;
    this.bleDirty = false;
    this.onSnapshot(this.getSnapshot());
  }

  // ---- Canvas Attachment & Direct Event Binding (zero React overhead) ----
  public attachCanvases(refs: CanvasRefs, gridContainer: HTMLElement | null): void {
    this.detachCanvases();
    this.canvases = { ...refs };

    if (refs.spectrum) {
      this.canvasCleanups.push(this.attachFreqInteractions(refs.spectrum, 22, 24));
    }
    if (refs.waterfall) {
      this.canvasCleanups.push(this.attachFreqInteractions(refs.waterfall, 8, 22));
    }
    if (refs.time) {
      this.canvasCleanups.push(this.attachTimeInteractions(refs.time));
    }

    const onResize = () => this.scheduleRedraw();
    window.addEventListener('resize', onResize);
    this.canvasCleanups.push(() => window.removeEventListener('resize', onResize));

    if (gridContainer && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.scheduleRedraw());
      this.resizeObserver.observe(gridContainer);
    }

    this.scheduleRedraw();
  }

  private detachCanvases(): void {
    for (const fn of this.canvasCleanups) fn();
    this.canvasCleanups = [];
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  private attachFreqInteractions(canvas: HTMLCanvasElement, padTop: number, padBottom: number): () => void {
    let dragging = false;
    let dragStartX = 0;
    let dragStartView = 0;

    const normFromClientX = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - FREQ_PAD_L - FREQ_PAD_R);
      const px = clientX - rect.left - FREQ_PAD_L;
      const frac = Math.max(0, Math.min(1, px / plotW));
      return this.viewStart + frac * this.viewSpan;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const center = normFromClientX(e.clientX);
      const zoomFactor = e.deltaY < 0 ? 0.78 : 1.28;
      const newSpan = Math.max(0.015, Math.min(1, this.viewSpan * zoomFactor));
      const ratio = (center - this.viewStart) / this.viewSpan;
      let newStart = center - ratio * newSpan;
      newStart = Math.max(0, Math.min(1 - newSpan, newStart));
      this.viewStart = newStart;
      this.viewSpan = newSpan;
      this.scheduleRedraw();
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      dragStartX = e.clientX;
      dragStartView = this.viewStart;
    };

    const onWinMouseMove = (e: MouseEvent) => {
      if (!dragging) return;
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - FREQ_PAD_L - FREQ_PAD_R);
      const dx = e.clientX - dragStartX;
      const shift = -(dx / plotW) * this.viewSpan;
      this.viewStart = Math.max(0, Math.min(1 - this.viewSpan, dragStartView + shift));
      this.scheduleRedraw();
    };

    const onWinMouseUp = (e: MouseEvent) => {
      if (!dragging) return;
      const moved = Math.abs(e.clientX - dragStartX);
      dragging = false;
      if (moved < 3 && e.target === canvas) {
        const rect = canvas.getBoundingClientRect();
        if (e.clientY - rect.top >= padTop && e.clientY - rect.top <= rect.height - padBottom) {
          this.markerNorm = normFromClientX(e.clientX);
          this.scheduleRedraw();
        }
      }
    };

    const onMouseMove = (e: MouseEvent) => {
      if (dragging) return;
      this.hoverNorm = normFromClientX(e.clientX);
      this.scheduleRedraw();
    };

    const onMouseLeave = () => {
      this.hoverNorm = null;
      this.scheduleRedraw();
    };

    const onDblClick = () => {
      this.viewStart = 0;
      this.viewSpan = 1;
      this.markerNorm = null;
      this.scheduleRedraw();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onWinMouseMove);
    window.addEventListener('mouseup', onWinMouseUp);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('dblclick', onDblClick);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onWinMouseMove);
      window.removeEventListener('mouseup', onWinMouseUp);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('dblclick', onDblClick);
    };
  }

  private attachTimeInteractions(canvas: HTMLCanvasElement): () => void {
    let dragging = false;
    let dragX = 0;
    let dragOff = 0;

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const plotW = Math.max(20, rect.width - 70);
      const px = e.clientX - rect.left - 54;
      this.timeHoverFrac = Math.max(0, Math.min(1, px / plotW));
      if (dragging && this.decoded) {
        const dx = e.clientX - dragX;
        const deltaSamples = Math.round(-(dx / plotW) * this.settings.timeWindow);
        const maxOff = Math.max(0, this.decoded.count - this.settings.timeWindow);
        const nextOff = Math.max(0, Math.min(maxOff, dragOff + deltaSamples));
        if (nextOff !== this.settings.timeOffset) {
          this.settings = { ...this.settings, timeOffset: nextOff };
          this.emitSnapshot(false);
        }
      }
      this.scheduleRedraw();
    };

    const onMouseLeave = () => {
      this.timeHoverFrac = null;
      this.scheduleRedraw();
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      dragX = e.clientX;
      dragOff = this.settings.timeOffset;
    };

    const onWinMouseUp = () => {
      if (dragging) {
        dragging = false;
        this.emitSnapshot(true);
      }
    };

    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onWinMouseUp);

    return () => {
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onWinMouseUp);
    };
  }

  // ---- Helper URL / Config / RF ----
  private getRouterHttpBase(): string {
    const custom = normalizeHttpBase(this.settings.routerUrl);
    if (custom) return custom;
    if (!this.isFileProtocol && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return '';
  }

  private getRouterWsUrl(): string {
    const httpBase = this.getRouterHttpBase();
    if (!httpBase) return '';
    return httpBase.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + '/ws';
  }

  private apiUrl(path: string): string {
    const base = this.getRouterHttpBase();
    return base ? base + path : path;
  }

  private currentFsHz(): number {
    const mhz = this.settings.fsMhz;
    return (Number.isFinite(mhz) && mhz > 0 ? mhz : 80) * 1e6;
  }

  private currentCenterHz(): number {
    const mhz = this.settings.loMhz;
    return (Number.isFinite(mhz) && mhz >= 0 ? mhz : 0) * 1e6;
  }

  private getNodeProfile(node: number): NodeProfile | null {
    const key = String(node);
    const def = DEFAULT_NODE_PROFILES[key] || null;
    const remote = this.nodeProfiles[key] || null;
    if (!def) return remote;
    if (!remote) return def;
    return { ...def, ...remote };
  }

  private syncStreamDefaultForSource(): void {
    if (this.streamManualOverride) return;
    const src = this.settings.source;
    const prof = this.getNodeProfile(this.settings.node);
    const liveHw = (src === 'ws' || src === 'http') && this.serverOnline && !this.demoMode;
    const useEven = !prof || prof.streamMode === 'even' || prof.interleaved === true;
    this.settings = { ...this.settings, streamMode: liveHw && useEven ? 'even' : 'all' };
  }

  private formatRfSummary(rf: RfHwInfo | null): string {
    if (!rf) return 'RF: Waiting for ChInfo...';
    const parts: string[] = [];
    if (rf.band0 && rf.band0.lo_mhz) {
      parts.push(
        (this.settings.band === 0 ? '[Active] ' : '') +
          '2.4G: ' +
          rf.band0.lo_mhz +
          ' MHz' +
          (rf.band0.bw_mhz ? ' (' + rf.band0.bw_mhz + 'M)' : '')
      );
    }
    if (rf.band1 && rf.band1.lo_mhz) {
      parts.push(
        (this.settings.band === 1 ? '[Active] ' : '') +
          '5G: ' +
          rf.band1.lo_mhz +
          ' MHz' +
          (rf.band1.bw_mhz ? ' (' + rf.band1.bw_mhz + 'M)' : '')
      );
    }
    return parts.length ? 'RF · ' + parts.join(' · ') : 'RF: Channels inactive';
  }

  private computeHardwareFsMhz(band: 0 | 1, node: number, bwIdx: number): number {
    const bandMeta = this.bandsMeta && this.bandsMeta[String(band)];
    const prof = this.getNodeProfile(node);
    if (node === 15) {
      if (band === 1) {
        return (bandMeta && bandMeta.adc_fs_mhz) || (prof && prof.fs_mhz_5g) || 160;
      }
      return (bandMeta && bandMeta.adc_fs_mhz) || (prof && prof.fs_mhz) || 80;
    }
    if (node === 6 || node === 8) {
      return computeRfSampleRateMhz(band, node, bwIdx);
    }
    return (band === 1 ? prof?.fs_mhz_5g : prof?.fs_mhz) || (band === 1 ? 160 : 80);
  }

  private applyNodeAndRfConfig(
    node: number,
    opts: { forceRf?: boolean; updateFormat?: boolean; guardMode?: boolean } = {}
  ): void {
    const prof = this.getNodeProfile(node);
    const rf = this.lastRfInfo;
    let nextFormat = this.settings.format;
    let nextMode = this.settings.mode;
    let nextFs = this.settings.fsMhz;
    let nextLo = this.settings.loMhz;
    let nextBw = this.settings.bw;

    if (prof) {
      if (prof.format && opts.updateFormat !== false) {
        nextFormat = prof.format;
      }
      if (prof.direct_stream_safe === false && nextMode === 'direct' && opts.guardMode !== false) {
        nextMode = 'api';
      }
    }

    if (!this.rfManualOverride || opts.forceRf) {
      const bandIdx: 0 | 1 = this.settings.band === 1 ? 1 : 0;
      const bandInfo = rf && (bandIdx === 1 ? rf.band1 : rf.band0);
      const bandMeta = this.bandsMeta && this.bandsMeta[String(bandIdx)];
      nextLo =
        bandInfo && bandInfo.lo_mhz
          ? bandInfo.lo_mhz
          : bandMeta && bandMeta.default_lo_mhz
            ? bandMeta.default_lo_mhz
            : bandIdx === 1
              ? 5250
              : 2462;
      if (!this.bwManualOverride && bandInfo && bandInfo.bw_idx != null && bandInfo.bw_idx <= 3) {
        nextBw = bandIdx === 0 && bandInfo.bw_idx > 1 ? 1 : bandInfo.bw_idx;
      } else if (bandIdx === 0 && nextBw > 1) {
        nextBw = 1;
      }
      nextFs = this.computeHardwareFsMhz(bandIdx, node, nextBw);
    }

    this.settings = {
      ...this.settings,
      format: nextFormat,
      mode: nextMode,
      bw: nextBw,
      fsMhz: nextFs,
      loMhz: nextLo,
    };
    this.syncStreamDefaultForSource();
  }

  private setConnPill(kind: ConnKind, text: string): void {
    this.connKind = kind;
    this.connText = text;
  }

  private formatStatusMeta(st: Record<string, unknown> | null): void {
    if (!st) return;
    if (st.fw_state != null) {
      this.fwText = 'fw: ' + st.fw_state;
      this.fwKind = st.fw_state === 3 || st.fw_state === 7 ? 'ok' : 'warn';
    }
    if (st.raw_tick != null) {
      this.tickText = 'tick: ' + st.raw_tick;
      this.tickKind = st.magic_ok ? 'ok' : 'warn';
    }
    if (st.cr0 != null && st.cr9 != null) {
      const cr0Hex = typeof st.cr0 === 'number' ? '0x' + st.cr0.toString(16) : String(st.cr0);
      const cr9Hex = typeof st.cr9 === 'number' ? '0x' + st.cr9.toString(16) : String(st.cr9);
      this.crText = 'cr0/9: ' + cr0Hex + '/' + cr9Hex;
    }
    if (st.rf && typeof st.rf === 'object') {
      this.lastRfInfo = st.rf as RfHwInfo;
      this.applyNodeAndRfConfig(this.settings.node, { updateFormat: false, guardMode: false });
      this.scheduleRedraw();
    }
  }

  // ---- Rate Counters ----
  private resetRateCounters(): void {
    this.rxFramesInWin = 0;
    this.rxBytesInWin = 0;
    this.rxWinStartMs = 0;
    this.rxFps = 0;
    this.rxMbps = 0;
    this.uiFramesInWin = 0;
    this.uiWinStartMs = 0;
    this.uiFps = 0;
    this.nextUiRenderMs = 0;
  }

  private recordRxFrame(byteLength: number): void {
    const now = performance.now();
    if (!this.rxWinStartMs) {
      this.rxWinStartMs = now;
      this.rxFramesInWin = 0;
      this.rxBytesInWin = 0;
    }
    this.rxFramesInWin++;
    this.rxBytesInWin += byteLength || 0;
    const dt = now - this.rxWinStartMs;
    if (dt >= 400) {
      this.rxFps = (this.rxFramesInWin * 1000) / dt;
      this.rxMbps = ((this.rxBytesInWin / (1024 * 1024)) * 1000) / dt;
      this.rxWinStartMs = now;
      this.rxFramesInWin = 0;
      this.rxBytesInWin = 0;
      this.updateFpsText(false);
    }
  }

  private recordUiFrame(now: number): void {
    if (!this.uiWinStartMs) {
      this.uiWinStartMs = now;
      this.uiFramesInWin = 0;
      return;
    }
    this.uiFramesInWin++;
    const dt = now - this.uiWinStartMs;
    if (dt >= 400) {
      this.uiFps = (this.uiFramesInWin * 1000) / dt;
      this.uiWinStartMs = now;
      this.uiFramesInWin = 0;
    }
  }

  private effectiveStepDelay(baseMs: number): number {
    if (this.settings.fpsLimit > 0) {
      return Math.max(baseMs, Math.round(1000 / this.settings.fpsLimit));
    }
    return baseMs;
  }

  private updateFpsText(force: boolean): void {
    const limit = this.settings.fpsLimit;
    if (!this.streaming && !this.localPlaying) {
      this.fpsText = this.rxFps > 0 ? this.rxFps.toFixed(1) + ' fps' : '0.0 fps';
      this.fpsTitle = limit > 0 ? `RX frame rate (UI limit: ${limit} fps)` : 'RX frame rate';
      this.emitSnapshot(force);
      return;
    }
    const fps = this.rxFps || this.uiFps || 0;
    let baseText: string;
    if (fps >= 100 && this.rxMbps > 0.1) {
      baseText = `${fps.toFixed(0)} fps · ${this.rxMbps.toFixed(1)} MB/s`;
    } else if (this.rxMbps > 0.5) {
      baseText = `${fps.toFixed(1)} fps · ${this.rxMbps.toFixed(1)} MB/s`;
    } else {
      baseText = `${fps.toFixed(1)} fps`;
    }
    if (limit > 0) {
      const uiStr = this.uiFps > 0 ? this.uiFps.toFixed(1) : `<=${limit}`;
      this.fpsText = `${baseText} · UI ${uiStr} fps`;
      this.fpsTitle = `RX ${this.rxFps.toFixed(1)} fps (${this.rxMbps.toFixed(2)} MiB/s) · Sampled UI ${this.uiFps.toFixed(1)} / ${limit} fps`;
    } else {
      this.fpsText = baseText;
      this.fpsTitle = `RX ${this.rxFps.toFixed(1)} fps (${this.rxMbps.toFixed(2)} MiB/s) · UI render ${this.uiFps.toFixed(1)} fps`;
    }
    this.emitSnapshot(force);
  }

  // ---- BLE Processing ----
  private recordBleHits(hits: BlePacketHit[]): void {
    const now = Date.now();
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      this.bleTotalHits++;
      if (h.crcOk === true) this.bleCrcPassCount++;
      const macKey = (h.mac || 'trunc(' + h.pduLen + ')') + '|' + h.ch + '|' + h.pduType;
      let dev = this.bleDevices.get(macKey);
      if (!dev) {
        dev = {
          mac: h.mac || '(trunc len=' + h.pduLen + ')',
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
          lastSeenMs: now,
        };
        this.bleDevices.set(macKey, dev);
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

      this.bleRecentPackets.unshift({
        time: new Date(now).toLocaleTimeString('en-GB', { hour12: false }),
        seq: h.seq,
        ch: h.ch,
        mac: dev.mac,
        pduName: h.pduName,
        pduLen: h.pduLen,
        rssi: h.rssiDbfs,
        cfo: h.cfoKhz,
        crcOk: h.crcOk,
        summary: h.advSummary || h.dataHex,
      });
      if (this.bleRecentPackets.length > 40) {
        this.bleRecentPackets.length = 40;
      }
    }
    this.bleDirty = true;
  }

  private runBleScan(arrayBuffer: ArrayBuffer): void {
    if (!this.settings.bleEnabled || !arrayBuffer) return;
    this.bleScannedFrames++;
    this.bleDirty = true;
    const hits = this.bleDecoder.scanFrame(arrayBuffer, {
      loMhz: this.settings.loMhz,
      fsMhz: this.settings.fsMhz,
      streamMode: this.settings.streamMode,
    });
    if (hits.length > 0) {
      this.recordBleHits(hits);
    }
  }

  // ---- Core DSP + Canvas Draw Hot Path ----
  private formatHexPreview(dec: DecodedIqFrame): string {
    const fmtVal = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
    const previewLines: string[] = [];
    const lim = Math.min(6, dec.count);
    for (let i = 0; i < lim; i++) {
      const iv = fmtVal(dec.iRaw[i]).padStart(6, ' ');
      const qv = fmtVal(dec.qRaw[i]).padStart(6, ' ');
      const hex = dec.rawWords ? '0x' + dec.rawWords[i].toString(16).padStart(8, '0') + ' ' : '';
      previewLines.push(`[${i}] ${hex}I=${iv} Q=${qv}`);
    }
    return previewLines.join('\n') || 'empty frame';
  }

  private processRawFrame(
    arrayBuffer: ArrayBuffer,
    opts: {
      pushWaterfall?: boolean;
      resetHistory?: boolean;
      forceStats?: boolean;
      skipRxCount?: boolean;
      skipBle?: boolean;
      directDraw?: boolean;
      headerModeOverride?: HeaderMode;
      streamModeOverride?: StreamMode;
    } = {}
  ): void {
    if (!arrayBuffer || arrayBuffer.byteLength < 4) return;
    this.lastRawBuffer = arrayBuffer;

    const decoded = decodeIqBuffer(arrayBuffer, {
      format: this.settings.format,
      swapIQ: this.settings.swapIQ,
      headerMode: opts.headerModeOverride || this.settings.headerMode,
      streamMode: opts.streamModeOverride || this.settings.streamMode,
      out: this.decodePool,
    });
    if (decoded.count === 0) return;

    this.decoded = decoded;
    if (decoded.meta && decoded.meta.kind === 'wsiq') {
      this.lastHeaderMeta = decoded.meta;
    }

    const now = performance.now();
    const shouldUpdateStats =
      !this.streaming ||
      !!opts.resetHistory ||
      !!opts.forceStats ||
      (this.settings.fpsLimit > 0 && this.settings.fpsLimit <= 30) ||
      now - this.lastStatsMs >= 130;

    if (shouldUpdateStats) {
      if (decoded.meta && decoded.meta.kind === 'wsiq') {
        this.formatStatusMeta({ cr0: decoded.meta.cr0, cr9: decoded.meta.cr9 });
      }
      this.stats = computeStats(decoded);
      this.hexPreview = this.formatHexPreview(decoded);
      this.lastStatsMs = now;
    }

    this.maxAbsNorm = decoded.maxAbsNorm || 1;

    const count = decoded.count;
    const clampedWin = Math.min(count, Math.max(32, this.settings.timeWindow));
    const maxOffset = Math.max(0, count - clampedWin);
    if (this.settings.timeOffset > maxOffset) {
      this.settings = { ...this.settings, timeOffset: maxOffset };
    }

    const needsSpectrum = this.settings.panes.spectrum || this.settings.panes.waterfall;
    if (needsSpectrum) {
      this.spectrumStale = false;
      const fftSize = this.settings.fftSize || 2048;
      if (!this.rawBinsScratch || this.rawBinsScratch.length !== fftSize) {
        this.rawBinsScratch = new Float32Array(fftSize);
      }
      const rawBins = computeSpectrum(decoded.iNorm, decoded.qNorm, {
        fftSize,
        window: this.settings.window,
        dcRemove: this.settings.dcRemove,
        detector: this.settings.detector,
        outBins: this.rawBinsScratch,
        maxBlocks: this.streaming && !opts.resetHistory ? 16 : 0,
      });

      const alpha = Math.max(0, Math.min(0.95, this.settings.ema || 0));
      if (!this.emaDb || this.emaDb.length !== rawBins.length || alpha === 0 || opts.resetHistory) {
        if (!this.emaDb || this.emaDb.length !== rawBins.length) {
          this.emaDb = new Float32Array(rawBins.length);
        }
        this.emaDb.set(rawBins);
      } else {
        const keep = alpha;
        const take = 1 - alpha;
        for (let i = 0; i < rawBins.length; i++) {
          this.emaDb[i] = this.emaDb[i] * keep + rawBins[i] * take;
        }
      }
      this.binsDb = this.emaDb;

      if (!this.peakDb || this.peakDb.length !== rawBins.length || opts.resetHistory) {
        if (!this.peakDb || this.peakDb.length !== this.binsDb.length) {
          this.peakDb = new Float32Array(this.binsDb.length);
        }
        this.peakDb.set(this.binsDb);
      } else {
        for (let i = 0; i < rawBins.length; i++) {
          if (this.binsDb[i] > this.peakDb[i]) this.peakDb[i] = this.binsDb[i];
        }
      }

      if (opts.pushWaterfall !== false && this.settings.panes.waterfall) {
        this.waterfall.pushRow(this.binsDb);
      }
    } else {
      this.spectrumStale = true;
    }

    if (opts.pushWaterfall !== false && !opts.skipRxCount) {
      this.recordRxFrame(arrayBuffer.byteLength);
      this.recordUiFrame(now);
      this.updateFpsText(false);
    }

    if (!opts.skipBle && opts.pushWaterfall !== false) {
      this.runBleScan(arrayBuffer);
    }

    if (shouldUpdateStats || this.bleDirty) {
      this.emitSnapshot(!!opts.resetHistory || !!opts.forceStats);
    }

    if (opts.directDraw) {
      this.drawAll();
    } else {
      this.scheduleRedraw();
    }
  }

  public drawAll = (): void => {
    this.redrawQueued = false;
    this.rafId = null;

    const dbMin = this.settings.dbMin;
    const dbMax = Math.max(dbMin + 10, this.settings.dbMax);
    const fsHz = this.currentFsHz();
    const centerHz = this.currentCenterHz();

    if (this.settings.panes.spectrum && this.canvases.spectrum) {
      drawSpectrum(this.canvases.spectrum, {
        binsDb: this.binsDb,
        peakDb: this.peakDb,
        showPeak: this.settings.showPeakHold,
        showFill: this.settings.showFill,
        dbMin,
        dbMax,
        fsHz,
        centerHz,
        viewStart: this.viewStart,
        viewSpan: this.viewSpan,
        markerNorm: this.markerNorm,
        hoverNorm: this.hoverNorm,
      });
    }

    if (this.settings.panes.waterfall && this.canvases.waterfall) {
      this.waterfall.draw(this.canvases.waterfall, {
        dbMin,
        dbMax,
        contrast: this.settings.wfContrast,
        palette: this.settings.palette,
        fsHz,
        centerHz,
        viewStart: this.viewStart,
        viewSpan: this.viewSpan,
        markerNorm: this.markerNorm,
        hoverNorm: this.hoverNorm,
        rowHeight: 2,
      });
    }

    if (this.settings.panes.time && this.canvases.time) {
      drawWaveform(this.canvases.time, {
        decoded: this.decoded,
        timeOffset: this.settings.timeOffset,
        timeWindow: this.settings.timeWindow,
        showEnvelope: this.settings.showEnvelope,
        autoScaleY: this.settings.autoTimeScale,
        maxAbsNorm: this.maxAbsNorm,
        hoverFrac: this.timeHoverFrac,
      });
    }

    if (this.settings.panes.constellation && this.canvases.constellation) {
      this.constellation.draw(this.canvases.constellation, {
        decoded: this.decoded,
        stats: this.stats,
        persistence: this.settings.constPersist,
        constGain: this.settings.constGain,
      });
    }
  };

  public scheduleRedraw(): void {
    if (this.redrawQueued || this.destroyed) return;
    this.redrawQueued = true;
    this.rafId = requestAnimationFrame(this.drawAll);
  }

  private reprocessLastFrame(): void {
    if (this.lastRawBuffer) {
      this.processRawFrame(this.lastRawBuffer, { pushWaterfall: false, resetHistory: true, forceStats: true });
    }
  }

  // ---- WebSocket & HTTP Backends ----
  private updateWsConnBadge(): void {
    if (!this.wsConnected) return;
    if (this.streaming && this.activeLanes > 0) {
      this.setConnPill('ok', `WS Kernel Async · ${this.activeLanes} Lanes`);
    } else if (this.demoMode) {
      this.setConnPill('ok', 'WS Demo Connected');
    } else {
      this.setConnPill('ok', this.directRouter ? 'WS Direct Router' : 'WS Connected');
    }
    this.emitSnapshot(true);
  }

  private closeDataLanes(): void {
    this.wsSid = 0;
    this.activeLanes = 0;
    if (this.wsLanes.length === 0) return;
    const lanes = this.wsLanes;
    this.wsLanes = [];
    for (const lws of lanes) {
      try {
        lws.onopen = null;
        lws.onclose = null;
        lws.onerror = null;
        lws.onmessage = null;
        lws.close();
      } catch {
        // ignore
      }
    }
  }

  private clearLiveDrain(): void {
    this.drainQueued = false;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.pendingRawBuffer = null;
  }

  private closeWebSocketCleanly(): void {
    this.wsShouldReconnect = false;
    this.wsConnected = false;
    this.clearLiveDrain();
    this.closeDataLanes();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.onclose = null;
        old.onerror = null;
        old.onmessage = null;
        old.close();
      } catch {
        // ignore
      }
    }
  }

  private pushLiveBinaryFrame(buf: ArrayBuffer): void {
    if (!buf) return;
    this.recordRxFrame(buf.byteLength);
    if (buf.byteLength >= 32) {
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) === WSIQ_MAGIC_LE) {
        const seq = dv.getUint32(8, true);
        if (this.lastLiveSeq >= 0 && ((seq - this.lastLiveSeq) | 0) <= 0) {
          return;
        }
        this.lastLiveSeq = seq;
      }
    }
    this.runBleScan(buf);
    const limit = this.settings.fpsLimit || 0;
    if (limit > 60) {
      const now = performance.now();
      const intervalMs = 1000 / limit;
      if (!this.nextUiRenderMs || now - this.nextUiRenderMs > intervalMs * 2) {
        this.nextUiRenderMs = now + intervalMs;
      } else if (now + 0.15 < this.nextUiRenderMs) {
        this.pendingRawBuffer = buf;
        return;
      } else {
        this.nextUiRenderMs += intervalMs;
      }
      this.pendingRawBuffer = null;
      this.processRawFrame(buf, {
        pushWaterfall: true,
        skipRxCount: true,
        skipBle: true,
        directDraw: false,
        forceStats: false,
      });
      this.recordUiFrame(now);
      this.updateFpsText(false);
      return;
    }
    this.pendingRawBuffer = buf;
    this.scheduleLiveDrain();
  }

  private openDataLanes(sid: number): void {
    const wsUrl = this.getRouterWsUrl();
    if (!wsUrl || !sid || !this.streaming || this.settings.source !== 'ws') return;
    this.closeDataLanes();
    this.wsSid = sid;
    for (let i = 0; i < WS_LANE_COUNT; i++) {
      const lws = new WebSocket(wsUrl) as AttachedWebSocket;
      let attached = false;
      lws.binaryType = 'arraybuffer';
      lws._sid = sid;
      this.wsLanes.push(lws);

      lws.onopen = () => {
        if (!this.streaming || this.wsSid !== sid || this.settings.source !== 'ws') {
          try {
            lws.close();
          } catch {
            // ignore
          }
          return;
        }
        lws.send(JSON.stringify({ type: 'attach', sid }));
      };

      lws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          if (this.streaming && this.wsSid === sid && this.settings.source === 'ws') {
            this.pushLiveBinaryFrame(ev.data);
          }
          return;
        }
        if (typeof ev.data === 'string') {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'status' && msg.attached && !attached) {
              attached = true;
              this.activeLanes++;
              this.updateWsConnBadge();
            } else if (msg.type === 'error') {
              try {
                lws.close();
              } catch {
                // ignore
              }
            }
          } catch {
            // ignore
          }
        }
      };

      const onDone = () => {
        if (attached) {
          attached = false;
          if (this.activeLanes > 0) this.activeLanes--;
          this.updateWsConnBadge();
        }
        const idx = this.wsLanes.indexOf(lws);
        if (idx >= 0) this.wsLanes.splice(idx, 1);
      };
      lws.onclose = onDone;
      lws.onerror = onDone;
    }
  }

  private drainLiveFrame = (): void => {
    this.drainQueued = false;
    const limit = this.settings.fpsLimit || 0;
    if (limit > 60) return;
    const buf = this.pendingRawBuffer;
    if (!buf) return;
    const now = performance.now();
    if (limit > 0) {
      const intervalMs = 1000 / limit;
      if (this.nextUiRenderMs && now + 2.5 < this.nextUiRenderMs) {
        this.scheduleLiveDrain();
        return;
      }
      if (!this.nextUiRenderMs || now - this.nextUiRenderMs > intervalMs * 2) {
        this.nextUiRenderMs = now + intervalMs;
      } else {
        this.nextUiRenderMs += intervalMs;
      }
    } else {
      this.nextUiRenderMs = 0;
    }
    this.pendingRawBuffer = null;
    this.processRawFrame(buf, {
      pushWaterfall: true,
      skipRxCount: true,
      skipBle: true,
      directDraw: true,
      forceStats: limit > 0,
    });
    this.recordUiFrame(now);
    this.updateFpsText(limit > 0);
  };

  private scheduleLiveDrain(): void {
    if (this.drainQueued || !this.pendingRawBuffer) return;
    const limit = this.settings.fpsLimit || 0;
    if (limit <= 0) {
      this.drainQueued = true;
      requestAnimationFrame(this.drainLiveFrame);
      return;
    }
    const intervalMs = 1000 / limit;
    const now = performance.now();
    if (!this.nextUiRenderMs || now - this.nextUiRenderMs > intervalMs * 2) {
      this.drainQueued = true;
      requestAnimationFrame(this.drainLiveFrame);
      return;
    }
    const waitMs = this.nextUiRenderMs - now;
    if (waitMs <= 18) {
      this.drainQueued = true;
      requestAnimationFrame(this.drainLiveFrame);
    } else {
      const leadMs = Math.min(12, intervalMs * 0.35);
      const sleepMs = Math.max(0, waitMs - leadMs);
      this.drainQueued = true;
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        if (!this.drainQueued) return;
        requestAnimationFrame(this.drainLiveFrame);
      }, sleepMs);
    }
  }

  private connectWebSocket(): void {
    const wsUrl = this.getRouterWsUrl();
    if (!wsUrl) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.wsShouldReconnect = true;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.setConnPill('warn', 'Connecting WS...');
    this.emitSnapshot(true);

    ws.onopen = () => {
      this.wsConnected = true;
      this.updateWsConnBadge();
      ws.send(JSON.stringify({ type: 'status' }));
      if (this.streaming && this.settings.source === 'ws') {
        this.sendWsStart();
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'status') {
            this.formatStatusMeta(msg);
            if (msg.streaming && msg.kernelNet && msg.controlOnly && msg.sid) {
              if (this.streaming && this.settings.source === 'ws') {
                this.openDataLanes(msg.sid);
              }
            } else if (msg.streaming === false) {
              this.closeDataLanes();
              this.updateWsConnBadge();
            }
            this.emitSnapshot(true);
          } else if (msg.type === 'error') {
            if (!this.forceSingleLane && msg.message && String(msg.message).includes('Kernel net') && this.streaming) {
              this.forceSingleLane = true;
              this.sendWsStart();
              return;
            }
            this.onNotify('CT3003 Error: ' + msg.message, 'error');
            if (this.streaming) this.stopStreaming();
          }
        } catch {
          // ignore
        }
      } else if (ev.data instanceof ArrayBuffer) {
        if (this.streaming && this.settings.source === 'ws') {
          this.pushLiveBinaryFrame(ev.data);
        } else {
          this.processRawFrame(ev.data, { pushWaterfall: true });
        }
      }
    };

    ws.onclose = () => {
      this.wsConnected = false;
      this.ws = null;
      this.closeDataLanes();
      if (this.wsShouldReconnect && this.streaming && this.settings.source === 'ws') {
        this.setConnPill('err', 'WS Disconnected, Reconnecting');
        this.emitSnapshot(true);
        this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 1500);
      } else {
        this.setConnPill('', this.serverOnline ? 'HTTP Ready' : 'Standalone Synth');
        this.emitSnapshot(true);
      }
    };

    ws.onerror = () => {
      this.wsConnected = false;
    };
  }

  private guardSafeStreamMode(): {
    node: number;
    len: number;
    bw: number;
    band: 0 | 1;
    direct: boolean;
    intervalMs: number;
    preset: SynthPreset;
  } {
    let direct = this.settings.mode === 'direct';
    if (!this.demoMode && direct && (this.settings.node === 15 || this.settings.band === 1)) {
      this.settings = { ...this.settings, mode: 'api' };
      direct = false;
      this.onNotify(
        this.settings.band === 1
          ? '5G (Band 1) switched to API mode'
          : 'Node 15 (ADC) streaming switched to API mode to protect WM firmware',
        'warning'
      );
      this.emitSnapshot(true);
    }
    return {
      node: this.settings.node,
      len: this.settings.len,
      bw: this.settings.bw,
      band: this.settings.band,
      direct,
      intervalMs: this.settings.intervalMs,
      preset: this.settings.synthPreset,
    };
  }

  private sendWsStart(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connectWebSocket();
      return;
    }
    const p = this.guardSafeStreamMode();
    const wantMulti = !this.forceSingleLane && p.intervalMs <= 20;
    this.closeDataLanes();
    this.clearLiveDrain();
    this.lastLiveSeq = -1;
    this.nextUiRenderMs = 0;
    this.ws.send(
      JSON.stringify({
        type: 'start',
        node: p.node,
        len: p.len,
        bw: p.bw,
        band: p.band,
        direct: p.direct,
        intervalMs: p.intervalMs,
        controlOnly: wantMulti,
        preset: p.preset,
      })
    );
  }

  private captureHttpOneshot(): Promise<void> {
    const p = this.guardSafeStreamMode();
    const qs =
      `?node=${p.node}&len=${p.len}&bw=${p.bw}&band=${p.band}&direct=${p.direct ? 1 : 0}` +
      `&preset=${encodeURIComponent(p.preset)}`;
    return fetch(this.apiUrl('/api/capture' + qs), { cache: 'no-store' })
      .then((resp) => {
        if (!resp.ok) {
          return resp.text().then((txt) => {
            throw new Error(txt || 'HTTP ' + resp.status);
          });
        }
        const cr0 = resp.headers.get('X-IQ-CR0');
        const cr9 = resp.headers.get('X-IQ-CR9');
        const sampleCount = resp.headers.get('X-IQ-Sample-Count');
        if (cr0 || cr9) {
          this.formatStatusMeta({ cr0: cr0 || '-', cr9: cr9 || '-', sample_count: sampleCount });
        }
        return resp.arrayBuffer();
      })
      .then((buf) => {
        this.processRawFrame(buf, { pushWaterfall: true });
      })
      .catch((err: Error) => {
        this.onNotify('HTTP capture failed: ' + err.message, 'error');
        if (this.streaming) this.stopStreaming();
      });
  }

  // ---- Public Actions for React Controls ----
  public toggleStreaming(): void {
    if (this.streaming) this.stopStreaming();
    else this.startStreaming();
  }

  public startStreaming(): void {
    this.stopLocalPlayback();
    this.resetRateCounters();
    this.pendingRawBuffer = null;
    this.streaming = true;
    this.emitSnapshot(true);

    const src = this.settings.source;
    if (src === 'ws' || src === 'http') {
      this.guardSafeStreamMode();
    }
    if (src === 'ws') {
      if (!this.serverOnline) {
        this.onNotify('Router offline — switching to Synthetic Generator', 'info');
        this.settings = { ...this.settings, source: 'synthetic' };
        this.emitSnapshot(true);
        this.startStreaming();
        return;
      }
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendWsStart();
      } else {
        this.connectWebSocket();
      }
      return;
    }

    if (src === 'http') {
      let busy = false;
      const runPoll = () => {
        if (!this.streaming || this.settings.source !== 'http') return;
        if (busy) {
          this.streamTimer = setTimeout(runPoll, 50);
          return;
        }
        busy = true;
        this.captureHttpOneshot().finally(() => {
          busy = false;
          if (this.streaming && this.settings.source === 'http') {
            const delay = this.effectiveStepDelay(this.settings.intervalMs);
            this.streamTimer = setTimeout(runPoll, delay);
          }
        });
      };
      runPoll();
      return;
    }

    if (src === 'file') {
      this.startLocalPlayback();
      return;
    }

    // Synthetic streaming
    const tickSynth = () => {
      if (!this.streaming || this.settings.source !== 'synthetic') return;
      const buf = generateSyntheticFrame(this.settings.synthPreset, this.settings.len, this.synthState);
      this.processRawFrame(buf, { pushWaterfall: true });
      const delay = this.effectiveStepDelay(this.settings.intervalMs === 0 ? 16 : this.settings.intervalMs);
      this.streamTimer = setTimeout(tickSynth, delay);
    };
    tickSynth();
  }

  public stopStreaming(): void {
    this.streaming = false;
    this.clearLiveDrain();
    this.lastLiveSeq = -1;
    if (this.streamTimer) {
      clearTimeout(this.streamTimer);
      this.streamTimer = null;
    }
    this.closeDataLanes();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'stop' }));
    }
    this.updateWsConnBadge();
    this.stopLocalPlayback();
    this.resetRateCounters();
    this.updateFpsText(true);
    if (this.decoded) {
      this.stats = computeStats(this.decoded);
      this.hexPreview = this.formatHexPreview(this.decoded);
    }
    this.emitSnapshot(true);
  }

  public triggerOneshot(): void {
    const src = this.settings.source;
    if (src === 'synthetic') {
      const buf = generateSyntheticFrame(this.settings.synthPreset, this.settings.len, this.synthState);
      this.processRawFrame(buf, { pushWaterfall: true, forceStats: true });
      return;
    }
    if (src === 'file') {
      this.stepFileFrame();
      return;
    }
    if (src === 'ws' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const p = this.guardSafeStreamMode();
      this.ws.send(
        JSON.stringify({
          type: 'oneshot',
          node: p.node,
          len: p.len,
          bw: p.bw,
          band: p.band,
          direct: p.direct,
          preset: p.preset,
        })
      );
      return;
    }
    this.captureHttpOneshot();
  }

  public setBand(bandIdx: 0 | 1, opts: { keepHistory?: boolean; forceRf?: boolean; skipRestart?: boolean } = {}): void {
    const changed = this.settings.band !== bandIdx;
    this.settings = { ...this.settings, band: bandIdx };
    if (changed && !opts.keepHistory) {
      this.rfManualOverride = false;
      this.bwManualOverride = false;
      this.emaDb = null;
      this.peakDb = null;
      this.waterfall.clear();
      this.constellation.clear();
    }
    this.applyNodeAndRfConfig(this.settings.node, {
      forceRf: !this.rfManualOverride || !!opts.forceRf,
      updateFormat: false,
    });
    this.emitSnapshot(true);
    this.scheduleRedraw();

    if (changed && this.serverOnline && !this.demoMode && this.rfControlV2) {
      void this.refreshRfState();
    }

    if (changed && this.settings.source === 'synthetic' && !this.streaming) {
      const buf = generateSyntheticFrame(this.settings.synthPreset, this.settings.len, this.synthState);
      this.processRawFrame(buf, { pushWaterfall: true, forceStats: true });
    }
    if (changed && this.streaming && this.settings.source === 'ws' && !opts.skipRestart) {
      this.sendWsStart();
    } else if (
      changed &&
      !this.streaming &&
      this.wsConnected &&
      (this.settings.source === 'ws' || this.settings.source === 'http')
    ) {
      this.triggerOneshot();
    }
  }

  public setSource(source: SourceKind): void {
    if (this.streaming) this.stopStreaming();
    this.settings = { ...this.settings, source };
    this.syncStreamDefaultForSource();
    this.emitSnapshot(true);
    if (source === 'ws') this.connectWebSocket();
  }

  public setNode(nodeRaw: number, fromPreset = false): void {
    const node = Math.max(0, Math.min(63, Math.round(nodeRaw) || 15));
    this.settings = { ...this.settings, node };
    if (fromPreset) this.rfManualOverride = false;
    this.applyNodeAndRfConfig(node, { forceRf: fromPreset || !this.rfManualOverride });
    this.emitSnapshot(true);
    this.scheduleRedraw();
    if (this.serverOnline && !this.demoMode && this.rfControlV2) {
      void this.refreshRfState();
    }
    if (this.streaming && this.settings.source === 'ws') {
      this.sendWsStart();
    }
  }

  public setCaptureOption<K extends 'len' | 'mode' | 'bw' | 'synthPreset' | 'intervalMs'>(
    key: K,
    value: SdrSettings[K]
  ): void {
    if (
      key === 'mode' &&
      !this.demoMode &&
      this.settings.node === 15 &&
      value === 'direct' &&
      this.streaming
    ) {
      this.onNotify('Node 15 (ADC) streaming supports API mode only', 'warning');
      return;
    }
    this.settings = { ...this.settings, [key]: value };
    if (key === 'bw' && typeof value === 'number' && !this.demoMode && !this.rfManualOverride) {
      const clampedBw = this.settings.band === 0 && value > 1 ? 1 : Math.max(0, Math.min(3, value));
      this.bwManualOverride = true;
      this.settings = {
        ...this.settings,
        bw: clampedBw,
        fsMhz: this.computeHardwareFsMhz(this.settings.band, this.settings.node, clampedBw),
      };
      this.scheduleRedraw();
    }
    this.emitSnapshot(true);
    if (this.streaming && this.settings.source === 'ws') {
      this.sendWsStart();
    }
    if (key === 'synthPreset' && this.settings.source === 'synthetic' && !this.streaming) {
      const buf = generateSyntheticFrame(this.settings.synthPreset, this.settings.len, this.synthState);
      this.processRawFrame(buf, { pushWaterfall: true, resetHistory: true, forceStats: true });
    }
  }

  public setFpsLimit(val: number): void {
    const limit = Math.max(0, Math.min(1000, Math.round(val) || 0));
    this.settings = { ...this.settings, fpsLimit: limit };
    this.nextUiRenderMs = 0;
    this.uiFramesInWin = 0;
    this.uiWinStartMs = 0;
    this.uiFps = 0;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
      this.drainQueued = false;
    }
    if (this.pendingRawBuffer && this.streaming && this.settings.source === 'ws') {
      if (limit > 60) {
        const buf = this.pendingRawBuffer;
        this.pendingRawBuffer = null;
        this.drainQueued = false;
        this.nextUiRenderMs = performance.now() + 1000 / limit;
        this.processRawFrame(buf, { pushWaterfall: true, skipRxCount: true, directDraw: false, forceStats: false });
        this.recordUiFrame(performance.now());
        this.updateFpsText(true);
      } else {
        this.scheduleLiveDrain();
      }
    } else {
      this.updateFpsText(true);
    }
  }

  public setDspOption<
    K extends 'format' | 'headerMode' | 'streamMode' | 'fftSize' | 'window' | 'detector' | 'swapIQ' | 'dcRemove'
  >(key: K, value: SdrSettings[K]): void {
    if (key === 'streamMode') this.streamManualOverride = true;
    this.settings = { ...this.settings, [key]: value };
    this.emitSnapshot(true);

    if (key === 'headerMode' && this.fileRawBuffer && this.settings.source === 'file') {
      this.loadNamedBuffer(this.fileName, this.fileRawBuffer, { keepFormat: true });
    } else if (this.fileBuffer && this.settings.source === 'file') {
      this.renderFileSlice(this.fileSampleCursor, true);
    } else {
      this.reprocessLastFrame();
    }
  }

  public setRfScale(key: 'fsMhz' | 'loMhz', value: number): void {
    if (!Number.isFinite(value)) return;
    this.rfManualOverride = true;
    this.settings = { ...this.settings, [key]: value };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public syncHwRf(): void {
    this.rfManualOverride = false;
    this.bwManualOverride = false;
    this.streamManualOverride = false;
    this.applyNodeAndRfConfig(this.settings.node, { forceRf: true });
    this.reprocessLastFrame();
    this.refreshStatus();
    if (this.rfControlV2 && !this.demoMode) {
      void this.refreshRfState();
    }
    this.emitSnapshot(true);
    this.onNotify(`Synced hardware Fs / LO for Node ${this.settings.node}`, 'info');
  }

  public setRfWf(wf: 0 | 1): void {
    const next: 0 | 1 = wf === 1 ? 1 : 0;
    if (this.rfWf === next) return;
    this.rfWf = next;
    this.emitSnapshot(true);
    if (this.serverOnline && !this.demoMode && this.rfControlV2) {
      void this.refreshRfState(next);
    }
  }

  public setRfSyncChInfo(sync: boolean): void {
    this.rfSyncChInfo = !!sync;
    this.emitSnapshot(true);
  }

  private mergeRfStateIntoChInfo(st: Rf7976State, forceScaleUpdate: boolean): void {
    const prevNode = this.settings.node;
    const prevBw = this.settings.bw;
    const bandKey = st.band === 1 ? 'band1' : 'band0';
    const loKhz = st.sx?.chinfo_lo_khz > 100000 ? st.sx.chinfo_lo_khz : st.sx?.est_lo_khz;
    const loMhz = loKhz > 100000 ? loKhz / 1000 : undefined;

    const curRf: RfHwInfo = { ...(this.lastRfInfo || {}) };
    curRf[bandKey] = {
      ...(curRf[bandKey] || {}),
      lo_khz: loKhz,
      lo_mhz: loMhz,
      bw_idx: st.rate?.bw_idx,
      bw_mhz: st.rate?.bw_mhz,
      pri: st.rate?.pri_ch,
      rx_n: st.rate?.rx_n,
      tx_n: st.rate?.tx_n,
    };
    this.lastRfInfo = curRf;

    if (forceScaleUpdate && st.band === this.settings.band) {
      this.rfManualOverride = false;
      this.bwManualOverride = false;
      const nextNode = st.rate?.icap_node ? st.rate.icap_node : this.settings.node;
      const nextBw = typeof st.rate?.bw_idx === 'number' && st.rate.bw_idx <= 3 ? st.rate.bw_idx : this.settings.bw;
      const nodeOrBwChanged = nextNode !== prevNode || nextBw !== prevBw;
      if (nodeOrBwChanged) {
        this.settings = { ...this.settings, node: nextNode, bw: nextBw };
      }
      this.applyNodeAndRfConfig(this.settings.node, { forceRf: true, updateFormat: nextNode !== prevNode });
      if (loMhz && st.sx?.chinfo_lo_khz > 100000) {
        this.settings = { ...this.settings, loMhz };
      }
      if (st.rate?.active_fs_mhz > 0) {
        this.settings = { ...this.settings, fsMhz: st.rate.active_fs_mhz };
      }
      if (nodeOrBwChanged && this.streaming && this.settings.source === 'ws') {
        this.sendWsStart();
      }
    }
  }

  private syncCaptureRateFromRfState(st: Rf7976State): void {
    if (st.band !== this.settings.band) return;
    const prevNode = this.settings.node;
    const prevBw = this.settings.bw;
    const nextNode = st.rate?.icap_node ? st.rate.icap_node : prevNode;
    const nextBw = typeof st.rate?.bw_idx === 'number' && st.rate.bw_idx <= 3 ? st.rate.bw_idx : prevBw;
    const nodeOrBwChanged = nextNode !== prevNode || nextBw !== prevBw;
    this.bwManualOverride = false;
    this.settings = {
      ...this.settings,
      node: nextNode,
      bw: nextBw,
      fsMhz: st.rate?.active_fs_mhz > 0 ? st.rate.active_fs_mhz : this.settings.fsMhz,
    };
    if (nextNode !== prevNode) {
      const prof = this.getNodeProfile(nextNode);
      if (prof?.format) this.settings = { ...this.settings, format: prof.format };
      if (prof?.direct_stream_safe === false && this.settings.mode === 'direct') {
        this.settings = { ...this.settings, mode: 'api' };
      }
      this.syncStreamDefaultForSource();
    }
    this.scheduleRedraw();
    if (nodeOrBwChanged && this.streaming && this.settings.source === 'ws') {
      this.sendWsStart();
    }
  }

  public async refreshRfState(wfOverride?: 0 | 1): Promise<Rf7976State | null> {
    if (!this.serverOnline || this.demoMode || !this.getRouterHttpBase()) return null;
    const wf = wfOverride !== undefined ? wfOverride : this.rfWf;
    const qs = `?band=${this.settings.band}&wf=${wf}&node=${this.settings.node}`;
    this.rfBusy = true;
    this.rfError = '';
    this.emitSnapshot(true);
    try {
      const res = await fetch(this.apiUrl('/api/rf/state' + qs), { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      this.rfHwState = data as Rf7976State;
      this.rfControlV2 = true;
      return this.rfHwState;
    } catch (err) {
      this.rfError = err instanceof Error ? err.message : 'RF readback failed';
      return null;
    } finally {
      this.rfBusy = false;
      this.emitSnapshot(true);
    }
  }

  public async applyRfControl(patch: RfApplyPayload): Promise<Rf7976State | null> {
    if (!this.serverOnline || this.demoMode || !this.getRouterHttpBase()) {
      this.onNotify('Connect to a live CT3003 router first', 'warning');
      return null;
    }
    const payload: RfApplyPayload = {
      band: this.settings.band,
      wf: this.rfWf,
      node: this.settings.node,
      sync_chinfo: this.rfSyncChInfo,
      ...patch,
    };
    this.rfBusy = true;
    this.rfError = '';
    this.emitSnapshot(true);
    try {
      const res = await fetch(this.apiUrl('/api/rf/apply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const st = data as Rf7976State;
      this.rfHwState = st;
      if (payload.sync_chinfo !== false) {
        this.mergeRfStateIntoChInfo(st, true);
        void this.refreshStatus();
        this.scheduleRedraw();
      } else if (
        patch.icap_node != null ||
        patch.bw_idx != null ||
        patch.bw_mhz != null ||
        patch.sample_rate_mhz != null
      ) {
        this.syncCaptureRateFromRfState(st);
      }
      return st;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RF apply failed';
      this.rfError = msg;
      this.onNotify(msg, 'error');
      return null;
    } finally {
      this.rfBusy = false;
      this.emitSnapshot(true);
    }
  }

  public async snapshotRf(): Promise<boolean> {
    if (!this.serverOnline || this.demoMode || !this.getRouterHttpBase()) return false;
    this.rfBusy = true;
    this.rfError = '';
    this.emitSnapshot(true);
    try {
      const res = await fetch(this.apiUrl('/api/rf/snapshot'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ band: this.settings.band, wf: this.rfWf }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (this.rfHwState) {
        this.rfHwState = { ...this.rfHwState, has_snapshot: true };
      }
      this.onNotify(`Saved RF baseline snapshot (${data.count} regs)`, 'success');
      void this.refreshRfState();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RF snapshot failed';
      this.rfError = msg;
      this.onNotify(msg, 'error');
      return false;
    } finally {
      this.rfBusy = false;
      this.emitSnapshot(true);
    }
  }

  public async restoreRf(): Promise<Rf7976State | null> {
    if (!this.serverOnline || this.demoMode || !this.getRouterHttpBase()) return null;
    this.rfBusy = true;
    this.rfError = '';
    this.emitSnapshot(true);
    try {
      const res = await fetch(this.apiUrl('/api/rf/restore'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node: this.settings.node }),
        cache: 'no-store',
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const st = data as Rf7976State;
      this.rfHwState = st;
      this.mergeRfStateIntoChInfo(st, true);
      void this.refreshStatus();
      this.scheduleRedraw();
      this.onNotify('Restored MT7976 baseline RF snapshot', 'success');
      return st;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'RF restore failed';
      this.rfError = msg;
      this.onNotify(msg, 'error');
      return null;
    } finally {
      this.rfBusy = false;
      this.emitSnapshot(true);
    }
  }

  public setDisplayOption<
    K extends
      | 'palette'
      | 'ema'
      | 'dbMin'
      | 'dbMax'
      | 'wfContrast'
      | 'constPersist'
      | 'showFill'
      | 'showPeakHold'
      | 'showEnvelope'
      | 'autoTimeScale'
      | 'constGain'
  >(key: K, value: SdrSettings[K]): void {
    this.settings = { ...this.settings, [key]: value };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public setTimeWindow(win: number): void {
    const total = this.decoded ? this.decoded.count : 8192;
    const clamped = Math.min(total, Math.max(32, win));
    const maxOff = Math.max(0, total - clamped);
    const nextOff = Math.min(this.settings.timeOffset, maxOff);
    this.settings = { ...this.settings, timeWindow: clamped, timeOffset: nextOff };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public setTimeOffset(offset: number): void {
    const total = this.decoded ? this.decoded.count : 0;
    const maxOff = Math.max(0, total - this.settings.timeWindow);
    const nextOff = Math.max(0, Math.min(maxOff, Math.round(offset) || 0));
    this.settings = { ...this.settings, timeOffset: nextOff };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public autoDbRange(): void {
    if (!this.binsDb || this.binsDb.length === 0) return;
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < this.binsDb.length; i++) {
      if (this.binsDb[i] < mn) mn = this.binsDb[i];
      if (this.binsDb[i] > mx) mx = this.binsDb[i];
    }
    const newMin = Math.max(-130, Math.min(-20, Math.floor((mn - 6) / 2) * 2));
    const newMax = Math.max(newMin + 20, Math.min(10, Math.ceil((mx + 8) / 2) * 2));
    this.settings = { ...this.settings, dbMin: newMin, dbMax: newMax };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public resetZoom(): void {
    this.viewStart = 0;
    this.viewSpan = 1;
    this.markerNorm = null;
    this.settings = { ...this.settings, timeOffset: 0 };
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public clearWaterfallAndPeak(): void {
    this.waterfall.clear();
    this.constellation.clear();
    if (this.binsDb) this.peakDb = new Float32Array(this.binsDb);
    this.emitSnapshot(true);
    this.scheduleRedraw();
  }

  public setPaneVisible(name: PaneName, visible: boolean): void {
    const nextPanes = { ...this.settings.panes, [name]: visible };
    this.settings = { ...this.settings, panes: nextPanes };
    if (name === 'ble' && visible && !this.settings.bleEnabled) {
      this.setBleEnabled(true, { keepPane: true });
    } else {
      this.emitSnapshot(true);
    }
    if (visible && this.spectrumStale && (name === 'spectrum' || name === 'waterfall')) {
      this.reprocessLastFrame();
    } else {
      setTimeout(() => this.scheduleRedraw(), 16);
    }
  }

  public restoreDefaultPanes(): void {
    this.settings = {
      ...this.settings,
      panes: {
        ...this.settings.panes,
        spectrum: true,
        waterfall: true,
        time: true,
        constellation: true,
      },
    };
    this.emitSnapshot(true);
    if (this.spectrumStale) this.reprocessLastFrame();
    else setTimeout(() => this.scheduleRedraw(), 16);
  }

  public setBleEnabled(on: boolean, opts: { keepPane?: boolean } = {}): void {
    this.bleDecoder.resetNoiseFloor();
    const nextPanes =
      on && !opts.keepPane && !this.settings.panes.ble
        ? { ...this.settings.panes, ble: true }
        : this.settings.panes;
    this.settings = { ...this.settings, bleEnabled: on, panes: nextPanes };
    this.emitSnapshot(true);
  }

  public applyBlePreset(): void {
    const curLo = this.settings.band === 0 ? this.settings.loMhz : 0;
    const curCh = resolveChannels(curLo, 40);
    const needTune =
      curCh.length === 0 || curCh.every((c) => Math.abs(c.fOffMhz) < 2.0);
    const curBwIdx =
      this.rfHwState?.rate?.bw_idx ??
      this.lastRfInfo?.band0?.bw_idx ??
      this.settings.bw;
    const needHwApply =
      this.serverOnline &&
      !this.demoMode &&
      this.rfControlV2 &&
      (needTune || curBwIdx !== 0);

    // Under 20 MHz BW (Node 6 -> 40 Msps, 204.8 us per 16384w frame), 2434 MHz
    // places BLE Ch38 (2426 MHz) at -8 MHz inside the analog passband and clear of DC.
    const targetLo = needTune ? 2434 : curLo;

    this.settings = {
      ...this.settings,
      bleEnabled: true,
      panes: { ...this.settings.panes, ble: true },
      band: 0,
      node: 6,
      len: 16384,
      bw: 0,
      loMhz: needHwApply || !this.serverOnline || this.demoMode ? targetLo : this.settings.loMhz,
      fsMhz: 40,
    };
    if (this.serverOnline && this.settings.source !== 'ws') {
      this.settings = { ...this.settings, source: 'ws' };
    }
    this.rfManualOverride = false;
    this.bwManualOverride = false;
    this.bleDecoder.resetNoiseFloor();

    if (needHwApply) {
      this.rfManualOverride = true;
      this.emitSnapshot(true);
      this.scheduleRedraw();
      if (this.streaming && this.settings.source === 'ws') {
        this.sendWsStart();
      }
      void this.applyRfControl({
        band: 0,
        wf: this.rfWf,
        lo_mhz: targetLo,
        bw_idx: 0,
        icap_node: 6,
        sync_chinfo: true,
      }).then((st) => {
        if (st) {
          this.bleDecoder.resetNoiseFloor();
          const msg = needTune
            ? `Applied BLE preset: tuned ${targetLo} MHz @ 20 MHz (Ch38 2426 MHz, 40 Msps)`
            : 'Applied BLE preset: switched BW to 20 MHz (Node 6, 40 Msps)';
          this.onNotify(msg, 'success');
        } else {
          this.rfManualOverride = false;
        }
      });
      return;
    }

    if (!this.rfControlV2) {
      this.applyNodeAndRfConfig(6, { forceRf: true });
    }
    this.syncStreamDefaultForSource();
    this.emitSnapshot(true);
    this.scheduleRedraw();
    if (this.streaming && this.settings.source === 'ws') {
      this.sendWsStart();
    }
    this.onNotify('Applied BLE preset: 2.4G · Node 6 · 16384 words', 'success');
  }

  public clearBleRecords(): void {
    this.bleScannedFrames = 0;
    this.bleTotalHits = 0;
    this.bleCrcPassCount = 0;
    this.bleDevices.clear();
    this.bleRecentPackets = [];
    this.bleDecoder.resetNoiseFloor();
    this.emitSnapshot(true);
  }

  // ---- Router URL & Status ----
  public setRouterUrl(raw: string, connectNow = false): void {
    const normalized = connectNow ? normalizeHttpBase(raw) : raw;
    this.settings = { ...this.settings, routerUrl: normalized };
    if (connectNow) {
      saveRouterUrl(normalized);
      this.probeAndConnectEndpoint();
    }
    this.emitSnapshot(true);
  }

  public useDefaultRouter(): void {
    const raw = this.settings.routerUrl.trim();
    const target = normalizeHttpBase(raw || DEFAULT_ROUTER_URL);
    this.settings = { ...this.settings, routerUrl: target };
    saveRouterUrl(target);
    this.emitSnapshot(true);
    this.probeAndConnectEndpoint();
  }

  public useSameOrigin(): void {
    this.settings = { ...this.settings, routerUrl: '' };
    saveRouterUrl('');
    this.emitSnapshot(true);
    this.probeAndConnectEndpoint();
  }

  public refreshStatus(): Promise<void> {
    if (!this.serverOnline || !this.getRouterHttpBase()) return Promise.resolve();
    return fetch(this.apiUrl('/api/status'), { cache: 'no-store' })
      .then((r) => r.json())
      .then((st) => {
        if (st && st.ok) {
          this.formatStatusMeta(st);
          if (st.direct_router != null) this.directRouter = !!st.direct_router;
          if (st.demo) {
            this.demoMode = true;
            this.setConnPill('ok', this.wsConnected ? 'WS Demo Ready' : 'HTTP Demo Ready');
          }
          this.emitSnapshot(true);
        } else if (st && st.error) {
          this.fwText = 'status err';
          this.fwKind = 'warn';
          this.emitSnapshot(true);
        }
      })
      .catch(() => {
        // ignore network errors
      });
  }

  public probeAndConnectEndpoint(silentFallback = false): void {
    if (this.streaming) this.stopStreaming();
    this.closeWebSocketCleanly();
    this.serverOnline = false;
    this.directRouter = false;

    const httpBase = this.getRouterHttpBase();
    if (!httpBase) {
      this.setConnPill('', 'Standalone Synth');
      this.settings = { ...this.settings, source: 'synthetic' };
      this.emitSnapshot(true);
      return;
    }

    if (!silentFallback) {
      this.setConnPill('warn', 'Connecting ' + httpBase + '...');
      this.emitSnapshot(true);
    }

    fetch(this.apiUrl('/api/config'), { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then((cfg) => {
        if (!cfg || !cfg.ok) throw new Error('invalid config');
        this.serverOnline = true;
        this.demoMode = !!cfg.demo;
        this.directRouter = !!cfg.direct_router;
        this.rfControlV2 = !!cfg.rf_control_v2;
        if (cfg.bands) this.bandsMeta = cfg.bands;
        if (cfg.node_profiles) this.nodeProfiles = cfg.node_profiles;

        const next = { ...this.settings };
        if (cfg.default_node != null) next.node = Number(cfg.default_node);
        if (cfg.default_len != null) next.len = Number(cfg.default_len);
        if (cfg.default_bw != null) next.bw = Number(cfg.default_bw);
        if (cfg.default_band != null) next.band = Number(cfg.default_band) === 1 ? 1 : 0;
        if (cfg.default_format) next.format = cfg.default_format;
        if (cfg.default_fs_mhz != null) next.fsMhz = Number(cfg.default_fs_mhz);
        if (cfg.default_lo_mhz != null) next.loMhz = Number(cfg.default_lo_mhz);
        if (cfg.default_stream_mode && !this.streamManualOverride) {
          next.streamMode = cfg.default_stream_mode;
        }
        if (next.source === 'synthetic' || next.source === 'file') {
          next.source = 'ws';
        }
        this.settings = next;
        this.applyNodeAndRfConfig(this.settings.node, { forceRf: false });

        this.serverSamples = Array.isArray(cfg.samples) ? cfg.samples : [];
        this.emitSnapshot(true);
        this.scheduleRedraw();

        this.connectWebSocket();
        if (typeof WebSocket === 'undefined') this.refreshStatus();
        if (this.rfControlV2 && !this.demoMode) {
          void this.refreshRfState();
        }
      })
      .catch(() => {
        this.serverOnline = false;
        this.setConnPill('', this.isFileProtocol ? 'file:// Offline' : 'Standalone Synth');
        this.settings = { ...this.settings, source: 'synthetic' };
        this.syncStreamDefaultForSource();
        this.emitSnapshot(true);
      });
  }

  // ---- Local File & Server Sample Playback ----
  public loadFileObject(file: File): void {
    file.arrayBuffer().then((buf) => {
      this.loadNamedBuffer(file.name, buf);
      this.onNotify(`Loaded ${file.name} (${buf.byteLength} B)`, 'success');
    });
  }

  public loadServerSample(name: string): void {
    this.selectedSample = name;
    if (!name) {
      this.emitSnapshot(true);
      return;
    }
    fetch(this.apiUrl('/samples/' + encodeURIComponent(name)), { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then((buf) => {
        this.loadNamedBuffer(name, buf);
        this.onNotify(`Loaded sample ${name} (${buf.byteLength} B)`, 'success');
      })
      .catch((err: Error) => {
        this.onNotify('Failed to load sample: ' + err.message, 'error');
      });
  }

  private loadNamedBuffer(name: string, arrayBuffer: ArrayBuffer, opts: { keepFormat?: boolean } = {}): void {
    this.stopStreaming();
    const nextFormat = opts.keepFormat ? this.settings.format : inferFormatFromFilename(name);
    const extracted = extractPayloadBytes(arrayBuffer, this.settings.headerMode);
    const bytes = extracted.payload;
    const spec = FORMAT_SPECS[nextFormat];
    const totalSamples = Math.floor(bytes.byteLength / spec.bytesPerSample);

    this.fileRawBuffer = arrayBuffer;
    this.fileBuffer = bytes;
    this.fileName = name;
    this.fileTotalSamples = totalSamples;
    this.fileSampleCursor = 0;

    this.settings = { ...this.settings, format: nextFormat, source: 'file' };
    this.renderFileSlice(0, true);
  }

  public renderFileSlice(sampleStart: number, resetHistory = false): void {
    if (!this.fileBuffer) return;
    const spec = FORMAT_SPECS[this.settings.format];
    const len = this.settings.len || 8192;
    const byteStart = Math.max(0, sampleStart * spec.bytesPerSample);
    const byteLen = Math.min(this.fileBuffer.byteLength - byteStart, len * spec.bytesPerSample);
    if (byteLen <= 0) return;

    const slice = this.fileBuffer.slice(byteStart, byteStart + byteLen);
    this.fileSampleCursor = sampleStart;
    this.processRawFrame(slice.buffer, {
      pushWaterfall: true,
      resetHistory,
      forceStats: true,
      headerModeOverride: 'none',
    });
  }

  public stepFileFrame(): void {
    if (!this.fileBuffer) {
      this.onNotify('Select or drop an IQ binary file first', 'info');
      return;
    }
    const len = this.settings.len || 8192;
    const step = Math.max(256, Math.min(len, this.settings.fftSize || 2048));
    let next = this.fileSampleCursor + step;
    if (next >= this.fileTotalSamples) next = 0;
    this.renderFileSlice(next, false);
  }

  public toggleLocalPlayback(): void {
    if (this.localPlaying) this.stopLocalPlayback();
    else this.startLocalPlayback();
  }

  public startLocalPlayback(): void {
    if (!this.fileBuffer) {
      this.onNotify('Select or drop an IQ file first', 'info');
      return;
    }
    this.stopLocalPlayback();
    this.localPlaying = true;
    this.emitSnapshot(true);
    const loop = () => {
      if (!this.localPlaying) return;
      this.stepFileFrame();
      const delay = this.effectiveStepDelay(this.settings.intervalMs === 0 ? 16 : this.settings.intervalMs);
      this.fileTimer = setTimeout(loop, delay);
    };
    loop();
  }

  public stopLocalPlayback(): void {
    this.localPlaying = false;
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
      this.fileTimer = null;
    }
    this.emitSnapshot(true);
  }

  public downloadBin(): void {
    if (!this.lastRawBuffer) {
      this.onNotify('No IQ data available to save', 'info');
      return;
    }
    const extracted = extractPayloadBytes(this.lastRawBuffer, 'wsiq');
    const copy = new Uint8Array(extracted.payload.byteLength);
    copy.set(extracted.payload);
    const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ct3003_iq_${Date.now()}.bin`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
