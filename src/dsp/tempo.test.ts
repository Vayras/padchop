import { describe, expect, it } from 'vitest'
import { makeLoop } from './synth'
import { detectTempo } from './tempo'

const SR = 22050
const CHORDS = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [57, 60, 64]]

describe('detectTempo', () => {
  for (const bpm of [78, 92, 120, 140, 174]) {
    it(`finds ${bpm} BPM`, () => {
      const sig = makeLoop({ bpm, bars: 12, sr: SR, chords: CHORDS, offset: 0.37 })
      const t = detectTempo(sig, SR)
      expect(Math.abs(t.bpm - bpm)).toBeLessThan(0.5)
    })
  }

  it('places beats on the hits and the downbeat on bar starts', () => {
    const bpm = 100
    const offset = 0.37
    const sig = makeLoop({ bpm, bars: 12, sr: SR, chords: CHORDS, offset })
    const t = detectTempo(sig, SR)
    const period = 60 / bpm
    // Every detected beat lies within 20 ms of the true grid.
    for (const b of t.beats) {
      const k = Math.round((b - offset) / period)
      expect(Math.abs(b - (offset + k * period))).toBeLessThan(0.02)
    }
    const db = t.beats[t.downbeatIndex]
    const beatInBar = Math.round((db - offset) / period) % 4
    expect(beatInBar).toBe(0)
  })
})
