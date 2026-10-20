// padchop DSP: analysis (tempo, key, transients, sample regions), auto-chop,
// time-stretch and envelopes. Plain C++17, no framework dependencies.
// A port of src/dsp/*.ts; the TypeScript and C++ versions are kept in step.
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace padchop {

using Signal = std::vector<float>;

// ---------------------------------------------------------------- FFT

/** Iterative radix-2 FFT with cached twiddles and bit-reversal tables. */
class FFT {
public:
    explicit FFT(int size);
    int size() const { return n_; }
    /** |X[k]| for k in [0, size/2] from a real frame (zero-padded past `len`). */
    void magnitude(const float* input, int len, float* out);
    /** In-place complex transform; the inverse is unnormalised (divide by size). */
    void complex(double* re, double* im, bool inverse = false) const;

private:
    void transform(double* re, double* im, bool inverse) const;
    int n_;
    std::vector<double> cos_, sin_;
    std::vector<uint32_t> rev_;
    std::vector<double> re_, im_;
};

/** Periodic Hann window. */
std::vector<float> hann(int size);

// ---------------------------------------------------------------- Results

enum class Mode { Major, Minor };
enum class Source { Audio, Name };

struct Onset {
    double time = 0;     // seconds
    double strength = 0; // 0..1
};

struct TempoResult {
    double bpm = 120;
    std::vector<double> beats; // seconds
    int downbeatIndex = 0;
    double confidence = 0;
    Source source = Source::Audio;
};

struct KeyResult {
    int tonic = 0; // pitch class, 0 = C
    Mode mode = Mode::Major;
    double score = 0;
    double confidence = 0;
    std::vector<double> chroma; // 12 values, max-normalised
    Source source = Source::Audio;
};

struct Region {
    double start = 0, end = 0, score = 0;
};

struct AnalysisResult {
    double sampleRate = 0;
    double duration = 0;
    TempoResult tempo;
    KeyResult key;
    std::vector<Onset> onsets;
    std::vector<Region> regions;
    std::vector<float> peaks; // normalised peak envelope
    double peaksPerSecond = 400;
};

// ---------------------------------------------------------------- Analysis

struct NameHints {
    std::optional<double> bpm;
    std::optional<std::pair<int, Mode>> key;
};

/** BPM / key from sample-pack filenames ("zulu_texture_Cm_73", "Break 90BPM"). */
NameHints parseNameHints(const std::string& filename);

struct TransientFrames {
    std::vector<double> intensity;
    std::vector<double> low;
    double rate = 0;
    double frameSeconds = 0;
};
TransientFrames transientFrames(const Signal& signal, double sampleRate);
std::vector<Onset> pickTransients(const TransientFrames& tf, double minGap = 0.05);

struct BeatFeatures {
    double rate = 0;
    std::vector<float> tempoOnset, beatOnset, power;
};
BeatFeatures beatFeatures(const Signal& signal, double sampleRate);
std::vector<double> combHistogram(const std::vector<float>& onset, double rate, double minBpm = 70, double maxBpm = 180);
std::vector<double> trackBeats(const std::vector<float>& onset, double period, double rate);
TempoResult detectTempo(const Signal& signal, double sampleRate, std::optional<double> hintBpm = std::nullopt);

KeyResult detectKey(const Signal& signal, double sampleRate);

std::vector<float> brightness(const Signal& signal, double sampleRate);
std::vector<Region> findRegions(const Signal& signal, double sampleRate);

std::vector<float> peakEnvelope(const Signal& signal, double sampleRate, double perSecond = 400);

/** Windowed-sinc resampler (16 taps each side), used to prepare analysis input. */
Signal resample(const Signal& x, double from, double to);

/** Full analysis of a mono signal (22.05 kHz recommended). */
AnalysisResult analyze(const Signal& signal, double sampleRate, const NameHints& hints = {});

// ---------------------------------------------------------------- Chop

constexpr int kPadCount = 16;

struct Envelope {
    double attack = 0.002, decay = 0, sustain = 1, release = 0.01;
};

struct Slice {
    double start = 0, end = 0;
    int semitones = 0;
    double gain = 1;
    Envelope env;
};

enum class ChopMode { Find, Slicer, Random, Transients, Keys };

struct ChopSettings {
    ChopMode mode = ChopMode::Find;
    double beatStep = 1;  // slicer: beats per slice
    int offset = 0;       // slicer: shift in slice lengths
    double minGap = 0.25; // transients: seconds
    int seed = 1;         // random / find
};

/** Allowed slicer lengths, in beats. */
const std::vector<double>& beatSteps();

/** One entry per pad; std::nullopt = empty pad. */
using PadSlots = std::vector<std::optional<Slice>>;

ChopSettings initialChop(const AnalysisResult& a);
PadSlots autoChop(const AnalysisResult& a, const ChopSettings& s, double cursor = 0);
double quantizeToGrid(double t, const AnalysisResult& a, double fraction);

// ---------------------------------------------------------------- Time-stretch

/**
 * Stretch `input` (one vector per channel) to `factor` times its length,
 * keeping pitch: a peak-locked phase vocoder with a phase reset on onsets.
 */
std::vector<Signal> timeStretch(const std::vector<Signal>& input, double sampleRate, double factor);

// ---------------------------------------------------------------- Envelope

/**
 * Gain at time `t` (seconds from note start) for a chop lasting `dur` seconds:
 * attack to `level`, decay to sustain, release to zero by `dur`. Attack and
 * release shrink proportionally when the chop is shorter than both.
 */
double envelopeGain(double t, double dur, double level, const Envelope& env);

// ---------------------------------------------------------------- Keys

/** Semitones moving `track` onto `anchor`'s scale by the smallest interval (-6..+5). */
int keyMatchShift(const KeyResult& track, const KeyResult& anchor);

/** Keyboard-mode layout: bottom-left pad is the root, rising across then up. */
int keyboardSemitone(int pad, int octave);

} // namespace padchop
