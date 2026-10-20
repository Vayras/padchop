import { describe, expect, it } from 'vitest'
import type { KeyResult } from '../dsp/types'
import { keyMatchShift, resizeLane } from './project'
import { keyboardSemitone } from './slices'

const key = (tonic: number, mode: 'major' | 'minor'): KeyResult => ({ tonic, mode, score: 1, confidence: 1, chroma: [], source: 'audio' })

describe('keyMatchShift', () => {
  it('moves by the smallest interval', () => {
    expect(keyMatchShift(key(2, 'minor'), key(0, 'minor'))).toBe(-2) // Dm -> Cm
    expect(keyMatchShift(key(10, 'major'), key(0, 'major'))).toBe(2) // Bb -> C
    expect(keyMatchShift(key(6, 'major'), key(0, 'major'))).toBe(-6) // F# -> C (tritone goes down)
  })
  it('treats relative major/minor as a match', () => {
    expect(keyMatchShift(key(3, 'major'), key(0, 'minor'))).toBe(0) // Eb major ~ C minor
    expect(keyMatchShift(key(9, 'minor'), key(0, 'major'))).toBe(0) // A minor ~ C major
  })
})

describe('keyboardSemitone', () => {
  it('puts the root bottom-left and rises across then up', () => {
    expect(keyboardSemitone(12, 0)).toBe(0) // Z
    expect(keyboardSemitone(15, 0)).toBe(3) // V
    expect(keyboardSemitone(8, 0)).toBe(4) // A
    expect(keyboardSemitone(3, 0)).toBe(15) // 4
    expect(keyboardSemitone(12, -1)).toBe(-12)
  })
})

describe('resizeLane', () => {
  it('keeps existing steps and pads with empties', () => {
    expect(resizeLane([{ pad: 1, semitones: 0, note: false }, null], 3)).toEqual([{ pad: 1, semitones: 0, note: false }, null, null])
  })
})
