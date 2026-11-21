/* SPDX-License-Identifier: MIT */
import * as React from 'react';
import {
  Download,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
  Sun,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type {
  CaptureMode,
  PaneName,
  SdrEngine,
  SdrTelemetrySnapshot,
  SourceKind,
} from '@/src/sdr/engine';

const SOURCE_LABELS: Record<SourceKind, string> = {
  ws: 'Direct Router (WS)',
  http: 'Direct Router (HTTP)',
  file: 'Local File Playback',
  synthetic: 'Synthetic Generator',
};

const NODE_PRESET_LABELS: Record<string, string> = {
  '15': '15 · ADC WF1/0 (12b)',
  '6': '6 · RXFD WF1/0 (14b)',
  '8': '8 · RXFE/WF2 (14b)',
  custom: 'Custom',
};

const LEN_OPTIONS = [1024, 2048, 4096, 8192, 16384];
const BW_OPTIONS: Array<{ idx: number; label: string; shortLabel: string }> = [
  { idx: 0, label: '0 · 20 MHz', shortLabel: '0·20M' },
  { idx: 1, label: '1 · 40 MHz', shortLabel: '1·40M' },
  { idx: 2, label: '2 · 80 MHz (5G)', shortLabel: '2·80M' },
  { idx: 3, label: '3 · 160 MHz (5G)', shortLabel: '3·160M' },
];
const FPS_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Unlimited' },
  { value: 400, label: '400 Hz' },
  { value: 200, label: '200 Hz' },
  { value: 120, label: '120 Hz' },
  { value: 60, label: '60 Hz' },
  { value: 30, label: '30 Hz' },
  { value: 20, label: '20 Hz' },
  { value: 15, label: '15 Hz' },
  { value: 10, label: '10 Hz' },
  { value: 5, label: '5 Hz' },
  { value: 2, label: '2 Hz' },
  { value: 1, label: '1 Hz' },
];

const PANE_ITEMS: Array<{ id: PaneName; label: string }> = [
  { id: 'spectrum', label: 'Spectrum' },
  { id: 'waterfall', label: 'Waterfall' },
  { id: 'time', label: 'Time' },
  { id: 'constellation', label: 'Constellation' },
  { id: 'ble', label: 'BLE' },
];

interface TopToolbarProps {
  engine: SdrEngine;
  snapshot: SdrTelemetrySnapshot;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}

export const TopToolbar: React.FC<TopToolbarProps> = ({
  engine,
  snapshot,
  sidebarOpen,
  onToggleSidebar,
  theme,
  onToggleTheme,
}) => {
  const { settings, streaming } = snapshot;
  const nodePresetVal =
    settings.node === 15 || settings.node === 6 || settings.node === 8
      ? String(settings.node)
      : 'custom';

  const activePaneValues = (Object.keys(settings.panes) as PaneName[]).filter(
    (k) => settings.panes[k]
  );

  const fpsLabel =
    FPS_OPTIONS.find((o) => o.value === settings.fpsLimit)?.label ?? 'Unlimited';

  const connColorClass =
    snapshot.connKind === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : snapshot.connKind === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : snapshot.connKind === 'err'
          ? 'text-destructive'
          : 'text-muted-foreground';

  const connDotClass =
    snapshot.connKind === 'ok'
      ? 'bg-emerald-500'
      : snapshot.connKind === 'warn'
        ? 'bg-amber-500'
        : snapshot.connKind === 'err'
          ? 'bg-destructive'
          : 'bg-muted-foreground/60';

  const fwColorClass =
    snapshot.fwKind === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : snapshot.fwKind === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';

  const tickColorClass =
    snapshot.tickKind === 'ok'
      ? 'text-emerald-600 dark:text-emerald-400'
      : snapshot.tickKind === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-muted-foreground';

  return (
    <header className="flex flex-none flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-background px-3 py-2">
      {/* Sidebar toggle + Brand */}
      <div className="flex items-center gap-2 pr-2 border-r">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onToggleSidebar}
                aria-label={sidebarOpen ? 'Collapse Sidebar' : 'Expand Sidebar'}
              >
                {sidebarOpen ? (
                  <PanelLeftClose className="size-4" />
                ) : (
                  <PanelLeftOpen className="size-4" />
                )}
              </Button>
            }
          />
          <TooltipContent side="bottom">Toggle sidebar</TooltipContent>
        </Tooltip>

        <span className="text-sm font-semibold tracking-tight text-foreground whitespace-nowrap shrink-0">
          CT3003 IQ
        </span>
      </div>

      {/* Source Select */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Source</span>
        <Select
          value={settings.source}
          onValueChange={(v) => {
            if (v) engine.setSource(v as SourceKind);
          }}
        >
          <SelectTrigger size="sm" className="min-w-[148px] text-xs">
            <SelectValue>{SOURCE_LABELS[settings.source]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {(Object.keys(SOURCE_LABELS) as SourceKind[]).map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {SOURCE_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Primary Stream Action + One-Shot */}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant={streaming ? 'destructive' : 'default'}
          onClick={() => engine.toggleStreaming()}
        >
          {streaming ? (
            <>
              <Square className="size-3 fill-current" />
              Stop Streaming
            </>
          ) : (
            <>
              <Play className="size-3 fill-current" />
              Start Streaming
            </>
          )}
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => engine.triggerOneshot()}
        >
          <Zap className="size-3.5" />
          One-Shot
        </Button>
      </div>

      <Separator orientation="vertical" className="h-5 hidden xl:block" />

      {/* Band Switch (2.4G / 5G) */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Band</span>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          value={[String(settings.band)]}
          onValueChange={(vals) => {
            const next = vals[vals.length - 1];
            if (next === '0' || next === '1') {
              engine.setBand(next === '1' ? 1 : 0);
            }
          }}
        >
          <ToggleGroupItem value="0" className="font-mono text-xs">
            2.4G
          </ToggleGroupItem>
          <ToggleGroupItem value="1" className="font-mono text-xs">
            5G
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Node Preset + Number */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Node</span>
        <Select
          value={nodePresetVal}
          onValueChange={(v) => {
            if (!v || v === 'custom') return;
            engine.setNode(parseInt(v, 10), true);
          }}
        >
          <SelectTrigger size="sm" className="w-[152px] font-mono text-xs">
            <SelectValue>{NODE_PRESET_LABELS[nodePresetVal]}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {Object.entries(NODE_PRESET_LABELS).map(([k, lbl]) => (
              <SelectItem key={k} value={k} className="font-mono text-xs">
                {lbl}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          min={0}
          max={63}
          value={settings.node}
          onChange={(e) => engine.setNode(parseInt(e.target.value, 10))}
          aria-label="ICAP Node Index"
          className="h-7 w-14 px-2 font-mono text-xs tabular-nums"
        />
      </div>

      {/* Words */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Words</span>
        <Select
          value={String(settings.len)}
          onValueChange={(v) => {
            if (v) engine.setCaptureOption('len', parseInt(v, 10));
          }}
        >
          <SelectTrigger size="sm" className="w-[78px] font-mono text-xs tabular-nums">
            <SelectValue>{settings.len}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LEN_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)} className="font-mono text-xs tabular-nums">
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Mode */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Mode</span>
        <Select
          value={settings.mode}
          onValueChange={(v) => {
            if (v) engine.setCaptureOption('mode', v as CaptureMode);
          }}
        >
          <SelectTrigger size="sm" className="w-[76px] text-xs">
            <SelectValue>{settings.mode === 'api' ? 'API' : 'Direct'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="api" className="text-xs">
              API
            </SelectItem>
            <SelectItem value="direct" className="text-xs">
              Direct
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* BW */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">BW</span>
        <Select
          value={String(settings.bw)}
          onValueChange={(v) => {
            if (v !== null) engine.setCaptureOption('bw', parseInt(v, 10));
          }}
        >
          <SelectTrigger size="sm" className="w-[78px] font-mono text-xs tabular-nums">
            <SelectValue>
              {BW_OPTIONS[settings.bw]?.shortLabel ?? String(settings.bw)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {BW_OPTIONS.map((b) => (
              <SelectItem
                key={b.idx}
                value={String(b.idx)}
                disabled={settings.band === 0 && b.idx > 1}
                className="font-mono text-xs"
              >
                {b.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* FPS Limit */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground whitespace-nowrap">FPS</span>
        <Select
          value={String(settings.fpsLimit)}
          onValueChange={(v) => {
            if (v !== null) engine.setFpsLimit(parseInt(v, 10));
          }}
        >
          <SelectTrigger size="sm" className="w-[96px] font-mono text-xs tabular-nums">
            <SelectValue>{fpsLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {FPS_OPTIONS.map((opt) => (
              <SelectItem
                key={opt.value}
                value={String(opt.value)}
                className="font-mono text-xs tabular-nums"
              >
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Save .bin */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="sm"
              variant="outline"
              onClick={() => engine.downloadBin()}
            >
              <Download className="size-3.5" />
              Save .bin
            </Button>
          }
        />
        <TooltipContent side="bottom">Export current raw IQ buffer as .bin</TooltipContent>
      </Tooltip>

      {/* Pane Visibility Toggles */}
      <ToggleGroup
        multiple
        variant="outline"
        size="sm"
        spacing={0}
        value={activePaneValues}
        onValueChange={(vals) => {
          const nextSet = new Set(vals);
          for (const item of PANE_ITEMS) {
            const shouldBeOn = nextSet.has(item.id);
            if (shouldBeOn !== settings.panes[item.id]) {
              engine.setPaneVisible(item.id, shouldBeOn);
            }
          }
        }}
        aria-label="Pane Visibility Toggles"
      >
        {PANE_ITEMS.map((item) => (
          <ToggleGroupItem key={item.id} value={item.id} className="text-xs">
            {item.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {/* Unboxed Live Telemetry Strip + Theme Toggle */}
      <div className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs tabular-nums">
        <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${connColorClass}`}>
          <span className={`size-1.5 rounded-full ${connDotClass}`} aria-hidden="true" />
          {snapshot.connText}
        </span>
        <span className="text-muted-foreground/50" aria-hidden="true">·</span>
        <span className={`whitespace-nowrap ${fwColorClass}`}>{snapshot.fwText}</span>
        <span className="text-muted-foreground/50" aria-hidden="true">·</span>
        <span className={`whitespace-nowrap ${tickColorClass}`}>{snapshot.tickText}</span>
        <span className="text-muted-foreground/50" aria-hidden="true">·</span>
        <span className="text-muted-foreground whitespace-nowrap">{snapshot.crText}</span>
        <span className="text-muted-foreground/50" aria-hidden="true">·</span>
        <span
          className="text-foreground font-medium whitespace-nowrap"
          title={snapshot.fpsTitle}
        >
          {snapshot.fpsText}
        </span>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                onClick={onToggleTheme}
                aria-label="Toggle Light / Dark Theme"
                className="ml-1"
              >
                {theme === 'dark' ? (
                  <Sun className="size-3.5" />
                ) : (
                  <Moon className="size-3.5" />
                )}
              </Button>
            }
          />
          <TooltipContent side="bottom">
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
};
