#include "State.h"

namespace padchop::plugin {

namespace {

double num(const juce::var& v, const char* key, double fallback) {
    const auto x = v.getProperty(key, fallback);
    return x.isVoid() ? fallback : static_cast<double>(x);
}

bool flag(const juce::var& v, const char* key, bool fallback) {
    const auto x = v.getProperty(key, fallback);
    return x.isVoid() ? fallback : static_cast<bool>(x);
}

juce::var array(const std::vector<double>& xs) {
    juce::Array<juce::var> a;
    a.ensureStorageAllocated(static_cast<int>(xs.size()));
    for (double x : xs) a.add(x);
    return a;
}

} // namespace

Envelope envelopeFromJson(const juce::var& v) {
    Envelope e;
    if (!v.isObject()) return e;
    e.attack = num(v, "attack", e.attack);
    e.decay = num(v, "decay", e.decay);
    e.sustain = num(v, "sustain", e.sustain);
    e.release = num(v, "release", e.release);
    return e;
}

ProjectState projectFromJson(const juce::var& json) {
    ProjectState p;
    p.anchorId = json.getProperty("anchorId", "").toString().toStdString();
    const auto bpm = json.getProperty("bpmOverride", juce::var());
    if (!bpm.isVoid() && !bpm.isUndefined()) p.bpmOverride = static_cast<double>(bpm);
    p.keyShift = static_cast<int>(num(json, "keyShift", 0));

    if (const auto* tracks = json.getProperty("tracks", juce::var()).getArray()) {
        for (const auto& t : *tracks) {
            TrackState ts;
            ts.id = t.getProperty("id", "").toString().toStdString();
            ts.selected = static_cast<int>(num(t, "selected", 0));
            ts.keyboard = flag(t, "keyboard", false);
            ts.octave = static_cast<int>(num(t, "octave", 0));
            ts.gain = num(t, "gain", 1);
            ts.pan = num(t, "pan", 0);
            ts.lowCut = num(t, "lowCut", 20);
            ts.highCut = num(t, "highCut", 20000);
            ts.muted = flag(t, "muted", false);
            ts.solo = flag(t, "solo", false);
            ts.matchKey = flag(t, "matchKey", true);
            ts.sync = flag(t, "sync", true);
            if (const auto* slices = t.getProperty("slices", juce::var()).getArray()) {
                for (int i = 0; i < kPadCount && i < slices->size(); ++i) {
                    const auto& s = (*slices)[i];
                    if (!s.isObject()) continue;
                    Slice sl;
                    sl.start = num(s, "start", 0);
                    sl.end = num(s, "end", 0);
                    sl.semitones = static_cast<int>(num(s, "semitones", 0));
                    sl.gain = num(s, "gain", 1);
                    sl.env = envelopeFromJson(s.getProperty("env", juce::var()));
                    ts.slices[i] = sl;
                }
            }
            p.tracks.push_back(std::move(ts));
        }
    }

    const auto pattern = json.getProperty("pattern", juce::var());
    p.bars = std::max(1, static_cast<int>(num(pattern, "bars", 2)));
    p.stepsPerBar = std::max(1, static_cast<int>(num(pattern, "stepsPerBar", 8)));
    if (auto* lanes = pattern.getProperty("lanes", juce::var()).getDynamicObject()) {
        for (const auto& prop : lanes->getProperties()) {
            std::vector<std::optional<StepState>> lane;
            if (const auto* steps = prop.value.getArray()) {
                for (const auto& s : *steps) {
                    if (!s.isObject()) { lane.emplace_back(); continue; }
                    lane.push_back(StepState{static_cast<int>(num(s, "pad", 0)), static_cast<int>(num(s, "semitones", 0)), flag(s, "note", false)});
                }
            }
            p.lanes[prop.name.toString().toStdString()] = std::move(lane);
        }
    }
    return p;
}

juce::var analysisToJson(const AnalysisResult& a) {
    auto* o = new juce::DynamicObject();
    o->setProperty("sampleRate", a.sampleRate);
    o->setProperty("duration", a.duration);

    auto* tempo = new juce::DynamicObject();
    tempo->setProperty("bpm", a.tempo.bpm);
    tempo->setProperty("beats", array(a.tempo.beats));
    tempo->setProperty("downbeatIndex", a.tempo.downbeatIndex);
    tempo->setProperty("confidence", a.tempo.confidence);
    tempo->setProperty("source", a.tempo.source == Source::Name ? "name" : "audio");
    o->setProperty("tempo", juce::var(tempo));

    auto* key = new juce::DynamicObject();
    key->setProperty("tonic", a.key.tonic);
    key->setProperty("mode", a.key.mode == Mode::Major ? "major" : "minor");
    key->setProperty("score", a.key.score);
    key->setProperty("confidence", a.key.confidence);
    key->setProperty("chroma", array(a.key.chroma));
    key->setProperty("source", a.key.source == Source::Name ? "name" : "audio");
    o->setProperty("key", juce::var(key));

    juce::Array<juce::var> onsets;
    for (const auto& on : a.onsets) {
        auto* x = new juce::DynamicObject();
        x->setProperty("time", on.time);
        x->setProperty("strength", on.strength);
        onsets.add(juce::var(x));
    }
    o->setProperty("onsets", onsets);

    juce::Array<juce::var> regions;
    for (const auto& r : a.regions) {
        auto* x = new juce::DynamicObject();
        x->setProperty("start", r.start);
        x->setProperty("end", r.end);
        x->setProperty("score", r.score);
        regions.add(juce::var(x));
    }
    o->setProperty("regions", regions);

    juce::Array<juce::var> peaks;
    peaks.ensureStorageAllocated(static_cast<int>(a.peaks.size()));
    for (float p : a.peaks) peaks.add(std::round(p * 1000) / 1000.0); // 3 decimals keep the JSON small
    o->setProperty("peaks", peaks);
    o->setProperty("peaksPerSecond", a.peaksPerSecond);
    return juce::var(o);
}

} // namespace padchop::plugin
