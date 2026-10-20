#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace padchop::plugin {

namespace {
constexpr double kAnalysisRate = 22050;
} // namespace

Processor::Processor()
    : juce::AudioProcessor(BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
    formats_.registerBasicFormats();
}

Processor::~Processor() {
    *alive_ = false;
    loaders_.removeAllJobs(true, 5000);
}

bool Processor::isBusesLayoutSupported(const BusesLayout& layouts) const {
    const auto out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void Processor::prepareToPlay(double sampleRate, int samplesPerBlock) { engine_.prepare(sampleRate, samplesPerBlock); }

void Processor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) {
    juce::ScopedNoDenormals noDenormals;
    HostInfo host;
    if (auto* ph = getPlayHead()) {
        if (const auto pos = ph->getPosition()) {
            host.playing = pos->getIsPlaying();
            if (const auto bpm = pos->getBpm()) host.bpm = *bpm;
            if (const auto ppq = pos->getPpqPosition()) host.ppq = *ppq;
        }
    }
    engine_.process(buffer, midi, host);
}

juce::AudioProcessorEditor* Processor::createEditor() { return new Editor(*this); }

// ------------------------------------------------------------------ loading

juce::var Processor::trackJson(const LoadedTrack& t) {
    auto* o = new juce::DynamicObject();
    o->setProperty("id", juce::String(t.id));
    o->setProperty("name", juce::String(t.name));
    o->setProperty("analysis", analysisToJson(t.analysis));
    return juce::var(o);
}

void Processor::loadFile(const juce::File& file, std::function<void(juce::var, juce::String)> done, std::string id) {
    if (id.empty()) id = "n" + std::to_string(nextId_++);
    loaders_.addJob([this, file, done, id, alive = alive_] {
        std::unique_ptr<juce::AudioFormatReader> reader(formats_.createReaderFor(file));
        if (!reader || reader->lengthInSamples <= 0) {
            juce::MessageManager::callAsync([done, file, alive] { if (*alive) done({}, "Can't read " + file.getFileName()); });
            return;
        }
        const int channels = static_cast<int>(std::min<unsigned>(2, reader->numChannels));
        const auto length = static_cast<int>(reader->lengthInSamples);
        juce::AudioBuffer<float> buffer(channels, length);
        reader->read(&buffer, 0, length, 0, true, channels > 1);

        auto track = std::make_shared<LoadedTrack>();
        track->id = id;
        track->name = file.getFileNameWithoutExtension().toStdString();
        track->path = file.getFullPathName().toStdString();
        track->sampleRate = reader->sampleRate;
        std::vector<Signal> audio;
        Signal mono(static_cast<size_t>(length), 0.f);
        for (int c = 0; c < channels; ++c) {
            const float* p = buffer.getReadPointer(c);
            audio.emplace_back(p, p + length);
            for (int i = 0; i < length; ++i) mono[static_cast<size_t>(i)] += p[i] / channels;
        }
        track->audio = std::make_shared<const std::vector<Signal>>(std::move(audio));
        track->analysis = analyze(resample(mono, reader->sampleRate, kAnalysisRate), kAnalysisRate,
                                  parseNameHints(file.getFileName().toStdString()));
        // Keep the analysis timebase in seconds of the original file.
        track->analysis.sampleRate = kAnalysisRate;

        juce::MessageManager::callAsync([this, track, done, alive] {
            if (!*alive) return;
            loaded_[track->id] = track;
            rebuildSnapshot();
            done(trackJson(*track), {});
        });
    });
}

void Processor::removeTrack(const std::string& id) {
    loaded_.erase(id);
    engine_.renders().dropTrack(id);
    rebuildSnapshot();
}

// ------------------------------------------------------------------ project state

void Processor::setProject(const juce::var& project) {
    project_ = project;
    rebuildSnapshot();
}

void Processor::rebuildSnapshot() {
    auto snap = std::make_shared<Snapshot>();
    snap->project = projectFromJson(project_);
    const auto& tracks = snap->project.tracks;
    std::shared_ptr<const LoadedTrack> anchor;
    for (const auto& t : tracks) {
        const auto it = loaded_.find(t.id);
        snap->audio.push_back(it == loaded_.end() ? nullptr : it->second);
        if (t.id == snap->project.anchorId && it != loaded_.end()) anchor = it->second;
    }
    if (!anchor) for (const auto& a : snap->audio) if (a) { anchor = a; break; }
    for (size_t i = 0; i < tracks.size(); ++i) {
        const auto& a = snap->audio[i];
        const bool isAnchor = a && anchor && a->id == anchor->id;
        snap->keyShiftOf.push_back(a && anchor && !isAnchor && tracks[i].matchKey ? keyMatchShift(a->analysis.key, anchor->analysis.key) : 0);
    }
    snap->bpm = snap->project.bpmOverride.value_or(anchor ? anchor->analysis.tempo.bpm : 120);
    engine_.publish(snap);
    engine_.prepareRenders();
}

juce::var Processor::restoreData() const {
    auto* o = new juce::DynamicObject();
    juce::Array<juce::var> tracks;
    for (const auto& [id, t] : loaded_) tracks.add(trackJson(*t));
    o->setProperty("tracks", tracks);
    o->setProperty("project", project_);
    return juce::var(o);
}

void Processor::getStateInformation(juce::MemoryBlock& dest) {
    auto* root = new juce::DynamicObject();
    root->setProperty("version", 1);
    root->setProperty("project", project_);
    juce::Array<juce::var> files;
    for (const auto& [id, t] : loaded_) {
        auto* f = new juce::DynamicObject();
        f->setProperty("id", juce::String(id));
        f->setProperty("path", juce::String(t->path));
        files.add(juce::var(f));
    }
    root->setProperty("files", files);
    const auto json = juce::JSON::toString(juce::var(root), true);
    dest.replaceAll(json.toRawUTF8(), json.getNumBytesAsUTF8());
}

void Processor::setStateInformation(const void* data, int size) {
    const auto root = juce::JSON::parse(juce::String::fromUTF8(static_cast<const char*>(data), size));
    if (!root.isObject()) return;
    project_ = root.getProperty("project", juce::var());
    loaded_.clear();
    rebuildSnapshot();
    if (const auto* files = root.getProperty("files", juce::var()).getArray()) {
        auto remaining = std::make_shared<int>(files->size());
        for (const auto& f : *files) {
            const std::string id = f.getProperty("id", "").toString().toStdString();
            // Keep new ids from colliding with restored ones.
            if (id.size() > 1 && id[0] == 'n') nextId_ = std::max(nextId_, std::atoi(id.c_str() + 1) + 1);
            loadFile(juce::File(f.getProperty("path", "").toString()), [this, remaining](juce::var, juce::String) {
                if (--*remaining == 0 && onRestored) onRestored();
            }, id);
        }
    }
}

} // namespace padchop::plugin

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new padchop::plugin::Processor(); }
