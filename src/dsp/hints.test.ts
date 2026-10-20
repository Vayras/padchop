import { describe, expect, it } from 'vitest'
import { parseNameHints } from './hints'

describe('parseNameHints', () => {
  it.each([
    ['zulu_texture_Cm_73.wav', 73, { tonic: 0, mode: 'minor' }],
    ['All Killer Breaks - KB5 Kit06 Break01 90BPM_01.wav', 90, undefined],
    ['MSXII_SchlumpLoops10_Fast Paced_142 Bpm.wav', 142, undefined],
    ['country carl 154 bpm.wav', 154, undefined],
    ['DrumLoop22_BasementBreaks_100.wav', 100, undefined],
    ['Pad F#min 120 bpm.wav', 120, { tonic: 6, mode: 'minor' }],
    ['Keys Eb major 86.wav', 86, { tonic: 3, mode: 'major' }],
    ['All Killer Breaks - KB8 Break05 80BPPM_01.wav', 80, undefined],
    ['Break A.wav', undefined, undefined],
    ['spooky choir.wav', undefined, undefined],
  ])('%s', (name, bpm, key) => {
    const h = parseNameHints(name)
    expect(h.bpm).toBe(bpm)
    expect(h.key).toEqual(key)
  })
})
