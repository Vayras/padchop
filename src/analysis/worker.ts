/// <reference lib="webworker" />
import { analyze } from '../dsp/analyze'
import type { NameHints } from '../dsp/hints'

export interface AnalyzeRequest {
  samples: Float32Array
  sampleRate: number
  hints: NameHints
}

self.onmessage = (e: MessageEvent<AnalyzeRequest>) => {
  const { samples, sampleRate, hints } = e.data
  try {
    const result = analyze(samples, sampleRate, (stage) => self.postMessage({ type: 'progress', stage }), hints)
    self.postMessage({ type: 'done', result }, [result.peaks.buffer])
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
