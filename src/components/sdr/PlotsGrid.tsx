/* SPDX-License-Identifier: MIT */
import * as React from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  CanvasRefs,
  PaneName,
  SdrEngine,
  SdrTelemetrySnapshot,
} from '@/src/sdr/engine';

const TIME_WINDOWS = [128, 256, 512, 1024, 2048, 8192];
const CONST_GAINS = [1, 2, 4, 8];

interface PlotsGridProps {
  engine: SdrEngine;
  snapshot: SdrTelemetrySnapshot;
}

export const PlotsGrid: React.FC<PlotsGridProps> = ({ engine, snapshot }) => {
  const { settings } = snapshot;
  const [maximizedPane, setMaximizedPane] = React.useState<PaneName | null>(null);

  const gridRef = React.useRef<HTMLElement | null>(null);
  const cvSpectrumRef = React.useRef<HTMLCanvasElement | null>(null);
  const cvWaterfallRef = React.useRef<HTMLCanvasElement | null>(null);
  const cvTimeRef = React.useRef<HTMLCanvasElement | null>(null);
  const cvConstRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const refs: CanvasRefs = {
      spectrum: cvSpectrumRef.current,
      waterfall: cvWaterfallRef.current,
      time: cvTimeRef.current,
      constellation: cvConstRef.current,
    };
    engine.attachCanvases(refs, gridRef.current);
  }, [engine]);

  React.useEffect(() => {
    if (maximizedPane && !settings.panes[maximizedPane]) {
      setMaximizedPane(null);
    }
  }, [maximizedPane, settings.panes]);

  React.useEffect(() => {
    const t = setTimeout(() => engine.scheduleRedraw(), 20);
    return () => clearTimeout(t);
  }, [
    engine,
    maximizedPane,
    settings.panes.spectrum,
    settings.panes.waterfall,
    settings.panes.time,
    settings.panes.constellation,
    settings.panes.ble,
  ]);

  const orderedPanes: PaneName[] = ['spectrum', 'time', 'waterfall', 'constellation', 'ble'];
  const visiblePanes = orderedPanes.filter((p) => settings.panes[p]);
  const visibleCount = visiblePanes.length;
  const onlyFreqPair =
    visibleCount === 2 && settings.panes.spectrum && settings.panes.waterfall;

  const firstVisibleForSpanTall = visibleCount === 3 ? visiblePanes[0] : null;

  let gridLayoutClass = 'grid-cols-[1.28fr_1fr] grid-rows-2';
  if (maximizedPane) {
    gridLayoutClass = 'grid-cols-1 grid-rows-1';
  } else if (visibleCount === 0 || visibleCount === 1) {
    gridLayoutClass = 'grid-cols-1 grid-rows-1';
  } else if (visibleCount === 2) {
    gridLayoutClass = onlyFreqPair
      ? 'grid-cols-1 grid-rows-[1fr_1.12fr]'
      : 'grid-cols-2 grid-rows-1';
  } else if (visibleCount === 3) {
    gridLayoutClass = 'grid-cols-[1.22fr_1fr] grid-rows-2';
  } else if (visibleCount === 5) {
    gridLayoutClass = 'grid-cols-2 grid-rows-[1fr_1fr_0.95fr]';
  }

  const toggleMaximize = (pane: PaneName) => {
    setMaximizedPane((prev) => (prev === pane ? null : pane));
  };

  const isPaneShown = (pane: PaneName) => {
    if (!settings.panes[pane]) return false;
    if (maximizedPane && maximizedPane !== pane) return false;
    return true;
  };

  const renderCardHeader = (
    pane: PaneName,
    title: string,
    meta: string,
    extraActions?: React.ReactNode
  ) => {
    const isMax = maximizedPane === pane;
    return (
      <div className="flex flex-none items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5 min-w-0">
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <span className="text-xs font-semibold text-foreground whitespace-nowrap">
            {title}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground truncate">
            {meta}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {extraActions}
          <Button
            size="xs"
            variant="outline"
            onClick={() => toggleMaximize(pane)}
            title={isMax ? 'Restore layout' : 'Maximize pane'}
          >
            {isMax ? (
              <>
                <Minimize2 className="size-3" />
                Restore
              </>
            ) : (
              <>
                <Maximize2 className="size-3" />
                Max
              </>
            )}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => engine.setPaneVisible(pane, false)}
            aria-label={`Close ${title}`}
            title="Close Pane"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  };

  return (
    <main
      ref={gridRef}
      className={`flex-1 min-w-0 min-h-0 grid gap-2.5 p-2.5 bg-muted/20 max-[1040px]:grid-cols-1 max-[1040px]:grid-rows-[repeat(4,300px)] max-[1040px]:min-h-[1240px] ${gridLayoutClass}`}
    >
      {/* 1. Live Spectrum FFT */}
      <section
        hidden={!isPaneShown('spectrum')}
        className={`flex flex-col min-w-0 min-h-0 rounded-lg border bg-card text-card-foreground shadow-xs overflow-hidden ${
          !maximizedPane && firstVisibleForSpanTall === 'spectrum' ? 'row-span-2' : ''
        }`}
      >
        {renderCardHeader(
          'spectrum',
          '1. Live Spectrum FFT',
          snapshot.metaSpectrum,
          <span
            className="hidden sm:inline font-mono text-[11px] text-muted-foreground whitespace-nowrap"
            title="Wheel zoom / Drag pan / Click marker / Double-click reset"
          >
            Wheel Zoom
          </span>
        )}
        <div className="relative flex-1 min-w-0 min-h-0 bg-[#09090b]">
          <canvas
            ref={cvSpectrumRef}
            className="absolute inset-0 block w-full h-full cursor-crosshair"
          />
        </div>
      </section>

      {/* 3. Time Domain */}
      <section
        hidden={!isPaneShown('time')}
        className={`flex flex-col min-w-0 min-h-0 rounded-lg border bg-card text-card-foreground shadow-xs overflow-hidden ${
          !maximizedPane && firstVisibleForSpanTall === 'time' ? 'row-span-2' : ''
        }`}
      >
        {renderCardHeader(
          'time',
          '3. Time Domain',
          snapshot.metaTime,
          <>
            <Select
              value={String(settings.timeWindow)}
              onValueChange={(v) => {
                if (v) engine.setTimeWindow(parseInt(v, 10));
              }}
            >
              <SelectTrigger
                size="sm"
                className="h-6 w-[68px] font-mono text-xs tabular-nums"
              >
                <SelectValue>{settings.timeWindow}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {TIME_WINDOWS.map((w) => (
                  <SelectItem key={w} value={String(w)} className="font-mono text-xs tabular-nums">
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="w-20 flex items-center" title="Time sample offset">
              <Slider
                value={[settings.timeOffset]}
                min={0}
                max={Math.max(1, snapshot.timeMaxOffset)}
                step={1}
                disabled={snapshot.timeMaxOffset <= 0}
                onValueChange={(v) => {
                  const num = Array.isArray(v) ? v[0] : v;
                  if (typeof num === 'number') engine.setTimeOffset(num);
                }}
              />
            </div>
          </>
        )}
        <div className="relative flex-1 min-w-0 min-h-0 bg-[#09090b]">
          <canvas
            ref={cvTimeRef}
            className="absolute inset-0 block w-full h-full cursor-crosshair"
          />
        </div>
      </section>

      {/* 2. Waterfall */}
      <section
        hidden={!isPaneShown('waterfall')}
        className={`flex flex-col min-w-0 min-h-0 rounded-lg border bg-card text-card-foreground shadow-xs overflow-hidden ${
          !maximizedPane && firstVisibleForSpanTall === 'waterfall' ? 'row-span-2' : ''
        }`}
      >
        {renderCardHeader(
          'waterfall',
          '2. Waterfall',
          snapshot.metaWaterfall,
          <span className="hidden sm:inline font-mono text-[11px] text-muted-foreground whitespace-nowrap">
            Linked to FFT X-axis
          </span>
        )}
        <div className="relative flex-1 min-w-0 min-h-0 bg-[#09090b]">
          <canvas
            ref={cvWaterfallRef}
            className="absolute inset-0 block w-full h-full cursor-crosshair"
          />
        </div>
      </section>

      {/* 4. I/Q Constellation */}
      <section
        hidden={!isPaneShown('constellation')}
        className={`flex flex-col min-w-0 min-h-0 rounded-lg border bg-card text-card-foreground shadow-xs overflow-hidden ${
          !maximizedPane && firstVisibleForSpanTall === 'constellation' ? 'row-span-2' : ''
        }`}
      >
        {renderCardHeader(
          'constellation',
          '4. I/Q Constellation',
          snapshot.metaConst,
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-muted-foreground">Gain</span>
            <Select
              value={String(settings.constGain)}
              onValueChange={(v) => {
                if (v) engine.setDisplayOption('constGain', parseFloat(v));
              }}
            >
              <SelectTrigger size="sm" className="h-6 w-[58px] font-mono text-xs">
                <SelectValue>{settings.constGain}×</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CONST_GAINS.map((g) => (
                  <SelectItem key={g} value={String(g)} className="font-mono text-xs">
                    {g}×
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="relative flex-1 min-w-0 min-h-0 bg-[#09090b]">
          <canvas
            ref={cvConstRef}
            className="absolute inset-0 block w-full h-full cursor-crosshair"
          />
        </div>
      </section>

      {/* 5. BLE Advertising Decoder */}
      <section
        hidden={!isPaneShown('ble')}
        className={`flex flex-col min-w-0 min-h-0 rounded-lg border bg-card text-card-foreground shadow-xs overflow-hidden ${
          !maximizedPane && visibleCount === 5 ? 'col-span-2' : ''
        } ${!maximizedPane && firstVisibleForSpanTall === 'ble' ? 'row-span-2' : ''}`}
      >
        {renderCardHeader(
          'ble',
          '5. BLE Advertising Decoder (BLE 1M)',
          snapshot.metaBle,
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => engine.applyBlePreset()}
              className="font-mono"
            >
              Node 6 / 16384
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => engine.clearBleRecords()}
            >
              Clear
            </Button>
          </>
        )}
        <div className="flex-1 min-h-0 grid grid-cols-[1.65fr_1fr] gap-2 p-2 bg-muted/20 max-lg:grid-cols-1">
          <div className="min-w-0 min-h-0 rounded-md border bg-card overflow-auto">
            <Table className="font-mono text-xs tabular-nums">
              <TableHeader className="sticky top-0 bg-muted/80 backdrop-blur-xs z-10">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-8 px-2 text-xs">MAC / ID</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Ch</TableHead>
                  <TableHead className="h-8 px-2 text-xs">PDU Type</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Len</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Hits</TableHead>
                  <TableHead className="h-8 px-2 text-xs">RSSI</TableHead>
                  <TableHead className="h-8 px-2 text-xs">CFO</TableHead>
                  <TableHead className="h-8 px-2 text-xs">CRC24</TableHead>
                  <TableHead className="h-8 px-2 text-xs">
                    Decoded Info / Company / Hex Payload
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.bleDevices.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                      {settings.bleEnabled
                        ? 'Listening for BLE 1M advertising packets on 2.4 GHz (Ch 37/38/39)...'
                        : 'Enable Live BLE Decoding or apply Node 6 / 16384 preset to scan.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  snapshot.bleDevices.map((d) => {
                    const crcText =
                      d.crcState === true ? 'OK' : d.crcState === false ? 'FAIL' : 'TRUNC';
                    const crcCls =
                      d.crcState === true
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : d.crcState === false
                          ? 'text-destructive'
                          : 'text-muted-foreground';
                    const payloadStr =
                      [d.advSummary, d.dataHex ? 'hex:' + d.dataHex : '']
                        .filter(Boolean)
                        .join(' · ') || '-';
                    return (
                      <TableRow key={`${d.mac}|${d.ch}|${d.pduName}`}>
                        <TableCell className="py-1.5 px-2">
                          {d.mac} {d.txAdd ? '(R)' : '(P)'}
                        </TableCell>
                        <TableCell className="py-1.5 px-2">{d.ch}</TableCell>
                        <TableCell className="py-1.5 px-2">{d.pduName}</TableCell>
                        <TableCell className="py-1.5 px-2">{d.pduLen}</TableCell>
                        <TableCell className="py-1.5 px-2">{d.count}</TableCell>
                        <TableCell className="py-1.5 px-2">{d.bestRssi.toFixed(1)} dB</TableCell>
                        <TableCell className="py-1.5 px-2">
                          {d.lastCfo >= 0 ? '+' : ''}
                          {d.lastCfo.toFixed(1)}k
                        </TableCell>
                        <TableCell className={`py-1.5 px-2 font-semibold ${crcCls}`}>
                          {crcText}
                        </TableCell>
                        <TableCell className="py-1.5 px-2 whitespace-normal break-all text-muted-foreground max-w-[360px]">
                          {payloadStr}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className="min-w-0 min-h-0 flex flex-col rounded-md border bg-card overflow-hidden">
            <div className="flex-none border-b bg-muted/50 px-2.5 py-1.5 text-xs font-medium text-muted-foreground">
              Recent Advertising Packets
            </div>
            <ScrollArea className="flex-1 min-h-0">
              <div className="p-2 font-mono text-[11px] tabular-nums space-y-1">
                {snapshot.bleRecentPackets.length === 0 ? (
                  <p className="text-muted-foreground py-3 text-center">No packets captured yet.</p>
                ) : (
                  snapshot.bleRecentPackets.map((p, idx) => {
                    const crcTag =
                      p.crcOk === true ? 'CRC✓' : p.crcOk === false ? 'CRC✗' : 'trunc';
                    return (
                      <div key={`${p.seq}-${idx}`} className="truncate text-foreground">
                        [{p.time}] #{p.seq} Ch{p.ch} {p.pduName} {p.mac} {p.rssi.toFixed(1)}dB{' '}
                        {crcTag}
                        {p.summary ? ` | ${p.summary}` : ''}
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
      </section>

      {/* Empty State when all panes are hidden */}
      {visibleCount === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-card text-muted-foreground">
          <p className="text-sm">All plot panes are hidden</p>
          <Button size="sm" onClick={() => engine.restoreDefaultPanes()}>
            Restore All Panes
          </Button>
        </div>
      )}
    </main>
  );
};
