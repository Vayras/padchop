// Playback engine: one shared AudioContext, one-shot slice voices with repitch.

/** Amplitude envelope in seconds (sustain is a 0..1 level). */
export interface Envelope {
  attack: number
  decay: number
  sustain: number
  release: number
}

export const DEFAULT_ENVELOPE: Envelope = { attack: 0.002, decay: 0, sustain: 1, release: 0.01 }

/** Shortest fade ever used, so starts, ends and chokes never click. */
const MIN_FADE = 0.002
/** A choked voice fades over its release, capped so retriggers stay tight. */
const MAX_CHOKE_FADE = 0.25

export interface PlayOptions {
  start: number // seconds into the source buffer
  end: number
  semitones?: number
  gain?: number
  /** AudioContext time to start at; defaults to now. */
  when?: number
  /** Mixer bus (track id) to play through; defaults to the master. */
  bus?: string
  envelope?: Envelope
  /**
   * Map playback back to source time for the playhead (stretched renders):
   * position = start + elapsed × rate × scale. Defaults to the buffer's own time.
   */
  timeline?: { start: number; scale: number }
  /** Called when the voice ends (naturally or when stopped). */
  onEnded?: () => void
}

export interface Voice {
  stop(): void
  /** Current playhead in source seconds. */
  position(): number
}

export interface MixSettings {
  /** Linear gain, 0..2. */
  level: number
  /** -1 (left) .. 1 (right). */
  pan: number
  /** High-pass cutoff in Hz; 20 = off. */
  lowCut: number
  /** Low-pass cutoff in Hz; 20000 = off. */
  highCut: number
  /** Silenced (mute, or another track is soloed). */
  silent: boolean
}

/** One mixer channel: gain → pan → high-pass → low-pass → meter → master. */
interface Bus {
  input: GainNode
  pan: StereoPannerNode
  lowCut: BiquadFilterNode
  highCut: BiquadFilterNode
  meter: AnalyserNode
  scratch: Float32Array<ArrayBuffer>
}

const MIX_SMOOTHING = 0.015 // seconds; avoids zipper noise on fader moves

export class AudioEngine {
  readonly ctx: AudioContext
  private readonly master: GainNode
  private readonly active = new Map<string, { src: AudioBufferSourceNode; amp: GainNode; release: number }>()
  private readonly buses = new Map<string, Bus>()

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.connect(this.ctx.destination)
  }

  async decode(file: Blob): Promise<AudioBuffer> {
    const bytes = await file.arrayBuffer()
    return this.ctx.decodeAudioData(bytes)
  }

  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  /**
   * Play [start, end) of `buffer`. `channel` is a choke group: a new voice on a
   * channel cuts the previous one at its start time (like a pad retrigger).
   */
  play(buffer: AudioBuffer, channel: string, opts: PlayOptions): Voice {
    const t0 = Math.max(this.ctx.currentTime, opts.when ?? this.ctx.currentTime)
    this.stopChannel(channel, t0)
    const rate = Math.pow(2, (opts.semitones ?? 0) / 12)
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.playbackRate.value = rate

    const amp = this.ctx.createGain()
    const dur = Math.max(0, opts.end - opts.start) / rate
    const env = opts.envelope ?? DEFAULT_ENVELOPE
    scheduleEnvelope(amp.gain, t0, dur, opts.gain ?? 1, env)

    src.connect(amp).connect(opts.bus ? this.bus(opts.bus).input : this.master)
    src.start(t0, opts.start, opts.end - opts.start)
    const entry = { src, amp, release: env.release }
    this.active.set(channel, entry)
    src.onended = () => {
      if (this.active.get(channel) === entry) this.active.delete(channel)
      amp.disconnect()
      opts.onEnded?.()
    }
    return {
      stop: () => this.fadeOut(entry, this.ctx.currentTime, MIN_FADE * 2),
      position: () => {
        const tl = opts.timeline ?? { start: opts.start, scale: 1 }
        return tl.start + Math.max(0, this.ctx.currentTime - t0) * rate * tl.scale
      },
    }
  }

  private bus(id: string): Bus {
    let b = this.buses.get(id)
    if (!b) {
      const ctx = this.ctx
      const input = ctx.createGain()
      const pan = ctx.createStereoPanner()
      const lowCut = ctx.createBiquadFilter()
      lowCut.type = 'highpass'
      lowCut.frequency.value = 20
      const highCut = ctx.createBiquadFilter()
      highCut.type = 'lowpass'
      highCut.frequency.value = 20000
      const meter = ctx.createAnalyser()
      meter.fftSize = 1024
      input.connect(pan).connect(lowCut).connect(highCut).connect(meter).connect(this.master)
      b = { input, pan, lowCut, highCut, meter, scratch: new Float32Array(meter.fftSize) }
      this.buses.set(id, b)
    }
    return b
  }

  setMix(id: string, m: MixSettings): void {
    const b = this.bus(id)
    const t = this.ctx.currentTime
    b.input.gain.setTargetAtTime(m.silent ? 0 : m.level, t, MIX_SMOOTHING)
    b.pan.pan.setTargetAtTime(m.pan, t, MIX_SMOOTHING)
    b.lowCut.frequency.setTargetAtTime(m.lowCut, t, MIX_SMOOTHING)
    b.highCut.frequency.setTargetAtTime(m.highCut, t, MIX_SMOOTHING)
  }

  /** Peak level of a bus over the last ~20 ms, 0..1+ (0 if the bus doesn't exist). */
  meter(id: string): number {
    const b = this.buses.get(id)
    if (!b) return 0
    b.meter.getFloatTimeDomainData(b.scratch)
    let peak = 0
    for (const v of b.scratch) peak = Math.max(peak, Math.abs(v))
    return peak
  }

  removeBus(id: string): void {
    const b = this.buses.get(id)
    if (!b) return
    b.meter.disconnect()
    this.buses.delete(id)
  }

  stopChannel(channel: string, when?: number): void {
    const entry = this.active.get(channel)
    if (!entry) return
    this.active.delete(channel)
    const at = Math.max(this.ctx.currentTime, when ?? 0)
    this.fadeOut(entry, at, Math.min(MAX_CHOKE_FADE, Math.max(MIN_FADE, entry.release)))
  }

  /** Release a voice: fade from wherever its envelope is to silence, then stop it. */
  private fadeOut(entry: { src: AudioBufferSourceNode; amp: GainNode }, at: number, fade: number): void {
    const g = entry.amp.gain
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(at)
    else {
      g.cancelScheduledValues(at)
      g.setValueAtTime(g.value, at)
    }
    g.linearRampToValueAtTime(0, at + fade)
    try {
      entry.src.stop(at + fade + 0.005)
    } catch {
      // already stopped
    }
  }

  stopAll(): void {
    for (const ch of [...this.active.keys()]) this.stopChannel(ch)
  }
}

/**
 * Attack to `level`, decay to `sustain × level`, release to zero by the end of
 * `dur`. Attack and release shrink proportionally if the chop is too short.
 */
export function scheduleEnvelope(g: AudioParam, t0: number, dur: number, level: number, env: Envelope): void {
  let a = Math.max(MIN_FADE, env.attack)
  let r = Math.max(MIN_FADE, env.release)
  if (a + r > dur) {
    const k = dur / (a + r)
    a *= k
    r *= k
  }
  const peakAt = t0 + a
  const relAt = t0 + dur - r
  const sustain = level * Math.min(1, Math.max(0, env.sustain))
  g.setValueAtTime(0, t0)
  g.linearRampToValueAtTime(level, peakAt)
  let atRelease = level
  if (sustain < level) {
    // Even a zero decay ramps briefly, so dropping to the sustain level never clicks.
    const d = Math.max(MIN_FADE, env.decay)
    const decayEnd = peakAt + d
    if (decayEnd <= relAt) {
      g.linearRampToValueAtTime(sustain, decayEnd)
      atRelease = sustain
    } else {
      atRelease = level + (sustain - level) * ((relAt - peakAt) / d)
      g.linearRampToValueAtTime(atRelease, relAt)
    }
  }
  g.setValueAtTime(atRelease, relAt)
  g.linearRampToValueAtTime(0, t0 + dur)
}

/** Mono mixdown + resample via OfflineAudioContext (proper anti-aliasing). */
export async function toMono(buffer: AudioBuffer, sampleRate: number): Promise<Float32Array> {
  const length = Math.ceil(buffer.duration * sampleRate)
  const off = new OfflineAudioContext(1, length, sampleRate)
  const src = off.createBufferSource()
  src.buffer = buffer
  src.connect(off.destination)
  src.start()
  const rendered = await off.startRendering()
  return rendered.getChannelData(0).slice()
}
