# CT3003 SDR Web IQ Stream Viewer

Zero-dependency HTML5/Canvas + direct-on-router C HTTP/WebSocket daemon (plus optional Python 3 stdlib bridge) for inspecting CT3003 (`MT7981B` + `MT7976CN`) **2.4 GHz (Band 0 / PHY0)** and **5 GHz (Band 1 / PHY1)** IQ captures in real time or offline.

## Quick Start

### 1. Direct Router Mode (Recommended — Pure JS Direct to CT3003, No PC Python/SSH Hop)

Cross-compile and run the lightweight static HTTP + RFC 6455 WebSocket daemon (`wmsdr serve`) directly on the router (`/root/wmtest/wmsdr` + `/root/wmtest/web/`):

```sh
insmod /root/wmtest/wm_sdr.ko
start-stop-daemon -S -b -m -p /var/run/wmsdr.pid -x /root/wmtest/wmsdr -- serve 8088 /root/wmtest/web
```

Open `http://192.168.6.2:8088/` directly in your browser (or open local `host/web/index.html` and click **Direct 192.168.6.2:8088** / pass `?router=http://192.168.6.2:8088` via CORS).

- **2.4G / 5G switching**: Click **2.4G** / **5G** in the top bar (or pass `--band 0|1` / `?band=0|1`) to switch ICAP capture between Band 0 (`PHY0`, `Node 15 ADC @ 80 Msps`) and Band 1 (`PHY1`, `Node 15 ADC @ 160 Msps` in HE80/HE160 or `80 Msps` in BW20/BW40), automatically syncing `LO` and `Fs` from hardware `ChInfo`.
- **UI FPS limit & BLE decoder**: Use the FPS selector (`1–400 Hz` / `Unlimited`) to cap UI refresh rate, and enable the built-in **Bluetooth Advertising Decoder** (`BLE 1M`, Node 6 at `40 Msps`, `16384` words) to decode live BLE advertising PDUs with CRC-24 verification.

### 2. PC Demo Mode (`--demo`, No Hardware Required)

Runs a synthetic CT3003 `u32_12` generator directly in Python so the full HTTP + WebSocket UI works without a board connected:

```powershell
python host/web/server.py --demo
```

Open `http://127.0.0.1:8088/` in a browser. Supported synthetic presets (`preset` query/WS parameter):
- `ofdm_wifi` — occupied baseband carriers (`-0.22..+0.22 Fs`) + pilot lines
- `multitone` — multi-tone complex CW + pulsed tone + noise
- `qpsk_burst` — shaped QPSK burst with carrier frequency offset
- `sweep` — swept chirp + static tone

### 3. Real CT3003 SSH Mode

Connects to the CT3003 board over SSH (using `BatchMode=yes`, so configure SSH keys or an active SSH session/ControlMaster beforehand):

```powershell
python host/web/server.py --host root@192.168.6.2 --remote-wmsdr /root/wmtest/wmsdr
```

On Windows (`--ssh-cmd auto`), `server.py` automatically uses `wsl -e ssh` if `wsl` is available, or `ssh` otherwise. Override explicitly with `--ssh-cmd wsl` or `--ssh-cmd native`. Pass `--no-control-master` to disable SSH `ControlMaster` connection multiplexing.

Underlying remote commands executed over SSH:
- Status + RF channel info: `<remote_wmsdr> fwstate && <remote_wmsdr> iqstatus && (<remote_wmsdr> wmpeek 0xE00F8524 ...)` (`ChInfo` Band0/Band1 LO & BW)
- One-shot capture: `<remote_wmsdr> iqcapture /tmp/wmsdr_web_iq.bin <node> <len> <bw> [direct] >&2 && cat /tmp/wmsdr_web_iq.bin`
- High-FPS live stream: persistent pipe `exec <remote_wmsdr> iqstream <node> <len> <bw> <0|1> <interval_ms>` (falls back automatically to per-frame `iqcapture` on older `wmsdr` binaries). Note: `Node 15 (ADC WF1/0)` uses `API` mode (`direct=0`) during continuous streaming and interleaves `WF0` (even words) and `WF1` (odd words) at `80 Msps` per antenna chain (`12-bit` `u32_12`).

UI panes (`Spectrum`, `Waterfall`, `Time`, `Constellation`) can each be toggled independently from the top bar or closed individually (`×`) to adapt grid layout and reduce CPU/Canvas work at high FPS.

### 4. Sample Archive Mode (`--samples-dir`)

Expose a local directory of captured files (`.bin`, `.iq`, `.s16le`, `.s32le`, `.cf32`) to the UI dropdown and `/samples/<filename>`:

```powershell
python host/web/server.py --demo --samples-dir ./captures
```

### 5. `file://` Offline Mode (No Server Needed)

Open `host/web/index.html` directly via `file://` in any modern browser:
- Automatically enters offline mode (`Synthetic Generator` / `Local File Playback`)
- Supports drag-and-drop or file picker loading for `.bin`, `.iq`, `.s16le`, `.cs16`, `.s32le`, `.cs32`, `.cf32`, `.fc32`
- Strips `WSIQ` (32 B), `ICAP` (28 B), or `IQUD` (44 B) headers automatically (`headerMode = auto`)

---

## CLI Options (`host/web/server.py`)

| Option | Default | Description |
|---|---|---|
| `--bind` | `127.0.0.1` | Bind IP address |
| `--port` | `8088` | HTTP/WebSocket listen port |
| `--host` | `root@192.168.6.2` | Target SSH `user@host` |
| `--ssh-cmd` | `auto` | SSH launcher: `auto`, `native`, or `wsl` |
| `--remote-wmsdr` | `/root/wmtest/wmsdr` | Path to `wmsdr` binary on the CT3003 board |
| `--samples-dir` | `None` | Optional directory exposing `.bin`/`.iq`/`.s16le`/`.s32le`/`.cf32` files |
| `--demo` | `False` | Enable synthetic `u32_12` capture generator instead of SSH |
| `--no-control-master` | `False` | Disable SSH `ControlMaster` multiplexing |

---

## HTTP REST API

All static files (`/`, `/index.html`, `/style.css`, `/dsp.js`, `/render.js`, `/ble.js`, `/app.js`) and API endpoints return `Cache-Control: no-store`.

### `GET /api/config`
Returns server configuration, verified node profiles (`15=ADC WF1/0`, `6=RXFD WF1/0`, `8=RXFD WF2/0`), and available sample filenames:
```json
{
  "ok": true,
  "host": "root@192.168.6.2",
  "remote_wmsdr": "/root/wmtest/wmsdr",
  "demo": true,
  "samples": ["warm_node8.bin"],
  "default_node": 15,
  "default_len": 8192,
  "default_bw": 0,
  "default_format": "u32_12",
  "default_stream_mode": "even",
  "default_fs_mhz": 80.0,
  "default_lo_mhz": 2462.0
}
```

### `GET /api/samples`
Lists safe regular sample files in `--samples-dir`:
```json
{
  "ok": true,
  "files": [
    {"name": "warm_node8.bin", "size": 32768}
  ]
}
```

### `GET /samples/<filename>`
Streams `application/octet-stream` from `--samples-dir` after strict basename, `..` traversal, symlink-escape, and extension validation.

### `GET /api/status`
Runs `fwstate && iqstatus` plus WM `ChInfo` (`0xE00F8524/30/44/50`) over SSH (or returns simulated mailbox/RF state in `--demo` mode):
```json
{
  "ok": true,
  "demo": false,
  "host": "root@192.168.6.2",
  "fw_state": 7,
  "raw_tick": 2734,
  "magic": "0x51494d57",
  "magic_ok": true,
  "version": 1,
  "cmd": 0,
  "status": "DONE",
  "status_code": 2,
  "node": 15,
  "length": 8192,
  "data_addr": "0xe0200000",
  "sample_count": 8192,
  "tick": 2720,
  "error": 0,
  "cr0": 1024,
  "cr2": 0,
  "cr9": 131068,
  "bw": 0,
  "arg0": 0,
  "arg1": 0,
  "rf": {
    "band0": {"lo_khz": 2462000, "lo_mhz": 2462.0, "bw_idx": 1, "bw_mhz": 40, "pri": 1, "rx_n": 2, "tx_n": 2},
    "band1": {"lo_khz": 5250000, "lo_mhz": 5250.0, "bw_idx": 3, "bw_mhz": 160, "pri": 0, "rx_n": 3, "tx_n": 3}
  }
}
```
Returns HTTP `502` JSON on SSH or parser failure.

### `GET /api/capture?node=15&len=8192&bw=0&direct=0&preset=ofdm_wifi`
Validates `0 <= node <= 63`, `1 <= len <= 131072`, and `0 <= bw <= 3`, serializes hardware/demo capture with a lock, and returns `len * 4` bytes of `application/octet-stream` (`u32_12` little-endian words).

Response headers:
- `X-IQ-Node`: node index
- `X-IQ-Words`: captured word count (`len`)
- `X-IQ-Sample-Count`: `sample_count` reported by firmware/demo
- `X-IQ-CR0`: hex register value (e.g. `0x00000400`)
- `X-IQ-CR9`: hex register value (e.g. `0x0001fffc`)
- `X-IQ-Direct`: `"1"` or `"0"`
- `X-IQ-Seq`: monotonic sequence counter

Returns HTTP `400` JSON for invalid parameters or `502` JSON on backend failure.

---

## WebSocket API (`GET /ws`)

Standard RFC 6455 WebSocket endpoint (`Sec-WebSocket-Key` + GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).

### Client → Server (JSON Text Frames)

- Start continuous streaming:
  ```json
  {"type":"start","node":8,"len":8192,"bw":0,"direct":false,"intervalMs":0,"preset":"ofdm_wifi"}
  ```
  (`intervalMs = 0` streams back-to-back over `wmsdr iqstream` on CT3003 or ~60 fps in `--demo` mode)
- Single-frame capture:
  ```json
  {"type":"oneshot","node":8,"len":8192,"bw":0,"direct":false,"preset":"ofdm_wifi"}
  ```
- Stop continuous streaming:
  ```json
  {"type":"stop"}
  ```
- Query current firmware/demo status:
  ```json
  {"type":"status"}
  ```

### Server → Client (JSON Text Frames)

- Status update: `{"type":"status", ..., "streaming": true|false}`
- Error notification: `{"type":"error", "message": "..."}` (streaming automatically stops after 3 consecutive capture errors)

### Server → Client (Binary `WSIQ` Frames)

Each binary frame starts with a 32-byte little-endian `struct.Struct("<8I")` header followed immediately by `words * 4` bytes of raw IQ words:

| Offset | Field | Value / Description |
|---|---|---|
| `0x00` | `magic` | `0x51495357` (`"WSIQ"` LE) |
| `0x04` | `version` | `1` |
| `0x08` | `seq` | Monotonic frame sequence number |
| `0x0C` | `node` | ICAP node index |
| `0x10` | `words` | Sample word count (`len`) |
| `0x14` | `cr0` | Hardware `cr0` register |
| `0x18` | `cr9` | Hardware `cr9` register |
| `0x1C` | `flags` | `bit0 = direct`, `bit1 = demo`, `bits[15:8] = bw & 0xff` |

Each 32-bit little-endian sample word (`u32_12`) packs signed 12-bit two's-complement I in bits `[11:0]` and signed 12-bit Q in bits `[27:16]`.

---

## Running Tests

```powershell
python firmware/tests/test_web_iq.py
```
