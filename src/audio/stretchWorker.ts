/// <reference lib="webworker" />
import { timeStretch } from '../dsp/stretch'

export interface StretchRequest {
  id: number
  channels: Float32Array[]
  sampleRate: number
  factor: number
}

self.onmessage = (e: MessageEvent<StretchRequest>) => {
  const { id, channels, sampleRate, factor } = e.data
  const out = timeStretch(channels, sampleRate, factor)
  self.postMessage({ id, channels: out }, out.map((c) => c.buffer))
}
