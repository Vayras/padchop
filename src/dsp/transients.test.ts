import { describe, expect, it } from 'vitest'
import { kick, noiseHit } from './synth'
import { pickTransients, transientFrames } from './transients'

const SR = 22050

describe('transients', () => {
  it('finds each hit within 12 ms', () => {
    const times = [0.25, 0.71, 1.1, 1.6, 2.05, 2.4]
    const sig = new Float32Array(3 * SR)
    times.forEach((t, i) => (i % 2 ? noiseHit(sig, SR, t, 20, 0.8, i + 3) : kick(sig, SR, t)))
    const onsets = pickTransients(transientFrames(sig, SR))
    expect(onsets.length).toBe(times.length)
    onsets.forEach((o, i) => expect(Math.abs(o.time - times[i])).toBeLessThan(0.012))
  })

  it('ranks a loud hit above a quiet one', () => {
    const sig = new Float32Array(2 * SR)
    kick(sig, SR, 0.3, 0.15)
    kick(sig, SR, 1.2, 0.9)
    const onsets = pickTransients(transientFrames(sig, SR))
    expect(onsets).toHaveLength(2)
    expect(onsets[1].strength).toBeGreaterThan(onsets[0].strength)
  })

  it('finds nothing in silence', () => {
    expect(pickTransients(transientFrames(new Float32Array(SR), SR))).toEqual([])
  })
})
