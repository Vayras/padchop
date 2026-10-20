// Stretched copies of chops, rendered on a background thread and cached until
// the chop, tempo or pitch changes. The audio thread only ever try-locks, so a
// render that isn't ready simply falls back to varispeed for that hit.
#pragma once

#include "State.h"

#include <juce_core/juce_core.h>

#include <atomic>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <tuple>

namespace padchop::plugin {

struct Rendered {
    std::shared_ptr<const std::vector<Signal>> audio;
    double sampleRate = 44100;
    /** Where the chop sits inside `audio`, in seconds. */
    double start = 0, end = 0;
};

class RenderCache : private juce::Thread {
public:
    RenderCache();
    ~RenderCache() override;

    /** Audio-thread safe: the render if it's ready and the cache isn't busy. */
    std::shared_ptr<const Rendered> tryGet(const std::string& trackId, double start, double end, double factor);
    /** Queue a render unless it's cached or queued. Not for the audio thread. */
    void request(const std::shared_ptr<const LoadedTrack>& track, double start, double end, double factor);
    /** Audio-thread safe: queue a render for a hit that wasn't ready (wait-free; may drop). */
    void requestFromAudio(const std::shared_ptr<const LoadedTrack>& track, double start, double end, double factor);
    void dropTrack(const std::string& trackId);
    bool busy() const { return pending_.load() > 0; }

private:
    using Key = std::tuple<std::string, long, long, long>;
    static Key key(const std::string& id, double start, double end, double factor);
    struct Job {
        std::shared_ptr<const LoadedTrack> track;
        double start, end, factor;
    };
    void run() override;
    void enqueue(Job job);

    std::mutex cacheLock_;
    std::map<Key, std::shared_ptr<const Rendered>> cache_;
    std::deque<Key> order_; // LRU-ish eviction order

    std::mutex queueLock_;
    std::deque<Job> queue_;
    std::map<Key, bool> queued_;
    std::atomic<int> pending_{0};

    // Hits from the audio thread that weren't ready, handed over wait-free.
    static constexpr int kAudioRequests = 64;
    juce::AbstractFifo audioFifo_{kAudioRequests};
    std::array<Job, kAudioRequests> audioJobs_;
};

} // namespace padchop::plugin
