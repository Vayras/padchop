// Lookahead step scheduler: a JS timer wakes every 25 ms and schedules any steps
// due in the next 120 ms on the AudioContext clock, so timing stays sample-accurate.

const LOOKAHEAD = 0.12
const TICK_MS = 25

export interface SequencerHost {
  /** Current tempo and pattern length, read every tick so edits apply live. */
  timing(): { bpm: number; stepsPerBar: number; totalSteps: number }
  /** Schedule everything on `step` at AudioContext time `when`; `stepDur` is the step length in seconds. */
  fire(step: number, when: number, stepDur: number): void
}

export class Sequencer {
  private timer: ReturnType<typeof setInterval> | null = null
  private nextTime = 0
  private nextStep = 0
  /** (AudioContext time, step) pairs for drawing the playhead. */
  private readonly history: { time: number; step: number }[] = []

  private readonly ctx: AudioContext
  private readonly host: SequencerHost

  constructor(ctx: AudioContext, host: SequencerHost) {
    this.ctx = ctx
    this.host = host
  }

  get playing(): boolean {
    return this.timer !== null
  }

  start(): void {
    if (this.timer) return
    this.nextTime = this.ctx.currentTime + 0.05
    this.nextStep = 0
    this.history.length = 0
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.history.length = 0
  }

  /** The step currently sounding, or -1. */
  currentStep(): number {
    const now = this.ctx.currentTime
    let step = -1
    for (const h of this.history) if (h.time <= now) step = h.step
    return step
  }

  private tick(): void {
    const { bpm, stepsPerBar, totalSteps } = this.host.timing()
    // stepsPerBar steps in a 4/4 bar.
    const stepDur = (60 / bpm) * (4 / stepsPerBar)
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      const step = this.nextStep % totalSteps
      this.host.fire(step, this.nextTime, stepDur)
      this.history.push({ time: this.nextTime, step })
      this.nextTime += stepDur
      this.nextStep = step + 1
    }
    const now = this.ctx.currentTime
    while (this.history.length > 1 && this.history[1].time <= now) this.history.shift()
  }
}
