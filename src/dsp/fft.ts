// In-place iterative radix-2 FFT with cached twiddles and bit-reversal tables.

export class FFT {
  readonly size: number
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  private readonly rev: Uint32Array
  private readonly re: Float64Array
  private readonly im: Float64Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${size}`)
    this.size = size
    this.cos = new Float64Array(size / 2)
    this.sin = new Float64Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / size)
    }
    const bits = Math.log2(size)
    this.rev = new Uint32Array(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.re = new Float64Array(size)
    this.im = new Float64Array(size)
  }

  /** Writes |X[k]| for k in [0, size/2] into `out` (length size/2 + 1). */
  magnitude(input: ArrayLike<number>, out: Float32Array): void {
    const { size, re, im, rev } = this
    for (let i = 0; i < size; i++) {
      re[rev[i]] = i < input.length ? input[i] : 0
      im[rev[i]] = 0
    }
    this.transform()
    for (let k = 0; k <= size / 2; k++) out[k] = Math.hypot(re[k], im[k])
  }

  /**
   * In-place complex transform of (re, im), length `size`. The inverse is
   * unnormalised: divide by `size` to round-trip.
   */
  complex(re: Float64Array, im: Float64Array, inverse = false): void {
    const { size, rev } = this
    for (let i = 0; i < size; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    this.transform(re, im, inverse)
  }

  private transform(re = this.re, im = this.im, inverse = false): void {
    const { size, cos, sin } = this
    const sign = inverse ? -1 : 1
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const step = size / len
      for (let start = 0; start < size; start += len) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step]
          const wi = sign * sin[j * step]
          const a = start + j
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

export function hann(size: number): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return w
}

/**
 * Magnitude spectrogram. Frame i is centred at sample i * hop.
 * Returns frames as an array of Float32Array(fftSize / 2 + 1).
 */
export function spectrogram(signal: Float32Array, fftSize: number, hop: number): Float32Array[] {
  const fft = new FFT(fftSize)
  const win = hann(fftSize)
  const frame = new Float32Array(fftSize)
  const frames: Float32Array[] = []
  const n = Math.ceil(signal.length / hop)
  const half = fftSize >> 1
  for (let f = 0; f < n; f++) {
    const start = f * hop - half
    for (let i = 0; i < fftSize; i++) {
      const s = start + i
      frame[i] = s >= 0 && s < signal.length ? signal[s] * win[i] : 0
    }
    const mag = new Float32Array(half + 1)
    fft.magnitude(frame, mag)
    frames.push(mag)
  }
  return frames
}
