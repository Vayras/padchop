// Stretched copies of chops, rendered in a worker and cached until the chop,
// tempo or pitch changes. Playback asks synchronously (`get`) and falls back
// to varispeed for the rare hit that isn't ready yet.

import type { StretchRequest } from './stretchWorker'

/** Real audio on each side of a chop, so the vocoder's window has context. */
const CONTEXT_SECONDS = 0.1
const MAX_ENTRIES = 400

export interface Rendered {
  buffer: AudioBuffer
  /** Where the chop starts and ends inside `buffer`, in seconds. */
  start: number
  end: number
}

interface Entry {
  ready: Rendered | null
}

export class RenderCache {
  private readonly ctx: BaseAudioContext
  private readonly worker: Worker
  private readonly entries = new Map<string, Entry>()
  private readonly waiting = new Map<number, (channels: Float32Array[]) => void>()
  private nextId = 0
  private inFlight = 0
  private readonly onBusy: (busy: boolean) => void

  constructor(ctx: BaseAudioContext, onBusy: (busy: boolean) => void) {
    this.ctx = ctx
    this.onBusy = onBusy
    this.worker = new Worker(new URL('./stretchWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      this.waiting.get(e.data.id)?.(e.data.channels)
      this.waiting.delete(e.data.id)
    }
  }

  private static key(trackId: string, start: number, end: number, factor: number): string {
    return `${trackId}|${start.toFixed(4)}|${end.toFixed(4)}|${factor.toFixed(4)}`
  }

  get(trackId: string, start: number, end: number, factor: number): Rendered | null {
    const e = this.entries.get(RenderCache.key(trackId, start, end, factor))
    if (!e) return null
    // Refresh LRU order.
    const k = RenderCache.key(trackId, start, end, factor)
    this.entries.delete(k)
    this.entries.set(k, e)
    return e.ready
  }

  /** Start rendering [start, end) of `source` stretched by `factor`, unless cached. */
  request(trackId: string, source: AudioBuffer, start: number, end: number, factor: number): void {
    const k = RenderCache.key(trackId, start, end, factor)
    if (this.entries.has(k)) return
    const entry: Entry = { ready: null }
    this.entries.set(k, entry)
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)

    const sr = source.sampleRate
    const from = Math.max(0, Math.floor((start - CONTEXT_SECONDS) * sr))
    const to = Math.min(source.length, Math.ceil((end + CONTEXT_SECONDS) * sr))
    const channels = Array.from({ length: source.numberOfChannels }, (_, c) => source.getChannelData(c).slice(from, to))
    const id = this.nextId++
    this.setInFlight(1)
    this.waiting.set(id, (out) => {
      this.setInFlight(-1)
      if (this.entries.get(k) !== entry) return // evicted meanwhile
      const buffer = this.ctx.createBuffer(out.length, out[0].length, sr)
      out.forEach((c, i) => buffer.copyToChannel(c as Float32Array<ArrayBuffer>, i))
      const offset = (start - from / sr) * factor
      entry.ready = { buffer, start: offset, end: offset + (end - start) * factor }
    })
    const msg: StretchRequest = { id, channels, sampleRate: sr, factor }
    this.worker.postMessage(msg, channels.map((c) => c.buffer))
  }

  dropTrack(trackId: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(`${trackId}|`)) this.entries.delete(k)
  }

  private setInFlight(d: number): void {
    const was = this.inFlight > 0
    this.inFlight += d
    if (was !== this.inFlight > 0) this.onBusy(this.inFlight > 0)
  }
}
