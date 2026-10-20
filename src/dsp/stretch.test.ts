import { describe, expect, it } from 'vitest'
import { timeStretch } from './stretch'
import { kick } from './synth'
import { pickTransients, transientFrames } from './transients'

const SR = 44100

function sine(hz: number, seconds: number, amp = 0.5): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR)
  return x
}

/** Frequency from zero crossings over the middle of the signal. */
function pitchOf(x: Float32Array): number {
  const a = Math.floor(x.length * 0.25)
  const b = Math.floor(x.length * 0.75)
  let crossings = 0
  for (let i = a + 1; i < b; i++) if (x[i - 1] < 0 && x[i] >= 0) crossings++
  return (crossings * SR) / (b - a)
}

function rms(x: Float32Array): number {
  const a = Math.floor(x.length * 0.25)
  const b = Math.floor(x.length * 0.75)
  let s = 0
  for (let i = a; i < b; i++) s += x[i] * x[i]
  return Math.sqrt(s / (b - a))
}

describe('timeStretch', () => {
  for (const factor of [0.6, 1.25, 1.8]) {
    it(`stretches by ${factor} keeping pitch and level`, () => {
      const x = sine(440, 1)
      const [y] = timeStretch([x], SR, factor)
      expect(y.length).toBe(Math.round(x.length * factor))
      expect(Math.abs(pitchOf(y) - 440)).toBeLessThan(3)
      expect(Math.abs(rms(y) / rms(x) - 1)).toBeLessThan(0.1)
    })
  }

  it('moves drum hits to their stretched positions', () => {
    const factor = 1.5
    const x = new Float32Array(2 * SR)
    const hits = [0.2, 0.7, 1.2, 1.7]
    for (const t of hits) kick(x, SR, t)
    const [y] = timeStretch([x], SR, factor)
    const onsets = pickTransients(transientFrames(y, SR)).filter((o) => o.strength > 0.3)
    expect(onsets).toHaveLength(hits.length)
    onsets.forEach((o, i) => expect(Math.abs(o.time - hits[i] * factor)).toBeLessThan(0.02))
  })

  it('keeps stereo channels separate', () => {
    const [l, r] = timeStretch([sine(300, 0.5), new Float32Array(SR / 2)], SR, 1.3)
    expect(rms(l)).toBeGreaterThan(0.2)
    expect(rms(r)).toBeLessThan(1e-3)
  })
})
