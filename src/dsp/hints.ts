// BPM / key hints from sample-pack filenames ("zulu_texture_Cm_73", "Break 90BPM",
// "F#min 120 bpm"), used like file tags: a BPM narrows the tempo search to ±12.5,
// and a key skips key analysis.

import type { Mode } from './types'

export interface NameHints {
  bpm?: number
  key?: { tonic: number; mode: Mode }
}

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const SEP = String.raw`[\s_\-()[\].,]`

export function parseNameHints(filename: string): NameHints {
  const name = filename.replace(/\.[a-z0-9]+$/i, '')
  const hints: NameHints = {}

  // "90bpm", "90 BPM", "90BPPM" first; then a bare 2-3 digit token.
  const withUnit = name.match(/(\d{2,3}(?:\.\d+)?)\s?bp+m/i)
  const bare = name.match(new RegExp(`(?:^|${SEP})(\\d{2,3})(?=$|${SEP})`, 'g'))
  const candidates = withUnit ? [withUnit[1]] : (bare ?? []).map((t) => t.replace(new RegExp(`^${SEP}`), ''))
  for (const c of candidates) {
    const v = Number(c)
    if (v >= 50 && v <= 200) { hints.bpm = v; break }
  }

  // A key needs an explicit quality ("Cm", "C#min", "Eb major") so words and
  // section letters ("Break A") aren't mistaken for keys.
  const keyRe = new RegExp(`(?:^|${SEP})([A-Ga-g])(#|b|♯|♭)?\\s?(minor|min|m|major|maj|M)(?=$|${SEP}|\\d)`)
  const k = name.match(keyRe)
  if (k) {
    let tonic = LETTER[k[1].toLowerCase()]
    if (k[2] === '#' || k[2] === '♯') tonic += 1
    if (k[2] === 'b' || k[2] === '♭') tonic -= 1
    const q = k[3]
    const mode: Mode = q === 'M' || q.toLowerCase().startsWith('maj') ? 'major' : 'minor'
    hints.key = { tonic: (tonic + 12) % 12, mode }
  }
  return hints
}
