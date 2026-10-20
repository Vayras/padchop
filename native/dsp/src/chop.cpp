// Auto-chop modes: find samples, slicer, random, transients and key shift.
#include "padchop/dsp.h"

#include <algorithm>
#include <cmath>

namespace padchop {

namespace {

constexpr double kTailGuard = 0.5; // never start a chop in the last half second

/** JavaScript Math.round: halves round towards +infinity. */
double jsRound(double x) { return std::floor(x + 0.5); }

/** Deterministic PRNG (mulberry32) so "shuffle" is reproducible and matches the web app. */
class Mulberry32 {
public:
    explicit Mulberry32(uint32_t seed) : a_(seed) {}
    double next() {
        a_ += 0x6d2b79f5u;
        uint32_t t = a_;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return (t ^ (t >> 14)) / 4294967296.0;
    }

private:
    uint32_t a_;
};

std::vector<double> pickRandom(std::vector<double> items, int n, Mulberry32& rand) {
    const int k = std::min<int>(n, static_cast<int>(items.size()));
    for (int i = 0; i < k; ++i) {
        const int j = i + static_cast<int>(std::floor(rand.next() * (items.size() - i)));
        std::swap(items[i], items[j]);
    }
    items.resize(k);
    return items;
}

Slice makeSlice(double start, double end) {
    Slice s;
    s.start = start;
    s.end = end;
    return s;
}

/** Each chop runs to the next beat-aligned chop, capped at one bar. */
PadSlots startsToSlices(std::vector<double> starts, const AnalysisResult& a) {
    std::sort(starts.begin(), starts.end());
    const double bar = 4 * 60 / a.tempo.bpm;
    PadSlots out;
    for (size_t i = 0; i < starts.size(); ++i) {
        const double next = i + 1 < starts.size() ? starts[i + 1] : a.duration;
        out.push_back(makeSlice(starts[i], std::min({next, starts[i] + bar, a.duration})));
    }
    return out;
}

} // namespace

const std::vector<double>& beatSteps() {
    static const std::vector<double> steps{0.5, 1, 2, 4, 8, 16};
    return steps;
}

ChopSettings initialChop(const AnalysisResult& a) {
    ChopSettings s;
    if (a.duration > 30) return s;
    const double beats = a.duration * a.tempo.bpm / 60;
    s.mode = ChopMode::Slicer;
    s.beatStep = 16;
    for (double b : beatSteps()) {
        if (beats / b <= kPadCount) { s.beatStep = b; break; }
    }
    return s;
}

double quantizeToGrid(double t, const AnalysisResult& a, double fraction) {
    const auto& beats = a.tempo.beats;
    if (beats.size() < 2) return t;
    int i = -1;
    for (size_t k = 0; k < beats.size(); ++k) if (beats[k] > t) { i = static_cast<int>(k); break; }
    if (i <= 0) i = i == 0 ? 1 : static_cast<int>(beats.size()) - 1;
    const double b0 = beats[i - 1], b1 = beats[i];
    const double step = (b1 - b0) * fraction;
    return std::max(0.0, b0 + jsRound((t - b0) / step) * step);
}

PadSlots autoChop(const AnalysisResult& a, const ChopSettings& s, double cursor) {
    std::vector<double> beats;
    for (double b : a.tempo.beats) if (b < a.duration - kTailGuard) beats.push_back(b);
    Mulberry32 rand(static_cast<uint32_t>(s.seed * 7919 + 1));

    switch (s.mode) {
    case ChopMode::Random: {
        if (a.duration <= 3.5) return {makeSlice(0, a.duration)};
        if (static_cast<int>(beats.size()) < kPadCount) {
            std::vector<double> times;
            for (int i = 0; i < kPadCount; ++i) times.push_back(rand.next() * (a.duration - kTailGuard));
            return startsToSlices(times, a);
        }
        return startsToSlices(pickRandom(beats, kPadCount, rand), a);
    }
    case ChopMode::Find: {
        std::vector<double> inRegion;
        for (double b : beats)
            for (const auto& r : a.regions)
                if (b >= r.start && b < r.end) { inRegion.push_back(b); break; }
        // Fewer candidates than pads: use them all and leave the rest empty.
        if (static_cast<int>(inRegion.size()) > kPadCount) inRegion = pickRandom(inRegion, kPadCount, rand);
        return startsToSlices(inRegion, a);
    }
    case ChopMode::Slicer: {
        const double len = s.beatStep * 60 / a.tempo.bpm;
        const double start = quantizeToGrid(cursor, a, 0.25) + s.offset * len;
        PadSlots out;
        for (int i = 0; i < kPadCount; ++i) {
            const double t0 = start + i * len;
            if (t0 < 0) continue;
            if (t0 + len / 2 > a.duration) break; // keep the last slice if at least half of it exists
            out.push_back(makeSlice(t0, std::min(t0 + len, a.duration)));
        }
        return out;
    }
    case ChopMode::Transients: {
        // Strongest first, greedily keeping those at least minGap from any kept one.
        auto byStrength = a.onsets;
        std::stable_sort(byStrength.begin(), byStrength.end(), [](const Onset& x, const Onset& y) { return x.strength > y.strength; });
        std::vector<double> kept;
        for (const auto& o : byStrength) {
            if (o.time >= a.duration - kTailGuard) continue;
            if (std::all_of(kept.begin(), kept.end(), [&](double t) { return std::abs(t - o.time) >= s.minGap; })) kept.push_back(o.time);
            if (static_cast<int>(kept.size()) == kPadCount) break;
        }
        std::sort(kept.begin(), kept.end());
        PadSlots out;
        for (size_t i = 0; i < kept.size(); ++i)
            out.push_back(makeSlice(kept[i], std::min(i + 1 < kept.size() ? kept[i + 1] : a.duration, a.duration)));
        return out;
    }
    case ChopMode::Keys: {
        // One beat-quantised chop, pads 1..16 = -7..+8 semitones (pad 8 is the original).
        const double start = quantizeToGrid(cursor, a, 1);
        const double end = std::min(a.duration, start + 60 / a.tempo.bpm * 2);
        PadSlots out;
        for (int i = 0; i < kPadCount; ++i) {
            auto sl = makeSlice(start, end);
            sl.semitones = i - 7;
            out.push_back(sl);
        }
        return out;
    }
    }
    return {};
}

} // namespace padchop
