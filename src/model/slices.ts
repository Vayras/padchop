import { DEFAULT_ENVELOPE, type Envelope } from '../audio/engine'

export interface Slice {
  id: string
  start: number // seconds
  end: number
  semitones: number
  gain: number
  /** Amplitude envelope; short attack/release remove clicks at chop edges. */
  env: Envelope
}

export const PAD_COUNT = 16

/** One entry per pad; null = empty pad. */
export type PadSlots = (Slice | null)[]

// Pad colours: eight hues, repeated for the bottom half of the grid.
export const PAD_COLORS = [
  '#F0565A', '#FF8A3D', '#F5C042', '#5BD08A', '#3CCFC4', '#4F9DFF', '#9B7BFF', '#F06FC2',
  '#F0565A', '#FF8A3D', '#F5C042', '#5BD08A', '#3CCFC4', '#4F9DFF', '#9B7BFF', '#F06FC2',
]

// Computer keyboard layout: four rows of four.
export const PAD_KEYS = ['1', '2', '3', '4', 'q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v']

let nextId = 0
export function makeSlice(start: number, end: number): Slice {
  return { id: `s${nextId++}`, start, end, semitones: 0, gain: 1, env: { ...DEFAULT_ENVELOPE } }
}

/** Turn sorted cue points into slices, each running to the next cue (or `limit`). */
export function cuesToSlices(cues: number[], duration: number, maxLength?: number): Slice[] {
  const sorted = [...cues].sort((a, b) => a - b).slice(0, PAD_COUNT)
  return sorted.map((t, i) => {
    let end = i + 1 < sorted.length ? sorted[i + 1] : duration
    if (maxLength !== undefined) end = Math.min(end, t + maxLength)
    return makeSlice(t, Math.min(end, duration))
  })
}

/**
 * Keyboard mode layout: bottom-left pad (Z) is the root, notes rise left to
 * right then upwards, like an MPC's chromatic pad mode.
 */
export function keyboardSemitone(pad: number, octave: number): number {
  const row = Math.floor(pad / 4)
  const col = pad % 4
  return (3 - row) * 4 + col + octave * 12
}
