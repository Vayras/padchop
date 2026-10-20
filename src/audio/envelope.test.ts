import { describe, expect, it } from 'vitest'
import { scheduleEnvelope } from './engine'

/** Records automation calls and evaluates the resulting gain curve. */
function fakeParam() {
  const events: { t: number; v: number; ramp: boolean }[] = []
  const param = {
    setValueAtTime: (v: number, t: number) => { events.push({ t, v, ramp: false }) },
    linearRampToValueAtTime: (v: number, t: number) => { events.push({ t, v, ramp: true }) },
  } as unknown as AudioParam
  const at = (t: number) => {
    let prev = { t: 0, v: 0 }
    for (const e of events) {
      if (e.t > t) return e.ramp ? prev.v + ((e.v - prev.v) * (t - prev.t)) / (e.t - prev.t) : prev.v
      prev = e
    }
    return prev.v
  }
  return { param, at }
}

describe('scheduleEnvelope', () => {
  it('starts and ends silent, peaks after the attack, holds the sustain', () => {
    const { param, at } = fakeParam()
    scheduleEnvelope(param, 0, 1, 0.8, { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.2 })
    expect(at(0)).toBe(0)
    expect(at(0.1)).toBeCloseTo(0.8)
    expect(at(0.3)).toBeCloseTo(0.4)
    expect(at(0.7)).toBeCloseTo(0.4)
    expect(at(1)).toBeCloseTo(0)
    expect(at(0.9)).toBeCloseTo(0.2) // halfway through the release
  })

  it('squeezes attack and release into chops shorter than both', () => {
    const { param, at } = fakeParam()
    scheduleEnvelope(param, 0, 0.1, 1, { attack: 0.2, decay: 0, sustain: 1, release: 0.2 })
    expect(at(0.05)).toBeCloseTo(1)
    expect(at(0.1)).toBeCloseTo(0)
  })

  it('never jumps: a zero decay still ramps to the sustain level', () => {
    const { param, at } = fakeParam()
    scheduleEnvelope(param, 0, 1, 1, { attack: 0.01, decay: 0, sustain: 0.3, release: 0.01 })
    expect(at(0.0105)).toBeGreaterThan(0.3)
    expect(at(0.0105)).toBeLessThan(1)
  })
})
