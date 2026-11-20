#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Python 3 stdlib HTTP/WebSocket bridge for the CT3003 IQ stream viewer."""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import random
import re
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Sequence
import urllib.parse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WSIQ_MAGIC = 0x51495357  # "WSIQ" little-endian
WSIQ_VERSION = 1
WSIQ_HEADER_STRUCT = struct.Struct("<8I")

WMIQ_MAGIC = 0x51494D57  # "WMIQ" little-endian

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 8088
DEFAULT_HOST = "root@192.168.6.2"
DEFAULT_REMOTE_WMSDR = "/root/wmtest/wmsdr"
DEFAULT_NODE = 15
DEFAULT_LEN = 8192
DEFAULT_BW = 0
DEFAULT_FS_MHZ = 80.0
DEFAULT_LO_MHZ = 2462.0
MAX_LEN = 131072
MAX_WS_FRAME_BYTES = 1024 * 1024

CHINFO_BW_MHZ = {0: 20, 1: 40, 2: 80, 3: 160}
CHINFO_ADDRS = (0xE00F8524, 0xE00F8530, 0xE00F8544, 0xE00F8550)

NODE_PROFILES: dict[str, dict[str, Any]] = {
    "15": {
        "node": 15,
        "name": "ADC WF1/0 (Band0 2.4G)",
        "format": "u32_12",
        "bits": 12,
        "band": 0,
        "fs_mhz": 80.0,
        "interleaved": True,
        "direct_stream_safe": False,
    },
    "6": {
        "node": 6,
        "name": "RXFD WF1/0 (Band0 2.4G)",
        "format": "u32_14",
        "bits": 14,
        "band": 0,
        "fs_mhz": 40.0,
        "interleaved": True,
        "direct_stream_safe": True,
    },
    "8": {
        "node": 8,
        "name": "RXFD WF2/0 (Band1 5G)",
        "format": "u32_14",
        "bits": 14,
        "band": 1,
        "fs_mhz": 40.0,
        "interleaved": True,
        "direct_stream_safe": True,
    },
}

ALLOWED_SAMPLE_EXTS = frozenset({".bin", ".iq", ".s16le", ".s32le", ".cf32"})
VALID_PRESETS = ("ofdm_wifi", "multitone", "qpsk_burst", "sweep")

STATIC_ROUTES: dict[str, tuple[str, str]] = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/dsp.js": ("dsp.js", "application/javascript; charset=utf-8"),
    "/render.js": ("render.js", "application/javascript; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}

STATUS_NAMES = {
    0: "IDLE",
    1: "ARMED",
    2: "DONE",
    3: "ERROR",
}


class BackendError(RuntimeError):
    """Raised when the SSH/hardware capture backend fails."""


class LegacyStreamUnsupported(BackendError):
    """Raised when remote wmsdr binary does not support `iqstream`."""


def _read_exact_stream(stream: Any, n: int) -> bytes:
    """Read up to n bytes from a binary pipe across short reads until n or EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            break
        buf.extend(chunk)
    return bytes(buf)


class SampleAccessError(Exception):
    """Raised when a sample file request is invalid or inaccessible."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def resolve_ssh_cmd(ssh_cmd: str | Sequence[str] = "auto") -> list[str]:
    """Resolve --ssh-cmd ('auto', 'native', 'wsl', or argv sequence) to argv."""
    if isinstance(ssh_cmd, (list, tuple)):
        cmd = [str(part) for part in ssh_cmd if str(part)]
        if not cmd:
            raise ValueError("ssh_cmd sequence must not be empty")
        return cmd

    mode = (ssh_cmd or "auto").strip().lower()
    if mode == "auto":
        if sys.platform == "win32" and shutil.which("wsl"):
            return ["wsl", "-e", "ssh"]
        return ["ssh"]
    if mode == "native":
        return ["ssh"]
    if mode == "wsl":
        return ["wsl", "-e", "ssh"]
    raise ValueError(f"Invalid --ssh-cmd {ssh_cmd!r}: expected auto, native, or wsl")


def pack_wsiq_header(
    seq: int,
    node: int,
    words: int,
    cr0: int,
    cr9: int,
    *,
    direct: bool = False,
    demo: bool = False,
    bw: int = 0,
    band: int = 0,
) -> bytes:
    """Pack the 32-byte WSIQ binary WebSocket frame header."""
    flags = (
        (1 if direct else 0)
        | ((1 if demo else 0) << 1)
        | ((int(bw) & 0xFF) << 8)
        | ((int(band) & 1) << 16)
    )
    return WSIQ_HEADER_STRUCT.pack(
        WSIQ_MAGIC,
        WSIQ_VERSION,
        seq & 0xFFFFFFFF,
        node & 0xFFFFFFFF,
        words & 0xFFFFFFFF,
        cr0 & 0xFFFFFFFF,
        cr9 & 0xFFFFFFFF,
        flags & 0xFFFFFFFF,
    )


def parse_bool_flag(raw: Any, default: bool = False) -> bool:
    """Parse boolean query/JSON parameter from bool, int, or string."""
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, int):
        if raw in (0, 1):
            return bool(raw)
        raise ValueError(f"Invalid boolean flag integer: {raw}")
    text = str(raw).strip().lower()
    if text in ("", "0", "false", "no", "off"):
        return False
    if text in ("1", "true", "yes", "on"):
        return True
    raise ValueError(f"Invalid boolean flag value: {raw!r}")


def parse_int_param(raw: Any, name: str, default: int, lo: int, hi: int) -> int:
    """Parse and range-check an integer parameter."""
    if raw is None or (isinstance(raw, str) and raw.strip() == ""):
        val = default
    elif isinstance(raw, bool):
        raise ValueError(f"Parameter {name} must be an integer")
    elif isinstance(raw, int):
        val = raw
    else:
        text = str(raw).strip()
        try:
            val = int(text, 0)
        except ValueError as exc:
            raise ValueError(f"Invalid integer for {name}: {raw!r}") from exc
    if val < lo or val > hi:
        raise ValueError(f"Parameter {name}={val} out of range [{lo}..{hi}]")
    return val


def normalize_preset(raw: Any) -> str:
    """Normalize synthetic signal preset name, defaulting to ofdm_wifi."""
    if raw is None:
        return "ofdm_wifi"
    text = str(raw).strip().lower()
    return text if text in VALID_PRESETS else "ofdm_wifi"


def validate_capture_params(
    node_raw: Any = DEFAULT_NODE,
    len_raw: Any = DEFAULT_LEN,
    bw_raw: Any = DEFAULT_BW,
    direct_raw: Any = False,
    preset_raw: Any = "ofdm_wifi",
) -> tuple[int, int, int, bool, str]:
    """Validate node, len, bw, direct, and preset parameters."""
    node = parse_int_param(node_raw, "node", DEFAULT_NODE, 0, 63)
    length = parse_int_param(len_raw, "len", DEFAULT_LEN, 1, MAX_LEN)
    bw = parse_int_param(bw_raw, "bw", DEFAULT_BW, 0, 3)
    direct = parse_bool_flag(direct_raw, default=False)
    preset = normalize_preset(preset_raw)
    return node, length, bw, direct, preset


def _decode_chinfo_band(lo_khz: int, meta_word: int) -> dict[str, Any]:
    """Decode WM ChInfo ChS1 (kHz) and packed Pri/BW/TxN/RxN word."""
    bw_idx = (meta_word >> 8) & 0xFF
    pri = meta_word & 0xFF
    rx_n = (meta_word >> 16) & 0xFF
    tx_n = (meta_word >> 24) & 0xFF
    valid_khz = 1_000_000 <= lo_khz <= 7_200_000
    lo_mhz = round(lo_khz / 1000.0, 3) if valid_khz else None
    return {
        "lo_khz": lo_khz if valid_khz else 0,
        "lo_mhz": lo_mhz,
        "bw_idx": bw_idx,
        "bw_mhz": CHINFO_BW_MHZ.get(bw_idx),
        "pri": pri,
        "rx_n": rx_n,
        "tx_n": tx_n,
    }


def parse_chinfo_words(text: str) -> dict[str, Any] | None:
    """Parse optional `WM[0x........] = 0x........` ChInfo peeks from SSH status output."""
    words: dict[int, int] = {}
    for line in text.replace("\r\n", "\n").replace("\r", "\n").splitlines():
        m = re.match(r"^\s*WM\[(0x[0-9a-fA-F]+)\]\s*=\s*(0x[0-9a-fA-F]+|\d+)\b", line)
        if m:
            words[int(m.group(1), 16)] = int(m.group(2), 0)
    if not any(addr in words for addr in CHINFO_ADDRS):
        return None
    b0 = _decode_chinfo_band(words.get(0xE00F8524, 0), words.get(0xE00F8530, 0))
    b1 = _decode_chinfo_band(words.get(0xE00F8544, 0), words.get(0xE00F8550, 0))
    return {"band0": b0, "band1": b1}


def parse_iqstatus_output(text: str, *, host: str = "", demo: bool = False) -> dict[str, Any]:
    """Parse combined `wmsdr fwstate && wmsdr iqstatus` stdout into a status dict."""
    norm = text.replace("\r\n", "\n").replace("\r", "\n")

    kv_raw: dict[str, tuple[str, str | None]] = {}
    fw_state: int | None = None

    for line in norm.splitlines():
        line_s = line.strip()
        if not line_s:
            continue
        m_fw = re.match(r"^fw_state\s+(0x[0-9a-fA-F]+|\d+)\b", line_s)
        if m_fw:
            fw_state = int(m_fw.group(1), 0)
            continue
        m_kv = re.match(
            r"^([A-Za-z0-9_/]+)\s+(0x[0-9a-fA-F]+|\d+)(?:\s*\(([^)]*)\))?",
            line_s,
        )
        if m_kv:
            key = m_kv.group(1)
            val_tok = m_kv.group(2)
            paren = m_kv.group(3)
            kv_raw[key] = (val_tok, paren.strip() if paren is not None else None)

    required_any = ("raw_tick", "magic", "status", "node", "length")
    if not any(k in kv_raw for k in required_any):
        raise ValueError("Could not find iqstatus fields in output")

    def _int_field(key: str, default: int = 0) -> int:
        if key not in kv_raw:
            return default
        return int(kv_raw[key][0], 0)

    magic_int = _int_field("magic", 0)
    data_addr_int = _int_field("data_addr", 0)
    status_code = _int_field("status", 0)
    status_label = kv_raw.get("status", ("", None))[1]
    if not status_label:
        status_label = STATUS_NAMES.get(status_code, "UNKNOWN")

    arg1_val = _int_field("arg1/ret", _int_field("arg1", 0))
    rf = parse_chinfo_words(norm)

    res: dict[str, Any] = {
        "ok": True,
        "demo": demo,
        "host": host,
        "fw_state": fw_state if fw_state is not None else 0,
        "raw_tick": _int_field("raw_tick", 0),
        "magic": f"0x{magic_int:08x}",
        "magic_ok": magic_int == WMIQ_MAGIC,
        "version": _int_field("version", 0),
        "cmd": _int_field("cmd", 0),
        "status": status_label,
        "status_code": status_code,
        "node": _int_field("node", 0),
        "length": _int_field("length", 0),
        "data_addr": f"0x{data_addr_int:08x}",
        "sample_count": _int_field("sample_count", 0),
        "tick": _int_field("tick", 0),
        "error": _int_field("error", 0),
        "cr0": _int_field("cr0", 0),
        "cr2": _int_field("cr2", 0),
        "cr9": _int_field("cr9", 0),
        "bw": _int_field("bw", 0),
        "arg0": _int_field("arg0", 0),
        "arg1": arg1_val,
    }
    if rf is not None:
        res["rf"] = rf
    return res


def parse_iqcapture_output(text: str) -> dict[str, Any]:
    """Parse `wmsdr iqcapture` summary text (from stderr/stdout) for metadata."""
    norm = text.replace("\r\n", "\n").replace("\r", "\n")

    def _match_int(pattern: str) -> int | None:
        m = re.search(pattern, norm)
        return int(m.group(1), 0) if m else None

    cr0 = _match_int(r"\bcr0=(0x[0-9a-fA-F]+|\d+)")
    cr9 = _match_int(r"\bcr9=(0x[0-9a-fA-F]+|\d+)")
    sample_count = _match_int(r"\bsample_count=(0x[0-9a-fA-F]+|\d+)")
    node = _match_int(r"\bnode=(0x[0-9a-fA-F]+|\d+)")
    length = _match_int(r"\blen=(0x[0-9a-fA-F]+|\d+)")
    err = _match_int(r"\b(?:err|error)=(0x[0-9a-fA-F]+|\d+)")

    m_mode = re.search(r"\bmode=([A-Za-z0-9_-]+)", norm)
    mode = m_mode.group(1) if m_mode else None

    m_addr = re.search(r"\bfrom\s+(0x[0-9a-fA-F]+)\b", norm)
    data_addr = f"0x{int(m_addr.group(1), 0):08x}" if m_addr else None

    if cr0 is None and cr9 is None and sample_count is None:
        raise ValueError("Could not parse iqcapture metadata from output")

    return {
        "mode": mode,
        "node": node,
        "len": length,
        "sample_count": sample_count,
        "cr0": cr0,
        "cr9": cr9,
        "err": err,
        "data_addr": data_addr,
    }


def is_safe_sample_filename(name: str) -> bool:
    """Return True if name is a safe single-segment sample filename."""
    if not name or name in (".", "..") or name.startswith("."):
        return False
    if "/" in name or "\\" in name or ".." in name or "\x00" in name:
        return False
    if Path(name).name != name:
        return False
    return Path(name).suffix.lower() in ALLOWED_SAMPLE_EXTS


def _pack_i12q12(iv: float, qv: float) -> int:
    """Clamp I/Q floats to signed 12-bit [-2048..2047] and pack as u32_12."""
    ii = max(-2048, min(2047, int(round(iv))))
    iq = max(-2048, min(2047, int(round(qv))))
    return ((iq & 0xFFF) << 16) | (ii & 0xFFF)


class SyntheticGenerator:
    """Synthetic CT3003 u32_12 IQ generator matching host/web/dsp.js presets."""

    def __init__(self, seed: int = 0x13572468) -> None:
        self._rng = random.Random(seed)
        self._phase = 0
        self._frame = 0
        self._sweep_phase = 0.0

    def generate(
        self,
        preset: str,
        count: int,
        *,
        node: int = DEFAULT_NODE,
        bw: int = DEFAULT_BW,
        direct: bool = False,
    ) -> bytes:
        """Generate `count` packed u32_12 IQ words for the requested preset."""
        preset_norm = normalize_preset(preset)
        frame = self._frame
        self._frame += 1
        phase0 = self._phase
        self._phase += count

        gain = 0.72 if direct else 1.0
        if node == 9:
            gain *= 0.85
        bw_scale = 1.0 + 0.08 * bw

        rng = self._rng
        gauss = rng.gauss
        two_pi = 2.0 * math.pi
        pack_word = _pack_i12q12
        words = [0] * count

        if preset_norm == "multitone":
            w1 = -0.18 * two_pi
            w2 = min(0.45, 0.085 * bw_scale) * two_pi
            w3 = min(0.47, 0.31 * bw_scale) * two_pi
            ph3 = frame * 0.2
            c1, s1 = math.cos(w1), math.sin(w1)
            c2, s2 = math.cos(w2), math.sin(w2)
            c3, s3 = math.cos(w3), math.sin(w3)
            x1, y1 = math.cos(w1 * phase0), math.sin(w1 * phase0)
            x2, y2 = math.cos(w2 * phase0), math.sin(w2 * phase0)
            x3, y3 = math.cos(w3 * phase0 + ph3), math.sin(w3 * phase0 + ph3)
            a1, a2, a3 = 520.0 * gain, 280.0 * gain, 160.0 * gain

            for n in range(count):
                pulse = 1.0 if (n & 2047) < 1400 else 0.05
                iv = gauss(0.0, 22.0) + a1 * x1 + a2 * pulse * x2 + a3 * x3
                qv = gauss(0.0, 22.0) + a1 * y1 + a2 * pulse * y2 + a3 * y3
                words[n] = pack_word(iv, qv)
                x1, y1 = x1 * c1 - y1 * s1, x1 * s1 + y1 * c1
                x2, y2 = x2 * c2 - y2 * s2, x2 * s2 + y2 * c2
                x3, y3 = x3 * c3 - y3 * s3, x3 * s3 + y3 * c3

        elif preset_norm == "qpsk_burst":
            sym_i = 1
            sym_q = 1
            cfo_step = 0.0007 * two_pi
            cw, sw = math.cos(cfo_step), math.sin(cfo_step)
            cx, cy = math.cos(cfo_step * phase0), math.sin(cfo_step * phase0)
            env_step = two_pi / 16.0
            env_lut = [0.6 + 0.4 * (0.55 + 0.45 * math.sin(env_step * k - math.pi * 0.5)) for k in range(16)]
            amp = 760.0 * gain
            getrandbits = rng.getrandbits

            for n in range(count):
                slot = n & 15
                if slot == 0:
                    bits = getrandbits(2)
                    sym_i = 1 if (bits & 1) else -1
                    sym_q = 1 if (bits & 2) else -1
                scale = amp * env_lut[slot]
                bi = sym_i * scale
                bq = sym_q * scale
                iv = gauss(0.0, 22.0) + bi * cx - bq * cy
                qv = gauss(0.0, 22.0) + bi * cy + bq * cx
                words[n] = pack_word(iv, qv)
                cx, cy = cx * cw - cy * sw, cx * sw + cy * cw

        elif preset_norm == "sweep":
            sw_ph = self._sweep_phase
            w_tone = -0.27 * two_pi
            ct, st = math.cos(w_tone), math.sin(w_tone)
            xt, yt = math.cos(w_tone * phase0), math.sin(w_tone * phase0)
            a_chirp = 650.0 * gain
            a_tone = 90.0 * gain
            inv_n = 1.0 / max(1, count)
            base_pos = frame * 0.05

            for n in range(count):
                norm_pos = ((base_pos + n * inv_n) % 1.0) - 0.5
                sw_ph += norm_pos * 0.85 * math.pi
                iv = gauss(0.0, 22.0) + a_chirp * math.cos(sw_ph) + a_tone * xt
                qv = gauss(0.0, 22.0) + a_chirp * math.sin(sw_ph) + a_tone * yt
                words[n] = pack_word(iv, qv)
                xt, yt = xt * ct - yt * st, xt * st + yt * ct

            self._sweep_phase = sw_ph % two_pi

        else:
            # ofdm_wifi: occupied baseband -0.22..+0.22 Fs band + pilot lines
            carriers = []
            for c in range(-6, 7):
                if c == 0:
                    continue
                w = min(0.45, max(-0.45, c * 0.032 * bw_scale)) * two_pi
                ph = ((c * 13 + frame * 7) % 11) * 0.57
                amp = (135.0 if abs(c) in (2, 5) else 85.0) * gain
                carriers.append([
                    amp,
                    math.cos(w),
                    math.sin(w),
                    math.cos(w * phase0 + ph),
                    math.sin(w * phase0 + ph),
                ])

            for n in range(count):
                iv = gauss(0.0, 22.0)
                qv = gauss(0.0, 22.0)
                for car in carriers:
                    amp, cw, sw, xr, xi = car
                    iv += amp * xr
                    qv += amp * xi
                    car[3] = xr * cw - xi * sw
                    car[4] = xr * sw + xi * cw
                words[n] = pack_word(iv, qv)

        return struct.pack(f"<{count}I", *words)


class IQBackend:
    """Thread-safe CT3003 SSH/demo capture and sample directory backend."""

    def __init__(
        self,
        *,
        host: str = DEFAULT_HOST,
        ssh_cmd: str | Sequence[str] = "auto",
        remote_wmsdr: str = DEFAULT_REMOTE_WMSDR,
        samples_dir: str | Path | None = None,
        demo: bool = False,
        no_control_master: bool = False,
    ) -> None:
        self.host = host
        self.ssh_argv = resolve_ssh_cmd(ssh_cmd)
        self.remote_wmsdr = remote_wmsdr
        self.samples_dir = Path(samples_dir) if samples_dir is not None else None
        self.demo = bool(demo)
        self.no_control_master = bool(no_control_master)

        self.capture_lock = threading.Lock()
        self._seq = 0
        self._synth = SyntheticGenerator()
        self._t0 = time.monotonic()

        self._last_node = DEFAULT_NODE
        self._last_len = DEFAULT_LEN
        self._last_bw = DEFAULT_BW
        self._last_cr0 = 0x00000400
        self._last_cr9 = DEFAULT_LEN * 4
        self._last_sample_count = DEFAULT_LEN

    def _build_ssh_cmd(self, remote_cmd: str) -> list[str]:
        cmd = list(self.ssh_argv)
        use_cm = (not self.no_control_master) and (
            sys.platform != "win32" or cmd[0].lower().endswith("wsl") or cmd[0] == "wsl"
        )
        if use_cm:
            cm_path = f"/tmp/wmsdr_web_{os.getpid()}_%r_%h_%p"
            cmd.extend([
                "-o", "ControlMaster=auto",
                "-o", f"ControlPath={cm_path}",
                "-o", "ControlPersist=120",
            ])
        cmd.extend([
            "-T",
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=5",
            self.host,
            remote_cmd,
        ])
        return cmd

    def list_samples(self) -> list[dict[str, Any]]:
        """List safe IQ sample files in --samples-dir."""
        if self.samples_dir is None:
            return []
        try:
            base = self.samples_dir.resolve()
        except OSError:
            return []
        if not base.is_dir():
            return []

        files: list[dict[str, Any]] = []
        for entry in sorted(base.iterdir(), key=lambda p: p.name.lower()):
            if not is_safe_sample_filename(entry.name):
                continue
            try:
                resolved = entry.resolve()
                if resolved.parent != base or not resolved.is_file():
                    continue
                size = resolved.stat().st_size
            except OSError:
                continue
            files.append({"name": entry.name, "size": size})
        return files

    def resolve_sample_path(self, raw_tail: str) -> Path:
        """Validate /samples/<filename> and return the safe regular file Path."""
        if not raw_tail:
            raise SampleAccessError(400, "Missing sample filename")
        raw_lower = raw_tail.lower()
        if (
            "/" in raw_tail
            or "\\" in raw_tail
            or ".." in raw_tail
            or "%2f" in raw_lower
            or "%5c" in raw_lower
            or "%00" in raw_lower
        ):
            raise SampleAccessError(400, "Invalid sample path")

        name = urllib.parse.unquote(raw_tail)
        if (
            not name
            or name in (".", "..")
            or ".." in name
            or "/" in name
            or "\\" in name
            or "\x00" in name
            or name.startswith(".")
            or Path(name).name != name
        ):
            raise SampleAccessError(400, "Invalid sample filename")

        if Path(name).suffix.lower() not in ALLOWED_SAMPLE_EXTS:
            raise SampleAccessError(403, "Unsupported sample file extension")

        if self.samples_dir is None:
            raise SampleAccessError(404, "Samples directory not configured")

        try:
            base = self.samples_dir.resolve()
            candidate = base / name
            resolved = candidate.resolve()
        except OSError as exc:
            raise SampleAccessError(404, f"Sample lookup failed: {exc}") from exc

        if resolved.parent != base:
            raise SampleAccessError(403, "Path escapes samples directory")
        if not resolved.exists() or not resolved.is_file():
            raise SampleAccessError(404, "Sample file not found")
        return resolved

    def get_config(self) -> dict[str, Any]:
        """Return /api/config payload."""
        return {
            "ok": True,
            "host": self.host,
            "remote_wmsdr": self.remote_wmsdr,
            "demo": self.demo,
            "direct_router": False,
            "samples": [item["name"] for item in self.list_samples()],
            "default_node": DEFAULT_NODE,
            "default_len": DEFAULT_LEN,
            "default_bw": DEFAULT_BW,
            "default_band": 0,
            "default_format": "u32_12",
            "default_stream_mode": "all" if self.demo else "even",
            "default_fs_mhz": DEFAULT_FS_MHZ,
            "default_lo_mhz": DEFAULT_LO_MHZ,
            "bands": {
                "0": {
                    "band": 0,
                    "name": "2.4G",
                    "label": "2.4 GHz (Band 0 / PHY0)",
                    "adc_fs_mhz": DEFAULT_FS_MHZ,
                    "rxfd_fs_mhz": 40.0,
                    "default_lo_mhz": DEFAULT_LO_MHZ,
                },
                "1": {
                    "band": 1,
                    "name": "5G",
                    "label": "5 GHz (Band 1 / PHY1)",
                    "adc_fs_mhz": 160.0,
                    "rxfd_fs_mhz": 40.0,
                    "default_lo_mhz": 5250.0,
                },
            },
            "node_profiles": NODE_PROFILES,
        }

    def _run_ssh(self, remote_cmd: str, *, action: str, timeout: float) -> tuple[bytes, str]:
        cmd = self._build_ssh_cmd(remote_cmd)
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=timeout,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise BackendError(f"SSH {action} failed: {exc}") from exc

        stderr_text = proc.stderr.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        if proc.returncode != 0:
            msg = stderr_text.strip() or f"SSH {action} exited with code {proc.returncode}"
            raise BackendError(msg)
        return proc.stdout, stderr_text

    def get_status(self) -> dict[str, Any]:
        """Return /api/status payload via demo state or SSH `fwstate && iqstatus`."""
        if self.demo:
            tick = 1000 + int((time.monotonic() - self._t0) * 100)
            return {
                "ok": True,
                "demo": True,
                "host": self.host,
                "fw_state": 7,
                "raw_tick": tick,
                "magic": f"0x{WMIQ_MAGIC:08x}",
                "magic_ok": True,
                "version": 1,
                "cmd": 0,
                "status": "DONE",
                "status_code": 2,
                "node": self._last_node,
                "length": self._last_len,
                "data_addr": "0xe0200000",
                "sample_count": self._last_sample_count,
                "tick": max(1000, tick - 8),
                "error": 0,
                "cr0": self._last_cr0,
                "cr2": 0,
                "cr9": self._last_cr9,
                "bw": self._last_bw,
                "arg0": 0,
                "arg1": 0,
                "rf": {
                    "band0": _decode_chinfo_band(int(DEFAULT_LO_MHZ * 1000), 0x02020101),
                    "band1": _decode_chinfo_band(5250000, 0x03030300),
                },
            }

        wmsdr_q = shlex.quote(self.remote_wmsdr)
        chinfo_cmd = "; ".join(f"{wmsdr_q} wmpeek 0x{addr:08x}" for addr in CHINFO_ADDRS)
        if not self.capture_lock.acquire(timeout=2.0):
            raise BackendError("Capture device busy")
        try:
            raw_stdout, _ = self._run_ssh(
                f"{wmsdr_q} fwstate && {wmsdr_q} iqstatus && ( {chinfo_cmd}; true ) 2>/dev/null",
                action="iqstatus",
                timeout=15,
            )
        finally:
            self.capture_lock.release()
        stdout_text = raw_stdout.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        try:
            return parse_iqstatus_output(stdout_text, host=self.host, demo=False)
        except ValueError as exc:
            raise BackendError(f"Failed to parse iqstatus output: {exc}") from exc

    def capture(
        self,
        node: int,
        length: int,
        bw: int,
        direct: bool,
        preset: str = "ofdm_wifi",
        band: int = 0,
    ) -> dict[str, Any]:
        """Execute one IQ capture under capture_lock and return payload + metadata."""
        band = 1 if int(band) else 0
        if band or node == 15:
            direct = False
        expected_bytes = length * 4
        with self.capture_lock:
            if self.demo:
                eff_preset = "qpsk_burst" if (band == 1 and preset == "ofdm_wifi") else preset
                payload = self._synth.generate(
                    eff_preset,
                    length,
                    node=node,
                    bw=bw,
                    direct=direct,
                )
                cr0 = 0x00000400
                cr9 = expected_bytes & 0xFFFFFFFF
                sample_count = length
            else:
                wmsdr_q = shlex.quote(self.remote_wmsdr)
                direct_arg = " direct" if direct else ""
                band_arg = " --band 1" if band else ""
                remote_cmd = (
                    f"{wmsdr_q} iqcapture /tmp/wmsdr_web_iq.bin "
                    f"{node} {length} {bw}{direct_arg}{band_arg} >&2 && cat /tmp/wmsdr_web_iq.bin"
                )
                payload, stderr_text = self._run_ssh(remote_cmd, action="iqcapture", timeout=25)
                if len(payload) != expected_bytes:
                    raise BackendError(
                        f"Payload length mismatch: got {len(payload)} bytes, expected {expected_bytes}"
                    )

                try:
                    meta = parse_iqcapture_output(stderr_text)
                except ValueError as exc:
                    raise BackendError(f"Failed to parse iqcapture stderr: {exc}") from exc

                cr0 = meta["cr0"] if meta["cr0"] is not None else 0
                cr9 = meta["cr9"] if meta["cr9"] is not None else 0
                sample_count = meta["sample_count"] if meta["sample_count"] is not None else length

            self._seq = (self._seq + 1) & 0xFFFFFFFF
            seq = self._seq
            self._last_node = node
            self._last_len = length
            self._last_bw = bw
            self._last_cr0 = cr0
            self._last_cr9 = cr9
            self._last_sample_count = sample_count

            return {
                "seq": seq,
                "node": node,
                "words": length,
                "bw": bw,
                "band": band,
                "direct": direct,
                "demo": self.demo,
                "cr0": cr0,
                "cr9": cr9,
                "sample_count": sample_count,
                "payload": payload,
            }

    def stream_wsiq(
        self,
        node: int,
        length: int,
        bw: int,
        direct: bool,
        interval_ms: int,
        stop_evt: threading.Event,
        on_frame: Any,
        *,
        band: int = 0,
    ) -> int:
        """Stream back-to-back WSIQ binary frames over a persistent SSH `wmsdr iqstream` pipe."""
        band = 1 if int(band) else 0
        if not self.demo and node == 15 and direct:
            raise BackendError(
                "ADC Node 15 continuous stream requires API mode (direct=0); Direct streaming risks WM lockup"
            )
        if band:
            direct = False
        if not self.capture_lock.acquire(timeout=2.0):
            raise BackendError("Capture device busy")
        frames_emitted = 0
        proc: subprocess.Popen[bytes] | None = None
        stopper_done = threading.Event()
        stderr_chunks: list[str] = []

        try:
            wmsdr_q = shlex.quote(self.remote_wmsdr)
            direct_flag = 1 if direct else 0
            band_arg = " --band 1" if band else ""
            remote_cmd = (
                f"exec {wmsdr_q} iqstream {node} {length} {bw} {direct_flag} {interval_ms}{band_arg}"
            )
            cmd = self._build_ssh_cmd(remote_cmd)
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise BackendError(f"SSH iqstream failed to start: {exc}") from exc

            proc_lock = threading.Lock()

            def _stop_proc() -> None:
                with proc_lock:
                    if proc is None:
                        return
                    if proc.stdin is not None:
                        try:
                            proc.stdin.write(b"q\n")
                            proc.stdin.flush()
                        except (OSError, ValueError):
                            pass
                        try:
                            proc.stdin.close()
                        except (OSError, ValueError):
                            pass
                    try:
                        proc.terminate()
                    except (OSError, ValueError):
                        pass

            def _drain_stderr() -> None:
                assert proc is not None and proc.stderr is not None
                try:
                    while True:
                        chunk = proc.stderr.read(4096)
                        if not chunk:
                            break
                        if len(stderr_chunks) < 16:
                            stderr_chunks.append(
                                chunk.decode("utf-8", errors="replace").replace("\r\n", "\n")
                            )
                except (OSError, ValueError):
                    pass

            def _watch_stop() -> None:
                while not stopper_done.is_set():
                    if stop_evt.wait(0.05):
                        break
                if not stopper_done.is_set():
                    _stop_proc()

            t_err = threading.Thread(target=_drain_stderr, name="ssh-iqstream-err", daemon=True)
            t_stop = threading.Thread(target=_watch_stop, name="ssh-iqstream-stop", daemon=True)
            t_err.start()
            t_stop.start()

            assert proc.stdout is not None
            expected_bytes = length * 4
            while not stop_evt.is_set():
                hdr = _read_exact_stream(proc.stdout, WSIQ_HEADER_STRUCT.size)
                if len(hdr) < WSIQ_HEADER_STRUCT.size:
                    break
                magic, version, _rseq, rnode, words, cr0, cr9, flags = WSIQ_HEADER_STRUCT.unpack(hdr)
                if magic != WSIQ_MAGIC or version != WSIQ_VERSION or words != length:
                    raise BackendError(
                        f"Invalid WSIQ stream header magic=0x{magic:08x} ver={version} words={words}"
                    )
                payload = _read_exact_stream(proc.stdout, expected_bytes)
                if len(payload) < expected_bytes:
                    break

                self._seq = (self._seq + 1) & 0xFFFFFFFF
                seq = self._seq
                self._last_node = rnode
                self._last_len = length
                self._last_bw = bw
                self._last_cr0 = cr0
                self._last_cr9 = cr9
                self._last_sample_count = length

                new_hdr = WSIQ_HEADER_STRUCT.pack(
                    magic, version, seq, rnode, words, cr0, cr9, flags
                )
                frames_emitted += 1
                if not on_frame(new_hdr + payload):
                    break

            stopper_done.set()
            _stop_proc()
            try:
                proc.stdout.close()
            except (OSError, ValueError):
                pass
            try:
                rc = proc.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = proc.wait(timeout=1.0)
            t_err.join(timeout=0.5)
            t_stop.join(timeout=0.2)

            if frames_emitted == 0 and not stop_evt.is_set():
                stderr_text = "".join(stderr_chunks).strip()
                lower = stderr_text.lower()
                if rc == 2 or "bad arguments" in lower or "usage:" in lower:
                    raise LegacyStreamUnsupported(stderr_text or "remote wmsdr lacks iqstream")
                raise BackendError(stderr_text or f"SSH iqstream exited with code {rc}")

            return frames_emitted
        finally:
            stopper_done.set()
            if proc is not None and proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
            self.capture_lock.release()


class WebSocketSession:
    """RFC 6455 WebSocket session with per-connection streaming worker."""

    def __init__(self, handler: IQRequestHandler, server: IQHttpServer) -> None:
        self.handler = handler
        self.server = server
        self.backend = server.backend
        self.sock: socket.socket = handler.connection
        self.rfile = handler.rfile

        self.write_lock = threading.Lock()
        self.worker_lock = threading.Lock()
        self.closed = False
        self._worker_thread: threading.Thread | None = None
        self._worker_stop: threading.Event | None = None
        self._stream_cfg: dict[str, Any] = {}

    def is_streaming(self) -> bool:
        with self.worker_lock:
            return self._worker_thread is not None and self._worker_thread.is_alive()

    def send_frame(self, opcode: int, *parts: bytes) -> bool:
        """Send an unmasked server->client RFC 6455 frame thread-safely."""
        if self.closed:
            return False
        total_len = sum(len(p) for p in parts)
        b0 = 0x80 | (opcode & 0x0F)
        if total_len < 126:
            header = struct.pack("!BB", b0, total_len)
        elif total_len < 65536:
            header = struct.pack("!BBH", b0, 126, total_len)
        else:
            header = struct.pack("!BBQ", b0, 127, total_len)

        with self.write_lock:
            if self.closed:
                return False
            try:
                self.sock.sendall(header)
                for part in parts:
                    if part:
                        self.sock.sendall(part)
                return True
            except OSError:
                self.closed = True
                return False

    def send_json(self, obj: dict[str, Any]) -> bool:
        data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        return self.send_frame(0x1, data)

    def send_binary_capture(self, cap: dict[str, Any]) -> bool:
        hdr = pack_wsiq_header(
            cap["seq"],
            cap["node"],
            cap["words"],
            cap["cr0"],
            cap["cr9"],
            direct=cap["direct"],
            demo=cap["demo"],
            bw=cap["bw"],
            band=cap.get("band", 0),
        )
        return self.send_frame(0x2, hdr, cap["payload"])

    def stop_streaming(self) -> None:
        with self.worker_lock:
            thread = self._worker_thread
            stop_evt = self._worker_stop
            self._worker_thread = None
            self._worker_stop = None
        if stop_evt is not None:
            stop_evt.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=3.0)

    def start_streaming(
        self,
        node: int,
        length: int,
        bw: int,
        direct: bool,
        interval_ms: int,
        preset: str,
        *,
        band: int = 0,
    ) -> None:
        self.stop_streaming()
        stop_evt = threading.Event()
        cfg = {
            "node": node,
            "len": length,
            "bw": bw,
            "band": band,
            "direct": direct,
            "intervalMs": interval_ms,
            "preset": preset,
        }
        worker = threading.Thread(
            target=self._stream_loop,
            args=(stop_evt, cfg),
            name=f"ws-stream-{id(self):x}",
            daemon=True,
        )
        with self.worker_lock:
            self._worker_stop = stop_evt
            self._worker_thread = worker
            self._stream_cfg = cfg
        worker.start()

    def _handle_stream_error(
        self,
        stop_evt: threading.Event,
        consecutive_errors: int,
        exc: Exception,
    ) -> tuple[int, bool]:
        """Record a streaming backend error; emit status and stop after 3 failures."""
        consecutive_errors += 1
        self.send_json({"type": "error", "message": str(exc)})
        if consecutive_errors >= 3:
            with self.worker_lock:
                if self._worker_stop is stop_evt:
                    self._worker_thread = None
                    self._worker_stop = None
            self.send_json({
                "type": "status",
                "ok": False,
                "demo": self.backend.demo,
                "host": self.backend.host,
                "streaming": False,
                "error": str(exc),
            })
            return consecutive_errors, True
        return consecutive_errors, False

    def _stream_loop(self, stop_evt: threading.Event, cfg: dict[str, Any]) -> None:
        raw_interval = cfg["intervalMs"]
        effective_ms = 16 if (self.backend.demo and raw_interval == 0) else raw_interval
        interval_s = max(0.0, effective_ms / 1000.0)
        consecutive_errors = 0
        use_pipe = not self.backend.demo

        while not self.closed and not stop_evt.is_set() and not self.server.stop_event.is_set():
            if use_pipe:
                try:
                    emitted = self.backend.stream_wsiq(
                        cfg["node"],
                        cfg["len"],
                        cfg["bw"],
                        cfg["direct"],
                        cfg["intervalMs"],
                        stop_evt,
                        lambda frame_bytes: self.send_frame(0x2, frame_bytes),
                        band=cfg.get("band", 0),
                    )
                    if self.closed or stop_evt.is_set() or self.server.stop_event.is_set():
                        break
                    if emitted > 0:
                        consecutive_errors = 0
                        continue
                except LegacyStreamUnsupported:
                    use_pipe = False
                except Exception as exc:
                    consecutive_errors, fatal = self._handle_stream_error(stop_evt, consecutive_errors, exc)
                    if fatal or stop_evt.wait(0.25):
                        break
                    continue

            t_start = time.monotonic()
            try:
                cap = self.backend.capture(
                    cfg["node"],
                    cfg["len"],
                    cfg["bw"],
                    cfg["direct"],
                    preset=cfg["preset"],
                    band=cfg.get("band", 0),
                )
                consecutive_errors = 0
                if not self.send_binary_capture(cap):
                    break
            except Exception as exc:
                consecutive_errors, fatal = self._handle_stream_error(stop_evt, consecutive_errors, exc)
                if fatal:
                    break

            elapsed = time.monotonic() - t_start
            wait_s = max(0.0, interval_s - elapsed)
            if wait_s > 0 and stop_evt.wait(wait_s):
                break

    def _read_exact(self, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                raise EOFError("WebSocket EOF")
            buf.extend(chunk)
        return bytes(buf)

    def _recv_frame(self) -> tuple[bool, int, bytes]:
        hdr = self._read_exact(2)
        b0, b1 = hdr[0], hdr[1]
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        length = b1 & 0x7F

        if length == 126:
            length = struct.unpack("!H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(8))[0]

        if length > MAX_WS_FRAME_BYTES:
            raise ValueError(f"Incoming WS frame too large: {length} bytes")

        mask_key = self._read_exact(4) if masked else b""
        payload = self._read_exact(length) if length else b""
        if masked and payload:
            payload = bytes(b ^ mask_key[i & 3] for i, b in enumerate(payload))
        return fin, opcode, payload

    def _handle_message(self, opcode: int, payload: bytes) -> None:
        if opcode != 0x1:
            self.send_json({"type": "error", "message": "Binary messages from client are not supported"})
            return

        try:
            msg = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self.send_json({"type": "error", "message": f"Invalid JSON message: {exc}"})
            return

        if not isinstance(msg, dict):
            self.send_json({"type": "error", "message": "JSON message must be an object"})
            return

        mtype = msg.get("type")
        if mtype == "status":
            streaming = self.is_streaming()
            try:
                status = self.backend.get_status()
                status["type"] = "status"
                status["streaming"] = streaming
                self.send_json(status)
            except Exception as exc:
                self.send_json({"type": "error", "message": str(exc)})
        elif mtype == "stop":
            self.stop_streaming()
            self.send_json({
                "type": "status",
                "ok": True,
                "demo": self.backend.demo,
                "host": self.backend.host,
                "streaming": False,
            })
        elif mtype == "oneshot":
            try:
                node, length, bw, direct, preset = validate_capture_params(
                    msg.get("node", DEFAULT_NODE),
                    msg.get("len", DEFAULT_LEN),
                    msg.get("bw", DEFAULT_BW),
                    msg.get("direct", False),
                    msg.get("preset", "ofdm_wifi"),
                )
                band = parse_int_param(msg.get("band", 0), "band", 0, 0, 1)
                cap = self.backend.capture(node, length, bw, direct, preset=preset, band=band)
                self.send_binary_capture(cap)
            except Exception as exc:
                self.send_json({"type": "error", "message": str(exc)})
        elif mtype == "start":
            try:
                node, length, bw, direct, preset = validate_capture_params(
                    msg.get("node", DEFAULT_NODE),
                    msg.get("len", DEFAULT_LEN),
                    msg.get("bw", DEFAULT_BW),
                    msg.get("direct", False),
                    msg.get("preset", "ofdm_wifi"),
                )
                band = parse_int_param(msg.get("band", 0), "band", 0, 0, 1)
                interval_ms = parse_int_param(msg.get("intervalMs", 0), "intervalMs", 0, 0, 10000)
            except ValueError as exc:
                self.send_json({"type": "error", "message": str(exc)})
                return

            self.start_streaming(node, length, bw, direct, interval_ms, preset, band=band)
            self.send_json({
                "type": "status",
                "ok": True,
                "demo": self.backend.demo,
                "host": self.backend.host,
                "streaming": True,
                "node": node,
                "len": length,
                "bw": bw,
                "band": band,
                "direct": direct,
                "intervalMs": interval_ms,
                "preset": preset,
            })
        else:
            self.send_json({"type": "error", "message": f"Unknown message type: {mtype!r}"})

    def run(self) -> None:
        self.server.register_ws(self)
        frag_opcode: int | None = None
        frag_chunks: list[bytes] = []
        try:
            while not self.closed and not self.server.stop_event.is_set():
                fin, opcode, payload = self._recv_frame()
                if opcode >= 0x8:
                    if opcode == 0x8:
                        close_body = payload[:2] if len(payload) >= 2 else b""
                        self.send_frame(0x8, close_body)
                        self.closed = True
                        break
                    if opcode == 0x9:
                        self.send_frame(0xA, payload)
                        continue
                    if opcode == 0xA:
                        continue
                    self.send_frame(0x8, struct.pack("!H", 1002))
                    self.closed = True
                    break

                if opcode != 0x0:
                    if frag_opcode is not None:
                        self.send_frame(0x8, struct.pack("!H", 1002))
                        self.closed = True
                        break
                    if fin:
                        self._handle_message(opcode, payload)
                    else:
                        frag_opcode = opcode
                        frag_chunks = [payload]
                else:
                    if frag_opcode is None:
                        self.send_frame(0x8, struct.pack("!H", 1002))
                        self.closed = True
                        break
                    frag_chunks.append(payload)
                    if fin:
                        full_payload = b"".join(frag_chunks)
                        full_opcode = frag_opcode
                        frag_opcode = None
                        frag_chunks = []
                        self._handle_message(full_opcode, full_payload)
        except (EOFError, OSError, ValueError):
            pass
        finally:
            self.closed = True
            self.stop_streaming()
            self.server.unregister_ws(self)

    def force_close(self) -> None:
        self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class IQRequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP/1.1 + RFC 6455 WebSocket handler for the CT3003 IQ viewer."""

    protocol_version = "HTTP/1.1"
    server: "IQHttpServer"

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.server.quiet:
            return
        super().log_message(fmt, *args)

    def _send_bytes(
        self,
        status: int,
        content_type: str,
        body: bytes,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, status: int, obj: dict[str, Any]) -> None:
        body = json.dumps(obj, separators=(",", ":")).encode("utf-8")
        self._send_bytes(status, "application/json; charset=utf-8", body)

    def _serve_static(self, path: str) -> None:
        filename, content_type = STATIC_ROUTES[path]
        target = self.server.static_dir / filename
        if not target.is_file():
            self._send_json(404, {"ok": False, "error": f"Static file not found: {filename}"})
            return
        try:
            data = target.read_bytes()
        except OSError as exc:
            self._send_json(500, {"ok": False, "error": f"Failed to read {filename}: {exc}"})
            return
        self._send_bytes(200, content_type, data)

    def _serve_sample(self, raw_tail: str) -> None:
        try:
            path = self.server.backend.resolve_sample_path(raw_tail)
            size = path.stat().st_size
            with path.open("rb") as f:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except SampleAccessError as exc:
            self._send_json(exc.status_code, {"ok": False, "error": exc.message})
        except OSError as exc:
            self._send_json(500, {"ok": False, "error": f"Failed to stream sample: {exc}"})

    def _handle_capture(self, query_str: str) -> None:
        params = urllib.parse.parse_qs(query_str, keep_blank_values=True)

        def _first(key: str, default: Any = None) -> Any:
            vals = params.get(key)
            return vals[0] if vals else default

        try:
            node, length, bw, direct, preset = validate_capture_params(
                _first("node", DEFAULT_NODE),
                _first("len", DEFAULT_LEN),
                _first("bw", DEFAULT_BW),
                _first("direct", "0"),
                _first("preset", "ofdm_wifi"),
            )
            band = parse_int_param(_first("band", 0), "band", 0, 0, 1)
        except ValueError as exc:
            self._send_json(400, {"ok": False, "error": str(exc)})
            return

        try:
            cap = self.server.backend.capture(node, length, bw, direct, preset=preset, band=band)
        except BackendError as exc:
            self._send_json(502, {"ok": False, "error": str(exc)})
            return

        headers = {
            "X-IQ-Node": str(cap["node"]),
            "X-IQ-Words": str(cap["words"]),
            "X-IQ-Sample-Count": str(cap["sample_count"]),
            "X-IQ-CR0": f"0x{cap['cr0']:08x}",
            "X-IQ-CR9": f"0x{cap['cr9']:08x}",
            "X-IQ-Direct": "1" if cap["direct"] else "0",
            "X-IQ-Seq": str(cap["seq"]),
            "X-IQ-BW": str(cap["bw"]),
            "X-IQ-Band": str(cap.get("band", 0)),
            "X-IQ-Demo": "1" if cap["demo"] else "0",
        }
        self._send_bytes(200, "application/octet-stream", cap["payload"], extra_headers=headers)

    def _handle_websocket_upgrade(self) -> None:
        upgrade = self.headers.get("Upgrade", "")
        connection = self.headers.get("Connection", "")
        ws_key = self.headers.get("Sec-WebSocket-Key", "").strip()

        conn_tokens = {tok.strip().lower() for tok in connection.split(",") if tok.strip()}
        if upgrade.strip().lower() != "websocket" or "upgrade" not in conn_tokens or not ws_key:
            self._send_json(400, {"ok": False, "error": "Expected valid WebSocket upgrade headers"})
            return

        accept_digest = hashlib.sha1((ws_key + WS_GUID).encode("ascii")).digest()
        accept_b64 = base64.b64encode(accept_digest).decode("ascii")

        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_b64}\r\n"
            "\r\n"
        ).encode("ascii")
        self.wfile.write(resp)
        self.wfile.flush()
        self.close_connection = True

        session = WebSocketSession(self, self.server)
        session.run()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path

        if path == "/ws":
            self._handle_websocket_upgrade()
            return

        if path in STATIC_ROUTES:
            self._serve_static(path)
            return

        if path == "/api/config":
            self._send_json(200, self.server.backend.get_config())
            return

        if path == "/api/samples":
            self._send_json(200, {"ok": True, "files": self.server.backend.list_samples()})
            return

        if path.startswith("/samples/"):
            self._serve_sample(path[len("/samples/"):])
            return

        if path == "/api/status":
            try:
                status = self.server.backend.get_status()
            except BackendError as exc:
                self._send_json(502, {
                    "ok": False,
                    "demo": self.server.backend.demo,
                    "host": self.server.backend.host,
                    "error": str(exc),
                })
                return
            self._send_json(200, status)
            return

        if path == "/api/capture":
            self._handle_capture(parsed.query)
            return

        self._send_json(404, {"ok": False, "error": f"Not found: {path}"})


class IQHttpServer(http.server.ThreadingHTTPServer):
    """Threaded HTTP/WebSocket server with clean shutdown for active WS sessions."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: tuple[str, int],
        backend: IQBackend,
        *,
        static_dir: Path | None = None,
        quiet: bool = False,
    ) -> None:
        self.backend = backend
        self.static_dir = Path(static_dir) if static_dir is not None else Path(__file__).resolve().parent
        self.quiet = quiet
        self.stop_event = threading.Event()
        self._ws_lock = threading.Lock()
        self._ws_sessions: set[WebSocketSession] = set()
        super().__init__(server_address, IQRequestHandler)

    def register_ws(self, session: WebSocketSession) -> None:
        with self._ws_lock:
            self._ws_sessions.add(session)

    def unregister_ws(self, session: WebSocketSession) -> None:
        with self._ws_lock:
            self._ws_sessions.discard(session)

    def close_all_ws(self) -> None:
        with self._ws_lock:
            sessions = list(self._ws_sessions)
        for session in sessions:
            session.stop_streaming()
            session.force_close()

    def shutdown(self) -> None:
        self.stop_event.set()
        self.close_all_ws()
        super().shutdown()

    def server_close(self) -> None:
        self.stop_event.set()
        self.close_all_ws()
        super().server_close()


def create_server(
    *,
    bind: str = DEFAULT_BIND,
    port: int = DEFAULT_PORT,
    host: str = DEFAULT_HOST,
    ssh_cmd: str | Sequence[str] = "auto",
    remote_wmsdr: str = DEFAULT_REMOTE_WMSDR,
    samples_dir: str | Path | None = None,
    demo: bool = False,
    no_control_master: bool = False,
    static_dir: str | Path | None = None,
    quiet: bool = False,
) -> IQHttpServer:
    """Create and bind an IQHttpServer instance (port=0 picks an ephemeral port)."""
    backend = IQBackend(
        host=host,
        ssh_cmd=ssh_cmd,
        remote_wmsdr=remote_wmsdr,
        samples_dir=samples_dir,
        demo=demo,
        no_control_master=no_control_master,
    )
    resolved_static = Path(static_dir) if static_dir is not None else Path(__file__).resolve().parent
    return IQHttpServer((bind, port), backend, static_dir=resolved_static, quiet=quiet)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="CT3003 SDR IQ HTTP/WebSocket bridge server (Python 3 stdlib only)"
    )
    parser.add_argument("--bind", default=DEFAULT_BIND, help=f"Bind address (default: {DEFAULT_BIND})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Listen port (default: {DEFAULT_PORT})")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"SSH target host (default: {DEFAULT_HOST})")
    parser.add_argument(
        "--ssh-cmd",
        choices=("auto", "native", "wsl"),
        default="auto",
        help="SSH launcher mode: auto, native, or wsl (default: auto)",
    )
    parser.add_argument(
        "--remote-wmsdr",
        default=DEFAULT_REMOTE_WMSDR,
        help=f"Remote wmsdr path on target (default: {DEFAULT_REMOTE_WMSDR})",
    )
    parser.add_argument(
        "--samples-dir",
        type=Path,
        default=None,
        help="Optional directory exposing .bin/.iq/.s16le/.s32le/.cf32 files",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Use built-in synthetic CT3003 u32_12 generator instead of SSH hardware capture",
    )
    parser.add_argument(
        "--no-control-master",
        action="store_true",
        help="Disable SSH ControlMaster multiplexing",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    srv = create_server(
        bind=args.bind,
        port=args.port,
        host=args.host,
        ssh_cmd=args.ssh_cmd,
        remote_wmsdr=args.remote_wmsdr,
        samples_dir=args.samples_dir,
        demo=args.demo,
        no_control_master=args.no_control_master,
    )
    url = f"http://{srv.server_address[0]}:{srv.server_port}/"
    mode_desc = "DEMO (synthetic u32_12)" if args.demo else f"SSH ({args.host}, {' '.join(srv.backend.ssh_argv)})"
    print(f"CT3003 IQ viewer server listening at {url} [{mode_desc}]", flush=True)
    if args.samples_dir is not None:
        print(f"Serving samples from: {args.samples_dir}", flush=True)

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...", flush=True)
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
