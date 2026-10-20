// "Find samples" regions:
// 8 band powers -> per-0.5 s means -> log-squared levels -> low/mid/high colour
// channels -> Rec.709 luminance ("waveform brightness"). Windows of medium
// brightness (busy but not dense) are kept and merged into regions.

import { FFT } from './fft'
import type { Region } from './types'

const BAND_EDGES = [170, 340, 680, 1360, 2720, 5440, 10880] // Hz; 8 bands
const WINDOW_SECONDS = 0.5
const KEEP_MIN = 0.26
const KEEP_MAX = 0.49

/** Brightness score per 0.5 s window. */
export function brightness(signal: Float32Array, sampleRate: number): Float32Array {
  // ~11.6 ms frames: 512 points at 44.1 kHz, 256 at 22.05 kHz.
  const n = sampleRate > 30000 ? 512 : 256
  const fft = new FFT(n)
  const bins = n / 2 + 1
  const bandOf = new Uint8Array(bins)
  for (let j = 0; j < bins; j++) {
    const hz = (j * sampleRate) / n
    let b = 0
    while (b < BAND_EDGES.length && hz >= BAND_EDGES[b]) b++
    bandOf[j] = b
  }

  let peak = 0
  for (let i = 0; i < signal.length; i++) peak = Math.max(peak, Math.abs(signal[i]))
  const gain = peak > 0 && peak < 0.95 ? 1 / (peak * peak) : 1

  const framesPerWindow = Math.max(1, Math.round((WINDOW_SECONDS * sampleRate) / n))
  const nFrames = Math.floor(signal.length / n)
  const nWindows = Math.ceil(nFrames / framesPerWindow)
  const scores = new Float32Array(nWindows)
  const frame = new Float32Array(n)
  const mag = new Float32Array(bins)
  const acc = new Float64Array(8)
  const L = new Float64Array(8)

  for (let w = 0; w < nWindows; w++) {
    acc.fill(0)
    const f0 = w * framesPerWindow
    const f1 = Math.min(nFrames, f0 + framesPerWindow)
    for (let f = f0; f < f1; f++) {
      for (let i = 0; i < n; i++) frame[i] = signal[f * n + i]
      fft.magnitude(frame, mag)
      for (let j = 1; j < bins; j++) acc[bandOf[j]] += (mag[j] * mag[j]) / (n * n)
    }
    for (let b = 0; b < 8; b++) {
      const mean = (acc[b] * gain) / Math.max(1, f1 - f0)
      L[b] = Math.max(0, Math.log(mean + 1e-30) + 9.21) ** 2
    }
    const low = 0.018 * L[0] + 0.012 * L[1] + 0.006 * L[2]
    const mid = 0.012 * L[2] + 0.018 * L[3] + 0.012 * L[4]
    const high = 0.006 * L[4] + 0.012 * L[5] + 0.018 * L[6] + 0.024 * L[7]
    scores[w] =
      0.2126 * Math.min(low + 0.2, 1) + 0.7152 * Math.min(mid + 0.2, 1) + 0.0722 * Math.min(high + 0.2, 1)
  }
  return scores
}

export function findRegions(signal: Float32Array, sampleRate: number): Region[] {
  const duration = signal.length / sampleRate
  const scores = brightness(signal, sampleRate)
  const regions: Region[] = []
  let open: Region | null = null
  for (let w = 0; w < scores.length; w++) {
    const keep = scores[w] >= KEEP_MIN && scores[w] < KEEP_MAX
    const t = w * WINDOW_SECONDS
    if (keep) {
      if (!open) open = { start: t, end: t, score: 0 }
      open.end = Math.min(duration, t + WINDOW_SECONDS)
      open.score += scores[w]
    } else if (open) {
      regions.push(open)
      open = null
    }
  }
  if (open) regions.push(open)
  return regions
}
