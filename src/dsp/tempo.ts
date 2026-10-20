// Tempo and beat tracking:
//
//   1. STFT at ~86 frames/s, 24 critical-band energies, mu-law log compression.
//   2. Two onset signals: a smooth, bass-weighted one for tempo and a sharper,
//      broadband one for beat placement (Butterworth low-pass -> diff -> rectify).
//   3. Tempo: bank of resonant comb filters (one per lag, 1.5 s half-life),
//      noise-baseline correction, octave reinforcement, log-likelihood histogram.
//   4. Beats: dynamic programming over beat positions with a stiff period prior.
//   5. Grid: least-squares fit; a straight grid when beats fit within a few ms.
//   6. Downbeat: where strong content steps up (ramp kernel over per-beat power).

import { FFT, hann } from './fft'
import type { TempoResult } from './types'

const FRAME_RATE = 86.1328125 // 44100 / 512
const MIN_BPM = 70
const MAX_BPM = 180
const COMB_HALF_LIFE = 1.5 // seconds

// Critical-band layout (centre and half-width, Hz).
const BAND_CENTRES = [50, 150, 250, 350, 450, 570, 700, 840, 1000, 1170, 1370, 1600, 1850, 2150, 2500, 2900, 3400, 4000, 4800, 5800, 7000, 8500, 10500, 13500]
const BAND_HALF = [80, 100, 100, 100, 110, 120, 140, 150, 160, 190, 210, 240, 280, 320, 380, 450, 550, 700, 900, 1100, 1300, 1800, 2500, 3500]

// Per-band weights for the three derived signals.
const TEMPO_W = BAND_CENTRES.map((_, i) => (i === 0 ? 12 : i === 1 ? 5 : 1))
const BEAT_W = BAND_CENTRES.map((_, i) => (i < 6 ? 4 : 1))
const POWER_W = BAND_CENTRES.map((_, i) => [3, 5, 4][i] ?? (i >= 16 && i < 22 ? 0.5 : 0))

// 4th-order Butterworth low-pass sections, Wn relative to Nyquist of the frame rate.
const LP_SMOOTH = { b: [2.544e-4, 1.0176e-3, 1.5264e-3, 1.0176e-3, 2.544e-4], a: [1, -3.28338, 4.0959, -2.29504, 0.48659] } // ~3.8 Hz
const LP_SHARP = { b: [0.09398, 0.37592, 0.56388, 0.37592, 0.09398], a: [1, 0, 0.48603, 0, 0.01766] } // ~21.5 Hz

export interface BeatFeatures {
  rate: number
  tempoOnset: Float32Array
  beatOnset: Float32Array
  power: Float32Array
}

function triangularBands(fftSize: number, sampleRate: number): { lo: number; w: Float32Array }[] {
  const binHz = sampleRate / fftSize
  return BAND_CENTRES.map((c, i) => {
    const half = BAND_HALF[i]
    const lo = Math.max(1, Math.ceil((c - half) / binHz))
    const hi = Math.min(fftSize / 2, Math.floor((c + half) / binHz))
    const w = new Float32Array(Math.max(0, hi - lo + 1))
    let sum = 0
    for (let k = lo; k <= hi; k++) {
      const v = Math.max(0, 1 - Math.abs(k * binHz - c) / half)
      w[k - lo] = v
      sum += v
    }
    // Bands narrower than a bin get the nearest bin; bands above Nyquist stay empty.
    if (sum === 0 && c < sampleRate / 2) {
      const k = Math.min(fftSize / 2, Math.max(1, Math.round(c / binHz)))
      return { lo: k, w: new Float32Array([1]) }
    }
    for (let k = 0; k < w.length; k++) w[k] /= sum || 1
    return { lo, w }
  })
}

function iir(x: Float32Array, { b, a }: { b: number[]; a: number[] }, reverse = false): Float32Array {
  const n = x.length
  const y = new Float32Array(n)
  const xi = (i: number) => x[reverse ? n - 1 - i : i]
  const yv = new Float64Array(n)
  // Start at steady state for the first sample to avoid a start-up transient.
  const x0 = n ? xi(0) : 0
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let k = 0; k < b.length; k++) v += b[k] * (i - k >= 0 ? xi(i - k) : x0)
    for (let k = 1; k < a.length; k++) v -= a[k] * (i - k >= 0 ? yv[i - k] : x0)
    yv[i] = v
  }
  for (let i = 0; i < n; i++) y[reverse ? n - 1 - i : i] = yv[i]
  return y
}

const filtfilt = (x: Float32Array, f: { b: number[]; a: number[] }) => iir(iir(x, f), f, true)

function diffRectify(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length)
  for (let i = 1; i < x.length; i++) y[i] = Math.max(0, x[i] - x[i - 1])
  return y
}

export function beatFeatures(signal: Float32Array, sampleRate: number): BeatFeatures {
  const hop = Math.round(sampleRate / FRAME_RATE)
  const fftSize = 1 << (Math.floor(Math.log2(hop)) + 1)
  const fft = new FFT(fftSize)
  const win = hann(fftSize)
  const bands = triangularBands(fftSize, sampleRate)
  const nFrames = Math.ceil(signal.length / hop)
  const B = bands.length
  const bandSig = Array.from({ length: B }, () => new Float32Array(nFrames))
  const frame = new Float32Array(fftSize)
  const mag = new Float32Array(fftSize / 2 + 1)
  const mu = 1 / Math.log(101)

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop - fftSize / 2
    for (let i = 0; i < fftSize; i++) frame[i] = (signal[start + i] ?? 0) * win[i]
    fft.magnitude(frame, mag)
    for (let b = 0; b < B; b++) {
      const { lo, w } = bands[b]
      let e = 0
      for (let k = 0; k < w.length; k++) e += w[k] * mag[lo + k] * mag[lo + k]
      bandSig[b][f] = Math.log1p(100 * e) * mu
    }
  }

  const tempoOnset = new Float32Array(nFrames)
  const beatOnset = new Float32Array(nFrames)
  const power = new Float32Array(nFrames)
  for (let b = 0; b < B; b++) {
    const smooth = diffRectify(filtfilt(bandSig[b], LP_SMOOTH))
    const sharp = diffRectify(filtfilt(bandSig[b], LP_SHARP))
    for (let f = 0; f < nFrames; f++) {
      tempoOnset[f] += TEMPO_W[b] * smooth[f]
      beatOnset[f] += BEAT_W[b] * sharp[f]
      power[f] += POWER_W[b] * bandSig[b][f]
    }
  }
  return { rate: sampleRate / hop, tempoOnset, beatOnset, power }
}

/** Upsample by 2 with linear interpolation (tempo/beat stages run at ~172 Hz). */
function upsample2(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length * 2)
  for (let i = 0; i < x.length; i++) {
    y[2 * i] = x[i]
    y[2 * i + 1] = i + 1 < x.length ? 0.5 * (x[i] + x[i + 1]) : x[i]
  }
  return y
}

/**
 * Tempo histogram from a resonant comb-filter bank. Returns log-likelihood per
 * integer lag (frames at `rate`).
 */
export function combHistogram(onset: Float32Array, rate: number, minBpm = MIN_BPM, maxBpm = MAX_BPM): Float64Array {
  const lagMin = Math.floor((60 * rate) / maxBpm)
  const lagMax = Math.ceil((60 * rate) / minBpm)
  const lagLo = Math.max(2, Math.floor(lagMin / 2))
  const n = onset.length
  const hist = new Float64Array(lagMax + 1)
  const score = new Float64Array(lagMax + 2)
  const step = Math.max(1, Math.round(rate / 4)) // evaluate 4x per second

  const outputs: Float32Array[] = []
  const alphas: number[] = []
  for (let lag = lagLo; lag <= lagMax; lag++) {
    const alpha = Math.pow(2, -lag / (COMB_HALF_LIFE * rate))
    alphas[lag] = alpha
    const y = new Float32Array(n)
    for (let i = 0; i < n; i++) y[i] = (1 - alpha) * onset[i] + (i >= lag ? alpha * y[i - lag] : 0)
    outputs[lag] = y
  }

  // Leaky average of input energy, for normalisation.
  const inEnergy = new Float64Array(n)
  const leak = Math.pow(2, -1 / (COMB_HALF_LIFE * rate))
  let acc = 0
  for (let i = 0; i < n; i++) {
    acc = leak * acc + (1 - leak) * onset[i] * onset[i]
    inEnergy[i] = acc
  }
  let maxEnergy = 0
  for (const e of inEnergy) maxEnergy = Math.max(maxEnergy, e)

  for (let i = lagMax; i < n; i += step) {
    const norm = Math.max(inEnergy[i], 0.05 * maxEnergy)
    if (norm <= 0) continue
    for (let lag = lagLo; lag <= lagMax; lag++) {
      const y = outputs[lag]
      let e = 0
      for (let k = 0; k < lag; k++) e += y[i - k] * y[i - k]
      e /= lag * norm
      // Expected output/input energy ratio for white noise.
      const a = alphas[lag]
      const c = (1 - a) / (1 + a)
      score[lag] = Math.max(0, (e - c) / (1 - c))
    }
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const h = lag >> 1
      const octave = Math.max(score[h] ?? 0, score[h + 1] ?? 0, 0.001)
      hist[lag] += Math.log(score[lag] * octave + 0.01)
    }
  }
  for (let lag = 0; lag < lagMin; lag++) hist[lag] = -Infinity
  return hist
}

/** Peak lag with parabolic interpolation. */
function peakLag(hist: Float64Array): number {
  let best = -1
  for (let i = 0; i < hist.length; i++) if (best < 0 || hist[i] > hist[best]) best = i
  const l = hist[best - 1]
  const r = hist[best + 1]
  if (!Number.isFinite(l) || !Number.isFinite(r)) return best
  const d = l - 2 * hist[best] + r
  return d < 0 ? best + (0.5 * (l - r)) / d : best
}

/** Bidirectional comb at period P: periodic onset evidence. */
function combEvidence(x: Float32Array, period: number, rate: number): Float32Array {
  const P = Math.max(1, Math.round(period))
  const alpha = Math.pow(2, -P / (COMB_HALF_LIFE * rate))
  const n = x.length
  const fwd = new Float32Array(n)
  const bwd = new Float32Array(n)
  for (let i = 0; i < n; i++) fwd[i] = (1 - alpha) * x[i] + (i >= P ? alpha * fwd[i - P] : 0)
  for (let i = n - 1; i >= 0; i--) bwd[i] = (1 - alpha) * x[i] + (i + P < n ? alpha * bwd[i + P] : 0)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = fwd[i] + bwd[i] - (1 - alpha) * x[i]
  return out
}

/** Dynamic-programming beat placement with a stiff period prior. */
export function trackBeats(onset: Float32Array, period: number, rate: number): number[] {
  const ev = combEvidence(onset, period, rate)
  let max = 0
  for (const v of ev) max = Math.max(max, v)
  if (max === 0) return []
  const n = ev.length
  const local = new Float64Array(n)
  for (let i = 0; i < n; i++) local[i] = Math.max(-10, Math.log(ev[i] / max + 1e-6))
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const lo = Math.round(period * 0.8)
  const hi = Math.round(period * 1.2)
  for (let i = 0; i < n; i++) {
    let best = 0
    let arg = -1
    for (let d = lo; d <= hi && i - d >= 0; d++) {
      const dev = (d - period) / period
      const s = score[i - d] - 2500 * dev * dev
      if (arg < 0 || s > best) { best = s; arg = i - d }
    }
    score[i] = local[i] + (arg >= 0 ? best : 0)
    back[i] = arg
  }
  // Best end point within the last period.
  let end = n - 1
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[end]) end = i
  const frames: number[] = []
  for (let i = end; i >= 0; i = back[i]) frames.push(i)
  return frames.reverse().map((f) => f / rate)
}

/** Least-squares line through beat times: period and phase. */
export function fitGrid(beats: number[]): { period: number; t0: number; meanError: number } {
  const n = beats.length
  const mi = (n - 1) / 2
  const mt = beats.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0
  beats.forEach((t, i) => { sxy += (i - mi) * (t - mt); sxx += (i - mi) ** 2 })
  const period = sxx > 0 ? sxy / sxx : 0
  const t0 = mt - period * mi
  const meanError = beats.reduce((a, t, i) => a + Math.abs(t - (t0 + period * i)), 0) / n
  return { period, t0, meanError }
}

/**
 * Downbeat = the beat where strong content starts: antisymmetric 16-beat ramp
 * over per-beat power/transient strength. Short material falls back to the
 * bar phase with the strongest low-end hits.
 */
export function findDownbeat(beats: number[], f: BeatFeatures): number {
  if (beats.length < 4) return 0
  const at = (sig: Float32Array, t: number, radius: number) => {
    const c = Math.round(t * f.rate)
    const r = Math.round(radius * f.rate)
    let m = 0
    for (let i = Math.max(0, c - r); i <= Math.min(sig.length - 1, c + r); i++) m = Math.max(m, sig[i])
    return m
  }
  const beatPower = beats.map((t) => at(f.power, t, 0.1))
  const beatHit = beats.map((t) => at(f.beatOnset, t, 0.05))

  if (beats.length >= 24) {
    const kernel = [...Array.from({ length: 8 }, (_, k) => -(8 - k) / 72), ...Array.from({ length: 8 }, (_, k) => (8 - k) / 72)]
    let best = 0
    let arg = 0
    for (let i = 0; i < beats.length - 8; i++) {
      let d = 0
      for (let k = 0; k < 16; k++) {
        const j = i - 8 + k
        const v = j >= 0 && j < beats.length ? beatPower[j] + 0.35 * beatHit[j] : 0
        d += kernel[k] * v
      }
      if (d > best) { best = d; arg = i }
    }
    if (best > 0) return arg
  }
  // Bar phase: which of the 4 beat positions carries the strongest hits.
  let bestPhase = 0
  let bestVal = -Infinity
  for (let p = 0; p < 4; p++) {
    let s = 0, c = 0
    for (let i = p; i < beats.length; i += 4) { s += beatHit[i] + beatPower[i]; c++ }
    if (c && s / c > bestVal) { bestVal = s / c; bestPhase = p }
  }
  return bestPhase
}

const OFFBEAT_DOUBLE = 0.6

/** Mean onset peak halfway between beats relative to the mean peak on beats. */
export function offbeatRatio(onset: Float32Array, beats: number[], rate: number): number {
  const peak = (t: number) => {
    const c = Math.round(t * rate)
    const r = Math.round(0.03 * rate)
    let m = 0
    for (let i = Math.max(0, c - r); i <= Math.min(onset.length - 1, c + r); i++) m = Math.max(m, onset[i])
    return m
  }
  let on = 0, off = 0
  for (let i = 0; i + 1 < beats.length; i++) {
    on += peak(beats[i])
    off += peak((beats[i] + beats[i + 1]) / 2)
  }
  return on > 0 ? off / on : 0
}

export interface TempoOptions {
  /** Known/approximate BPM (e.g. from a file tag or name); the search narrows to ±12.5 BPM around it. */
  hintBpm?: number
}

const TILE_SECONDS = 30
const LOOP_BEATS = [4, 8, 12, 16, 24, 32, 48, 64]
const LOOP_MARGIN = 0.15

/** Repeat a short envelope so the 1.5 s comb filters can settle. */
function tile(x: Float32Array, rate: number): Float32Array {
  const reps = Math.ceil((TILE_SECONDS * rate) / Math.max(1, x.length))
  if (reps <= 1) return x
  const y = new Float32Array(x.length * reps)
  for (let r = 0; r < reps; r++) y.set(x, r * x.length)
  return y
}

function histAt(hist: Float64Array, lag: number): number {
  const i = Math.floor(lag)
  const f = lag - i
  const a = hist[i]
  const b = hist[i + 1]
  if (!Number.isFinite(a)) return b
  if (!Number.isFinite(b)) return a
  return a * (1 - f) + b * f
}

export function detectTempo(signal: Float32Array, sampleRate: number, opts: TempoOptions = {}): TempoResult {
  const features = beatFeatures(signal, sampleRate)
  const rate2 = features.rate * 2
  const beatOnset = upsample2(features.beatOnset)
  const duration = signal.length / sampleRate
  if (duration < 1) return { bpm: opts.hintBpm ?? 120, beats: [], downbeatIndex: 0, confidence: 0, source: opts.hintBpm ? 'name' : 'audio' }

  let minBpm = MIN_BPM
  let maxBpm = MAX_BPM
  if (opts.hintBpm) {
    minBpm = Math.max(40, opts.hintBpm - 12.5)
    maxBpm = Math.min(185, opts.hintBpm + 12.5)
  }

  const hist = combHistogram(upsample2(tile(features.tempoOnset, features.rate)), rate2, minBpm, maxBpm)
  const finite = Array.from(hist).filter(Number.isFinite)
  if (finite.length === 0) return { bpm: opts.hintBpm ?? 120, beats: [], downbeatIndex: 0, confidence: 0, source: opts.hintBpm ? 'name' : 'audio' }
  const sorted = [...finite].sort((a, b) => b - a)
  const top = sorted[0]
  const spread = top - sorted[sorted.length - 1]

  let lag = peakLag(hist)
  // Loops: sample-pack material is usually cut to a whole number of bars, so a
  // tempo that fits the length exactly wins unless the evidence clearly disagrees.
  const loopLags = LOOP_BEATS.map((n) => (60 * rate2 * duration) / (60 * n))
    .filter((l) => (60 * rate2) / l >= minBpm && (60 * rate2) / l <= maxBpm)
  if (loopLags.length && spread > 0) {
    const best = loopLags.reduce((a, b) => (histAt(hist, b) > histAt(hist, a) ? b : a))
    if (histAt(hist, best) >= top - LOOP_MARGIN * spread) lag = best
  }
  // Octave check: comb histograms favour the half tempo when the kick only lands
  // on beats 1 and 3. If the off-beats carry nearly as much onset energy as the
  // beats (the snare on 2 and 4), the true tempo is double.
  if ((60 * rate2) / (lag / 2) <= maxBpm && offbeatRatio(beatOnset, trackBeats(beatOnset, lag, rate2), rate2) > OFFBEAT_DOUBLE) {
    lag /= 2
  }
  // A labelled tempo is trusted exactly; analysis only finds the beat phase.
  if (opts.hintBpm) lag = (60 * rate2) / opts.hintBpm
  const confidence = spread > 0 ? Math.min(1, ((top - sorted[Math.min(5, sorted.length - 1)]) / spread) * 4) : 0

  let beats = trackBeats(beatOnset, lag, rate2)
  let bpm = (60 * rate2) / lag
  if (beats.length >= 4) {
    const grid = fitGrid(beats)
    const fittedBpm = 60 / grid.period
    if (!opts.hintBpm && Math.abs(fittedBpm - bpm) / bpm < 0.02) bpm = fittedBpm
    // Steady material: replace tracked beats with an exact grid (one tempo marker
    // for the whole track when every beat fits within a few ms).
    if (grid.meanError <= 0.012 || opts.hintBpm) {
      const period = 60 / bpm
      let t = grid.t0 + (grid.period - period) * ((beats.length - 1) / 2)
      while (t - period >= -0.03) t -= period
      beats = []
      for (; t < duration; t += period) if (t >= -0.03) beats.push(Math.max(0, t))
    }
  }
  const downbeatIndex = findDownbeat(beats, features)
  return { bpm, beats, downbeatIndex, confidence, source: opts.hintBpm ? 'name' : 'audio' }
}
