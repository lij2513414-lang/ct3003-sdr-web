export interface Rf7976SxState {
  est_lo_khz: number;
  est_lo_mhz: number;
  chinfo_lo_khz: number;
  chinfo_lo_mhz: number;
  sx_locked: number;
  vco_state: number;
  band_code: number;
  vtune: number;
  reg_int: number;
  reg_frac: number;
  xtal_133: number;
  status_ca4: number;
  vtmon_cd1: number;
  lo_route_021: number;
  lo_ctrl_002: number;
}

export interface Rf7976RateState {
  icap_node: number;
  bw_idx: number;
  bw_mhz: number;
  pri_ch: number;
  rx_n: number;
  tx_n: number;
  adc_fs_mhz: number;
  rxfd_fs_mhz: number;
  active_fs_mhz: number;
  adie_101: number;
  adie_105: number;
  adie_122: number;
  adie_171: number;
  ddie_80050: number;
}

export interface Rf7976RxGainState {
  agc_lock: number;
  rx_decode: number;
  pd_en: number;
  lna: number;
  pga: number;
  rfdgc: number;
  total_gain_db: number;
  mon_raw: number;
  ovr_raw: number;
  rfdgc_raw: number;
  pd_raw: number;
  adie_060: number;
  adie_070: number;
  adie_010: number;
  adie_011: number;
  adie_744: number;
}

export interface Rf7976FilterState {
  rc_code: number;
  rc_cal_res: number;
  rc_applied: number;
  adie_bw_idx: number;
  ddie_bw_idx: number;
  adie_100: number;
  adie_102: number;
  adie_172: number;
  adie_934: number;
  adie_e50: number;
  adie_e51: number;
  adie_ece: number;
  fc14: number;
  a3020: number;
  ddie_81044: number;
}

export interface Rf7976TempState {
  valid: boolean;
  temp_c: number;
  temp_mc?: number;
  adc: number;
  adie_030?: number;
  chip_id?: number;
  adie_138?: number;
  slope?: number;
  t_adc0?: number;
  t0_c?: number;
  efuse_t0?: boolean;
  protocol?: string;
}

export interface Rf7976State {
  ok: boolean;
  allow_tx: boolean;
  has_snapshot: boolean;
  sync_chinfo?: boolean;
  restored?: boolean;
  band: 0 | 1;
  wf: 0 | 1;
  batch_version: number;
  sx: Rf7976SxState;
  rate: Rf7976RateState;
  rx: Rf7976RxGainState;
  filter: Rf7976FilterState;
  temp?: Rf7976TempState;
  [ext: string]: unknown;
}

export const RF_SX0_LO_MIN_MHZ = 1824;
export const RF_SX1_LO_MIN_MHZ = 4565;
export const RF_SX0_VCO_MIN_MHZ = 5836.8;
export const RF_SX1_VCO_MIN_MHZ = 7304.0;
export const RF_VCO_MAX_MHZ = 9900;

export interface RfApplyPayload {
  band?: 0 | 1;
  wf?: 0 | 1;
  icap_node?: number;
  sync_chinfo?: boolean;
  lo_mhz?: number;
  freq_khz?: number;
  lo_force_on?: boolean | number;
  ttg_enable?: boolean | number;
  bw_idx?: number;
  bw_mhz?: number;
  adie_bw?: number;
  ddie_bw?: number;
  sample_rate_mhz?: number;
  agc_mode?: 'auto' | 'lock';
  agc_lock?: boolean | number;
  lna?: number;
  pga?: number;
  rfdgc?: number;
  pd_en?: boolean | number;
  rc_code?: number;
  rc_cal?: boolean;
  [ext: string]: unknown;
}

export const RF_BW_OPTIONS: ReadonlyArray<{ idx: number; mhz: number; fiveGOnly?: boolean }> = [
  { idx: 0, mhz: 20 },
  { idx: 1, mhz: 40 },
  { idx: 2, mhz: 80, fiveGOnly: true },
  { idx: 3, mhz: 160, fiveGOnly: true },
];

/** Compute actual hardware complex sample rate (Msps) for the active band, ICAP node, and BW index. */
export function computeRfSampleRateMhz(band: 0 | 1, node: number, bwIdx: number): number {
  if (node === 15) {
    return band === 1 ? 160 : 80;
  }
  if (node === 6 || node === 8) {
    if (band === 0) {
      return bwIdx <= 0 ? 40 : 80;
    }
    const bwMhz = bwIdx >= 3 ? 160 : bwIdx === 2 ? 80 : 40;
    return bwMhz;
  }
  return band === 1 ? 160 : 80;
}

export function fmtRfHex(v: number | undefined | null, width = 8): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width, '0');
}
