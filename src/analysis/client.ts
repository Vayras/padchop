import type { NameHints } from '../dsp/hints'
import type { AnalysisResult } from '../dsp/types'

export function runAnalysis(
  samples: Float32Array,
  sampleRate: number,
  onProgress: (stage: string) => void,
  hints: NameHints = {},
): Promise<AnalysisResult> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'progress') onProgress(msg.stage)
      else {
        worker.terminate()
        if (msg.type === 'done') resolve(msg.result)
        else reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message))
    }
    worker.postMessage({ samples, sampleRate, hints }, [samples.buffer])
  })
}
