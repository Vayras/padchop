import { DEFAULT_CHOP, type ChopSettings } from '../dsp/chop'
import type { AnalysisResult, KeyResult } from '../dsp/types'
import type { PadSlots } from './slices'

export const MAX_TRACKS = 4
const KEY_MATCH_CONFIDENCE = 0.35
export const TRACK_COLORS = ['#F0565A', '#4F9DFF', '#F5C042', '#5BD08A']
export const SLOT_NAMES = ['A', 'B', 'C', 'D']

export interface Track {
  id: string
  name: string
  /** Decoded audio for Web Audio playback; null inside the plugin, where the engine holds it. */
  buffer: AudioBuffer | null
  analysis: AnalysisResult
  slices: PadSlots
  selected: number
  chop: ChopSettings
  /** Keyboard mode: the selected pad's slice plays chromatically across all pads. */
  keyboard: boolean
  /** Keyboard mode octave offset. */
  octave: number
  cursor: number
  view: { start: number; end: number }
  /** Mixer level, linear gain 0..2 (+6 dB). */
  gain: number
  /** Mixer pan, -1..1. */
  pan: number
  /** Mixer high-pass (Hz, 20 = off) and low-pass (Hz, 20000 = off). */
  lowCut: number
  highCut: number
  muted: boolean
  solo: boolean
  /** Repitch this track into the anchor's key. Off by default for keyless material (drums). */
  matchKey: boolean
  /** Time-stretch this track to the project tempo. */
  sync: boolean
}

/** One sequencer cell: which pad to fire, plus a chromatic offset (keyboard mode). */
export interface Step {
  pad: number
  semitones: number
  /** Recorded in keyboard mode: labelled as a note and rings per pitch. */
  note: boolean
}

export interface Pattern {
  bars: number
  stepsPerBar: number
  /** Lanes keyed by track id; length = bars * stepsPerBar. */
  lanes: Record<string, (Step | null)[]>
}

let nextTrackId = 0
export function makeTrack(name: string, buffer: AudioBuffer | null, analysis: AnalysisResult, slices: PadSlots, chop: ChopSettings = DEFAULT_CHOP, id?: string): Track {
  return {
    id: id ?? `t${nextTrackId++}`,
    name,
    buffer,
    analysis,
    slices,
    selected: 0,
    chop,
    keyboard: false,
    octave: 0,
    cursor: 0,
    view: { start: 0, end: analysis.duration },
    gain: 1,
    pan: 0,
    lowCut: 20,
    highCut: 20000,
    muted: false,
    solo: false,
    matchKey: analysis.key.source === 'name' || analysis.key.confidence >= KEY_MATCH_CONFIDENCE,
    sync: true,
  }
}

/** Major-equivalent pitch class: a minor key shares its scale with the major three semitones up. */
function relativeMajor(k: KeyResult): number {
  return (k.tonic + (k.mode === 'minor' ? 3 : 0)) % 12
}

/**
 * Semitones that move `track`'s key onto the anchor's scale, by the smallest
 * interval (-6..+5). Relative major/minor count as a match (shift 0).
 */
export function keyMatchShift(track: KeyResult, anchor: KeyResult): number {
  const d = (relativeMajor(anchor) - relativeMajor(track) + 12) % 12
  return d > 5 ? d - 12 : d
}

/**
 * How to play a chop of `track` shifted by `semitones` at `projectBpm`:
 * `speed` is the tempo ratio (1 when not synced), `pitch` the pitch ratio, and
 * `factor` = pitch / speed is the time-stretch that, played back at `pitch`,
 * gives both.
 */
export function playbackPlan(track: Track, projectBpm: number, semitones: number): { speed: number; pitch: number; factor: number } {
  const speed = track.sync && track.analysis.tempo.bpm > 0 ? projectBpm / track.analysis.tempo.bpm : 1
  const pitch = Math.pow(2, semitones / 12)
  return { speed, pitch, factor: pitch / speed }
}

/** Slot badge: ANCHOR, NO MATCH, IN KEY or the semitone shift. */
export function slotTag(t: Track, isAnchor: boolean, shift: number): string {
  if (isAnchor) return 'ANCHOR'
  if (!t.matchKey) return 'NO MATCH'
  return shift === 0 ? 'IN KEY' : `${shift > 0 ? '+' : '−'}${Math.abs(shift)} ST`
}

export function resizeLane(lane: (Step | null)[] | undefined, length: number): (Step | null)[] {
  const out: (Step | null)[] = new Array(length).fill(null)
  if (lane) for (let i = 0; i < Math.min(length, lane.length); i++) out[i] = lane[i]
  return out
}

export const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
export const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

export function inScale(pc: number, key: KeyResult): boolean {
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE
  return scale.includes((((pc - key.tonic) % 12) + 12) % 12)
}

export type { ChopSettings }
