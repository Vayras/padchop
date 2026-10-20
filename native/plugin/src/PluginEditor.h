#pragma once

#include "PluginProcessor.h"

#include <juce_gui_extra/juce_gui_extra.h>

namespace padchop::plugin {

/** Hosts the padchop web UI in a WebView and bridges it to the engine. */
class Editor : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit Editor(Processor& processor);
    ~Editor() override;
    void resized() override;

private:
    void timerCallback() override;
    std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url);
    juce::WebBrowserComponent::Options options();

    Processor& processor_;
    std::unique_ptr<juce::ZipFile> ui_;
    std::unique_ptr<juce::FileChooser> chooser_;
    juce::WebBrowserComponent web_;
};

} // namespace padchop::plugin
