#include "RenderCache.h"

#include <cmath>

namespace padchop::plugin {

namespace {
/** Real audio on each side of a chop, so the vocoder's window has context. */
constexpr double kContextSeconds = 0.1;
constexpr size_t kMaxEntries = 400;
} // namespace

RenderCache::RenderCache() : juce::Thread("padchop stretch") { startThread(juce::Thread::Priority::low); }

RenderCache::~RenderCache() { stopThread(2000); }

RenderCache::Key RenderCache::key(const std::string& id, double start, double end, double factor) {
    return {id, std::lround(start * 1e4), std::lround(end * 1e4), std::lround(factor * 1e4)};
}

std::shared_ptr<const Rendered> RenderCache::tryGet(const std::string& trackId, double start, double end, double factor) {
    std::unique_lock<std::mutex> lock(cacheLock_, std::try_to_lock);
    if (!lock.owns_lock()) return nullptr;
    const auto it = cache_.find(key(trackId, start, end, factor));
    return it == cache_.end() ? nullptr : it->second;
}

void RenderCache::request(const std::shared_ptr<const LoadedTrack>& track, double start, double end, double factor) {
    if (!track) return;
    {
        std::lock_guard<std::mutex> lock(cacheLock_);
        if (cache_.count(key(track->id, start, end, factor))) return;
    }
    enqueue({track, start, end, factor});
}

void RenderCache::requestFromAudio(const std::shared_ptr<const LoadedTrack>& track, double start, double end, double factor) {
    const auto scope = audioFifo_.write(1);
    if (scope.blockSize1 > 0) audioJobs_[static_cast<size_t>(scope.startIndex1)] = {track, start, end, factor};
    notify();
}

void RenderCache::enqueue(Job job) {
    const auto k = key(job.track->id, job.start, job.end, job.factor);
    {
        std::lock_guard<std::mutex> lock(queueLock_);
        if (queued_.count(k)) return;
        queued_[k] = true;
        queue_.push_back(std::move(job));
        ++pending_;
    }
    notify();
}

void RenderCache::dropTrack(const std::string& trackId) {
    std::lock_guard<std::mutex> lock(cacheLock_);
    for (auto it = cache_.begin(); it != cache_.end();) {
        if (std::get<0>(it->first) == trackId) it = cache_.erase(it);
        else ++it;
    }
}

void RenderCache::run() {
    while (!threadShouldExit()) {
        // Hits the audio thread couldn't play stretched go to the front of the line.
        {
            const auto take = [this](int index) {
                const auto& j = audioJobs_[static_cast<size_t>(index)];
                request(j.track, j.start, j.end, j.factor);
            };
            const auto scope = audioFifo_.read(audioFifo_.getNumReady());
            for (int i = 0; i < scope.blockSize1; ++i) take(scope.startIndex1 + i);
            for (int i = 0; i < scope.blockSize2; ++i) take(scope.startIndex2 + i);
        }

        Job job;
        {
            std::lock_guard<std::mutex> lock(queueLock_);
            if (queue_.empty()) job.track = nullptr;
            else {
                job = std::move(queue_.front());
                queue_.pop_front();
            }
        }
        if (!job.track) {
            wait(200);
            continue;
        }

        const auto& t = *job.track;
        const double sr = t.sampleRate;
        const auto& src = *t.audio;
        const long len = src.empty() ? 0 : static_cast<long>(src[0].size());
        const long from = std::max(0L, static_cast<long>(std::floor((job.start - kContextSeconds) * sr)));
        const long to = std::min(len, static_cast<long>(std::ceil((job.end + kContextSeconds) * sr)));
        std::vector<Signal> region;
        for (const auto& ch : src) region.emplace_back(ch.begin() + from, ch.begin() + std::max(from, to));
        auto rendered = std::make_shared<Rendered>();
        rendered->audio = std::make_shared<const std::vector<Signal>>(timeStretch(region, sr, job.factor));
        rendered->sampleRate = sr;
        rendered->start = (job.start - from / sr) * job.factor;
        rendered->end = rendered->start + (job.end - job.start) * job.factor;

        const auto k = key(t.id, job.start, job.end, job.factor);
        {
            std::lock_guard<std::mutex> lock(cacheLock_);
            cache_[k] = rendered;
            order_.push_back(k);
            while (cache_.size() > kMaxEntries && !order_.empty()) {
                cache_.erase(order_.front());
                order_.pop_front();
            }
        }
        {
            std::lock_guard<std::mutex> lock(queueLock_);
            queued_.erase(k);
            --pending_;
        }
    }
}

} // namespace padchop::plugin
