// Native DSP tests: the same synthetic-signal checks as src/dsp/*.test.ts.
#include "padchop/dsp.h"

#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

using namespace padchop;

namespace {

int failures = 0;
int checks = 0;
std::string current;

void check(bool ok, const std::string& what) {
    ++checks;
    if (!ok) {
        ++failures;
        std::printf("  FAIL [%s] %s\n", current.c_str(), what.c_str());
    }
}

void test(const std::string& name, const std::function<void()>& body) {
    current = name;
    const int before = failures;
    body();
    std::printf("%s %s\n", failures == before ? "ok  " : "FAIL", name.c_str());
}

std::string fmt(double v) { return std::to_string(v); }

// ---- synthesis (ported from src/dsp/synth.ts) ----

void tone(Signal& out, double sr, double start, double dur, double hz, double amp, int harmonics = 5) {
    const long s0 = static_cast<long>(std::floor(start * sr));
    const long n = std::min(static_cast<long>(out.size()) - s0, static_cast<long>(std::floor(dur * sr)));
    for (long i = 0; i < n; ++i) {
        const double t = i / sr;
        const double env = std::min(1.0, i / (0.01 * sr)) * std::exp(-t * 1.5);
        double v = 0;
        for (int h = 1; h <= harmonics; ++h) v += std::sin(2 * M_PI * hz * h * t) / h;
        out[s0 + i] += static_cast<float>(amp * env * v);
    }
}

void kick(Signal& out, double sr, double start, double amp = 0.9) {
    const long s0 = static_cast<long>(std::floor(start * sr));
    const long n = std::min(static_cast<long>(out.size()) - s0, static_cast<long>(std::floor(0.25 * sr)));
    double phase = 0;
    for (long i = 0; i < n; ++i) {
        const double t = i / sr;
        const double f = 50 + 110 * std::exp(-t * 30);
        phase += 2 * M_PI * f / sr;
        out[s0 + i] += static_cast<float>(amp * std::exp(-t * 14) * std::sin(phase));
    }
}

void noiseHit(Signal& out, double sr, double start, double decay, double amp, uint32_t seed = 1) {
    const long s0 = static_cast<long>(std::floor(start * sr));
    const long n = std::min(static_cast<long>(out.size()) - s0, static_cast<long>(std::floor(0.3 * sr)));
    uint32_t x = seed;
    double prev = 0;
    for (long i = 0; i < n; ++i) {
        x = x * 1664525u + 1013904223u;
        const double r = x / 4294967296.0 - 0.5;
        const double hp = r - prev;
        prev = r;
        out[s0 + i] += static_cast<float>(amp * std::exp(-(i / sr) * decay) * hp);
    }
}

double midiHz(int m) { return 440 * std::pow(2.0, (m - 69) / 12.0); }

Signal makeLoop(double bpm, int bars, const std::vector<std::vector<int>>& chords, double sr, double offset = 0) {
    const double beat = 60 / bpm;
    Signal out(static_cast<size_t>(std::ceil((offset + bars * 4 * beat + 0.5) * sr)), 0.f);
    for (int bar = 0; bar < bars; ++bar) {
        const double t0 = offset + bar * 4 * beat;
        const auto& chord = chords[bar % chords.size()];
        for (int m : chord) tone(out, sr, t0, 4 * beat, midiHz(m), 0.12);
        tone(out, sr, t0, 4 * beat, midiHz(chord[0] - 12), 0.18, 3);
        for (int b = 0; b < 4; ++b) {
            const double t = t0 + b * beat;
            if (b == 0 || b == 2) kick(out, sr, t, b == 0 ? 1 : 0.7);
            if (b == 1 || b == 3) noiseHit(out, sr, t, 18, 0.9, bar * 4 + b + 1);
            noiseHit(out, sr, t + beat / 2, 60, 0.25, 97 + bar * 4 + b);
        }
    }
    return out;
}

Signal sine(double hz, double seconds, double sr, double amp = 0.5) {
    Signal x(static_cast<size_t>(std::lround(seconds * sr)));
    for (size_t i = 0; i < x.size(); ++i) x[i] = static_cast<float>(amp * std::sin(2 * M_PI * hz * i / sr));
    return x;
}

double pitchOf(const Signal& x, double sr) {
    const size_t a = x.size() / 4, b = x.size() * 3 / 4;
    int crossings = 0;
    for (size_t i = a + 1; i < b; ++i) if (x[i - 1] < 0 && x[i] >= 0) ++crossings;
    return crossings * sr / (b - a);
}

double rms(const Signal& x) {
    const size_t a = x.size() / 4, b = x.size() * 3 / 4;
    double s = 0;
    for (size_t i = a; i < b; ++i) s += x[i] * x[i];
    return std::sqrt(s / (b - a));
}

} // namespace

int main() {
    const double SR = 22050;
    const std::vector<std::vector<int>> I_IV_V_I{{60, 64, 67}, {65, 69, 72}, {67, 71, 74}, {60, 64, 67}};

    test("key: C major from I-IV-V-I", [&] {
        const auto k = detectKey(makeLoop(100, 8, I_IV_V_I, SR), SR);
        check(k.tonic == 0 && k.mode == Mode::Major, "got " + std::to_string(k.tonic));
    });
    test("key: A minor from i-iv-v-i", [&] {
        const auto k = detectKey(makeLoop(90, 8, {{57, 60, 64}, {62, 65, 69}, {64, 67, 71}, {57, 60, 64}}, SR), SR);
        check(k.tonic == 9 && k.mode == Mode::Minor, "got " + std::to_string(k.tonic));
    });
    test("key: F# major after transposition", [&] {
        auto chords = I_IV_V_I;
        for (auto& c : chords) for (auto& m : c) m += 6;
        const auto k = detectKey(makeLoop(120, 8, chords, SR), SR);
        check(k.tonic == 6 && k.mode == Mode::Major, "got " + std::to_string(k.tonic));
    });

    const std::vector<std::vector<int>> chords{{60, 64, 67}, {65, 69, 72}, {67, 71, 74}, {57, 60, 64}};
    for (double bpm : {78.0, 92.0, 120.0, 140.0, 174.0}) {
        test("tempo: " + fmt(bpm) + " BPM", [&] {
            const auto t = detectTempo(makeLoop(bpm, 12, chords, SR, 0.37), SR);
            check(std::abs(t.bpm - bpm) < 0.5, "got " + fmt(t.bpm));
        });
    }
    test("tempo: beats on the hits, downbeat on bar starts", [&] {
        const double bpm = 100, offset = 0.37, period = 60 / bpm;
        const auto t = detectTempo(makeLoop(bpm, 12, chords, SR, offset), SR);
        for (double b : t.beats) {
            const double k = std::round((b - offset) / period);
            check(std::abs(b - (offset + k * period)) < 0.02, "beat at " + fmt(b));
        }
        const double db = t.beats[t.downbeatIndex];
        check(static_cast<long>(std::lround((db - offset) / period)) % 4 == 0, "downbeat at " + fmt(db));
    });
    test("tempo: filename hint is used exactly", [&] {
        const auto t = detectTempo(makeLoop(96, 8, chords, SR, 0.2), SR, 96.0);
        check(std::abs(t.bpm - 96) < 1e-9 && t.source == Source::Name, "got " + fmt(t.bpm));
    });

    test("transients: each hit within 12 ms", [&] {
        const std::vector<double> times{0.25, 0.71, 1.1, 1.6, 2.05, 2.4};
        Signal sig(static_cast<size_t>(3 * SR), 0.f);
        for (size_t i = 0; i < times.size(); ++i) {
            if (i % 2) noiseHit(sig, SR, times[i], 20, 0.8, static_cast<uint32_t>(i + 3));
            else kick(sig, SR, times[i]);
        }
        const auto onsets = pickTransients(transientFrames(sig, SR));
        check(onsets.size() == times.size(), "found " + std::to_string(onsets.size()));
        for (size_t i = 0; i < std::min(onsets.size(), times.size()); ++i)
            check(std::abs(onsets[i].time - times[i]) < 0.012, "onset " + fmt(onsets[i].time));
    });
    test("transients: silence has none", [&] {
        check(pickTransients(transientFrames(Signal(static_cast<size_t>(SR), 0.f), SR)).empty(), "non-empty");
    });

    test("hints: filenames", [&] {
        struct Case { const char* name; double bpm; int tonic; int mode; }; // mode: -1 none, 0 major, 1 minor
        const Case cases[] = {
            {"zulu_texture_Cm_73.wav", 73, 0, 1},
            {"All Killer Breaks - KB5 Kit06 Break01 90BPM_01.wav", 90, -1, -1},
            {"MSXII_SchlumpLoops10_Fast Paced_142 Bpm.wav", 142, -1, -1},
            {"DrumLoop22_BasementBreaks_100.wav", 100, -1, -1},
            {"Pad F#min 120 bpm.wav", 120, 6, 1},
            {"Keys Eb major 86.wav", 86, 3, 0},
            {"All Killer Breaks - KB8 Break05 80BPPM_01.wav", 80, -1, -1},
            {"Break A.wav", 0, -1, -1},
        };
        for (const auto& c : cases) {
            const auto h = parseNameHints(c.name);
            check(c.bpm ? (h.bpm && *h.bpm == c.bpm) : !h.bpm, std::string(c.name) + " bpm");
            if (c.mode < 0) check(!h.key, std::string(c.name) + " key should be empty");
            else check(h.key && h.key->first == c.tonic && (h.key->second == Mode::Minor) == (c.mode == 1), std::string(c.name) + " key");
        }
    });

    for (double factor : {0.6, 1.25, 1.8}) {
        test("stretch: x" + fmt(factor) + " keeps pitch and level", [&] {
            const double sr = 44100;
            const auto x = sine(440, 1, sr);
            const auto y = timeStretch({x}, sr, factor)[0];
            check(y.size() == static_cast<size_t>(std::lround(x.size() * factor)), "length");
            check(std::abs(pitchOf(y, sr) - 440) < 3, "pitch " + fmt(pitchOf(y, sr)));
            check(std::abs(rms(y) / rms(x) - 1) < 0.1, "level " + fmt(rms(y) / rms(x)));
        });
    }
    test("stretch: drum hits land at stretched positions", [&] {
        const double sr = 44100, factor = 1.5;
        Signal x(static_cast<size_t>(2 * sr), 0.f);
        const std::vector<double> hits{0.2, 0.7, 1.2, 1.7};
        for (double t : hits) kick(x, sr, t);
        const auto y = timeStretch({x}, sr, factor)[0];
        std::vector<Onset> strong;
        for (const auto& o : pickTransients(transientFrames(y, sr))) if (o.strength > 0.3) strong.push_back(o);
        check(strong.size() == hits.size(), "found " + std::to_string(strong.size()));
        for (size_t i = 0; i < std::min(strong.size(), hits.size()); ++i)
            check(std::abs(strong[i].time - hits[i] * factor) < 0.02, "hit " + fmt(strong[i].time));
    });

    test("envelope: ADSR shape", [&] {
        const Envelope env{0.1, 0.2, 0.5, 0.2};
        check(envelopeGain(0, 1, 0.8, env) == 0, "start");
        check(std::abs(envelopeGain(0.1, 1, 0.8, env) - 0.8) < 1e-9, "peak");
        check(std::abs(envelopeGain(0.3, 1, 0.8, env) - 0.4) < 1e-9, "sustain");
        check(std::abs(envelopeGain(0.9, 1, 0.8, env) - 0.2) < 1e-9, "release midpoint");
        check(envelopeGain(1, 1, 0.8, env) == 0, "end");
        check(std::abs(envelopeGain(0.05, 0.1, 1, {0.2, 0, 1, 0.2}) - 1) < 1e-9, "squeezed peak");
    });

    test("keys: match shift and keyboard layout", [&] {
        auto key = [](int t, Mode m) { KeyResult k; k.tonic = t; k.mode = m; return k; };
        check(keyMatchShift(key(2, Mode::Minor), key(0, Mode::Minor)) == -2, "Dm->Cm");
        check(keyMatchShift(key(10, Mode::Major), key(0, Mode::Major)) == 2, "Bb->C");
        check(keyMatchShift(key(6, Mode::Major), key(0, Mode::Major)) == -6, "F#->C");
        check(keyMatchShift(key(3, Mode::Major), key(0, Mode::Minor)) == 0, "Eb ~ Cm");
        check(keyboardSemitone(12, 0) == 0 && keyboardSemitone(3, 0) == 15 && keyboardSemitone(12, -1) == -12, "layout");
    });

    test("chop: slicer covers a short loop with 16 pads", [&] {
        auto sig = makeLoop(90, 2, chords, SR);
        sig.resize(static_cast<size_t>(std::lround(8 * 60.0 / 90 * SR))); // exactly two bars, like a pack loop
        const auto a = analyze(sig, SR, parseNameHints("break_90.wav"));
        const auto s = initialChop(a);
        const auto pads = autoChop(a, s);
        check(s.mode == ChopMode::Slicer && s.beatStep == 0.5, "settings");
        check(pads.size() == 16, "pads " + std::to_string(pads.size()));
    });

    std::printf("\n%d checks, %d failed\n", checks, failures);
    return failures ? 1 : 0;
}
