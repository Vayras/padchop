// Global key estimation.
//
// Structure:
//   long-window STFT -> 72 semitone filters (C1..B6, A4 = 440 Hz) -> sum over the
//   whole track -> separate bass / treble chroma -> rotate-and-correlate against
//   major/minor templates.
// The templates are the published Krumhansl-Kessler probe-tone profiles, scored
// with Pearson correlation; padchop also reports a confidence margin.

import { FFT, hann } from './fft'
import type { KeyResult, Mode } from './types'

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const LOWEST_MIDI = 24 // C1, 32.70 Hz
const SEMITONES = 72 // six octaves up to B6
const BASS = [39, 52] // D#2..E3 (MIDI, inclusive): roots of the harmony
const TREBLE = [53, 95] // F3..B6
const BASS_WEIGHT = 0.35

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

interface Filter {
  lo: number
  weights: Float32Array
}

/** Raised-cosine filters roughly 0.8 semitone wide, one per semitone. */
function semitoneFilters(fftSize: number, sampleRate: number): Filter[] {
  const filters: Filter[] = []
  for (let s = 0; s < SEMITONES; s++) {
    const f = midiToHz(LOWEST_MIDI + s)
    const centre = (f * fftSize) / sampleRate
    const width = Math.max(1, centre * (Math.pow(2, 0.4 / 12) - Math.pow(2, -0.4 / 12)))
    const lo = Math.max(1, Math.ceil(centre - width / 2))
    const hi = Math.min(fftSize / 2, Math.floor(centre + width / 2))
    const n = Math.max(1, hi - lo + 1)
    const weights = new Float32Array(n)
    let sum = 0
    for (let b = 0; b < n; b++) {
      // Fall back to the single nearest bin when the filter is narrower than a bin.
      const x = n === 1 ? 0.5 : (lo + b - (centre - width / 2)) / width
      weights[b] = 0.5 - 0.5 * Math.cos(2 * Math.PI * Math.min(1, Math.max(0, x)))
      sum += weights[b]
    }
    if (sum === 0) weights.fill(1 / n)
    else for (let b = 0; b < n; b++) weights[b] /= sum
    filters.push({ lo: n === 1 ? Math.round(centre) : lo, weights })
  }
  return filters
}

/** Summed 72-semitone energy profile over the whole signal. */
export function semitoneProfile(signal: Float32Array, sampleRate: number): Float64Array {
  // ~0.37 s window at 22.05 kHz (8192) — enough resolution to split semitones near C2.
  const fftSize = sampleRate > 30000 ? 16384 : 8192
  const hop = fftSize / 4
  const fft = new FFT(fftSize)
  const win = hann(fftSize)
  const filters = semitoneFilters(fftSize, sampleRate)
  const frame = new Float32Array(fftSize)
  const mag = new Float32Array(fftSize / 2 + 1)
  const total = new Float64Array(SEMITONES)
  const energy = new Float64Array(SEMITONES)

  for (let start = 0; start + fftSize <= signal.length || start === 0; start += hop) {
    for (let i = 0; i < fftSize; i++) frame[i] = (signal[start + i] ?? 0) * win[i]
    fft.magnitude(frame, mag)
    let frameSum = 0
    for (let s = 0; s < SEMITONES; s++) {
      const { lo, weights } = filters[s]
      let e = 0
      for (let b = 0; b < weights.length; b++) {
        const m = mag[lo + b] ?? 0
        e += weights[b] * m * m
      }
      energy[s] = Math.sqrt(e)
      frameSum += energy[s]
    }
    // Per-frame normalisation so loud sections don't dominate the sum.
    if (frameSum > 1e-9) for (let s = 0; s < SEMITONES; s++) total[s] += energy[s] / frameSum
    if (start + fftSize > signal.length) break
  }
  return total
}

function fold(profile: Float64Array, fromMidi: number, toMidi: number): number[] {
  const c = new Array(12).fill(0)
  for (let m = fromMidi; m <= toMidi; m++) c[m % 12] += profile[m - LOWEST_MIDI] ?? 0
  const sum = c.reduce((a, b) => a + b, 0)
  return sum > 0 ? c.map((v) => v / sum) : c
}

function pearson(x: number[], y: number[]): number {
  const n = x.length
  const mx = x.reduce((a, b) => a + b, 0) / n
  const my = y.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx
    const dy = y[i] - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0
}

/** Template rotated so index 0 is pitch class `tonic`. */
function rotate(t: number[], tonic: number): number[] {
  return t.map((_, pc) => t[(pc - tonic + 12) % 12])
}

export function detectKey(signal: Float32Array, sampleRate: number): KeyResult {
  const profile = semitoneProfile(signal, sampleRate)
  const bass = fold(profile, BASS[0], BASS[1])
  const treble = fold(profile, TREBLE[0], TREBLE[1])
  const chroma = treble.map((v, i) => (1 - BASS_WEIGHT) * v + BASS_WEIGHT * bass[i])

  const scored: { tonic: number; mode: Mode; score: number }[] = []
  for (const [mode, template] of [['major', MAJOR], ['minor', MINOR]] as const) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const t = rotate(template, tonic)
      const score = (1 - BASS_WEIGHT) * pearson(treble, t) + BASS_WEIGHT * pearson(bass, t)
      scored.push({ tonic, mode, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const [best, second] = scored
  const max = Math.max(...chroma)
  return {
    tonic: best.tonic,
    mode: best.mode,
    score: best.score,
    confidence: Math.max(0, Math.min(1, (best.score - second.score) * 5)),
    chroma: chroma.map((v) => (max > 0 ? v / max : 0)),
    source: 'audio',
  }
}
