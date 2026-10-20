// "Find samples" regions: 8 band powers -> per-0.5 s means -> log-squared
// levels -> low/mid/high colour channels -> Rec.709 luminance ("waveform
// brightness"). Windows of medium brightness (busy but not dense) are kept and
// merged into regions.
#include "padchop/dsp.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace padchop {

namespace {
constexpr std::array<double, 7> kBandEdges{170, 340, 680, 1360, 2720, 5440, 10880}; // Hz; 8 bands
constexpr double kWindowSeconds = 0.5;
constexpr double kKeepMin = 0.26;
constexpr double kKeepMax = 0.49;
} // namespace

std::vector<float> brightness(const Signal& signal, double sampleRate) {
    // ~11.6 ms frames: 512 points at 44.1 kHz, 256 at 22.05 kHz.
    const int n = sampleRate > 30000 ? 512 : 256;
    FFT fft(n);
    const int bins = n / 2 + 1;
    std::vector<int> bandOf(bins);
    for (int j = 0; j < bins; ++j) {
        const double hz = j * sampleRate / n;
        int b = 0;
        while (b < static_cast<int>(kBandEdges.size()) && hz >= kBandEdges[b]) ++b;
        bandOf[j] = b;
    }
    float peak = 0;
    for (float v : signal) peak = std::max(peak, std::abs(v));
    const double gain = peak > 0 && peak < 0.95 ? 1 / (static_cast<double>(peak) * peak) : 1;

    const int framesPerWindow = std::max(1, static_cast<int>(std::lround(kWindowSeconds * sampleRate / n)));
    const int nFrames = static_cast<int>(signal.size()) / n;
    const int nWindows = (nFrames + framesPerWindow - 1) / framesPerWindow;
    std::vector<float> scores(nWindows);
    std::vector<float> mag(bins);
    std::array<double, 8> acc{}, L{};

    for (int w = 0; w < nWindows; ++w) {
        acc.fill(0);
        const int f0 = w * framesPerWindow;
        const int f1 = std::min(nFrames, f0 + framesPerWindow);
        for (int f = f0; f < f1; ++f) {
            fft.magnitude(signal.data() + static_cast<size_t>(f) * n, n, mag.data());
            for (int j = 1; j < bins; ++j) acc[bandOf[j]] += static_cast<double>(mag[j]) * mag[j] / (static_cast<double>(n) * n);
        }
        for (int b = 0; b < 8; ++b) {
            const double mean = acc[b] * gain / std::max(1, f1 - f0);
            const double l = std::max(0.0, std::log(mean + 1e-30) + 9.21);
            L[b] = l * l;
        }
        const double low = 0.018 * L[0] + 0.012 * L[1] + 0.006 * L[2];
        const double mid = 0.012 * L[2] + 0.018 * L[3] + 0.012 * L[4];
        const double high = 0.006 * L[4] + 0.012 * L[5] + 0.018 * L[6] + 0.024 * L[7];
        scores[w] = static_cast<float>(0.2126 * std::min(low + 0.2, 1.0) + 0.7152 * std::min(mid + 0.2, 1.0) + 0.0722 * std::min(high + 0.2, 1.0));
    }
    return scores;
}

std::vector<Region> findRegions(const Signal& signal, double sampleRate) {
    const double duration = signal.size() / sampleRate;
    const auto scores = brightness(signal, sampleRate);
    std::vector<Region> regions;
    std::optional<Region> open;
    for (size_t w = 0; w < scores.size(); ++w) {
        const bool keep = scores[w] >= kKeepMin && scores[w] < kKeepMax;
        const double t = w * kWindowSeconds;
        if (keep) {
            if (!open) open = Region{t, t, 0};
            open->end = std::min(duration, t + kWindowSeconds);
            open->score += scores[w];
        } else if (open) {
            regions.push_back(*open);
            open.reset();
        }
    }
    if (open) regions.push_back(*open);
    return regions;
}

} // namespace padchop
