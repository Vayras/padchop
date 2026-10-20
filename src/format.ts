import type { KeyResult } from './dsp/types'

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

export function formatTime(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60)
  const s = Math.max(0, seconds) - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

export function noteName(pitchClass: number): string {
  return NOTE_NAMES[((pitchClass % 12) + 12) % 12]
}

export function keyName(tonic: number, mode: 'major' | 'minor'): string {
  return `${noteName(tonic)} ${mode === 'major' ? 'maj' : 'min'}`
}

/** "C MIN" — the LCD style. */
export function keyLabel(k: Pick<KeyResult, 'tonic' | 'mode'>): string {
  return `${noteName(k.tonic)} ${k.mode === 'major' ? 'MAJ' : 'MIN'}`
}

// Camelot wheel: major keys are "B", minor keys are "A".
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1]
export function camelot(tonic: number, mode: 'major' | 'minor'): string {
  const pc = ((tonic % 12) + 12) % 12
  if (mode === 'major') return `${CAMELOT_MAJOR[pc]}B`
  // Relative major is three semitones up.
  return `${CAMELOT_MAJOR[(pc + 3) % 12]}A`
}

/** "+3 ST" / "−2 ST" / "0 ST". */
export function semitoneLabel(n: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} ST`
}

export function gainDb(gain: number): string {
  const db = 20 * Math.log10(Math.max(gain, 1e-4))
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`
}

/** Shorten long names for the LCD: "THORIR BALDURSSON! RUSSELL GORS…". */
export function shortName(name: string, max = 24): string {
  return name.length <= max ? name : name.slice(0, max - 1).trimEnd() + '…'
}

/** "2 ms" / "350 ms" / "1.20 s". */
export function secondsLabel(t: number): string {
  return t < 1 ? `${Math.round(t * 1000)} ms` : `${t.toFixed(2)} s`
}

export const MIN_DB = -60

export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain)
}

export function dbToGain(db: number): number {
  return db <= MIN_DB ? 0 : Math.pow(10, db / 20)
}

/** "−3.0 dB" / "−∞ dB". */
export function dbLabel(gain: number): string {
  const db = gainToDb(gain)
  if (db <= MIN_DB) return '−∞ dB'
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)} dB`
}

/** "C", "L40", "R15". */
export function panLabel(pan: number): string {
  const p = Math.round(pan * 50)
  return p === 0 ? 'C' : p < 0 ? `L${-p}` : `R${p}`
}

export function hzLabel(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : `${Math.round(hz)}`
}
