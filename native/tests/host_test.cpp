// Loads the built plugin (VST3 or AU) the way a DAW does and checks that it
// plays: MIDI pad triggers, time-stretch to the host tempo, and the sequencer
// following the host transport.
//   padchop_host_test <plugin path or AU> <sample.wav>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_events/juce_events.h>

#include <cmath>
#include <cstdio>

#if JUCE_MAC
#include <CoreFoundation/CoreFoundation.h>
#endif

namespace {

int failures = 0;

void check(bool ok, const juce::String& what) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", what.toRawUTF8());
    if (!ok) ++failures;
}

/** A host transport: playing or stopped, at a fixed tempo, advancing per block. */
struct Transport : juce::AudioPlayHead {
    bool playing = false;
    double bpm = 120, ppq = 0;
    juce::Optional<PositionInfo> getPosition() const override {
        PositionInfo p;
        p.setIsPlaying(playing);
        p.setBpm(bpm);
        p.setPpqPosition(ppq);
        p.setTimeSignature(TimeSignature{4, 4});
        return p;
    }
};

juce::String session(const juce::String& wav, bool withPattern) {
    // One track, pad 1 = the first 1/3 s (half a beat at 90 BPM).
    const juce::String lanes = withPattern ? R"("n0":[{"pad":0,"semitones":0,"note":false},null,{"pad":0,"semitones":0,"note":false},null])" : "";
    return R"({"version":1,"project":{"tracks":[{"id":"n0","slices":[{"start":0,"end":0.3333,"semitones":0,"gain":1,)"
           R"("env":{"attack":0.002,"decay":0,"sustain":1,"release":0.01}}],"selected":0,"keyboard":false,"octave":0,)"
           R"("gain":1,"pan":0,"lowCut":20,"highCut":20000,"muted":false,"solo":false,"matchKey":true,"sync":true}],)"
           R"("anchorId":"n0","bpmOverride":null,"keyShift":0,"pattern":{"bars":1,"stepsPerBar":4,"lanes":{)" + lanes + R"(}}},)"
           R"("files":[{"id":"n0","path":")" + wav.replace("\\", "\\\\") + R"("}]})";
}

/** Render `seconds` of audio; returns the per-sample peak envelope (stereo max). */
std::vector<float> render(juce::AudioPluginInstance& p, Transport& t, double seconds, int noteAt = -1) {
    const int block = 512;
    const double sr = 44100;
    juce::AudioBuffer<float> buf(2, block);
    std::vector<float> env;
    const int blocks = static_cast<int>(seconds * sr / block);
    for (int b = 0; b < blocks; ++b) {
        juce::MidiBuffer midi;
        if (b == noteAt) midi.addEvent(juce::MidiMessage::noteOn(1, 36, 1.0f), 0);
        buf.clear();
        p.processBlock(buf, midi);
        for (int i = 0; i < block; ++i) env.push_back(std::max(std::abs(buf.getSample(0, i)), std::abs(buf.getSample(1, i))));
        if (t.playing) t.ppq += block / sr * t.bpm / 60;
    }
    return env;
}

/** Seconds between the first and last sample above a threshold. */
double soundingSeconds(const std::vector<float>& env, float threshold = 1e-3f) {
    long first = -1, last = -1;
    for (long i = 0; i < static_cast<long>(env.size()); ++i)
        if (env[static_cast<size_t>(i)] > threshold) { if (first < 0) first = i; last = i; }
    return first < 0 ? 0 : (last - first) / 44100.0;
}

std::unique_ptr<juce::AudioPluginInstance> load(juce::AudioPluginFormatManager& fm, const juce::String& id, juce::String& error) {
    juce::OwnedArray<juce::PluginDescription> found;
    for (auto* format : fm.getFormats()) {
        // AUs are addressed by component id, so search the registered ones for padchop.
        if (id.endsWith(".component") && format->getName() == "AudioUnit") {
            const auto ids = format->searchPathsForPlugins({}, true, false);
            for (const auto& auId : ids)
                if (auId.contains("Pdch") || auId.containsIgnoreCase("padchop")) format->findAllTypesForFile(found, auId);
            if (found.isEmpty()) {
                std::printf("  (%d AUs registered; none is padchop", ids.size());
                for (const auto& auId : ids) if (auId.containsIgnoreCase("aumu")) std::printf("; e.g. %s", auId.toRawUTF8());
                std::printf(")\n");
            }
        } else if (format->fileMightContainThisPluginType(id)) {
            format->findAllTypesForFile(found, id);
        }
        if (!found.isEmpty()) break;
    }
    if (found.isEmpty()) { error = "no plugin found at " + id; return nullptr; }
    return fm.createPluginInstance(*found[0], 44100, 512, error);
}

void pump(int ms) { juce::MessageManager::getInstance()->runDispatchLoopUntil(ms); }

/**
 * Hand the plugin a session the way a DAW restores one: hosts wrap the plugin's
 * own state (VST3: base64 inside a VST3PluginState XML; AU: "jucePluginState"
 * inside the ClassInfo plist), so swap our JSON into the plugin's current state.
 */
bool restoreSession(juce::AudioPluginInstance& p, const juce::String& json) {
    juce::MemoryBlock current;
    p.getStateInformation(current);
    const juce::MemoryBlock ours(json.toRawUTF8(), json.getNumBytesAsUTF8());
    if (p.getPluginDescription().pluginFormatName == "VST3") {
        auto xml = juce::AudioProcessor::getXmlFromBinary(current.getData(), static_cast<int>(current.getSize()));
        if (!xml) return false;
        if (auto* c = xml->getChildByName("IComponent")) c->deleteAllTextElements(), c->addTextElement(ours.toBase64Encoding());
        juce::MemoryBlock next;
        juce::AudioProcessor::copyXmlToBinary(*xml, next);
        p.setStateInformation(next.getData(), static_cast<int>(next.getSize()));
        return true;
    }
   #if JUCE_MAC
    auto* data = CFDataCreate(nullptr, static_cast<const UInt8*>(current.getData()), static_cast<CFIndex>(current.getSize()));
    auto* plist = CFPropertyListCreateWithData(nullptr, data, kCFPropertyListMutableContainersAndLeaves, nullptr, nullptr);
    CFRelease(data);
    if (!plist || CFGetTypeID(plist) != CFDictionaryGetTypeID()) return false;
    auto* jsonData = CFDataCreate(nullptr, static_cast<const UInt8*>(ours.getData()), static_cast<CFIndex>(ours.getSize()));
    CFDictionarySetValue(static_cast<CFMutableDictionaryRef>(const_cast<void*>(plist)), CFSTR("jucePluginState"), jsonData);
    CFRelease(jsonData);
    auto* out = CFPropertyListCreateData(nullptr, plist, kCFPropertyListXMLFormat_v1_0, 0, nullptr);
    CFRelease(plist);
    if (!out) return false;
    p.setStateInformation(CFDataGetBytePtr(out), static_cast<int>(CFDataGetLength(out)));
    CFRelease(out);
    return true;
   #else
    return false;
   #endif
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: padchop_host_test <plugin> <sample.wav>\n"); return 2; }
    juce::ScopedJuceInitialiser_GUI init;
    juce::AudioPluginFormatManager fm;
    juce::addDefaultFormatsToManager(fm);
    const juce::String id = argv[1], wav = juce::File(argv[2]).getFullPathName();

    for (const bool withPattern : {false, true}) {
        juce::String error;
        auto plugin = load(fm, id, error);
        if (!plugin) { check(false, "load plugin: " + error); return 1; }
        Transport transport;
        plugin->setPlayHead(&transport);
        plugin->enableAllBuses();
        plugin->prepareToPlay(44100, 512);
        check(restoreSession(*plugin, session(wav, withPattern)), "session restored through the host's state format");
        pump(4000); // decode + analyse + queue renders

        if (!withPattern) {
            check(plugin->getName() == "padchop", "loads as padchop (" + plugin->getPluginDescription().pluginFormatName + ")");
            // Host at 120 BPM, sample at 90 BPM: the half-beat chop should last 0.25 s.
            transport.bpm = 120;
            render(*plugin, transport, 0.2); // settle, lets the engine see the host tempo
            pump(3000);                      // stretch renders finish
            const auto env = render(*plugin, transport, 1.0, 0);
            float peak = 0;
            for (float v : env) peak = std::max(peak, v);
            check(peak > 0.01f, "MIDI note 36 plays pad 1 (peak " + juce::String(peak, 3) + ")");
            const double len = soundingSeconds(env);
            check(std::abs(len - 0.25) < 0.03, "chop stretched to the 120 BPM host: " + juce::String(len, 3) + " s (expect 0.250)");
            transport.bpm = 90;
            const auto plain = render(*plugin, transport, 1.0, 0);
            const double plainLen = soundingSeconds(plain);
            check(std::abs(plainLen - 0.333) < 0.03, "at the sample's own 90 BPM it plays unstretched: " + juce::String(plainLen, 3) + " s");
        } else {
            // Host transport running: steps 1 and 3 of a 4-step bar fire chops.
            transport.playing = true;
            transport.bpm = 120;
            transport.ppq = 0;
            const auto env = render(*plugin, transport, 2.0);
            // Count chops: sounding stretches separated by at least 0.3 s of silence.
            int chops = 0;
            long lastLoud = -100000;
            for (long i = 0; i < static_cast<long>(env.size()); ++i) {
                if (env[static_cast<size_t>(i)] < 0.002f) continue;
                if (i - lastLoud > static_cast<long>(0.3 * 44100)) ++chops;
                lastLoud = i;
            }
            // One 4-step bar at 120 BPM lasts 2 s; steps 1 and 3 fire at 0 s and 1 s.
            check(chops == 2, "sequencer follows the host transport (" + juce::String(chops) + " chops in 2 s, expect 2)");
        }
        plugin->releaseResources();
    }
    std::printf("\n%s\n", failures ? "SOME CHECKS FAILED" : "ALL CHECKS PASSED");
    return failures ? 1 : 0;
}
