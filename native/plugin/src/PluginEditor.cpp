#include "PluginEditor.h"

#include <PadchopUi.h>

namespace padchop::plugin {

namespace {

const char* mimeFor(const juce::String& path) {
    const auto ext = path.fromLastOccurrenceOf(".", false, false).toLowerCase();
    if (ext == "html") return "text/html";
    if (ext == "js") return "text/javascript";
    if (ext == "css") return "text/css";
    if (ext == "svg") return "image/svg+xml";
    if (ext == "json") return "application/json";
    if (ext == "png") return "image/png";
    if (ext == "woff2") return "font/woff2";
    if (ext == "wav") return "audio/wav";
    return "application/octet-stream";
}

int intArg(const juce::Array<juce::var>& args, int i, int fallback = 0) {
    return i < args.size() ? static_cast<int>(args[i]) : fallback;
}

} // namespace

Editor::Editor(Processor& processor)
    : juce::AudioProcessorEditor(processor),
      processor_(processor),
      ui_(std::make_unique<juce::ZipFile>(new juce::MemoryInputStream(padchop_ui::ui_zip, static_cast<size_t>(padchop_ui::ui_zipSize), false), true)),
      web_(options()) {
    addAndMakeVisible(web_);
    web_.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    setResizable(true, true);
    setResizeLimits(390, 600, 2400, 1800);
    setSize(1280, 860);
    processor_.onRestored = [this] {
        web_.emitEventIfBrowserIsVisible("restore", processor_.restoreData());
    };
    startTimerHz(30);
}

Editor::~Editor() {
    processor_.onRestored = nullptr;
    stopTimer();
}

void Editor::resized() { web_.setBounds(getLocalBounds()); }

std::optional<juce::WebBrowserComponent::Resource> Editor::resource(const juce::String& url) {
    auto path = url.upToFirstOccurrenceOf("?", false, false).trimCharactersAtStart("/");
    if (path.isEmpty()) path = "index.html";
    const auto* entry = ui_->getEntry(path);
    if (!entry) return std::nullopt;
    std::unique_ptr<juce::InputStream> in(ui_->createStreamForEntry(*entry));
    if (!in) return std::nullopt;
    juce::MemoryBlock block;
    in->readIntoMemoryBlock(block);
    std::vector<std::byte> bytes(block.getSize());
    std::memcpy(bytes.data(), block.getData(), block.getSize());
    return juce::WebBrowserComponent::Resource{std::move(bytes), mimeFor(path)};
}

juce::WebBrowserComponent::Options Editor::options() {
    using Args = const juce::Array<juce::var>&;
    using Done = juce::WebBrowserComponent::NativeFunctionCompletion;
    return juce::WebBrowserComponent::Options{}
        .withNativeIntegrationEnabled()
        .withKeepPageLoadedWhenBrowserIsHidden()
        .withResourceProvider([this](const juce::String& url) { return resource(url); })
        // Ask the user for an audio file, then decode and analyse it natively.
        .withNativeFunction("openFile", [this](Args, Done done) {
            chooser_ = std::make_unique<juce::FileChooser>("Add sample", juce::File(), "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.m4a;*.ogg");
            chooser_->launchAsync(juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles, [this, done](const juce::FileChooser& fc) {
                const auto file = fc.getResult();
                if (file == juce::File()) { done(juce::var()); return; }
                web_.emitEventIfBrowserIsVisible("loading", file.getFileNameWithoutExtension());
                processor_.loadFile(file, [this, done](juce::var track, juce::String error) {
                    if (error.isNotEmpty()) web_.emitEventIfBrowserIsVisible("loadError", error);
                    done(track);
                });
            });
        })
        .withNativeFunction("setProject", [this](Args args, Done done) {
            if (!args.isEmpty()) processor_.setProject(juce::JSON::parse(args[0].toString()));
            done(true);
        })
        .withNativeFunction("triggerPad", [this](Args args, Done done) {
            processor_.engine().triggerPad(intArg(args, 0), intArg(args, 1));
            done(true);
        })
        .withNativeFunction("triggerNote", [this](Args args, Done done) {
            processor_.engine().triggerNote(intArg(args, 0), intArg(args, 1));
            done(true);
        })
        .withNativeFunction("preview", [this](Args args, Done done) {
            processor_.engine().preview(intArg(args, 0), args.size() > 1 ? static_cast<double>(args[1]) : 0.0);
            done(true);
        })
        .withNativeFunction("stopAll", [this](Args, Done done) {
            processor_.engine().stopAll();
            done(true);
        })
        .withNativeFunction("setSequencePlaying", [this](Args args, Done done) {
            processor_.engine().setSequencePlaying(!args.isEmpty() && static_cast<bool>(args[0]));
            done(true);
        })
        .withNativeFunction("removeTrack", [this](Args args, Done done) {
            if (!args.isEmpty()) processor_.removeTrack(args[0].toString().toStdString());
            done(true);
        })
        .withNativeFunction("uiReady", [this](Args, Done done) { done(processor_.restoreData()); });
}

void Editor::timerCallback() {
    auto& e = processor_.engine();
    auto* o = new juce::DynamicObject();
    o->setProperty("step", e.currentStep.load());
    o->setProperty("seqPlaying", e.sequencePlaying.load());
    o->setProperty("previewing", e.previewing.load());
    o->setProperty("playheadTrack", e.playheadTrack.load());
    o->setProperty("playheadTime", e.playheadTime.load());
    o->setProperty("hostBpm", e.hostBpm.load());
    o->setProperty("stretching", e.renders().busy());
    juce::Array<juce::var> meters, pads;
    for (int i = 0; i < kMaxTracks; ++i) {
        meters.add(e.meters[static_cast<size_t>(i)].exchange(0));
        pads.add(static_cast<int>(e.activePads[static_cast<size_t>(i)].load()));
    }
    o->setProperty("meters", meters);
    o->setProperty("pads", pads);
    web_.emitEventIfBrowserIsVisible("tick", juce::var(o));
}

} // namespace padchop::plugin
