// Transient detection: octave bands anchored at ~86 Hz, log band energy, onset =
// rise above the maximum of the previous 8 frames, transient when the summed
// squared onsets pass a threshold, then peak picking.
#include "padchop/dsp.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace padchop {

namespace {
constexpr int kFft = 512;
constexpr int kHop = 256;
constexpr double kBandBaseHz = 86.13;
constexpr int kBands = 8;
constexpr int kLookback = 8;
constexpr double kThreshold = 0.04;
} // namespace

TransientFrames transientFrames(const Signal& signal, double sampleRate) {
    FFT fft(kFft);
    const auto win = hann(kFft);
    const int bins = kFft / 2 + 1;
    std::vector<int> bandOf(bins, -1);
    for (int j = 1; j < bins; ++j) {
        const int b = static_cast<int>(std::floor(std::log2(j * sampleRate / kFft / kBandBaseHz)));
        bandOf[j] = std::clamp(b, 0, kBands);
    }
    const int n = static_cast<int>(signal.size());
    const int nFrames = (n + kHop - 1) / kHop;
    std::vector<std::array<float, kBands>> levels(nFrames);
    TransientFrames out;
    out.intensity.assign(nFrames, 0.0);
    out.low.assign(nFrames, 0.0);
    std::vector<float> frame(kFft), mag(bins);
    std::array<double, kBands + 1> energy{};

    for (int f = 0; f < nFrames; ++f) {
        const int start = f * kHop;
        for (int i = 0; i < kFft; ++i) {
            const int s = start + i;
            frame[i] = (s < n ? signal[s] : 0.f) * win[i];
        }
        fft.magnitude(frame.data(), kFft, mag.data());
        energy.fill(0.0);
        for (int j = 1; j < bins; ++j) energy[bandOf[j]] += static_cast<double>(mag[j]) * mag[j];
        // Log band level, ln(E) / 5, floored at zero; the top band is dropped.
        for (int b = 0; b < kBands; ++b) levels[f][b] = static_cast<float>(std::max(0.0, std::log(energy[b] + 1e-12) / 5));

        double s = 0;
        for (int b = 0; b < kBands; ++b) {
            float prevMax = 0;
            for (int k = std::max(0, f - kLookback); k < f; ++k) prevMax = std::max(prevMax, levels[k][b]);
            const double o = std::max(0.0, static_cast<double>(levels[f][b]) - prevMax);
            s += o * o;
            if (b < 2) out.low[f] += o;
        }
        out.intensity[f] = s;
    }
    out.rate = sampleRate / kHop;
    out.frameSeconds = kFft / sampleRate;
    return out;
}

std::vector<Onset> pickTransients(const TransientFrames& tf, double minGap) {
    const auto& in = tf.intensity;
    const int n = static_cast<int>(in.size());
    std::vector<bool> flagged(n);
    for (int i = 0; i < n; ++i) flagged[i] = in[i] > kThreshold;
    for (int i = 1; i < n - 1; ++i)
        if (!flagged[i] && flagged[i - 1] && flagged[i + 1]) flagged[i] = true;

    struct Hit { int frame; double s; };
    std::vector<Hit> raw;
    for (int i = 0; i < n; ++i) {
        if (!flagged[i]) continue;
        int best = i;
        while (i + 1 < n && flagged[i + 1]) {
            ++i;
            if (in[i] > in[best]) best = i;
        }
        raw.push_back({best, in[best]});
    }
    const double gap = minGap * tf.rate;
    std::vector<Hit> kept;
    for (const auto& r : raw) {
        if (!kept.empty() && r.frame - kept.back().frame < gap) {
            if (r.s > kept.back().s) kept.back() = r;
        } else {
            kept.push_back(r);
        }
    }
    double max = 0;
    for (const auto& r : kept) max = std::max(max, r.s);
    std::vector<Onset> onsets;
    onsets.reserve(kept.size());
    // The rise peaks when the attack reaches the middle of the analysis window.
    for (const auto& r : kept)
        onsets.push_back({r.frame / tf.rate + tf.frameSeconds / 2, max > 0 ? std::sqrt(r.s / max) : 0.0});
    return onsets;
}

} // namespace padchop
