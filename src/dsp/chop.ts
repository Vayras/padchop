// Auto-chop modes: find samples, slicer, random, transients and key shift.

import { makeSlice, PAD_COUNT, type Slice } from '../model/slices'
import type { AnalysisResult } from './types'

export type ChopMode = 'find' | 'slicer' | 'random' | 'transients' | 'keys'

export interface ChopSettings {
  mode: ChopMode
  /** Slicer: slice length in beats. */
  beatStep: number
  /** Slicer: shift the whole set by this many slice lengths. */
  offset: number
  /** Transients: minimum spacing between chosen onsets, seconds. */
  minGap: number
  /** Random / find: changes the draw. */
  seed: number
}

export const DEFAULT_CHOP: ChopSettings = { mode: 'find', beatStep: 1, offset: 0, minGap: 0.25, seed: 1 }

export const CHOP_MODES: { id: ChopMode; label: string; hint: string }[] = [
  { id: 'find', label: 'Find samples', hint: 'Beats inside busy-but-not-dense parts of the song' },
  { id: 'slicer', label: 'Slicer', hint: 'Equal slices on the beatgrid from the cursor' },
  { id: 'random', label: 'Random', hint: 'Random beats across the whole song' },
  { id: 'transients', label: 'Transients', hint: 'The strongest hits, spaced apart' },
  { id: 'keys', label: 'Key shift', hint: 'One chop played chromatically across all pads' },
]

export const BEAT_STEPS = [
  { beats: 0.5, label: '½' },
  { beats: 1, label: '1' },
  { beats: 2, label: '2' },
  { beats: 4, label: '4' },
  { beats: 8, label: '8' },
  { beats: 16, label: '16' },
]

const TAIL_GUARD = 0.5 // never start a chop in the last half second

/**
 * Starting chop for a new sample. Long songs: Find samples. Short loops and
 * one-shots: Slicer across the whole clip, with the slice length chosen so
 * 16 pads cover it.
 */
export function initialChop(a: AnalysisResult): ChopSettings {
  if (a.duration > 30) return DEFAULT_CHOP
  const beats = (a.duration * a.tempo.bpm) / 60
  const step = BEAT_STEPS.find((b) => beats / b.beats <= PAD_COUNT)?.beats ?? 16
  return { ...DEFAULT_CHOP, mode: 'slicer', beatStep: step }
}

/** Deterministic PRNG so "shuffle" is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickRandom<T>(items: T[], n: number, rand: () => number): T[] {
  const a = [...items]
  const k = Math.min(n, a.length)
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (a.length - i))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, k)
}

/** Each chop runs to the next beat-aligned chop, capped at one bar. */
function startsToSlices(starts: number[], a: AnalysisResult): Slice[] {
  const sorted = [...starts].sort((x, y) => x - y)
  const bar = (4 * 60) / a.tempo.bpm
  return sorted.map((t, i) => {
    const next = i + 1 < sorted.length ? sorted[i + 1] : a.duration
    return makeSlice(t, Math.min(next, t + bar, a.duration))
  })
}

export function autoChop(a: AnalysisResult, s: ChopSettings, cursor = 0): Slice[] {
  const beats = a.tempo.beats.filter((b) => b < a.duration - TAIL_GUARD)
  const rand = mulberry32(s.seed * 7919 + 1)

  switch (s.mode) {
    case 'random': {
      if (a.duration <= 3.5) return [makeSlice(0, a.duration)]
      if (beats.length < PAD_COUNT) {
        const times = Array.from({ length: PAD_COUNT }, () => rand() * (a.duration - TAIL_GUARD))
        return startsToSlices(times, a)
      }
      return startsToSlices(pickRandom(beats, PAD_COUNT, rand), a)
    }

    case 'find': {
      const inRegion = beats.filter((b) => a.regions.some((r) => b >= r.start && b < r.end))
      // Fewer candidates than pads: use them all and leave the rest empty.
      const chosen = inRegion.length > PAD_COUNT ? pickRandom(inRegion, PAD_COUNT, rand) : inRegion
      return startsToSlices(chosen, a)
    }

    case 'slicer': {
      const beatLen = 60 / a.tempo.bpm
      const len = s.beatStep * beatLen
      const start = quantizeToGrid(cursor, a, 0.25) + s.offset * len
      const out: Slice[] = []
      for (let i = 0; i < PAD_COUNT; i++) {
        const t0 = start + i * len
        if (t0 < 0) continue
        if (t0 + len / 2 > a.duration) break // keep the last slice if at least half of it exists
        out.push(makeSlice(t0, Math.min(t0 + len, a.duration)))
      }
      return out
    }

    case 'transients': {
      // Strongest first, greedily keeping those at least minGap from any kept one.
      const byStrength = [...a.onsets].sort((x, y) => y.strength - x.strength)
      const kept: number[] = []
      for (const o of byStrength) {
        if (o.time >= a.duration - TAIL_GUARD) continue
        if (kept.every((t) => Math.abs(t - o.time) >= s.minGap)) kept.push(o.time)
        if (kept.length === PAD_COUNT) break
      }
      kept.sort((x, y) => x - y)
      return kept.map((t, i) => makeSlice(t, Math.min(kept[i + 1] ?? a.duration, a.duration)))
    }

    case 'keys': {
      // One beat-quantised chop, pads 1..16 = -7..+8 semitones (pad 8 is the original).
      const start = quantizeToGrid(cursor, a, 1)
      const end = Math.min(a.duration, start + (60 / a.tempo.bpm) * 2)
      return Array.from({ length: PAD_COUNT }, (_, i) => ({ ...makeSlice(start, end), semitones: i - 7 }))
    }
  }
}

/** Snap `t` to the nearest `fraction`-of-a-beat position on the beatgrid. */
export function quantizeToGrid(t: number, a: AnalysisResult, fraction: number): number {
  const { beats } = a.tempo
  if (beats.length < 2) return t
  let i = beats.findIndex((b) => b > t)
  if (i <= 0) i = i === 0 ? 1 : beats.length - 1
  const b0 = beats[i - 1]
  const b1 = beats[i]
  const step = (b1 - b0) * fraction
  const snapped = b0 + Math.round((t - b0) / step) * step
  return Math.max(0, snapped)
}
