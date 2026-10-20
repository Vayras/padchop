import { describe, expect, it } from 'vitest'
import { detectKey } from './key'
import { makeLoop } from './synth'

const SR = 22050

describe('detectKey', () => {
  it('finds C major from a I-IV-V-I progression', () => {
    const sig = makeLoop({ bpm: 100, bars: 8, sr: SR, chords: [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]] })
    const k = detectKey(sig, SR)
    expect([k.tonic, k.mode]).toEqual([0, 'major'])
  })

  it('finds A minor from an i-iv-v-i progression', () => {
    const sig = makeLoop({ bpm: 90, bars: 8, sr: SR, chords: [[57, 60, 64], [62, 65, 69], [64, 67, 71], [57, 60, 64]] })
    const k = detectKey(sig, SR)
    expect([k.tonic, k.mode]).toEqual([9, 'minor'])
  })

  it('finds F# major after transposition', () => {
    const t = 6
    const sig = makeLoop({ bpm: 120, bars: 8, sr: SR, chords: [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]].map((c) => c.map((m) => m + t)) })
    const k = detectKey(sig, SR)
    expect([k.tonic, k.mode]).toEqual([6, 'major'])
  })
})
