// Time-stretch: a peak-locked phase vocoder. 4096-point Hann frames with a fixed 256-sample
// output hop, analysis hop = output hop / factor, spectral peaks found on the
// channel-summed magnitude, each peak's phase advanced by its measured
// frequency and the bins around it locked to it (identity phase locking).
// padchop adds a phase reset on sharp onsets so drums keep their attack.
//
// Pitch is not changed here: the caller stretches by pitch/speed and plays the
// result back at the pitch ratio.

import { FFT } from './fft'

/** Onsets where the spectrum jumps by more than this fraction reset the phases. */
const TRANSIENT_FLUX = 0.6

function frameSize(sampleRate: number): number {
  return sampleRate > 128000 ? 16384 : sampleRate > 64000 ? 8192 : 4096
}

function princarg(x: number): number {
  return x - 2 * Math.PI * Math.round(x / (2 * Math.PI))
}

/**
 * Stretch `input` (one array per channel) so it lasts `factor` times as long,
 * keeping its pitch. Returns new arrays of round(length × factor) samples.
 */
export function timeStretch(input: Float32Array[], sampleRate: number, factor: number): Float32Array[] {
  const inLen = input[0]?.length ?? 0
  const outLen = Math.max(0, Math.round(inLen * factor))
  if (inLen === 0 || Math.abs(factor - 1) < 1e-6) return input.map((c) => c.slice())

  const N = frameSize(sampleRate)
  const half = N / 2
  const bins = half + 1
  const Hs = N / 16
  const Ha = Hs / factor
  const fft = new FFT(N)
  const win = new Float64Array(N)
  for (let n = 0; n < N; n++) win[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N)
  let winSq = 0
  for (let n = 0; n < N; n++) winSq += win[n] * win[n]
  const norm = 1 / (N * (winSq / Hs)) // undo the unnormalised IFFT and the window overlap

  const C = input.length
  const out = input.map(() => new Float32Array(outLen))
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const mag = input.map(() => new Float64Array(bins))
  const phase = input.map(() => new Float64Array(bins))
  const prevPhase = input.map(() => new Float64Array(bins))
  const outPhase = input.map(() => new Float64Array(bins))
  const sumMag = new Float64Array(bins)
  const prevSumMag = new Float64Array(bins)
  const owner = new Int32Array(bins)
  const isPeak = new Uint8Array(bins)

  let prevPos = -1
  for (let t = 0; ; t++) {
    const outCentre = t * Hs
    if (outCentre - half > outLen) break
    const pos = Math.round(t * Ha)
    const hop = prevPos < 0 ? 0 : pos - prevPos

    // Analysis.
    sumMag.fill(0)
    for (let c = 0; c < C; c++) {
      const x = input[c]
      for (let n = 0; n < N; n++) {
        const s = pos - half + n
        re[n] = s >= 0 && s < inLen ? x[s] * win[n] : 0
        im[n] = 0
      }
      fft.complex(re, im)
      for (let k = 0; k < bins; k++) {
        const m = Math.hypot(re[k], im[k])
        mag[c][k] = m
        phase[c][k] = Math.atan2(im[k], re[k])
        sumMag[k] += m
      }
    }

    // Peaks on the summed spectrum; every bin belongs to the peak on its side of
    // the lowest point between two peaks.
    let peakMax = 0
    for (let k = 0; k < bins; k++) peakMax = Math.max(peakMax, sumMag[k])
    const floor = peakMax * 1e-5
    isPeak.fill(0)
    const peaks: number[] = []
    for (let k = 2; k < bins - 2; k++) {
      const m = sumMag[k]
      if (m > floor && m > sumMag[k - 1] && m >= sumMag[k + 1] && m > sumMag[k - 2] && m >= sumMag[k + 2]) {
        isPeak[k] = 1
        peaks.push(k)
      }
    }
    if (peaks.length === 0) peaks.push(0)
    let k0 = 0
    for (let p = 0; p < peaks.length; p++) {
      // Region ends at the minimum between this peak and the next.
      let end = bins - 1
      if (p + 1 < peaks.length) {
        end = peaks[p]
        for (let j = peaks[p]; j <= peaks[p + 1]; j++) if (sumMag[j] < sumMag[end]) end = j
      }
      for (let k = k0; k <= end; k++) owner[k] = peaks[p]
      k0 = end + 1
    }

    // Sharp onset: restart phase coherence from the input so the attack stays tight.
    let flux = 0
    let total = 0
    for (let k = 0; k < bins; k++) {
      flux += Math.max(0, sumMag[k] - prevSumMag[k])
      total += sumMag[k]
    }
    const reset = prevPos < 0 || hop === 0 || (total > 0 && flux / total > TRANSIENT_FLUX)
    prevSumMag.set(sumMag)

    // Phase propagation and synthesis, per channel.
    for (let c = 0; c < C; c++) {
      const ph = phase[c]
      const op = outPhase[c]
      if (reset) {
        op.set(ph)
      } else {
        for (const k of peaks) {
          const omega = (2 * Math.PI * k) / N
          const dev = princarg(ph[k] - prevPhase[c][k] - omega * hop)
          op[k] = op[k] + Hs * (omega + dev / hop)
        }
        for (let k = 0; k < bins; k++) {
          if (isPeak[k]) continue
          const pk = owner[k]
          op[k] = op[pk] + (ph[k] - ph[pk])
        }
      }
      prevPhase[c].set(ph)

      const m = mag[c]
      for (let k = 0; k < bins; k++) {
        re[k] = m[k] * Math.cos(op[k])
        im[k] = m[k] * Math.sin(op[k])
      }
      for (let k = 1; k < half; k++) {
        re[N - k] = re[k]
        im[N - k] = -im[k]
      }
      im[0] = 0
      im[half] = 0
      fft.complex(re, im, true)
      const y = out[c]
      const start = outCentre - half
      for (let n = 0; n < N; n++) {
        const s = start + n
        if (s >= 0 && s < outLen) y[s] += re[n] * win[n] * norm
      }
    }
    prevPos = pos
  }
  return out
}
