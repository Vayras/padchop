// The audio engine: pad voices with envelopes and time-stretch, four mixer
// buses, and a step sequencer that follows the host transport.
#pragma once

#include "RenderCache.h"
#include "State.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_dsp/juce_dsp.h>

#include <array>
#include <atomic>
#include <memory>
#include <optional>

namespace padchop::plugin {

constexpr int kMaxTracks = 4;

struct HostInfo {
    bool playing = false;
    std::optional<double> bpm;
    std::optional<double> ppq; // quarter notes since the song start
};

class Engine {
public:
    Engine();

    void prepare(double sampleRate, int maxBlock);
    void process(juce::AudioBuffer<float>& out, const juce::MidiBuffer& midi, const HostInfo& host);

    // ---- Message thread ----
    void publish(std::shared_ptr<const Snapshot> snapshot);
    std::shared_ptr<const Snapshot> snapshot() const { return std::atomic_load(&snapshot_); }
    /** Queue renders for every chop that can currently be played. */
    void prepareRenders();
    void triggerPad(int track, int pad);
    void triggerNote(int track, int semitones);
    void preview(int track, double start);
    void stopAll();
    void setSequencePlaying(bool on);
    RenderCache& renders() { return renders_; }

    // ---- Read by the UI (any thread) ----
    std::atomic<int> currentStep{-1};
    std::atomic<bool> sequencePlaying{false};
    std::atomic<bool> previewing{false};
    std::atomic<int> playheadTrack{-1};
    std::atomic<double> playheadTime{-1};
    std::atomic<double> hostBpm{0};
    std::array<std::atomic<float>, kMaxTracks> meters{};
    std::array<std::atomic<uint32_t>, kMaxTracks> activePads{};

private:
    struct Voice {
        bool active = false;
        int track = 0;
        int pad = -1;     // for UI pad lights; -1 = preview
        int choke = 0;    // voices with the same key cut each other off
        std::shared_ptr<const std::vector<Signal>> audio;
        double pos = 0, end = 0, inc = 1; // in source samples
        double elapsed = 0, dur = 0, level = 1;
        Envelope env;
        bool releasing = false;
        double releaseGain = 1, releaseStep = 0;
        bool isPreview = false;
        // Playhead mapping back to the original sample: start + read seconds × scale.
        double timelineStart = 0, readStart = 0, sourceRate = 44100, scale = 1;
        uint64_t serial = 0;
    };

    struct Command {
        enum class Type { Pad, Note, Preview, StopAll } type;
        int track = 0, value = 0;
        double time = 0;
    };

    struct Bus {
        juce::SmoothedValue<float> gain{1.f};
        juce::SmoothedValue<float> pan{0.f};
        std::array<juce::dsp::IIR::Filter<float>, 2> lowCut, highCut;
        double lowCutHz = 20, highCutHz = 20000;
        juce::AudioBuffer<float> buffer;
    };

    void handleCommand(const Command& c, const Snapshot& s, int offset);
    void handleMidi(const juce::MidiMessage& m, const Snapshot& s, int offset);
    void resolvePad(const Snapshot& s, int track, int pad, std::optional<int> note, double velocity, int offset);
    void startVoice(const Snapshot& s, int track, const Slice& slice, int semitones, double velocity, int choke, int pad, int offset, bool preview);
    void fireStep(const Snapshot& s, int step, int offset);
    void runSequencer(const Snapshot& s, const HostInfo& host, int numSamples);
    void renderVoices(int from, int to);
    double projectBpm(const Snapshot& s, const HostInfo& host) const;

    std::shared_ptr<const Snapshot> snapshot_;
    RenderCache renders_;
    double sampleRate_ = 44100;
    std::array<Voice, 64> voices_;
    std::array<Bus, kMaxTracks> buses_;
    uint64_t nextSerial_ = 1;

    static constexpr int kCommands = 256;
    juce::AbstractFifo commandFifo_{kCommands};
    std::array<Command, kCommands> commands_{};

    // Per-block event list (reserved in prepare(), so no allocation on the audio thread).
    struct Event {
        enum class Kind { Command, Midi, Step };
        int offset = 0;
        Kind kind = Kind::Command;
        int index = 0;
        juce::MidiMessage midi;
    };
    struct StepEvent { int offset; int step; };
    std::vector<Event> events_;
    std::vector<StepEvent> stepEvents_;
    std::vector<Command> pendingCommands_;

    double bpmNow_ = 120;
    uint64_t playheadSerial_ = 0;

    // Sequencer.
    std::atomic<bool> internalPlay_{false};
    double internalSteps_ = 0; // fractional step position of the internal clock
    long lastStep_ = -1;
    bool hostWasPlaying_ = false;
};

} // namespace padchop::plugin
