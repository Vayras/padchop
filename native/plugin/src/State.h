// Project state shared between the web UI (JSON) and the audio engine.
#pragma once

#include <juce_core/juce_core.h>
#include <padchop/dsp.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace padchop::plugin {

/** A loaded sample: decoded audio plus its analysis. Immutable once published. */
struct LoadedTrack {
    std::string id;
    std::string name;
    std::string path;
    double sampleRate = 44100;
    std::shared_ptr<const std::vector<Signal>> audio; // one vector per channel
    AnalysisResult analysis;
};

/** Per-track settings edited in the UI. */
struct TrackState {
    std::string id;
    PadSlots slices = PadSlots(kPadCount);
    int selected = 0;
    bool keyboard = false;
    int octave = 0;
    double gain = 1, pan = 0, lowCut = 20, highCut = 20000;
    bool muted = false, solo = false, matchKey = true, sync = true;
};

struct StepState {
    int pad = 0;
    int semitones = 0;
    bool note = false;
};

struct ProjectState {
    std::vector<TrackState> tracks;
    std::string anchorId;
    std::optional<double> bpmOverride;
    int keyShift = 0;
    int bars = 2;
    int stepsPerBar = 8;
    std::map<std::string, std::vector<std::optional<StepState>>> lanes;
};

/** Everything the audio thread needs, published as one immutable snapshot. */
struct Snapshot {
    ProjectState project;
    /** Loaded audio, aligned with project.tracks (null if a track isn't loaded yet). */
    std::vector<std::shared_ptr<const LoadedTrack>> audio;
    /** Semitones each track is moved into the anchor's key. */
    std::vector<int> keyShiftOf;
    /** Project tempo before any host override. */
    double bpm = 120;
};

ProjectState projectFromJson(const juce::var& json);
juce::var analysisToJson(const AnalysisResult& a);
Envelope envelopeFromJson(const juce::var& v);

} // namespace padchop::plugin
