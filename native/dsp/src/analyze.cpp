#include "padchop/dsp.h"

#include <algorithm>
#include <cmath>

namespace padchop {

std::vector<float> peakEnvelope(const Signal& signal, double sampleRate, double perSecond) {
    const double step = sampleRate / perSecond;
    const int n = static_cast<int>(std::ceil(signal.size() / step));
    std::vector<float> peaks(n);
    float max = 0;
    for (int i = 0; i < n; ++i) {
        float p = 0;
        const size_t from = static_cast<size_t>(std::floor(i * step));
        const size_t to = std::min(signal.size(), static_cast<size_t>(std::floor((i + 1) * step)));
        for (size_t j = from; j < to; ++j) p = std::max(p, std::abs(signal[j]));
        peaks[i] = p;
        max = std::max(max, p);
    }
    if (max > 0) for (auto& p : peaks) p /= max;
    return peaks;
}

AnalysisResult analyze(const Signal& signal, double sampleRate, const NameHints& hints) {
    AnalysisResult r;
    r.sampleRate = sampleRate;
    r.duration = signal.size() / sampleRate;
    r.onsets = pickTransients(transientFrames(signal, sampleRate));
    r.tempo = detectTempo(signal, sampleRate, hints.bpm);
    r.key = detectKey(signal, sampleRate);
    // A key in the filename wins over the detected one.
    if (hints.key) {
        r.key.tonic = hints.key->first;
        r.key.mode = hints.key->second;
        r.key.confidence = 1;
        r.key.source = Source::Name;
    }
    r.regions = findRegions(signal, sampleRate);
    r.peaks = peakEnvelope(signal, sampleRate, r.peaksPerSecond);
    return r;
}

} // namespace padchop
