/* SPDX-License-Identifier: MIT */
import * as React from 'react';
import {
  ChevronDown,
  FileUp,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  StepForward,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import type {
  DetectorKind,
  HeaderMode,
  IqFormatKey,
  StreamMode,
  SynthPreset,
  WindowKind,
} from '@/src/sdr/dsp';
import { getPaletteCssGradient, type PaletteName } from '@/src/sdr/render';
import type { SdrEngine, SdrTelemetrySnapshot } from '@/src/sdr/engine';

const SYNTH_LABELS: Record<SynthPreset, string> = {
  ofdm_wifi: 'Wi-Fi OFDM Carriers',
  multitone: 'Multi-tone CW + Noise',
  qpsk_burst: 'QPSK Modulated Burst',
  sweep: 'Chirp Sweep',
};

const FORMAT_LABELS: Record<IqFormatKey, string> = {
  u32_12: 'CT3003 Packed u32 (12b)',
  u32_14: 'Packed u32 (14b)',
  u32_16: 'Packed u32 (16b)',
  s16le: 'Interleaved s16le',
  s32le: 'Interleaved s32le',
  cf32: 'Complex float32',
};

const HEADER_LABELS: Record<HeaderMode, string> = {
  auto: 'Auto (WSIQ/ICAP/IQUD)',
  none: 'None (Raw)',
  wsiq: 'WSIQ (32B)',
  icap: 'ICAP (28B Stream)',
  iqud: 'IQUD (44B)',
};

const STREAM_LABELS: Record<StreamMode, string> = {
  all: 'All Words (Raw / Synth)',
  even: 'WF0 Even w[0::2] (HW)',
  odd: 'WF1 Odd w[1::2] (HW)',
};

const WINDOW_LABELS: Record<WindowKind, string> = {
  blackmanharris: 'Blackman-Harris',
  hann: 'Hann',
  hamming: 'Hamming',
  rect: 'Rectangular',
};

const DETECTOR_LABELS: Record<DetectorKind, string> = {
  avg: 'Average',
  peak: 'Peak',
};

const PALETTE_LABELS: Record<PaletteName, string> = {
  sdrsharp: 'SDR#',
  turbo: 'Turbo',
  viridis: 'Viridis',
  classic: 'Classic Blue',
  gray: 'Grayscale',
};

const FFT_SIZES = [512, 1024, 2048, 4096, 8192];

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const SidebarSection: React.FC<SectionProps> = ({
  title,
  defaultOpen = true,
  children,
}) => {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card text-card-foreground shadow-xs"
    >
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/50 transition-colors rounded-t-lg cursor-pointer select-none">
        <span>{title}</span>
        <ChevronDown
          className={`size-3.5 text-muted-foreground transition-transform duration-150 ${
            open ? 'rotate-0' : '-rotate-90'
          }`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3 pt-2 border-t space-y-2.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled?: boolean;
  onChange: (val: number) => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
  label,
  value,
  min,
  max,
  step,
  display,
  disabled,
  onChange,
}) => (
  <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
    <Label className="text-xs font-normal text-muted-foreground whitespace-nowrap">
      {label}
    </Label>
    <div className="flex items-center gap-2 min-w-0">
      <Slider
        value={[value]}
        min={min}
        max={max > min ? max : min + 1}
        step={step}
        disabled={disabled || max <= min}
        onValueChange={(v) => {
          const num = Array.isArray(v) ? v[0] : v;
          if (typeof num === 'number' && Number.isFinite(num)) {
            onChange(num);
          }
        }}
        className="flex-1"
      />
      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-foreground">
        {display}
      </span>
    </div>
  </div>
);

interface SwitchItemProps {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

const SwitchItem: React.FC<SwitchItemProps> = ({
  id,
  label,
  checked,
  onCheckedChange,
}) => (
  <div className="flex items-center justify-between gap-2">
    <Label
      htmlFor={id}
      className="text-xs font-normal text-foreground cursor-pointer select-none"
    >
      {label}
    </Label>
    <Switch
      id={id}
      size="sm"
      checked={checked}
      onCheckedChange={onCheckedChange}
    />
  </div>
);

interface ControlSidebarProps {
  engine: SdrEngine;
  snapshot: SdrTelemetrySnapshot;
  open: boolean;
}

export const ControlSidebar: React.FC<ControlSidebarProps> = ({
  engine,
  snapshot,
  open,
}) => {
  const { settings, stats } = snapshot;
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  if (!open) return null;

  const fmtVal = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));
  const topBleDevices = snapshot.bleDevices.slice(0, 6);

  return (
    <aside className="w-[324px] flex-none border-r bg-sidebar text-sidebar-foreground max-[1040px]:w-full max-[1040px]:border-r-0 max-[1040px]:border-b flex flex-col min-h-0">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-2.5 space-y-2.5">
          {/* 1. Source & Direct Router */}
          <SidebarSection title="Source & Direct Router" defaultOpen>
            <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
              <Label htmlFor="inp-router-url" className="text-xs font-normal text-muted-foreground">
                Router URL
              </Label>
              <Input
                id="inp-router-url"
                type="text"
                placeholder="http://192.168.6.2:8088"
                value={settings.routerUrl}
                onChange={(e) => engine.setRouterUrl(e.target.value, false)}
                onBlur={(e) => {
                  if (e.target.value.trim()) {
                    engine.setRouterUrl(e.target.value, true);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    engine.setRouterUrl(settings.routerUrl, true);
                  }
                }}
                className="h-7 font-mono text-xs"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.useDefaultRouter()}
                className="font-mono"
              >
                Direct 192.168.6.2:8088
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.useSameOrigin()}
              >
                Same Origin
              </Button>
            </div>

            {/* File upload dropbox */}
            <div className="rounded-md border border-dashed bg-muted/40 p-2.5 text-center">
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin,.iq,.s16le,.cs16,.s32le,.cs32,.cf32,.fc32,.raw"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) engine.loadFileObject(f);
                  e.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                className="w-full"
              >
                <FileUp className="size-3.5" />
                Load Local IQ File
              </Button>
              <p className="mt-1.5 text-[11px] text-muted-foreground break-all leading-snug">
                {snapshot.fileInfoText}
              </p>
            </div>

            {snapshot.serverSamples.length > 0 && (
              <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
                <Label className="text-xs font-normal text-muted-foreground">Samples</Label>
                <Select
                  value={snapshot.selectedSample}
                  onValueChange={(v) => engine.loadServerSample(v || '')}
                >
                  <SelectTrigger size="sm" className="w-full font-mono text-xs">
                    <SelectValue>{snapshot.selectedSample || '-- Select Sample --'}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.serverSamples.map((name) => (
                      <SelectItem key={name} value={name} className="font-mono text-xs">
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
              <Label className="text-xs font-normal text-muted-foreground">Synth Preset</Label>
              <Select
                value={settings.synthPreset}
                onValueChange={(v) => {
                  if (v) engine.setCaptureOption('synthPreset', v as SynthPreset);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{SYNTH_LABELS[settings.synthPreset]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SYNTH_LABELS) as SynthPreset[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {SYNTH_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label htmlFor="inp-interval" className="text-xs font-normal text-muted-foreground">
                Interval (ms)
              </Label>
              <Input
                id="inp-interval"
                type="number"
                min={0}
                max={5000}
                step={10}
                value={settings.intervalMs}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  engine.setCaptureOption(
                    'intervalMs',
                    Number.isNaN(val) ? 0 : Math.max(0, Math.min(5000, val))
                  );
                }}
                className="h-7 font-mono text-xs tabular-nums"
              />
            </div>

            {snapshot.fileLoaded && (
              <>
                <Separator />
                <SliderRow
                  label="File Offset"
                  value={snapshot.fileSampleCursor}
                  min={0}
                  max={Math.max(0, snapshot.fileMaxStart)}
                  step={1}
                  display={String(snapshot.fileSampleCursor)}
                  onChange={(val) => engine.renderFileSlice(val, false)}
                />
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => engine.toggleLocalPlayback()}
                  >
                    {snapshot.localPlaying ? (
                      <>
                        <Square className="size-3 fill-current" /> Stop
                      </>
                    ) : (
                      <>
                        <Play className="size-3 fill-current" /> Play File
                      </>
                    )}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => engine.stepFileFrame()}
                  >
                    <StepForward className="size-3" /> Step Frame
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => engine.refreshStatus()}
                  >
                    <RefreshCw className="size-3" /> Status
                  </Button>
                </div>
              </>
            )}
          </SidebarSection>

          {/* 2. Format & RF Scale */}
          <SidebarSection title="Format & RF Scale" defaultOpen>
            <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
              <Label className="text-xs font-normal text-muted-foreground">Format</Label>
              <Select
                value={settings.format}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('format', v as IqFormatKey);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{FORMAT_LABELS[settings.format]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FORMAT_LABELS) as IqFormatKey[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {FORMAT_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs font-normal text-muted-foreground">Header Strip</Label>
              <Select
                value={settings.headerMode}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('headerMode', v as HeaderMode);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{HEADER_LABELS[settings.headerMode]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(HEADER_LABELS) as HeaderMode[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {HEADER_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs font-normal text-muted-foreground">Antenna Lane</Label>
              <Select
                value={settings.streamMode}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('streamMode', v as StreamMode);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{STREAM_LABELS[settings.streamMode]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(STREAM_LABELS) as StreamMode[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {STREAM_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label htmlFor="inp-fs" className="text-xs font-normal text-muted-foreground">
                Sample Rate
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="inp-fs"
                  type="number"
                  min={0.1}
                  max={640}
                  step="any"
                  value={settings.fsMhz}
                  onChange={(e) => engine.setRfScale('fsMhz', parseFloat(e.target.value))}
                  className="h-7 font-mono text-xs tabular-nums"
                />
                <span className="font-mono text-[11px] text-muted-foreground shrink-0">MHz</span>
              </div>

              <Label htmlFor="inp-lo" className="text-xs font-normal text-muted-foreground">
                Center Freq
              </Label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="inp-lo"
                  type="number"
                  min={0}
                  max={7500}
                  step={0.5}
                  value={settings.loMhz}
                  onChange={(e) => engine.setRfScale('loMhz', parseFloat(e.target.value))}
                  className="h-7 font-mono text-xs tabular-nums"
                />
                <span className="font-mono text-[11px] text-muted-foreground shrink-0">MHz</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-0.5">
              <SwitchItem
                id="sw-swap-iq"
                label="Swap I/Q"
                checked={settings.swapIQ}
                onCheckedChange={(c) => engine.setDspOption('swapIQ', c)}
              />
              <SwitchItem
                id="sw-dc-remove"
                label="DC Remove"
                checked={settings.dcRemove}
                onCheckedChange={(c) => engine.setDspOption('dcRemove', c)}
              />
            </div>

            <div className="flex items-center justify-between gap-2 pt-0.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.syncHwRf()}
              >
                <RefreshCw className="size-3" />
                Sync HW Fs / LO
              </Button>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground leading-snug">
              {snapshot.rfSummaryText}
            </p>
          </SidebarSection>

          {/* 3. FFT & Plot Display */}
          <SidebarSection title="FFT & Plot Display" defaultOpen>
            <div className="grid grid-cols-[84px_minmax(0,1fr)] items-center gap-2">
              <Label className="text-xs font-normal text-muted-foreground">FFT Size</Label>
              <Select
                value={String(settings.fftSize)}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('fftSize', parseInt(v, 10));
                }}
              >
                <SelectTrigger size="sm" className="w-full font-mono text-xs tabular-nums">
                  <SelectValue>{settings.fftSize}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {FFT_SIZES.map((sz) => (
                    <SelectItem key={sz} value={String(sz)} className="font-mono text-xs tabular-nums">
                      {sz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs font-normal text-muted-foreground">Window</Label>
              <Select
                value={settings.window}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('window', v as WindowKind);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{WINDOW_LABELS[settings.window]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(WINDOW_LABELS) as WindowKind[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {WINDOW_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs font-normal text-muted-foreground">Detector</Label>
              <Select
                value={settings.detector}
                onValueChange={(v) => {
                  if (v) engine.setDspOption('detector', v as DetectorKind);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{DETECTOR_LABELS[settings.detector]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DETECTOR_LABELS) as DetectorKind[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {DETECTOR_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Label className="text-xs font-normal text-muted-foreground">Colormap</Label>
              <Select
                value={settings.palette}
                onValueChange={(v) => {
                  if (v) engine.setDisplayOption('palette', v as PaletteName);
                }}
              >
                <SelectTrigger size="sm" className="w-full text-xs">
                  <SelectValue>{PALETTE_LABELS[settings.palette]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PALETTE_LABELS) as PaletteName[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">
                      {PALETTE_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div
              className="h-2 rounded border"
              style={{ background: getPaletteCssGradient(settings.palette) }}
            />

            <div className="space-y-2 pt-0.5">
              <SliderRow
                label="EMA Smooth"
                value={settings.ema}
                min={0}
                max={0.9}
                step={0.05}
                display={settings.ema.toFixed(2)}
                onChange={(v) => engine.setDisplayOption('ema', v)}
              />
              <SliderRow
                label="Floor (dB)"
                value={settings.dbMin}
                min={-130}
                max={-20}
                step={2}
                display={String(settings.dbMin)}
                onChange={(v) => engine.setDisplayOption('dbMin', v)}
              />
              <SliderRow
                label="Ceiling (dB)"
                value={settings.dbMax}
                min={-60}
                max={10}
                step={2}
                display={String(settings.dbMax)}
                onChange={(v) => engine.setDisplayOption('dbMax', v)}
              />
              <SliderRow
                label="Contrast"
                value={settings.wfContrast}
                min={-40}
                max={40}
                step={2}
                display={String(settings.wfContrast)}
                onChange={(v) => engine.setDisplayOption('wfContrast', v)}
              />
              <SliderRow
                label="Persistence"
                value={settings.constPersist}
                min={0}
                max={0.9}
                step={0.05}
                display={settings.constPersist.toFixed(2)}
                onChange={(v) => engine.setDisplayOption('constPersist', v)}
              />
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 pt-1">
              <SwitchItem
                id="sw-fill"
                label="Spectrum Fill"
                checked={settings.showFill}
                onCheckedChange={(c) => engine.setDisplayOption('showFill', c)}
              />
              <SwitchItem
                id="sw-peak"
                label="Peak Hold"
                checked={settings.showPeakHold}
                onCheckedChange={(c) => engine.setDisplayOption('showPeakHold', c)}
              />
              <SwitchItem
                id="sw-env"
                label="Envelope |z|"
                checked={settings.showEnvelope}
                onCheckedChange={(c) => engine.setDisplayOption('showEnvelope', c)}
              />
              <SwitchItem
                id="sw-autoscale"
                label="Auto Time Y"
                checked={settings.autoTimeScale}
                onCheckedChange={(c) => engine.setDisplayOption('autoTimeScale', c)}
              />
            </div>

            <div className="flex flex-wrap gap-1.5 pt-1">
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.autoDbRange()}
              >
                Auto dB
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.resetZoom()}
              >
                <RotateCcw className="size-3" />
                Reset Zoom
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.clearWaterfallAndPeak()}
              >
                <Trash2 className="size-3" />
                Clear WF/Peak
              </Button>
            </div>
          </SidebarSection>

          {/* 4. Bluetooth Advertising Decoder */}
          <SidebarSection title="Bluetooth Advertising Decoder (BLE 2.4G)" defaultOpen={false}>
            <SwitchItem
              id="sw-ble-enable"
              label="Enable Live BLE Decoding"
              checked={settings.bleEnabled}
              onCheckedChange={(c) => engine.setBleEnabled(c, { keepPane: !c })}
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.applyBlePreset()}
              >
                BLE Preset (Node 6)
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => engine.clearBleRecords()}
              >
                Clear Records
              </Button>
            </div>
            <p className="font-mono text-[11px] text-muted-foreground leading-snug">
              {snapshot.bleStatusNote}
            </p>
            {topBleDevices.length > 0 && (
              <div className="space-y-1 max-h-36 overflow-y-auto font-mono text-[11px]">
                {topBleDevices.map((d) => (
                  <div
                    key={`${d.mac}-${d.ch}-${d.pduName}`}
                    className="rounded-md border bg-muted/40 px-2 py-1"
                  >
                    <div className="flex justify-between gap-2 text-foreground">
                      <span className="truncate">
                        {d.mac}
                        {d.devName ? ` ${d.devName}` : ''}
                      </span>
                      <span className="shrink-0 tabular-nums font-medium">
                        {d.bestRssi.toFixed(1)}dB ×{d.count}
                      </span>
                    </div>
                    <div className="truncate text-muted-foreground">
                      Ch{d.ch} {d.pduName} len={d.pduLen}
                      {d.advSummary ? ` · ${d.advSummary}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SidebarSection>

          {/* 5. IQ Quality & Hardware Stats */}
          <SidebarSection title="IQ Quality & Hardware Stats" defaultOpen>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] tabular-nums">
              <dt className="text-muted-foreground">Samples</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.count} (${snapshot.statsBits}b)` : '0'}
              </dd>

              <dt className="text-muted-foreground">Non-Zero</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.nonzero}/${stats.count} (${stats.nonzeroPct.toFixed(1)}%)` : '-'}
              </dd>

              <dt className="text-muted-foreground">Transitions</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.transitionPct.toFixed(1)}%` : '-'}
              </dd>

              <dt className="text-muted-foreground">I Range</dt>
              <dd className="text-right text-foreground">
                {stats ? `[${fmtVal(stats.minI)} .. ${fmtVal(stats.maxI)}]` : '-'}
              </dd>

              <dt className="text-muted-foreground">Q Range</dt>
              <dd className="text-right text-foreground">
                {stats ? `[${fmtVal(stats.minQ)} .. ${fmtVal(stats.maxQ)}]` : '-'}
              </dd>

              <dt className="text-muted-foreground">DC (I / Q)</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.meanI.toFixed(2)} / ${stats.meanQ.toFixed(2)}` : '-'}
              </dd>

              <dt className="text-muted-foreground">RMS (I / Q)</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.rmsI.toFixed(1)} / ${stats.rmsQ.toFixed(1)}` : '-'}
              </dd>

              <dt className="text-muted-foreground">Power / PAPR</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.rmsDbfs.toFixed(1)} dBFS / ${stats.paprDb.toFixed(1)} dB` : '-'}
              </dd>

              <dt className="text-muted-foreground">Clip / |ac1|</dt>
              <dd className="text-right text-foreground">
                {stats ? `${stats.clipCount} / ${stats.ac1Mag.toFixed(3)}` : '-'}
              </dd>
            </dl>

            <pre className="mt-2 rounded-md border bg-muted/50 p-2 font-mono text-[10.5px] leading-relaxed text-foreground overflow-x-auto tabular-nums">
              {snapshot.hexPreview}
            </pre>
          </SidebarSection>
        </div>
      </ScrollArea>
    </aside>
  );
};
