// Time-stretch: a peak-locked phase vocoder. 4096-point Hann frames with a
// fixed 256-sample output hop, analysis hop = output hop / factor, spectral peaks
// found on the channel-summed magnitude, each peak's phase advanced by its
// measured frequency and the bins around it locked to it (identity phase
// locking), plus a phase reset on sharp onsets so drums keep their attack.
// Pitch is not changed here: callers stretch by pitch/speed and resample.
#include "padchop/dsp.h"

#include <algorithm>
#include <cmath>

namespace padchop {

namespace {
constexpr double kTransientFlux = 0.6;

int frameSize(double sampleRate) { return sampleRate > 128000 ? 16384 : sampleRate > 64000 ? 8192 : 4096; }

double princarg(double x) { return x - 2 * M_PI * std::floor(x / (2 * M_PI) + 0.5); }
} // namespace

std::vector<Signal> timeStretch(const std::vector<Signal>& input, double sampleRate, double factor) {
    const int inLen = input.empty() ? 0 : static_cast<int>(input[0].size());
    const int outLen = std::max(0, static_cast<int>(std::lround(inLen * factor)));
    if (inLen == 0 || std::abs(factor - 1) < 1e-6) return input;

    const int N = frameSize(sampleRate);
    const int half = N / 2;
    const int bins = half + 1;
    const int Hs = N / 16;
    const double Ha = Hs / factor;
    FFT fft(N);
    std::vector<double> win(N);
    double winSq = 0;
    for (int n = 0; n < N; ++n) {
        win[n] = 0.5 - 0.5 * std::cos(2 * M_PI * n / N);
        winSq += win[n] * win[n];
    }
    const double norm = 1 / (N * (winSq / Hs)); // undo the unnormalised IFFT and the window overlap

    const size_t C = input.size();
    std::vector<Signal> out(C, Signal(outLen, 0.f));
    std::vector<double> re(N), im(N);
    std::vector<std::vector<double>> mag(C, std::vector<double>(bins)), phase(C, std::vector<double>(bins)),
        prevPhase(C, std::vector<double>(bins)), outPhase(C, std::vector<double>(bins));
    std::vector<double> sumMag(bins), prevSumMag(bins, 0.0);
    std::vector<int> owner(bins);
    std::vector<char> isPeak(bins);
    std::vector<int> peaks;

    long prevPos = -1;
    for (long t = 0;; ++t) {
        const long outCentre = t * Hs;
        if (outCentre - half > outLen) break;
        const long pos = std::lround(t * Ha);
        const long hop = prevPos < 0 ? 0 : pos - prevPos;

        // Analysis.
        std::fill(sumMag.begin(), sumMag.end(), 0.0);
        for (size_t c = 0; c < C; ++c) {
            const auto& x = input[c];
            for (int n = 0; n < N; ++n) {
                const long s = pos - half + n;
                re[n] = s >= 0 && s < inLen ? x[s] * win[n] : 0;
                im[n] = 0;
            }
            fft.complex(re.data(), im.data());
            for (int k = 0; k < bins; ++k) {
                const double m = std::hypot(re[k], im[k]);
                mag[c][k] = m;
                phase[c][k] = std::atan2(im[k], re[k]);
                sumMag[k] += m;
            }
        }

        // Peaks on the summed spectrum; every bin belongs to the peak on its side
        // of the lowest point between two peaks.
        const double peakMax = *std::max_element(sumMag.begin(), sumMag.end());
        const double floor = peakMax * 1e-5;
        std::fill(isPeak.begin(), isPeak.end(), 0);
        peaks.clear();
        for (int k = 2; k < bins - 2; ++k) {
            const double m = sumMag[k];
            if (m > floor && m > sumMag[k - 1] && m >= sumMag[k + 1] && m > sumMag[k - 2] && m >= sumMag[k + 2]) {
                isPeak[k] = 1;
                peaks.push_back(k);
            }
        }
        if (peaks.empty()) peaks.push_back(0);
        int k0 = 0;
        for (size_t p = 0; p < peaks.size(); ++p) {
            int end = bins - 1;
            if (p + 1 < peaks.size()) {
                end = peaks[p];
                for (int j = peaks[p]; j <= peaks[p + 1]; ++j) if (sumMag[j] < sumMag[end]) end = j;
            }
            for (int k = k0; k <= end; ++k) owner[k] = peaks[p];
            k0 = end + 1;
        }

        // Sharp onset: restart phase coherence from the input so the attack stays tight.
        double flux = 0, total = 0;
        for (int k = 0; k < bins; ++k) {
            flux += std::max(0.0, sumMag[k] - prevSumMag[k]);
            total += sumMag[k];
        }
        const bool reset = prevPos < 0 || hop == 0 || (total > 0 && flux / total > kTransientFlux);
        prevSumMag = sumMag;

        // Phase propagation and synthesis, per channel.
        for (size_t c = 0; c < C; ++c) {
            auto& ph = phase[c];
            auto& op = outPhase[c];
            if (reset) {
                op = ph;
            } else {
                for (int k : peaks) {
                    const double omega = 2 * M_PI * k / N;
                    const double dev = princarg(ph[k] - prevPhase[c][k] - omega * hop);
                    op[k] += Hs * (omega + dev / hop);
                }
                for (int k = 0; k < bins; ++k) {
                    if (isPeak[k]) continue;
                    const int pk = owner[k];
                    op[k] = op[pk] + (ph[k] - ph[pk]);
                }
            }
            prevPhase[c] = ph;

            const auto& m = mag[c];
            for (int k = 0; k < bins; ++k) {
                re[k] = m[k] * std::cos(op[k]);
                im[k] = m[k] * std::sin(op[k]);
            }
            for (int k = 1; k < half; ++k) {
                re[N - k] = re[k];
                im[N - k] = -im[k];
            }
            im[0] = 0;
            im[half] = 0;
            fft.complex(re.data(), im.data(), true);
            auto& y = out[c];
            const long start = outCentre - half;
            for (int n = 0; n < N; ++n) {
                const long s = start + n;
                if (s >= 0 && s < outLen) y[s] += static_cast<float>(re[n] * win[n] * norm);
            }
        }
        prevPos = pos;
    }
    return out;
}

double envelopeGain(double t, double dur, double level, const Envelope& env) {
    constexpr double kMinFade = 0.002;
    if (t <= 0 || t >= dur) return 0;
    double a = std::max(kMinFade, env.attack);
    double r = std::max(kMinFade, env.release);
    if (a + r > dur) {
        const double k = dur / (a + r);
        a *= k;
        r *= k;
    }
    const double relAt = dur - r;
    const double sustain = level * std::clamp(env.sustain, 0.0, 1.0);
    // Level at the start of the release, as the decay left it.
    auto beforeRelease = [&](double x) {
        if (x < a) return level * x / a;
        if (sustain >= level) return level;
        // Even a zero decay ramps briefly, so dropping to the sustain level never clicks.
        const double d = std::max(kMinFade, env.decay);
        if (x - a >= d) return sustain;
        return level + (sustain - level) * (x - a) / d;
    };
    if (t < relAt) return beforeRelease(t);
    const double atRelease = beforeRelease(relAt);
    return atRelease * (dur - t) / r;
}

} // namespace padchop
