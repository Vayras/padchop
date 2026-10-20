#pragma once

#include "PluginProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace padchop::plugin {

/** Hosts the padchop web UI in a WebView and bridges it to the engine. */
class Editor : public juce::AudioProcessorEditor, public juce::FileDragAndDropTarget, private juce::Timer {
public:
    explicit Editor(Processor& processor);
    ~Editor() override;
    void resized() override;

    // Audio files dragged in from Finder or the DAW load as new tracks.
    bool isInterestedInFileDrag(const juce::StringArray& files) override;
    void fileDragEnter(const juce::StringArray&, int, int) override;
    void fileDragExit(const juce::StringArray&) override;
    void filesDropped(const juce::StringArray& files, int, int) override;

private:
    void timerCallback() override;
    /** Load a file as a new track and hand the result to `done` (null when it failed). */
    void loadTrack(const juce::File& file, std::function<void(juce::var)> done);
    std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url);
    juce::WebBrowserComponent::Options options();

    Processor& processor_;
    std::unique_ptr<juce::ZipFile> ui_;
    std::unique_ptr<juce::FileChooser> chooser_;
    juce::WebBrowserComponent web_;
    /** Files still decoding, so drops don't overfill the track slots. */
    int loading_ = 0;
};

/** The WebView takes every drag itself; stop it so file drops reach the editor (macOS). */
void routeWebViewDropsToEditor(juce::Component& web);

} // namespace padchop::plugin
