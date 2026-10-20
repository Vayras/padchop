export function mean(a: ArrayLike<number>, from = 0, to = a.length): number {
  let s = 0
  for (let i = from; i < to; i++) s += a[i]
  return to > from ? s / (to - from) : 0
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

/** Normalise to unit max (no-op for all-zero input). */
export function normalizeMax(a: Float32Array): Float32Array {
  let mx = 0
  for (let i = 0; i < a.length; i++) mx = Math.max(mx, Math.abs(a[i]))
  if (mx > 0) for (let i = 0; i < a.length; i++) a[i] /= mx
  return a
}

/** Subtract a centred moving average of half-width `radius`, clamping at zero. */
export function subtractLocalMean(a: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(a.length)
  const prefix = new Float64Array(a.length + 1)
  for (let i = 0; i < a.length; i++) prefix[i + 1] = prefix[i] + a[i]
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - radius)
    const hi = Math.min(a.length, i + radius + 1)
    const m = (prefix[hi] - prefix[lo]) / (hi - lo)
    out[i] = Math.max(0, a[i] - m)
  }
  return out
}

/** Linear-interpolated value of `a` at fractional index `x`. */
export function sampleAt(a: ArrayLike<number>, x: number): number {
  if (x <= 0) return a[0] ?? 0
  const i = Math.floor(x)
  if (i >= a.length - 1) return a[a.length - 1] ?? 0
  const f = x - i
  return a[i] * (1 - f) + a[i + 1] * f
}
