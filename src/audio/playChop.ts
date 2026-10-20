import type { AudioEngine, Envelope, Voice } from './engine'
import type { RenderCache } from './renderCache'
import { playbackPlan, type Track } from '../model/project'

/** Web Audio playback needs the decoded buffer (only the plugin build has none). */
export function requireBuffer(track: Track): AudioBuffer {
  if (!track.buffer) throw new Error(`No audio buffer for track ${track.id}`)
  return track.buffer
}

/** Below this the stretch is inaudible, so plain varispeed is used. */
const NO_STRETCH = 0.003

export interface ChopRequest {
  track: Track
  start: number
  end: number
  /** Total pitch shift: pad + keyboard note + key match + transpose. */
  semitones: number
  gain: number
  envelope?: Envelope
  channel: string
  projectBpm: number
  when?: number
  onEnded?: () => void
}

/**
 * Play a chop at the project tempo and the requested pitch. Uses the stretched
 * render when it's ready; otherwise plays tempo-correct varispeed and asks for
 * the render so the next hit is right.
 */
export function playChop(eng: AudioEngine, cache: RenderCache, r: ChopRequest): Voice {
  const buffer = requireBuffer(r.track)
  const { speed, pitch, factor } = playbackPlan(r.track, r.projectBpm, r.semitones)
  const base = { gain: r.gain, envelope: r.envelope, bus: r.track.id, when: r.when, onEnded: r.onEnded }
  if (Math.abs(factor - 1) < NO_STRETCH) {
    return eng.play(buffer, r.channel, { ...base, start: r.start, end: r.end, semitones: r.semitones })
  }
  const ready = cache.get(r.track.id, r.start, r.end, factor)
  if (ready) {
    return eng.play(ready.buffer, r.channel, {
      ...base,
      start: ready.start,
      end: ready.end,
      semitones: 12 * Math.log2(pitch),
      timeline: { start: r.start, scale: 1 / factor },
    })
  }
  cache.request(r.track.id, buffer, r.start, r.end, factor)
  return eng.play(buffer, r.channel, { ...base, start: r.start, end: r.end, semitones: 12 * Math.log2(speed) })
}

/** Queue a render for a chop if it will need one. */
export function prepareChop(cache: RenderCache, track: Track, start: number, end: number, semitones: number, projectBpm: number): void {
  const { factor } = playbackPlan(track, projectBpm, semitones)
  if (Math.abs(factor - 1) >= NO_STRETCH) cache.request(track.id, requireBuffer(track), start, end, factor)
}
