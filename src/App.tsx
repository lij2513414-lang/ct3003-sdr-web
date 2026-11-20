/* SPDX-License-Identifier: MIT */
import * as React from 'react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ControlSidebar } from '@/src/components/sdr/ControlSidebar';
import { PlotsGrid } from '@/src/components/sdr/PlotsGrid';
import { TopToolbar } from '@/src/components/sdr/TopToolbar';
import { SdrEngine, type SdrTelemetrySnapshot } from '@/src/sdr/engine';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = React.useState(true);
  const [dragOver, setDragOver] = React.useState(false);
  const [theme, setTheme] = React.useState<'light' | 'dark'>('dark');

  const engineRef = React.useRef<SdrEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SdrEngine(
      (snap) => {
        setSnapshot(snap);
      },
      (msg, level = 'info') => {
        if (level === 'error') toast.error(msg);
        else if (level === 'warning') toast.warning(msg);
        else if (level === 'success') toast.success(msg);
        else toast.info(msg);
      }
    );
  }
  const engine = engineRef.current;

  const [snapshot, setSnapshot] = React.useState<SdrTelemetrySnapshot>(() =>
    engine.getSnapshot()
  );

  // Sync `.dark` class and native color-scheme on <html> for shadcn/ui Dark & Light mode
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  React.useEffect(() => {
    engine.init();
    const onBeforeUnload = () => engine.destroy();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      engine.destroy();
    };
  }, [engine]);

  React.useEffect(() => {
    const t = setTimeout(() => engine.scheduleRedraw(), 24);
    return () => clearTimeout(t);
  }, [engine, sidebarOpen]);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        engine.toggleStreaming();
      } else if (e.key === 'r' || e.key === 'R') {
        engine.resetZoom();
      } else if (e.key === 'm' || e.key === 'M') {
        engine.clearWaterfallAndPeak();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engine]);

  React.useEffect(() => {
    let dragCounter = 0;
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      setDragOver(true);
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDragLeave = () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) setDragOver(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        engine.loadFileObject(file);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [engine]);

  return (
    <TooltipProvider delay={250}>
      <div className="flex h-full flex-col bg-background text-foreground overflow-hidden max-[1040px]:overflow-auto">
        <TopToolbar
          engine={engine}
          snapshot={snapshot}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((prev) => !prev)}
          theme={theme}
          onToggleTheme={() => setTheme((prev) => (prev === 'light' ? 'dark' : 'light'))}
        />

        <div className="flex flex-1 min-h-0 max-[1040px]:flex-col">
          <ControlSidebar
            engine={engine}
            snapshot={snapshot}
            open={sidebarOpen}
          />
          <PlotsGrid engine={engine} snapshot={snapshot} />
        </div>

        {dragOver && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/85 border-2 border-dashed border-primary pointer-events-none">
            <p className="text-base font-semibold text-foreground">
              Drop IQ binary file to load (.bin / .s16le / .s32le / .cf32)
            </p>
          </div>
        )}

        <Toaster position="bottom-right" theme={theme} />
      </div>
    </TooltipProvider>
  );
}
