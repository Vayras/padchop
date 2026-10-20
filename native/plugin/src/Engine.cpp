#include "Engine.h"

#include <algorithm>
#include <cmath>

namespace padchop::plugin {

namespace {

/** Below this the stretch is inaudible, so plain varispeed is used. */
constexpr double kNoStretch = 0.003;
constexpr double kMinFade = 0.002;
constexpr double kMaxChokeFade = 0.25;
constexpr int kPadsChoke = 0;    // all pads of a track cut each other
constexpr int kKeyboardChoke = 500;
constexpr int kNoteStepChoke = 700;

struct Plan {
    double speed, pitch, factor;
};

Plan playbackPlan(const TrackState& t, const LoadedTrack& audio, double projectBpm, int semitones) {
    const double trackBpm = audio.analysis.tempo.bpm;
    const double speed = t.sync && trackBpm > 0 ? projectBpm / trackBpm : 1;
    const double pitch = std::pow(2.0, semitones / 12.0);
    return {speed, pitch, pitch / speed};
}

/** Catmull-Rom interpolation of `x` at fractional index `pos`. */
inline float cubic(const Signal& x, double pos) {
    const long n = static_cast<long>(x.size());
    const long i = static_cast<long>(pos);
    const float f = static_cast<float>(pos - i);
    auto at = [&](long k) { return x[static_cast<size_t>(std::clamp(k, 0L, n - 1))]; };
    const float y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2);
    const float c1 = 0.5f * (y2 - y0);
    const float c2 = y0 - 2.5f * y1 + 2.f * y2 - 0.5f * y3;
    const float c3 = 0.5f * (y3 - y0) + 1.5f * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
}

/** RBJ-cookbook biquad, computed without allocating (safe on the audio thread). */
void setBiquad(juce::dsp::IIR::Filter<float>& filter, bool highPass, double hz, double sampleRate) {
    const double w0 = 2 * M_PI * std::clamp(hz, 10.0, sampleRate * 0.49) / sampleRate;
    const double cosw = std::cos(w0), alpha = std::sin(w0) / (2 * M_SQRT1_2);
    const double b0 = highPass ? (1 + cosw) / 2 : (1 - cosw) / 2;
    const double b1 = highPass ? -(1 + cosw) : 1 - cosw;
    const double a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
    auto* c = filter.coefficients->getRawCoefficients();
    c[0] = static_cast<float>(b0 / a0);
    c[1] = static_cast<float>(b1 / a0);
    c[2] = static_cast<float>(b0 / a0);
    c[3] = static_cast<float>(a1 / a0);
    c[4] = static_cast<float>(a2 / a0);
}

} // namespace

Engine::Engine() {
    for (auto& m : meters) m.store(0);
    for (auto& p : activePads) p.store(0);
}

void Engine::prepare(double sampleRate, int maxBlock) {
    sampleRate_ = sampleRate;
    events_.reserve(2048);
    stepEvents_.reserve(512);
    pendingCommands_.reserve(kCommands);
    for (auto& bus : buses_) {
        bus.buffer.setSize(2, maxBlock);
        bus.gain.reset(sampleRate, 0.015);
        bus.pan.reset(sampleRate, 0.015);
        for (auto* f : {&bus.lowCut[0], &bus.lowCut[1], &bus.highCut[0], &bus.highCut[1]}) {
            f->coefficients = new juce::dsp::IIR::Coefficients<float>(1, 0, 0, 1, 0, 0);
            f->reset();
        }
        for (auto& f : bus.lowCut) setBiquad(f, true, bus.lowCutHz, sampleRate);
        for (auto& f : bus.highCut) setBiquad(f, false, bus.highCutHz, sampleRate);
    }
}

void Engine::publish(std::shared_ptr<const Snapshot> snapshot) { std::atomic_store(&snapshot_, std::move(snapshot)); }

double Engine::projectBpm(const Snapshot& s, const HostInfo& host) const { return host.bpm.value_or(s.bpm); }

// ------------------------------------------------------------------ message thread

void Engine::prepareRenders() {
    const auto s = snapshot();
    if (!s) return;
    const double bpm = hostBpm.load() > 0 ? hostBpm.load() : s->bpm;
    auto want = [&](size_t ti, const Slice& sl, int semitones) {
        const auto& audio = s->audio[ti];
        if (!audio) return;
        const auto plan = playbackPlan(s->project.tracks[ti], *audio, bpm, semitones);
        if (std::abs(plan.factor - 1) >= kNoStretch) renders_.request(audio, sl.start, sl.end, plan.factor);
    };
    for (size_t ti = 0; ti < s->project.tracks.size(); ++ti) {
        const auto& t = s->project.tracks[ti];
        const int shift = s->keyShiftOf[ti] + s->project.keyShift;
        if (t.keyboard && t.selected >= 0 && t.selected < kPadCount && t.slices[t.selected])
            for (int pad = 0; pad < kPadCount; ++pad) want(ti, *t.slices[t.selected], t.slices[t.selected]->semitones + keyboardSemitone(pad, t.octave) + shift);
        for (const auto& sl : t.slices) if (sl) want(ti, *sl, sl->semitones + shift);
        const auto lane = s->project.lanes.find(t.id);
        if (lane != s->project.lanes.end())
            for (const auto& step : lane->second)
                if (step && step->note && step->pad < kPadCount && t.slices[step->pad])
                    want(ti, *t.slices[step->pad], t.slices[step->pad]->semitones + step->semitones + shift);
    }
}

void Engine::triggerPad(int track, int pad) {
    const auto scope = commandFifo_.write(1);
    if (scope.blockSize1 > 0) commands_[static_cast<size_t>(scope.startIndex1)] = {Command::Type::Pad, track, pad, 0};
}

void Engine::triggerNote(int track, int semitones) {
    const auto scope = commandFifo_.write(1);
    if (scope.blockSize1 > 0) commands_[static_cast<size_t>(scope.startIndex1)] = {Command::Type::Note, track, semitones, 0};
}

void Engine::preview(int track, double start) {
    const auto scope = commandFifo_.write(1);
    if (scope.blockSize1 > 0) commands_[static_cast<size_t>(scope.startIndex1)] = {Command::Type::Preview, track, 0, start};
}

void Engine::stopAll() {
    const auto scope = commandFifo_.write(1);
    if (scope.blockSize1 > 0) commands_[static_cast<size_t>(scope.startIndex1)] = {Command::Type::StopAll, 0, 0, 0};
}

void Engine::setSequencePlaying(bool on) { internalPlay_.store(on); }

// ------------------------------------------------------------------ audio thread

void Engine::startVoice(const Snapshot& s, int track, const Slice& slice, int semitones, double velocity, int choke, int pad, int /*offset*/, bool preview) {
    const auto& audio = s.audio[static_cast<size_t>(track)];
    if (!audio || !audio->audio || audio->audio->empty()) return;
    const auto& ts = s.project.tracks[static_cast<size_t>(track)];
    const double srcRate = audio->sampleRate;
    const auto plan = playbackPlan(ts, *audio, bpmNow_, semitones);

    std::shared_ptr<const std::vector<Signal>> buf = audio->audio;
    double startSec = slice.start, endSec = slice.end, rate = plan.pitch, scale = 1;
    if (preview) {
        rate = plan.pitch; // the whole sample, pitch only
    } else if (std::abs(plan.factor - 1) >= kNoStretch) {
        if (auto r = renders_.tryGet(audio->id, slice.start, slice.end, plan.factor)) {
            buf = r->audio;
            startSec = r->start;
            endSec = r->end;
            scale = 1 / plan.factor;
        } else {
            // Not rendered yet: tempo-correct varispeed this time, ask for the render.
            renders_.requestFromAudio(audio, slice.start, slice.end, plan.factor);
            rate = plan.speed;
        }
    }

    // Choke: earlier voices in the same group fade out over their release.
    for (auto& v : voices_) {
        if (!v.active || v.releasing || v.track != track || v.choke != choke) continue;
        const double fade = std::clamp(v.env.release, kMinFade, kMaxChokeFade);
        v.releasing = true;
        v.releaseGain = 1;
        v.releaseStep = 1 / (fade * sampleRate_);
    }

    Voice* slot = nullptr;
    for (auto& v : voices_) if (!v.active) { slot = &v; break; }
    if (!slot) {
        slot = &voices_[0];
        for (auto& v : voices_) if (v.serial < slot->serial) slot = &v;
    }
    Voice& v = *slot;
    v = Voice{};
    v.active = true;
    v.track = track;
    v.pad = pad;
    v.choke = choke;
    v.audio = std::move(buf);
    v.sourceRate = srcRate;
    v.pos = startSec * srcRate;
    v.end = endSec * srcRate;
    v.inc = rate * srcRate / sampleRate_;
    v.dur = (endSec - startSec) / rate;
    v.level = slice.gain * velocity;
    v.env = preview ? Envelope{} : slice.env;
    v.isPreview = preview;
    v.timelineStart = slice.start;
    v.readStart = startSec;
    v.scale = scale;
    v.serial = nextSerial_++;
    playheadSerial_ = v.serial;
    playheadTrack.store(track);
}

void Engine::resolvePad(const Snapshot& s, int track, int pad, std::optional<int> note, double velocity, int offset) {
    if (track < 0 || track >= static_cast<int>(s.project.tracks.size())) return;
    const auto& t = s.project.tracks[static_cast<size_t>(track)];
    const int shift = s.keyShiftOf[static_cast<size_t>(track)] + s.project.keyShift;
    if (note || t.keyboard) {
        if (t.selected < 0 || t.selected >= kPadCount || !t.slices[t.selected]) return;
        const auto& sl = *t.slices[t.selected];
        const int kb = note ? *note : keyboardSemitone(pad, t.octave);
        startVoice(s, track, sl, sl.semitones + kb + shift, velocity, track * 1000 + kKeyboardChoke + (kb + 100), note ? -1 : pad, offset, false);
        return;
    }
    if (pad < 0 || pad >= kPadCount || !t.slices[pad]) return;
    const auto& sl = *t.slices[pad];
    startVoice(s, track, sl, sl.semitones + shift, velocity, track * 1000 + kPadsChoke, pad, offset, false);
}

void Engine::handleCommand(const Command& c, const Snapshot& s, int offset) {
    switch (c.type) {
    case Command::Type::Pad: resolvePad(s, c.track, c.value, std::nullopt, 1, offset); break;
    case Command::Type::Note: resolvePad(s, c.track, -1, c.value, 1, offset); break;
    case Command::Type::Preview: {
        if (c.track < 0 || c.track >= static_cast<int>(s.audio.size()) || !s.audio[static_cast<size_t>(c.track)]) break;
        Slice whole;
        whole.start = c.time;
        whole.end = s.audio[static_cast<size_t>(c.track)]->analysis.duration;
        const int shift = s.keyShiftOf[static_cast<size_t>(c.track)] + s.project.keyShift;
        startVoice(s, c.track, whole, shift, 1, c.track * 1000 + kPadsChoke, -1, offset, true);
        break;
    }
    case Command::Type::StopAll:
        for (auto& v : voices_) {
            if (!v.active || v.releasing) continue;
            v.releasing = true;
            v.releaseGain = 1;
            v.releaseStep = 1 / (0.005 * sampleRate_);
        }
        break;
    }
}

void Engine::handleMidi(const juce::MidiMessage& m, const Snapshot& s, int offset) {
    if (m.isAllNotesOff() || m.isAllSoundOff()) {
        handleCommand({Command::Type::StopAll, 0, 0, 0}, s, offset);
        return;
    }
    if (!m.isNoteOn() || s.project.tracks.empty()) return;
    // MIDI channel 1-4 plays track A-D; notes 36-51 are the pads (C1 = pad 1),
    // and a track in keyboard mode plays its selected chop chromatically around C3.
    const int track = std::min(m.getChannel() - 1, static_cast<int>(s.project.tracks.size()) - 1);
    const int note = m.getNoteNumber();
    const double velocity = m.getFloatVelocity();
    if (s.project.tracks[static_cast<size_t>(track)].keyboard) resolvePad(s, track, -1, note - 60, velocity, offset);
    else if (note >= 36 && note < 36 + kPadCount) resolvePad(s, track, note - 36, std::nullopt, velocity, offset);
}

void Engine::fireStep(const Snapshot& s, int step, int offset) {
    for (size_t ti = 0; ti < s.project.tracks.size(); ++ti) {
        const auto& t = s.project.tracks[ti];
        const auto lane = s.project.lanes.find(t.id);
        if (lane == s.project.lanes.end() || step >= static_cast<int>(lane->second.size())) continue;
        const auto& st = lane->second[static_cast<size_t>(step)];
        if (!st || st->pad < 0 || st->pad >= kPadCount || !t.slices[st->pad]) continue;
        const auto& sl = *t.slices[st->pad];
        const int shift = s.keyShiftOf[ti] + s.project.keyShift;
        // Chops choke each other per track; keyboard notes ring per pitch.
        const int choke = static_cast<int>(ti) * 1000 + (st->note ? kNoteStepChoke + st->semitones : kPadsChoke);
        startVoice(s, static_cast<int>(ti), sl, sl.semitones + st->semitones + shift, 1, choke, st->note ? -1 : st->pad, offset, false);
    }
}

void Engine::renderVoices(int from, int to) {
    if (to <= from) return;
    const double dt = 1 / sampleRate_;
    for (auto& v : voices_) {
        if (!v.active) continue;
        auto& bus = buses_[static_cast<size_t>(std::clamp(v.track, 0, kMaxTracks - 1))].buffer;
        const auto& a = *v.audio;
        const bool stereo = a.size() > 1;
        const double len = static_cast<double>(a[0].size());
        auto* outL = bus.getWritePointer(0);
        auto* outR = bus.getWritePointer(1);
        for (int i = from; i < to; ++i) {
            if (v.pos >= v.end || v.pos >= len - 1 || (v.releasing && v.releaseGain <= 0)) {
                v.active = false;
                v.audio.reset();
                break;
            }
            float g = static_cast<float>(envelopeGain(v.elapsed, v.dur, v.level, v.env));
            if (v.releasing) {
                g *= static_cast<float>(v.releaseGain);
                v.releaseGain -= v.releaseStep;
            }
            const float l = cubic(a[0], v.pos);
            const float r = stereo ? cubic(a[1], v.pos) : l;
            outL[i] += l * g;
            outR[i] += r * g;
            v.pos += v.inc;
            v.elapsed += dt;
        }
    }
}

void Engine::runSequencer(const Snapshot& s, const HostInfo& host, int numSamples) {
    const int total = s.project.bars * s.project.stepsPerBar;
    const double stepsPerBeat = s.project.stepsPerBar / 4.0;
    stepEvents_.clear();

    if (host.playing && host.ppq) {
        // Follow the host: steps sit on the host's beat grid.
        const double ppqPerSample = bpmNow_ / 60.0 / sampleRate_;
        const double p0 = *host.ppq * stepsPerBeat;
        const double p1 = (*host.ppq + numSamples * ppqPerSample) * stepsPerBeat;
        for (long k = static_cast<long>(std::ceil(p0 - 1e-9)); k < p1; ++k) {
            const int offset = static_cast<int>((k - p0) / stepsPerBeat / ppqPerSample);
            stepEvents_.push_back({std::clamp(offset, 0, numSamples - 1), static_cast<int>(((k % total) + total) % total)});
        }
        currentStep.store(static_cast<int>((static_cast<long>(std::floor(p1 - 1e-9)) % total + total) % total));
        sequencePlaying.store(true);
        hostWasPlaying_ = true;
        return;
    }
    if (hostWasPlaying_) {
        hostWasPlaying_ = false;
        internalPlay_.store(false);
    }
    if (!internalPlay_.load()) {
        internalSteps_ = 0;
        currentStep.store(-1);
        sequencePlaying.store(false);
        return;
    }
    const double stepSamples = 60.0 / bpmNow_ / stepsPerBeat * sampleRate_;
    const double p0 = internalSteps_;
    const double p1 = p0 + numSamples / stepSamples;
    for (long k = static_cast<long>(std::ceil(p0 - 1e-9)); k < p1; ++k) {
        const int offset = static_cast<int>((k - p0) * stepSamples);
        stepEvents_.push_back({std::clamp(offset, 0, numSamples - 1), static_cast<int>(k % total)});
    }
    internalSteps_ = std::fmod(p1, static_cast<double>(total));
    currentStep.store(static_cast<int>(std::floor(p1 - 1e-9)) % total);
    sequencePlaying.store(true);
}

void Engine::process(juce::AudioBuffer<float>& out, const juce::MidiBuffer& midi, const HostInfo& host) {
    const int n = out.getNumSamples();
    out.clear();
    hostBpm.store(host.bpm.value_or(0));
    const auto snap = std::atomic_load(&snapshot_);
    if (!snap) return;
    const Snapshot& s = *snap;
    bpmNow_ = projectBpm(s, host);
    for (auto& bus : buses_) bus.buffer.clear(0, n);

    // Events in time order: UI commands (block start), MIDI, sequencer steps.
    events_.clear();
    {
        const auto scope = commandFifo_.read(commandFifo_.getNumReady());
        for (int i = 0; i < scope.blockSize1; ++i) events_.push_back({0, Event::Kind::Command, scope.startIndex1 + i});
        for (int i = 0; i < scope.blockSize2; ++i) events_.push_back({0, Event::Kind::Command, scope.startIndex2 + i});
    }
    // Commands are copied out before the FIFO slots can be reused.
    pendingCommands_.clear();
    for (auto& e : events_) {
        pendingCommands_.push_back(commands_[static_cast<size_t>(e.index)]);
        e.index = static_cast<int>(pendingCommands_.size()) - 1;
    }
    for (const auto meta : midi) events_.push_back({std::clamp(meta.samplePosition, 0, n - 1), Event::Kind::Midi, 0, meta.getMessage()});
    runSequencer(s, host, n);
    for (const auto& st : stepEvents_) events_.push_back({st.offset, Event::Kind::Step, st.step});
    std::stable_sort(events_.begin(), events_.end(), [](const Event& a, const Event& b) { return a.offset < b.offset; });

    int pos = 0;
    for (const auto& e : events_) {
        renderVoices(pos, e.offset);
        pos = e.offset;
        switch (e.kind) {
        case Event::Kind::Command: handleCommand(pendingCommands_[static_cast<size_t>(e.index)], s, e.offset); break;
        case Event::Kind::Midi: handleMidi(e.midi, s, e.offset); break;
        case Event::Kind::Step: fireStep(s, e.index, e.offset); break;
        }
    }
    renderVoices(pos, n);

    // Mixer: level, pan, high-pass, low-pass per track; meters; sum to the output.
    bool anySolo = false;
    for (const auto& t : s.project.tracks) anySolo = anySolo || t.solo;
    const int outChannels = out.getNumChannels();
    for (size_t ti = 0; ti < buses_.size(); ++ti) {
        auto& bus = buses_[ti];
        if (ti >= s.project.tracks.size()) {
            meters[ti].store(0);
            continue;
        }
        const auto& t = s.project.tracks[ti];
        const bool silent = t.muted || (anySolo && !t.solo);
        bus.gain.setTargetValue(silent ? 0.f : static_cast<float>(t.gain));
        bus.pan.setTargetValue(static_cast<float>(t.pan));
        if (std::abs(bus.lowCutHz - t.lowCut) > 0.01) {
            bus.lowCutHz = t.lowCut;
            for (auto& f : bus.lowCut) setBiquad(f, true, t.lowCut, sampleRate_);
        }
        if (std::abs(bus.highCutHz - t.highCut) > 0.01) {
            bus.highCutHz = t.highCut;
            for (auto& f : bus.highCut) setBiquad(f, false, t.highCut, sampleRate_);
        }
        auto* L = bus.buffer.getWritePointer(0);
        auto* R = bus.buffer.getWritePointer(1);
        const bool filterLow = bus.lowCutHz > 21, filterHigh = bus.highCutHz < 19999;
        float peak = 0;
        for (int i = 0; i < n; ++i) {
            const float g = bus.gain.getNextValue();
            const float p = bus.pan.getNextValue();
            float l = L[i] * g, r = R[i] * g;
            // Stereo panning as in the web version (Web Audio StereoPannerNode).
            const float x = (p <= 0 ? p + 1 : p) * static_cast<float>(M_PI_2);
            if (p <= 0) { l = l + r * std::cos(x); r = r * std::sin(x); }
            else { r = r + l * std::sin(x); l = l * std::cos(x); }
            if (filterLow) { l = bus.lowCut[0].processSample(l); r = bus.lowCut[1].processSample(r); }
            if (filterHigh) { l = bus.highCut[0].processSample(l); r = bus.highCut[1].processSample(r); }
            peak = std::max({peak, std::abs(l), std::abs(r)});
            if (outChannels > 1) {
                out.addSample(0, i, l);
                out.addSample(1, i, r);
            } else if (outChannels == 1) {
                out.addSample(0, i, 0.5f * (l + r));
            }
        }
        // The UI reads and resets the meter, so keep the loudest block since then.
        float prev = meters[ti].load();
        while (peak > prev && !meters[ti].compare_exchange_weak(prev, peak)) {}
    }

    // UI readback: pad lights, preview state, playhead.
    std::array<uint32_t, kMaxTracks> pads{};
    bool anyPreview = false;
    double playhead = -1;
    for (const auto& v : voices_) {
        if (!v.active) continue;
        if (v.pad >= 0 && v.track < kMaxTracks && !v.releasing) pads[static_cast<size_t>(v.track)] |= 1u << v.pad;
        anyPreview = anyPreview || (v.isPreview && !v.releasing);
        if (v.serial == playheadSerial_) playhead = v.timelineStart + (v.pos / v.sourceRate - v.readStart) * v.scale;
    }
    for (int i = 0; i < kMaxTracks; ++i) activePads[static_cast<size_t>(i)].store(pads[static_cast<size_t>(i)]);
    previewing.store(anyPreview);
    playheadTime.store(playhead);
}

} // namespace padchop::plugin
