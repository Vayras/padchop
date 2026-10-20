// Transient detection: octave bands anchored at ~86 Hz, log band energy, onset = rise above the
// maximum of the previous 8 frames, transient when the summed squared onsets
// pass a threshold, then peak picking so each transient becomes one time + strength.

import { FFT, hann } from './fft'
import type { Onset } from './types'

export const TRANSIENT_FFT = 512
export const TRANSIENT_HOP = 256
const BAND_BASE_HZ = 86.13 // 44100 / 512
const BANDS = 8
const LOOKBACK = 8
const THRESHOLD = 0.04

export interface TransientFrames {
  /** Summed squared band onsets per frame. */
  intensity: Float32Array
  /** Low-band (lowest two octaves, ~86-344 Hz) onset per frame — kick-ish energy. */
  low: Float32Array
  /** Frames per second. */
  rate: number
  /** Analysis window length in seconds. */
  frameSeconds: number
}

export function transientFrames(signal: Float32Array, sampleRate: number): TransientFrames {
  const fft = new FFT(TRANSIENT_FFT)
  const win = hann(TRANSIENT_FFT)
  const bins = TRANSIENT_FFT / 2 + 1
  const bandOf = new Int8Array(bins).fill(-1)
  for (let j = 1; j < bins; j++) {
    const b = Math.floor(Math.log2((j * sampleRate) / TRANSIENT_FFT / BAND_BASE_HZ))
    bandOf[j] = Math.max(0, Math.min(BANDS, b))
  }
  const nFrames = Math.ceil(signal.length / TRANSIENT_HOP)
  const levels: Float32Array[] = []
  const intensity = new Float32Array(nFrames)
  const low = new Float32Array(nFrames)
  const frame = new Float32Array(TRANSIENT_FFT)
  const mag = new Float32Array(bins)
  const energy = new Float64Array(BANDS + 1)

  for (let f = 0; f < nFrames; f++) {
    const start = f * TRANSIENT_HOP
    for (let i = 0; i < TRANSIENT_FFT; i++) frame[i] = (signal[start + i] ?? 0) * win[i]
    fft.magnitude(frame, mag)
    energy.fill(0)
    for (let j = 1; j < bins; j++) energy[bandOf[j]] += mag[j] * mag[j]
    // Log band level, ln(E) / 5, floored at zero; the top band is dropped.
    const level = new Float32Array(BANDS)
    for (let b = 0; b < BANDS; b++) level[b] = Math.max(0, Math.log(energy[b] + 1e-12) / 5)
    levels.push(level)

    let s = 0
    for (let b = 0; b < BANDS; b++) {
      let prevMax = 0
      for (let k = Math.max(0, f - LOOKBACK); k < f; k++) prevMax = Math.max(prevMax, levels[k][b])
      const o = Math.max(0, level[b] - prevMax)
      s += o * o
      if (b < 2) low[f] += o
    }
    intensity[f] = s
  }
  return { intensity, low, rate: sampleRate / TRANSIENT_HOP, frameSeconds: TRANSIENT_FFT / sampleRate }
}

/**
 * One onset per run of above-threshold frames (single-frame gaps closed), placed at the run's strongest frame; strength = intensity relative to
 * the loudest transient. Onsets closer than `minGap` seconds keep the stronger.
 */
export function pickTransients(tf: TransientFrames, minGap = 0.05): Onset[] {
  const { intensity, rate, frameSeconds } = tf
  const flagged = Array.from(intensity, (s) => s > THRESHOLD)
  for (let i = 1; i < flagged.length - 1; i++) if (!flagged[i] && flagged[i - 1] && flagged[i + 1]) flagged[i] = true

  const raw: { frame: number; s: number }[] = []
  for (let i = 0; i < flagged.length; i++) {
    if (!flagged[i]) continue
    let best = i
    while (i + 1 < flagged.length && flagged[i + 1]) {
      i++
      if (intensity[i] > intensity[best]) best = i
    }
    raw.push({ frame: best, s: intensity[best] })
  }
  const gap = minGap * rate
  const kept: { frame: number; s: number }[] = []
  for (const r of raw) {
    const last = kept[kept.length - 1]
    if (last && r.frame - last.frame < gap) {
      if (r.s > last.s) kept[kept.length - 1] = r
    } else kept.push(r)
  }
  const max = kept.reduce((m, r) => Math.max(m, r.s), 0)
  // The rise peaks when the attack reaches the middle of the analysis window.
  return kept.map((r) => ({ time: r.frame / rate + frameSeconds / 2, strength: max > 0 ? Math.sqrt(r.s / max) : 0 }))
}
