// Small synthesis helpers for tests and the in-app demo loop.

export function tone(out: Float32Array, sr: number, start: number, dur: number, hz: number, amp: number, harmonics = 5): void {
  const s0 = Math.floor(start * sr)
  const n = Math.min(out.length - s0, Math.floor(dur * sr))
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const env = Math.min(1, i / (0.01 * sr)) * Math.exp(-t * 1.5)
    let v = 0
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * hz * h * t) / h
    out[s0 + i] += amp * env * v
  }
}

/** Decaying sine sweep: a crude kick drum. */
export function kick(out: Float32Array, sr: number, start: number, amp = 0.9): void {
  const s0 = Math.floor(start * sr)
  const n = Math.min(out.length - s0, Math.floor(0.25 * sr))
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = 50 + 110 * Math.exp(-t * 30)
    phase += (2 * Math.PI * f) / sr
    out[s0 + i] += amp * Math.exp(-t * 14) * Math.sin(phase)
  }
}

/** Seeded noise burst: a crude snare / hat. */
export function noiseHit(out: Float32Array, sr: number, start: number, decay: number, amp: number, seed = 1): void {
  const s0 = Math.floor(start * sr)
  const n = Math.min(out.length - s0, Math.floor(0.3 * sr))
  let x = seed
  let prev = 0
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    const r = x / 2 ** 32 - 0.5
    const hp = r - prev // first-difference brightens the noise
    prev = r
    out[s0 + i] += amp * Math.exp(-(i / sr) * decay) * hp
  }
}

export function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12)
}

/**
 * A drum + chord loop at `bpm`. `chords` are MIDI note lists, one per bar.
 * Bar 1 beat 1 starts at `offset` seconds.
 */
export function makeLoop(opts: { bpm: number; bars: number; chords: number[][]; sr: number; offset?: number }): Float32Array {
  const { bpm, bars, chords, sr } = opts
  const offset = opts.offset ?? 0
  const beat = 60 / bpm
  const out = new Float32Array(Math.ceil((offset + bars * 4 * beat + 0.5) * sr))
  for (let bar = 0; bar < bars; bar++) {
    const t0 = offset + bar * 4 * beat
    const chord = chords[bar % chords.length]
    for (const m of chord) tone(out, sr, t0, 4 * beat, midiHz(m), 0.12)
    tone(out, sr, t0, 4 * beat, midiHz(chord[0] - 12), 0.18, 3) // bass note
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat
      if (b === 0 || b === 2) kick(out, sr, t, b === 0 ? 1 : 0.7)
      if (b === 1 || b === 3) noiseHit(out, sr, t, 18, 0.9, bar * 4 + b + 1)
      noiseHit(out, sr, t + beat / 2, 60, 0.25, 97 + bar * 4 + b)
    }
  }
  return out
}
