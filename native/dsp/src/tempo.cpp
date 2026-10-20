// Tempo and beat tracking:
//   1. STFT at ~86 frames/s, 24 critical-band energies, mu-law log compression.
//   2. Two onset signals: a smooth, bass-weighted one for tempo and a sharper,
//      broadband one for beat placement (Butterworth low-pass -> diff -> rectify).
//   3. Tempo: bank of resonant comb filters (one per lag, 1.5 s half-life),
//      noise-baseline correction, octave reinforcement, log-likelihood histogram.
//   4. Beats: dynamic programming over beat positions with a stiff period prior.
//   5. Grid: least-squares fit; a straight grid when beats fit within a few ms.
//   6. Downbeat: where strong content steps up (ramp kernel over per-beat power).
#include "padchop/dsp.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numeric>

namespace padchop {

namespace {

constexpr double kFrameRate = 86.1328125; // 44100 / 512
constexpr double kMinBpm = 70;
constexpr double kMaxBpm = 180;
constexpr double kCombHalfLife = 1.5; // seconds
constexpr double kOffbeatDouble = 0.6;
constexpr double kTileSeconds = 30;
constexpr double kLoopMargin = 0.15;
constexpr std::array<int, 8> kLoopBeats{4, 8, 12, 16, 24, 32, 48, 64};
constexpr double kNegInf = -std::numeric_limits<double>::infinity();

constexpr std::array<double, 24> kBandCentres{50, 150, 250, 350, 450, 570, 700, 840, 1000, 1170, 1370, 1600,
                                              1850, 2150, 2500, 2900, 3400, 4000, 4800, 5800, 7000, 8500, 10500, 13500};
constexpr std::array<double, 24> kBandHalf{80, 100, 100, 100, 110, 120, 140, 150, 160, 190, 210, 240,
                                           280, 320, 380, 450, 550, 700, 900, 1100, 1300, 1800, 2500, 3500};

double tempoWeight(int i) { return i == 0 ? 12 : i == 1 ? 5 : 1; }
double beatWeight(int i) { return i < 6 ? 4 : 1; }
double powerWeight(int i) {
    if (i < 3) return std::array<double, 3>{3, 5, 4}[i];
    return i >= 16 && i < 22 ? 0.5 : 0;
}

struct Biquad4 { std::array<double, 5> b, a; };
// 4th-order Butterworth low-passes, Wn relative to the frame-rate Nyquist.
const Biquad4 kSmooth{{2.544e-4, 1.0176e-3, 1.5264e-3, 1.0176e-3, 2.544e-4}, {1, -3.28338, 4.0959, -2.29504, 0.48659}}; // ~3.8 Hz
const Biquad4 kSharp{{0.09398, 0.37592, 0.56388, 0.37592, 0.09398}, {1, 0, 0.48603, 0, 0.01766}};                    // ~21.5 Hz

struct Band { int lo; std::vector<float> w; };

std::vector<Band> triangularBands(int fftSize, double sampleRate) {
    const double binHz = sampleRate / fftSize;
    std::vector<Band> bands;
    for (size_t i = 0; i < kBandCentres.size(); ++i) {
        const double c = kBandCentres[i], half = kBandHalf[i];
        const int lo = std::max(1, static_cast<int>(std::ceil((c - half) / binHz)));
        const int hi = std::min(fftSize / 2, static_cast<int>(std::floor((c + half) / binHz)));
        std::vector<float> w(std::max(0, hi - lo + 1));
        double sum = 0;
        for (int k = lo; k <= hi; ++k) {
            const double v = std::max(0.0, 1 - std::abs(k * binHz - c) / half);
            w[k - lo] = static_cast<float>(v);
            sum += v;
        }
        // Bands narrower than a bin get the nearest bin; bands above Nyquist stay empty.
        if (sum == 0 && c < sampleRate / 2) {
            const int k = std::min(fftSize / 2, std::max(1, static_cast<int>(std::lround(c / binHz))));
            bands.push_back({k, {1.f}});
            continue;
        }
        for (auto& v : w) v = static_cast<float>(v / (sum != 0 ? sum : 1));
        bands.push_back({lo, std::move(w)});
    }
    return bands;
}

std::vector<float> iir(const std::vector<float>& x, const Biquad4& f, bool reverse) {
    const int n = static_cast<int>(x.size());
    auto xi = [&](int i) { return static_cast<double>(x[reverse ? n - 1 - i : i]); };
    std::vector<double> yv(n);
    // Start at steady state for the first sample to avoid a start-up transient.
    const double x0 = n ? xi(0) : 0;
    for (int i = 0; i < n; ++i) {
        double v = 0;
        for (int k = 0; k < 5; ++k) v += f.b[k] * (i - k >= 0 ? xi(i - k) : x0);
        for (int k = 1; k < 5; ++k) v -= f.a[k] * (i - k >= 0 ? yv[i - k] : x0);
        yv[i] = v;
    }
    std::vector<float> y(n);
    for (int i = 0; i < n; ++i) y[reverse ? n - 1 - i : i] = static_cast<float>(yv[i]);
    return y;
}

std::vector<float> filtfilt(const std::vector<float>& x, const Biquad4& f) { return iir(iir(x, f, false), f, true); }

std::vector<float> diffRectify(const std::vector<float>& x) {
    std::vector<float> y(x.size());
    for (size_t i = 1; i < x.size(); ++i) y[i] = std::max(0.f, x[i] - x[i - 1]);
    return y;
}

std::vector<float> upsample2(const std::vector<float>& x) {
    std::vector<float> y(x.size() * 2);
    for (size_t i = 0; i < x.size(); ++i) {
        y[2 * i] = x[i];
        y[2 * i + 1] = i + 1 < x.size() ? 0.5f * (x[i] + x[i + 1]) : x[i];
    }
    return y;
}

double peakLag(const std::vector<double>& hist) {
    int best = -1;
    for (int i = 0; i < static_cast<int>(hist.size()); ++i)
        if (best < 0 || hist[i] > hist[best]) best = i;
    if (best <= 0 || best + 1 >= static_cast<int>(hist.size())) return best;
    const double l = hist[best - 1], r = hist[best + 1];
    if (!std::isfinite(l) || !std::isfinite(r)) return best;
    const double d = l - 2 * hist[best] + r;
    return d < 0 ? best + 0.5 * (l - r) / d : best;
}

std::vector<float> combEvidence(const std::vector<float>& x, double period, double rate) {
    const int P = std::max(1, static_cast<int>(std::lround(period)));
    const double alpha = std::pow(2.0, -P / (kCombHalfLife * rate));
    const int n = static_cast<int>(x.size());
    std::vector<float> fwd(n), bwd(n), out(n);
    for (int i = 0; i < n; ++i) fwd[i] = static_cast<float>((1 - alpha) * x[i] + (i >= P ? alpha * fwd[i - P] : 0));
    for (int i = n - 1; i >= 0; --i) bwd[i] = static_cast<float>((1 - alpha) * x[i] + (i + P < n ? alpha * bwd[i + P] : 0));
    for (int i = 0; i < n; ++i) out[i] = static_cast<float>(fwd[i] + bwd[i] - (1 - alpha) * x[i]);
    return out;
}

struct Grid { double period, t0, meanError; };

Grid fitGrid(const std::vector<double>& beats) {
    const double n = static_cast<double>(beats.size());
    const double mi = (n - 1) / 2;
    const double mt = std::accumulate(beats.begin(), beats.end(), 0.0) / n;
    double sxy = 0, sxx = 0;
    for (size_t i = 0; i < beats.size(); ++i) {
        sxy += (i - mi) * (beats[i] - mt);
        sxx += (i - mi) * (i - mi);
    }
    const double period = sxx > 0 ? sxy / sxx : 0;
    const double t0 = mt - period * mi;
    double err = 0;
    for (size_t i = 0; i < beats.size(); ++i) err += std::abs(beats[i] - (t0 + period * i));
    return {period, t0, err / n};
}

double peakNear(const std::vector<float>& sig, double t, double radius, double rate) {
    const long c = std::lround(t * rate);
    const long r = std::lround(radius * rate);
    float m = 0;
    for (long i = std::max(0L, c - r); i <= std::min(static_cast<long>(sig.size()) - 1, c + r); ++i) m = std::max(m, sig[i]);
    return m;
}

int findDownbeat(const std::vector<double>& beats, const BeatFeatures& f) {
    const int n = static_cast<int>(beats.size());
    if (n < 4) return 0;
    std::vector<double> power(n), hit(n);
    for (int i = 0; i < n; ++i) {
        power[i] = peakNear(f.power, beats[i], 0.1, f.rate);
        hit[i] = peakNear(f.beatOnset, beats[i], 0.05, f.rate);
    }
    if (n >= 24) {
        std::array<double, 16> kernel{};
        for (int k = 0; k < 8; ++k) {
            kernel[k] = -(8 - k) / 72.0;
            kernel[8 + k] = (8 - k) / 72.0;
        }
        double best = 0;
        int arg = 0;
        for (int i = 0; i < n - 8; ++i) {
            double d = 0;
            for (int k = 0; k < 16; ++k) {
                const int j = i - 8 + k;
                const double v = j >= 0 && j < n ? power[j] + 0.35 * hit[j] : 0;
                d += kernel[k] * v;
            }
            if (d > best) { best = d; arg = i; }
        }
        if (best > 0) return arg;
    }
    // Bar phase: which of the 4 beat positions carries the strongest hits.
    int bestPhase = 0;
    double bestVal = kNegInf;
    for (int p = 0; p < 4; ++p) {
        double s = 0;
        int c = 0;
        for (int i = p; i < n; i += 4) { s += hit[i] + power[i]; ++c; }
        if (c && s / c > bestVal) { bestVal = s / c; bestPhase = p; }
    }
    return bestPhase;
}

double offbeatRatio(const std::vector<float>& onset, const std::vector<double>& beats, double rate) {
    double on = 0, off = 0;
    for (size_t i = 0; i + 1 < beats.size(); ++i) {
        on += peakNear(onset, beats[i], 0.03, rate);
        off += peakNear(onset, (beats[i] + beats[i + 1]) / 2, 0.03, rate);
    }
    return on > 0 ? off / on : 0;
}

std::vector<float> tile(const std::vector<float>& x, double rate) {
    const int reps = static_cast<int>(std::ceil(kTileSeconds * rate / std::max<size_t>(1, x.size())));
    if (reps <= 1) return x;
    std::vector<float> y;
    y.reserve(x.size() * reps);
    for (int r = 0; r < reps; ++r) y.insert(y.end(), x.begin(), x.end());
    return y;
}

double histAt(const std::vector<double>& hist, double lag) {
    const int i = static_cast<int>(std::floor(lag));
    const double f = lag - i;
    const double a = i >= 0 && i < static_cast<int>(hist.size()) ? hist[i] : kNegInf;
    const double b = i + 1 < static_cast<int>(hist.size()) ? hist[i + 1] : kNegInf;
    if (!std::isfinite(a)) return b;
    if (!std::isfinite(b)) return a;
    return a * (1 - f) + b * f;
}

} // namespace

BeatFeatures beatFeatures(const Signal& signal, double sampleRate) {
    const int hop = static_cast<int>(std::lround(sampleRate / kFrameRate));
    const int fftSize = 1 << (static_cast<int>(std::floor(std::log2(hop))) + 1);
    FFT fft(fftSize);
    const auto win = hann(fftSize);
    const auto bands = triangularBands(fftSize, sampleRate);
    const int n = static_cast<int>(signal.size());
    const int nFrames = (n + hop - 1) / hop;
    const int B = static_cast<int>(bands.size());
    std::vector<std::vector<float>> bandSig(B, std::vector<float>(nFrames));
    std::vector<float> frame(fftSize), mag(fftSize / 2 + 1);
    const double mu = 1 / std::log(101.0);

    for (int f = 0; f < nFrames; ++f) {
        const int start = f * hop - fftSize / 2;
        for (int i = 0; i < fftSize; ++i) {
            const int s = start + i;
            frame[i] = (s >= 0 && s < n ? signal[s] : 0.f) * win[i];
        }
        fft.magnitude(frame.data(), fftSize, mag.data());
        for (int b = 0; b < B; ++b) {
            double e = 0;
            const auto& band = bands[b];
            for (size_t k = 0; k < band.w.size(); ++k) e += band.w[k] * static_cast<double>(mag[band.lo + k]) * mag[band.lo + k];
            bandSig[b][f] = static_cast<float>(std::log1p(100 * e) * mu);
        }
    }

    BeatFeatures out;
    out.rate = sampleRate / hop;
    out.tempoOnset.assign(nFrames, 0.f);
    out.beatOnset.assign(nFrames, 0.f);
    out.power.assign(nFrames, 0.f);
    for (int b = 0; b < B; ++b) {
        const auto smooth = diffRectify(filtfilt(bandSig[b], kSmooth));
        const auto sharp = diffRectify(filtfilt(bandSig[b], kSharp));
        for (int f = 0; f < nFrames; ++f) {
            out.tempoOnset[f] += static_cast<float>(tempoWeight(b) * smooth[f]);
            out.beatOnset[f] += static_cast<float>(beatWeight(b) * sharp[f]);
            out.power[f] += static_cast<float>(powerWeight(b) * bandSig[b][f]);
        }
    }
    return out;
}

std::vector<double> combHistogram(const std::vector<float>& onset, double rate, double minBpm, double maxBpm) {
    const int lagMin = static_cast<int>(std::floor(60 * rate / maxBpm));
    const int lagMax = static_cast<int>(std::ceil(60 * rate / minBpm));
    const int lagLo = std::max(2, lagMin / 2);
    const int n = static_cast<int>(onset.size());
    std::vector<double> hist(lagMax + 1, 0.0), score(lagMax + 2, 0.0);
    const int step = std::max(1, static_cast<int>(std::lround(rate / 4))); // evaluate 4x per second

    std::vector<std::vector<float>> outputs(lagMax + 1);
    std::vector<double> alphas(lagMax + 1, 0.0);
    for (int lag = lagLo; lag <= lagMax; ++lag) {
        const double alpha = std::pow(2.0, -lag / (kCombHalfLife * rate));
        alphas[lag] = alpha;
        auto& y = outputs[lag];
        y.resize(n);
        for (int i = 0; i < n; ++i) y[i] = static_cast<float>((1 - alpha) * onset[i] + (i >= lag ? alpha * y[i - lag] : 0));
    }

    // Leaky average of input energy, for normalisation.
    std::vector<double> inEnergy(n);
    const double leak = std::pow(2.0, -1 / (kCombHalfLife * rate));
    double acc = 0, maxEnergy = 0;
    for (int i = 0; i < n; ++i) {
        acc = leak * acc + (1 - leak) * onset[i] * onset[i];
        inEnergy[i] = acc;
        maxEnergy = std::max(maxEnergy, acc);
    }

    for (int i = lagMax; i < n; i += step) {
        const double norm = std::max(inEnergy[i], 0.05 * maxEnergy);
        if (norm <= 0) continue;
        for (int lag = lagLo; lag <= lagMax; ++lag) {
            const auto& y = outputs[lag];
            double e = 0;
            for (int k = 0; k < lag; ++k) e += static_cast<double>(y[i - k]) * y[i - k];
            e /= lag * norm;
            // Expected output/input energy ratio for white noise.
            const double a = alphas[lag];
            const double c = (1 - a) / (1 + a);
            score[lag] = std::max(0.0, (e - c) / (1 - c));
        }
        for (int lag = lagMin; lag <= lagMax; ++lag) {
            const int h = lag >> 1;
            const double octave = std::max({score[h], score[h + 1], 0.001});
            hist[lag] += std::log(score[lag] * octave + 0.01);
        }
    }
    for (int lag = 0; lag < lagMin && lag <= lagMax; ++lag) hist[lag] = kNegInf;
    return hist;
}

std::vector<double> trackBeats(const std::vector<float>& onset, double period, double rate) {
    const auto ev = combEvidence(onset, period, rate);
    float max = 0;
    for (float v : ev) max = std::max(max, v);
    if (max == 0) return {};
    const int n = static_cast<int>(ev.size());
    std::vector<double> local(n), score(n, 0.0);
    std::vector<int> back(n, -1);
    for (int i = 0; i < n; ++i) local[i] = std::max(-10.0, std::log(ev[i] / static_cast<double>(max) + 1e-6));
    const int lo = static_cast<int>(std::lround(period * 0.8));
    const int hi = static_cast<int>(std::lround(period * 1.2));
    for (int i = 0; i < n; ++i) {
        double best = 0;
        int arg = -1;
        for (int d = lo; d <= hi && i - d >= 0; ++d) {
            const double dev = (d - period) / period;
            const double s = score[i - d] - 2500 * dev * dev;
            if (arg < 0 || s > best) { best = s; arg = i - d; }
        }
        score[i] = local[i] + (arg >= 0 ? best : 0);
        back[i] = arg;
    }
    // Best end point within the last period.
    int end = n - 1;
    for (int i = std::max(0, n - static_cast<int>(std::ceil(period))); i < n; ++i)
        if (score[i] > score[end]) end = i;
    std::vector<double> beats;
    for (int i = end; i >= 0; i = back[i]) beats.push_back(i / rate);
    std::reverse(beats.begin(), beats.end());
    return beats;
}

TempoResult detectTempo(const Signal& signal, double sampleRate, std::optional<double> hintBpm) {
    TempoResult result;
    result.source = hintBpm ? Source::Name : Source::Audio;
    result.bpm = hintBpm.value_or(120);
    const auto features = beatFeatures(signal, sampleRate);
    const double rate2 = features.rate * 2;
    const auto beatOnset = upsample2(features.beatOnset);
    const double duration = signal.size() / sampleRate;
    if (duration < 1) return result;

    double minBpm = kMinBpm, maxBpm = kMaxBpm;
    if (hintBpm) {
        minBpm = std::max(40.0, *hintBpm - 12.5);
        maxBpm = std::min(185.0, *hintBpm + 12.5);
    }

    const auto hist = combHistogram(upsample2(tile(features.tempoOnset, features.rate)), rate2, minBpm, maxBpm);
    std::vector<double> sorted;
    for (double v : hist) if (std::isfinite(v)) sorted.push_back(v);
    if (sorted.empty()) return result;
    std::sort(sorted.begin(), sorted.end(), std::greater<>());
    const double top = sorted.front();
    const double spread = top - sorted.back();

    double lag = peakLag(hist);
    // Loops: sample-pack material is usually cut to a whole number of bars, so a
    // tempo that fits the length exactly wins unless the evidence clearly disagrees.
    std::vector<double> loopLags;
    for (int beats : kLoopBeats) {
        const double l = 60 * rate2 * duration / (60.0 * beats);
        const double b = 60 * rate2 / l;
        if (b >= minBpm && b <= maxBpm) loopLags.push_back(l);
    }
    if (!loopLags.empty() && spread > 0) {
        double best = loopLags.front();
        for (double l : loopLags) if (histAt(hist, l) > histAt(hist, best)) best = l;
        if (histAt(hist, best) >= top - kLoopMargin * spread) lag = best;
    }
    // Octave check: comb histograms favour the half tempo when the kick only lands
    // on beats 1 and 3. If the off-beats carry nearly as much onset energy as the
    // beats (the snare on 2 and 4), the true tempo is double.
    if (60 * rate2 / (lag / 2) <= maxBpm && offbeatRatio(beatOnset, trackBeats(beatOnset, lag, rate2), rate2) > kOffbeatDouble)
        lag /= 2;
    // A labelled tempo is trusted exactly; analysis only finds the beat phase.
    if (hintBpm) lag = 60 * rate2 / *hintBpm;
    result.confidence = spread > 0 ? std::min(1.0, (top - sorted[std::min<size_t>(5, sorted.size() - 1)]) / spread * 4) : 0;

    auto beats = trackBeats(beatOnset, lag, rate2);
    double bpm = 60 * rate2 / lag;
    if (beats.size() >= 4) {
        const auto grid = fitGrid(beats);
        const double fitted = 60 / grid.period;
        if (!hintBpm && std::abs(fitted - bpm) / bpm < 0.02) bpm = fitted;
        // Steady material: replace tracked beats with an exact grid.
        if (grid.meanError <= 0.012 || hintBpm) {
            const double period = 60 / bpm;
            double t = grid.t0 + (grid.period - period) * ((beats.size() - 1) / 2.0);
            while (t - period >= -0.03) t -= period;
            beats.clear();
            for (; t < duration; t += period) if (t >= -0.03) beats.push_back(std::max(0.0, t));
        }
    }
    result.bpm = bpm;
    result.downbeatIndex = findDownbeat(beats, features);
    result.beats = std::move(beats);
    return result;
}

} // namespace padchop
