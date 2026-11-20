# CT3003 SDR IQ Stream Viewer

A high-performance Software-Defined Radio (SDR) IQ stream analyzer and offline playback web application built with **React 19, TypeScript, shadcn/ui, and a decoupled Canvas2D DSP engine**. Designed for inspecting **CT3003 (`MT7981B` + `MT7976CN`)** **2.4 GHz (Band 0 / PHY0)** and **5 GHz (Band 1 / PHY1)** ICAP captures in real time, with full support for synthetic signal generation and offline binary IQ file playback.

> **Architecture Highlight**: All high-frequency processing and rendering—zero-allocation `TypedArray` decoding pools, radix-2 FFT spectrum calculation, incremental `copyWithin` waterfall `ImageData` scrolling, offscreen persistence constellation rendering, multi-lane WebSocket ingestion, and BLE 1M advertising demodulation—run completely outside React's render cycle. The UI layer uses `shadcn/ui`'s default neutral dark theme (with Light/Dark mode switching) and receives throttled telemetry snapshots, delivering smooth high-FPS plotting alongside clean modern controls.

---

## Table of Contents

- [UI Showcase](#ui-showcase)
- [Key Features](#key-features)
- [Quick Start](#quick-start)
- [Usage Guide](#usage-guide)
  - [1. Top Toolbar](#1-top-toolbar)
  - [2. Left Control Sidebar](#2-left-control-sidebar)
  - [3. Plot Grid & Canvas Interactions](#3-plot-grid--canvas-interactions)
  - [4. BLE 1M Advertising Decoder Workflow](#4-ble-1m-advertising-decoder-workflow)
  - [5. Keyboard Shortcuts & URL Parameters](#5-keyboard-shortcuts--url-parameters)
- [Supported IQ Formats & Protocols](#supported-iq-formats--protocols)
- [Tech Stack & Project Structure](#tech-stack--project-structure)

---

## UI Showcase

> Tip: Save live screenshots of the running application as `docs/screenshot-dark.png` and `docs/screenshot-light.png`, then uncomment the image tags below to display them directly on your GitHub repository page.

<!-- Uncomment once screenshots are placed in docs/:
### Default Dark Theme (shadcn/ui Default Dark)
![CT3003 SDR IQ Stream Viewer - Dark Mode](docs/screenshot-dark.png)

### Light Theme
![CT3003 SDR IQ Stream Viewer - Light Mode](docs/screenshot-light.png)
-->

### Workspace Layout

The interface uses a three-zone desktop instrument layout in **shadcn/ui's default dark neutral theme**, with one-click Light/Dark theme switching in the top-right corner and automatic vertical stacking on narrower viewports:

```text
+--------------------------------------------------------------------------------------------------------+
| [☰] CT3003 IQ | Source | [▶ Start] [⚡ One-Shot] | Band [2.4G|5G] | Node | Words | Mode | BW | FPS    |
|               | [⬇ Save .bin] | Panes [Spectrum|Waterfall|Time|Constellation|BLE] | Telemetry · [☀/🌙] |
+----------------------+---------------------------------------------------------------------------------+
| Collapsible Sidebar  |                       Adaptive Multi-Pane Plot Grid                             |
|                      | +--------------------------------------+--------------------------------------+ |
| ▼ Source & Router    | | 1. Live Spectrum FFT   [Wheel Zoom]  | 3. Time Domain   [Window] [Offset]   | |
|   - Router URL       | |    Real-time FFT / Peak Hold / Marker|    I/Q waveforms + envelope |z|      | |
|   - Local File Load  | |                                      |    Hover readout: idx, I, Q, deg, hex| |
|   - Synth Presets    | +--------------------------------------+--------------------------------------+ |
|                      | | 2. Waterfall   [Linked to FFT X]     | 4. I/Q Constellation    [Gain 1x-8x] | |
| ▼ Format & RF Scale  | |    Time-frequency heatmap synced to  |    Polar I/Q scatter + persistence   | |
|   - Format/Hdr/Lane  | |    FFT X-axis (5 colormaps)          |    DC centroid crosshair indicator   | |
|   - Fs / LO HW Sync  | +--------------------------------------+--------------------------------------+ |
|                      | | 5. BLE Advertising Decoder (BLE 1M) [Optional, spans 2 columns in 5-pane mode]| |
| ▼ FFT & Plot Display | |    Left: Discovered devices table (MAC/Ch/PDU/Hits/RSSI/CFO/CRC24/Payload)   | |
|   - FFT/Win/Detector | |    Right: Recent Advertising Packets live capture log                         | |
|   - EMA/dB/Toggles   | +-----------------------------------------------------------------------------+ |
|                      |                                                                                 |
| ▶ BLE Decoder (2.4G) |                                                                                 |
| ▼ IQ Quality Stats   |                                                                                 |
|   - Metrics + Hex    |                                                                                 |
+----------------------+---------------------------------------------------------------------------------+
```

### Visualization Panes

| Pane | Primary Display | Key Capabilities |
| --- | --- | --- |
| **1. Live Spectrum FFT** | Complex FFT power spectrum (dBFS) with RF or baseband frequency axis | Mouse-wheel zoom, drag-to-pan, click-to-place frequency marker (exact frequency, level, peak delta), peak-hold trace, and spectrum fill |
| **2. Waterfall** | Scrolling time-frequency spectrogram | Pixel-level `ImageData` + `copyWithin` updates strictly linked to the Spectrum X-axis zoom/pan, with 5 colormaps and contrast control |
| **3. Time Domain** | Time-domain I/Q waveforms and instantaneous envelope `\|z\|` | Adjustable window (`128`–`8192` samples) and offset slider; crosshair hover displays sample index, exact I/Q values, phase angle, and raw 32-bit hex word |
| **4. I/Q Constellation** | Complex I/Q scatter plot | Offscreen canvas persistence decay, `1× / 2× / 4× / 8×` zoom gain, full-scale reference circles, and a red DC centroid crosshair |
| **5. BLE Advertising Decoder** | Live 2.4 GHz BLE 1M advertising demodulator (Ch 37 / 38 / 39) | Software GFSK demodulation, de-whitening, CRC-24 validation, aggregated device table (MAC, PDU type, RSSI, CFO, company/name/hex), and live packet feed |

---

## Key Features

- **High-FPS Decoupled Rendering**: DSP decoding and FFT pipelines reuse pre-allocated `TypedArray` pools to minimize GC pauses; Canvas2D rendering is scheduled independently via `requestAnimationFrame` with an optional FPS cap (`1–400 Hz` or `Unlimited`).
- **Four Data Sources**:
  - **Direct Router (WS)**: Connects directly to the CT3003 router (`wmsdr serve`) or bridge server over RFC 6455 WebSocket with multi-lane streaming.
  - **Direct Router (HTTP)**: Polls or single-captures binary frames over `/api/capture`.
  - **Local File Playback**: Load local binary IQ captures via file picker or drag-and-drop anywhere on the window, with slice scrubbing, continuous playback, and single-frame stepping.
  - **Synthetic Generator**: Built-in signal generator (`Wi-Fi OFDM Carriers`, `Multi-tone CW + Noise`, `QPSK Modulated Burst`, `Chirp Sweep`) so the entire UI works out of the box without hardware.
- **Adaptive Pane Management**: Toggle any of the 5 panes independently, maximize any pane full-screen (**Max / Restore**), or close panes (`×`) to automatically reflow the grid and reduce CPU/canvas workload at high frame rates.
- **shadcn/ui Default Design System**: Built on `shadcn/ui` neutral OKLCH tokens with default Dark mode, Light/Dark toggle, accessible selects, sliders, switches, collapsible sections, data tables, tooltips, and toast notifications.

---

## Quick Start

### Prerequisites

- **Node.js** `>= 18` (Node.js 20 recommended)
- **npm** (or `pnpm` / `bun`)

### 1. Install Dependencies & Start Development Server

```bash
npm install
npm run dev
```

Open `http://localhost:3000/` in your browser. When no hardware backend is reachable, the viewer automatically starts in **Synthetic Generator** mode so you can immediately explore live spectrum, waterfall, time-domain, and constellation plots.

### 2. Build for Production

```bash
npm run build
npm run preview
```

The static production bundle is emitted to `dist/` and can be hosted on any static web server, GitHub Pages, or directly inside the CT3003 router's `wmsdr serve` static directory.

### 3. Connect to a CT3003 Router (Live Hardware Mode)

1. Start the lightweight HTTP + WebSocket daemon (`wmsdr serve`) on the CT3003 router:
   ```sh
   insmod /root/wmtest/wm_sdr.ko
   start-stop-daemon -S -b -m -p /var/run/wmsdr.pid -x /root/wmtest/wmsdr -- serve 8088 /root/wmtest/web
   ```
2. In the left sidebar under **Source & Direct Router**:
   - Enter the router URL (e.g., `http://192.168.6.2:8088`) and press `Enter`, or click the **Direct 192.168.6.2:8088** quick button.
   - Switch **Source** in the top toolbar to `Direct Router (WS)` (or `Direct Router (HTTP)`) and click **Start Streaming**.
   - If the frontend is served directly from the router itself, click **Same Origin**.

---

## Usage Guide

### 1. Top Toolbar

| Control | Description |
| --- | --- |
| **Sidebar Toggle** | Collapse or expand the left control sidebar to maximize plot canvas area |
| **Source** | Switch between `Direct Router (WS)`, `Direct Router (HTTP)`, `Local File Playback`, and `Synthetic Generator` |
| **Start Streaming / Stop Streaming** | Start or stop continuous IQ capture or playback (`Space` shortcut) |
| **One-Shot** | Capture and inspect a single IQ frame |
| **Band (`2.4G` / `5G`)** | Switch CT3003 capture between Band 0 (PHY0, 2.4 GHz) and Band 1 (PHY1, 5 GHz), syncing hardware `LO` and `Fs` from `ChInfo` |
| **Node Preset & Index** | Select verified ICAP nodes (`15 · ADC WF1/0 (12b)`, `6 · RXFD WF1/0 (14b)`, `8 · RXFD WF2/0 (14b)`) or enter a custom node (`0–63`) |
| **Words** | Words captured per frame: `1024`, `2048`, `4096`, `8192`, or `16384` |
| **Mode** | Capture mode: `API` (recommended for continuous streaming) or `Direct` |
| **BW** | Hardware ICAP bandwidth index (`0`–`3`) |
| **FPS** | Cap UI rendering rate (`Unlimited` or `1 Hz`–`400 Hz`) |
| **Save .bin** | Download the currently displayed raw IQ buffer as a `.bin` file |
| **Pane Toggles** | Independently show or hide `Spectrum`, `Waterfall`, `Time`, `Constellation`, and `BLE` |
| **Telemetry & Theme Toggle** | Live connection indicator, firmware status (`FW`), hardware tick, `CR0`/`CR9` summary, live FPS counter, and Light/Dark theme toggle |

### 2. Left Control Sidebar

Organized into 5 collapsible sections:

1. **Source & Direct Router**
   - Configure **Router URL** with quick shortcuts (**Direct 192.168.6.2:8088**, **Same Origin**).
   - **Load Local IQ File**: Pick a file or **drag and drop** `.bin`, `.iq`, `.s16le`, `.cs16`, `.s32le`, `.cs32`, `.cf32`, `.fc32`, or `.raw` anywhere onto the page.
   - When a file is loaded, playback controls appear: **File Offset** slider, **Play File / Stop**, **Step Frame**, and **Status** refresh.
   - Choose **Synth Preset** (`Wi-Fi OFDM Carriers`, `Multi-tone CW + Noise`, `QPSK Modulated Burst`, `Chirp Sweep`) and **Interval (ms)**.
2. **Format & RF Scale**
   - **Format**: Choose IQ sample packing (`u32_12`, `u32_14`, `u32_16`, `s16le`, `s32le`, `cf32`).
   - **Header Strip**: Automatically or manually strip `WSIQ (32B)`, `ICAP (28B)`, or `IQUD (44B)` headers, or select `None (Raw)`.
   - **Antenna Lane**: Decode all words (`All Words`) or de-interleave hardware antenna chains (`WF0 Even w[0::2]` / `WF1 Odd w[1::2]`).
   - **Sample Rate (MHz)** & **Center Freq (MHz)**: Set manually or click **Sync HW Fs / LO** to pull live values from the router.
   - **Swap I/Q** & **DC Remove**: Invert spectral orientation or subtract frame DC offset.
3. **FFT & Plot Display**
   - Configure **FFT Size** (`512`–`8192`), **Window** (`Blackman-Harris`, `Hann`, `Hamming`, `Rectangular`), **Detector** (`Average` / `Peak`), and **Colormap** (`SDR#`, `Turbo`, `Viridis`, `Classic Blue`, `Grayscale`).
   - Adjust **EMA Smooth**, **Floor (dB)**, **Ceiling (dB)**, **Contrast**, and **Persistence** sliders.
   - Toggle **Spectrum Fill**, **Peak Hold**, **Envelope |z|**, and **Auto Time Y**.
   - Quick actions: **Auto dB**, **Reset Zoom**, and **Clear WF/Peak**.
4. **Bluetooth Advertising Decoder (BLE 2.4G)**
   - Toggle **Enable Live BLE Decoding**, apply **BLE Preset (Node 6)**, clear captured records, and inspect a compact list of the top 6 detected BLE advertisers.
5. **IQ Quality & Hardware Stats**
   - Live metrics for `Samples`, `Non-Zero`, `Transitions`, `I Range`, `Q Range`, `DC (I / Q)`, `RMS (I / Q)`, `Power / PAPR`, and `Clip / |ac1|`, followed by a raw hex word preview.

### 3. Plot Grid & Canvas Interactions

- **Live Spectrum FFT & Waterfall**:
  - **Mouse Wheel**: Zoom in/out centered on the cursor frequency (X-axis stays synchronized between Spectrum and Waterfall).
  - **Click & Drag**: Pan horizontally when zoomed in.
  - **Single Click**: Place or move the frequency marker to read exact frequency, power (dBFS), and delta from peak.
  - **Double Click**: Reset frequency zoom to full span.
- **Time Domain**:
  - Hover anywhere on the canvas for a vertical crosshair showing sample index, I/Q amplitudes, phase angle (`°`), and 32-bit hex word.
  - Use the header dropdown (`128`–`8192`) and offset slider to inspect specific segments of the captured frame.
- **I/Q Constellation**:
  - Switch **Gain** (`1×`, `2×`, `4×`, `8×`) in the card header to inspect low-amplitude signals.
- **Pane Controls**:
  - Click **Max** / **Restore** on any card to focus a single plot full-screen, or **×** to hide it.

### 4. BLE 1M Advertising Decoder Workflow

1. Ensure the band is set to **2.4G** (tuned across BLE advertising channels Ch 37 `2402 MHz`, Ch 38 `2426 MHz`, or Ch 39 `2480 MHz`).
2. Enable the **BLE** pane in the top toolbar (or expand **Bluetooth Advertising Decoder** in the sidebar).
3. Click **BLE Preset (Node 6)** / **Node 6 / 16384** to configure Node 6 at `40 Msps` with `16384` words and enable live decoding.
4. Click **Start Streaming** to populate the **BLE Advertising Decoder** table (MAC with Public `(P)` / Random `(R)` flag, channel, PDU type, hit count, RSSI, CFO, CRC-24 status, decoded device name/company/hex payload) and the live **Recent Advertising Packets** feed.

### 5. Keyboard Shortcuts & URL Parameters

#### Keyboard Shortcuts (when focus is not inside an input)

| Key | Action |
| --- | --- |
| `Space` | Start / Stop continuous streaming |
| `R` | Reset Spectrum & Waterfall frequency zoom |
| `M` | Clear Waterfall history and Peak Hold trace |

#### URL Query Parameters

Pre-configure the initial connection via URL query parameters:

```text
http://localhost:3000/?router=http://192.168.6.2:8088&band=0
```

- `router`: Target CT3003 router HTTP URL (switches to direct router mode automatically)
- `band`: Initial RF band (`0` = 2.4 GHz, `1` = 5 GHz)

---

## Supported IQ Formats & Protocols

### Binary IQ Formats

| Format Key | Description | Layout / Full Scale |
| --- | --- | --- |
| `u32_12` | CT3003 packed 32-bit word (default) | Little-endian `u32`: signed 12-bit I in `bits[11:0]`, signed 12-bit Q in `bits[27:16]` |
| `u32_14` | Packed 32-bit word (RXFD nodes) | Signed 14-bit I/Q packed per `u32` word |
| `u32_16` | Packed 32-bit word (16-bit) | Low 16-bit signed I, high 16-bit signed Q |
| `s16le` / `cs16` | Interleaved signed 16-bit integer | `[I0, Q0, I1, Q1, ...]` little-endian |
| `s32le` / `cs32` | Interleaved signed 32-bit integer | `[I0, Q0, I1, Q1, ...]` little-endian |
| `cf32` / `fc32` | Complex float32 (GNU Radio) | Interleaved IEEE 754 `float32` (`-1.0 .. +1.0`) |

Supported file extensions: `.bin`, `.iq`, `.s16le`, `.cs16`, `.s32le`, `.cs32`, `.cf32`, `.fc32`, `.raw`. With `Header Strip = Auto`, `WSIQ` (32 B), `ICAP` (28 B), and `IQUD` (44 B) headers are detected and stripped automatically.

### WebSocket Binary `WSIQ` Frame Format (`GET /ws`)

Each binary WebSocket frame starts with a 32-byte little-endian header (8 × `uint32`), immediately followed by `words × 4` bytes of raw IQ payload:

| Offset | Field | Description |
| --- | --- | --- |
| `0x00` | `magic` | `0x51495357` (`"WSIQ"` little-endian) |
| `0x04` | `version` | Protocol version (`1`) |
| `0x08` | `seq` | Monotonic frame sequence counter |
| `0x0C` | `node` | ICAP node index |
| `0x10` | `words` | Captured word count (`len`) |
| `0x14` | `cr0` | Hardware `CR0` register |
| `0x18` | `cr9` | Hardware `CR9` register |
| `0x1C` | `flags` | `bit0 = direct`, `bit1 = demo`, `bits[15:8] = bw & 0xff` |

---

## Tech Stack & Project Structure

### Tech Stack

- **Framework**: React 19, TypeScript, Vite 8
- **UI & Styling**: `shadcn/ui` (`@base-ui/react`), Tailwind CSS v4, Geist & JetBrains Mono typography, Lucide icons, Sonner toasts
- **Signal Processing & Rendering**: Pure TypeScript Canvas2D renderers + TypedArray DSP, FFT, and BLE 1M decoding engine

### Project Structure

```text
├── index.html                           # Entry HTML (default dark theme & fonts)
├── src/
│   ├── App.tsx                          # Application shell, theme sync, hotkeys & global file drop
│   ├── index.css                        # Tailwind v4 + shadcn/ui default OKLCH tokens
│   ├── components/sdr/
│   │   ├── TopToolbar.tsx               # Capture controls, pane toggles, telemetry & theme switch
│   │   ├── ControlSidebar.tsx           # Collapsible parameter panels & IQ quality stats
│   │   └── PlotsGrid.tsx                # Adaptive 5-pane grid, canvas hosts & BLE tables
│   └── sdr/
│       ├── engine.ts                    # Decoupled high-FPS SDR controller & streaming scheduler
│       ├── dsp.ts                       # TypedArray IQ decoder pool, windows, FFT, stats & synth
│       ├── render.ts                    # Canvas2D spectrum, waterfall, waveform & constellation
│       └── ble.ts                       # BLE 1M GFSK demodulator, de-whitening & CRC-24 check
└── components/ui/                       # shadcn/ui primitives
```

---

## License

MIT
