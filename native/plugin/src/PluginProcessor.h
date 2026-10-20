#pragma once

#include "Engine.h"
#include "State.h"

#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>
#include <map>

namespace padchop::plugin {

class Processor : public juce::AudioProcessor {
public:
    Processor();
    ~Processor() override;

    // ---- juce::AudioProcessor ----
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout& layouts) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "padchop"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    double getTailLengthSeconds() const override { return 0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock& dest) override;
    void setStateInformation(const void* data, int size) override;

    // ---- Used by the editor (message thread) ----
    Engine& engine() { return engine_; }
    /** Decode and analyse a file in the background; `done` gets the track JSON or an error. */
    void loadFile(const juce::File& file, std::function<void(juce::var track, juce::String error)> done, std::string id = {});
    void removeTrack(const std::string& id);
    /** The UI's project (tracks, pads, pattern, mixer, tempo) as JSON. */
    void setProject(const juce::var& project);
    /** What a freshly opened editor needs: every loaded track and the saved project. */
    juce::var restoreData() const;
    /** Called when a restored session finishes loading its files. */
    std::function<void()> onRestored;

private:
    void rebuildSnapshot();
    static juce::var trackJson(const LoadedTrack& t);

    Engine engine_;
    juce::AudioFormatManager formats_;
    juce::ThreadPool loaders_{2};
    std::map<std::string, std::shared_ptr<const LoadedTrack>> loaded_;
    juce::var project_;
    int nextId_ = 0;
    /** Cleared on destruction so late loader callbacks do nothing. */
    std::shared_ptr<std::atomic<bool>> alive_ = std::make_shared<std::atomic<bool>>(true);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(Processor)
};

} // namespace padchop::plugin
