import type { NameHints } from './hints'
import { detectKey } from './key'
import { findRegions } from './regions'
import { detectTempo } from './tempo'
import { pickTransients, transientFrames } from './transients'
import type { AnalysisResult } from './types'

const PEAKS_PER_SECOND = 400

export function peakEnvelope(signal: Float32Array, sampleRate: number, perSecond = PEAKS_PER_SECOND): Float32Array {
  const step = sampleRate / perSecond
  const n = Math.ceil(signal.length / step)
  const peaks = new Float32Array(n)
  let max = 0
  for (let i = 0; i < n; i++) {
    let p = 0
    const end = Math.min(signal.length, Math.floor((i + 1) * step))
    for (let j = Math.floor(i * step); j < end; j++) p = Math.max(p, Math.abs(signal[j]))
    peaks[i] = p
    max = Math.max(max, p)
  }
  if (max > 0) for (let i = 0; i < n; i++) peaks[i] /= max
  return peaks
}

export function analyze(
  signal: Float32Array,
  sampleRate: number,
  onProgress: (stage: string) => void = () => {},
  hints: NameHints = {},
): AnalysisResult {
  onProgress('Finding transients')
  const onsets = pickTransients(transientFrames(signal, sampleRate))
  onProgress('Detecting tempo')
  const tempo = detectTempo(signal, sampleRate, { hintBpm: hints.bpm })
  onProgress('Detecting key')
  const detected = detectKey(signal, sampleRate)
  // A key in the filename wins over the detected one.
  const key = hints.key ? { ...detected, ...hints.key, confidence: 1, source: 'name' as const } : detected
  onProgress('Finding sample regions')
  const regions = findRegions(signal, sampleRate)
  return {
    sampleRate,
    duration: signal.length / sampleRate,
    tempo,
    key,
    onsets,
    regions,
    peaks: peakEnvelope(signal, sampleRate),
    peaksPerSecond: PEAKS_PER_SECOND,
  }
}
