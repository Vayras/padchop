export interface Onset {
  /** Seconds. */
  time: number
  /** Relative transient strength, 0..1. */
  strength: number
}

export interface TempoResult {
  bpm: number
  /** Beat times in seconds. */
  beats: number[]
  /** Index into `beats` of the first downbeat (bar start). */
  downbeatIndex: number
  /** 0..1, how peaked the tempo evidence was. */
  confidence: number
  /** 'name' when a BPM in the filename constrained the search. */
  source: 'audio' | 'name'
}

export type Mode = 'major' | 'minor'

export interface KeyResult {
  /** Pitch class of the tonic, 0 = C. */
  tonic: number
  mode: Mode
  /** Correlation of the winning template, -1..1. */
  score: number
  /** Margin over the runner-up; small values mean "ambiguous". */
  confidence: number
  /** Normalised 12-bin chroma profile of the whole sample. */
  chroma: number[]
  /** 'name' when the key came from the filename. */
  source: 'audio' | 'name'
}

export interface Region {
  start: number
  end: number
  /** Higher is a better candidate to sample. */
  score: number
}

export interface AnalysisResult {
  sampleRate: number
  duration: number
  tempo: TempoResult
  key: KeyResult
  onsets: Onset[]
  regions: Region[]
  /** Peak envelope for drawing, `peaksPerSecond` points per second. */
  peaks: Float32Array
  peaksPerSecond: number
}
