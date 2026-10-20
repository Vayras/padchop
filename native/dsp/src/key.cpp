// Global key estimation: long-window STFT -> 72 semitone filters (C1..B6,
// A4 = 440 Hz) -> sum over the whole track -> separate bass / treble chroma ->
// rotate-and-correlate against the Krumhansl-Kessler major/minor profiles.
#include "padchop/dsp.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>

namespace padchop {

namespace {

constexpr std::array<double, 12> kMajor{6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88};
constexpr std::array<double, 12> kMinor{6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17};
constexpr int kLowestMidi = 24; // C1
constexpr int kSemitones = 72;
constexpr int kBassFrom = 39, kBassTo = 52;     // D#2..E3
constexpr int kTrebleFrom = 53, kTrebleTo = 95; // F3..B6
constexpr double kBassWeight = 0.35;

double midiToHz(int m) { return 440 * std::pow(2.0, (m - 69) / 12.0); }

struct Filter { int lo; std::vector<float> weights; };

/** Raised-cosine filters roughly 0.8 semitone wide, one per semitone. */
std::vector<Filter> semitoneFilters(int fftSize, double sampleRate) {
    std::vector<Filter> filters;
    for (int s = 0; s < kSemitones; ++s) {
        const double centre = midiToHz(kLowestMidi + s) * fftSize / sampleRate;
        const double width = std::max(1.0, centre * (std::pow(2.0, 0.4 / 12) - std::pow(2.0, -0.4 / 12)));
        const int lo = std::max(1, static_cast<int>(std::ceil(centre - width / 2)));
        const int hi = std::min(fftSize / 2, static_cast<int>(std::floor(centre + width / 2)));
        const int n = std::max(1, hi - lo + 1);
        std::vector<float> w(n);
        double sum = 0;
        for (int b = 0; b < n; ++b) {
            // Fall back to the single nearest bin when the filter is narrower than a bin.
            const double x = n == 1 ? 0.5 : (lo + b - (centre - width / 2)) / width;
            w[b] = static_cast<float>(0.5 - 0.5 * std::cos(2 * M_PI * std::clamp(x, 0.0, 1.0)));
            sum += w[b];
        }
        if (sum == 0) std::fill(w.begin(), w.end(), 1.f / n);
        else for (auto& v : w) v = static_cast<float>(v / sum);
        filters.push_back({n == 1 ? static_cast<int>(std::lround(centre)) : lo, std::move(w)});
    }
    return filters;
}

std::array<double, kSemitones> semitoneProfile(const Signal& signal, double sampleRate) {
    const int fftSize = sampleRate > 30000 ? 16384 : 8192;
    const int hop = fftSize / 4;
    FFT fft(fftSize);
    const auto win = hann(fftSize);
    const auto filters = semitoneFilters(fftSize, sampleRate);
    std::vector<float> frame(fftSize), mag(fftSize / 2 + 1);
    std::array<double, kSemitones> total{}, energy{};
    const int len = static_cast<int>(signal.size());

    for (int start = 0; start + fftSize <= len || start == 0; start += hop) {
        for (int i = 0; i < fftSize; ++i) {
            const int s = start + i;
            frame[i] = (s < len ? signal[s] : 0.f) * win[i];
        }
        fft.magnitude(frame.data(), fftSize, mag.data());
        double frameSum = 0;
        for (int s = 0; s < kSemitones; ++s) {
            const auto& f = filters[s];
            double e = 0;
            for (size_t b = 0; b < f.weights.size(); ++b) {
                const size_t k = f.lo + b;
                const double m = k < mag.size() ? mag[k] : 0.0;
                e += f.weights[b] * m * m;
            }
            energy[s] = std::sqrt(e);
            frameSum += energy[s];
        }
        // Per-frame normalisation so loud sections don't dominate the sum.
        if (frameSum > 1e-9)
            for (int s = 0; s < kSemitones; ++s) total[s] += energy[s] / frameSum;
        if (start + fftSize > len) break;
    }
    return total;
}

std::array<double, 12> fold(const std::array<double, kSemitones>& profile, int from, int to) {
    std::array<double, 12> c{};
    for (int m = from; m <= to; ++m) {
        const int i = m - kLowestMidi;
        c[m % 12] += i >= 0 && i < kSemitones ? profile[i] : 0.0;
    }
    const double sum = std::accumulate(c.begin(), c.end(), 0.0);
    if (sum > 0) for (auto& v : c) v /= sum;
    return c;
}

double pearson(const std::array<double, 12>& x, const std::array<double, 12>& y) {
    const double mx = std::accumulate(x.begin(), x.end(), 0.0) / 12;
    const double my = std::accumulate(y.begin(), y.end(), 0.0) / 12;
    double sxy = 0, sxx = 0, syy = 0;
    for (int i = 0; i < 12; ++i) {
        const double dx = x[i] - mx, dy = y[i] - my;
        sxy += dx * dy;
        sxx += dx * dx;
        syy += dy * dy;
    }
    return sxx > 0 && syy > 0 ? sxy / std::sqrt(sxx * syy) : 0;
}

/** Template rotated so index 0 is pitch class `tonic`. */
std::array<double, 12> rotate(const std::array<double, 12>& t, int tonic) {
    std::array<double, 12> r{};
    for (int pc = 0; pc < 12; ++pc) r[pc] = t[(pc - tonic + 12) % 12];
    return r;
}

} // namespace

KeyResult detectKey(const Signal& signal, double sampleRate) {
    const auto profile = semitoneProfile(signal, sampleRate);
    const auto bass = fold(profile, kBassFrom, kBassTo);
    const auto treble = fold(profile, kTrebleFrom, kTrebleTo);
    std::array<double, 12> chroma{};
    for (int i = 0; i < 12; ++i) chroma[i] = (1 - kBassWeight) * treble[i] + kBassWeight * bass[i];

    struct Scored { int tonic; Mode mode; double score; };
    std::vector<Scored> scored;
    for (const auto mode : {Mode::Major, Mode::Minor}) {
        const auto& tmpl = mode == Mode::Major ? kMajor : kMinor;
        for (int tonic = 0; tonic < 12; ++tonic) {
            const auto t = rotate(tmpl, tonic);
            scored.push_back({tonic, mode, (1 - kBassWeight) * pearson(treble, t) + kBassWeight * pearson(bass, t)});
        }
    }
    std::stable_sort(scored.begin(), scored.end(), [](const Scored& a, const Scored& b) { return a.score > b.score; });
    const double max = *std::max_element(chroma.begin(), chroma.end());

    KeyResult k;
    k.tonic = scored[0].tonic;
    k.mode = scored[0].mode;
    k.score = scored[0].score;
    k.confidence = std::clamp((scored[0].score - scored[1].score) * 5, 0.0, 1.0);
    for (double v : chroma) k.chroma.push_back(max > 0 ? v / max : 0);
    return k;
}

int keyMatchShift(const KeyResult& track, const KeyResult& anchor) {
    auto relativeMajor = [](const KeyResult& k) { return (k.tonic + (k.mode == Mode::Minor ? 3 : 0)) % 12; };
    const int d = (relativeMajor(anchor) - relativeMajor(track) + 12) % 12;
    return d > 5 ? d - 12 : d;
}

int keyboardSemitone(int pad, int octave) {
    const int row = pad / 4, col = pad % 4;
    return (3 - row) * 4 + col + octave * 12;
}

} // namespace padchop
