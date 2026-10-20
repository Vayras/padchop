// padchop_analyze <file.wav>: prints the native analysis as one JSON line.
// Used to check the C++ port against the TypeScript analysis on real files.
#include "padchop/dsp.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

using namespace padchop;

namespace {

bool readWavMono(const char* path, Signal& out, double& rate) {
    std::ifstream f(path, std::ios::binary);
    std::vector<unsigned char> buf((std::istreambuf_iterator<char>(f)), {});
    if (buf.size() < 12 || std::memcmp(buf.data(), "RIFF", 4) || std::memcmp(buf.data() + 8, "WAVE", 4)) return false;
    auto u16 = [&](size_t o) { return buf[o] | buf[o + 1] << 8; };
    auto u32 = [&](size_t o) { return static_cast<uint32_t>(buf[o] | buf[o + 1] << 8 | buf[o + 2] << 16 | buf[o + 3] << 24); };
    int fmt = 0, channels = 0, bits = 0;
    size_t dataStart = 0, dataLen = 0;
    for (size_t off = 12; off + 8 <= buf.size();) {
        const uint32_t len = u32(off + 4);
        const size_t body = off + 8;
        if (!std::memcmp(buf.data() + off, "fmt ", 4)) {
            fmt = u16(body);
            channels = u16(body + 2);
            rate = u32(body + 4);
            bits = u16(body + 14);
            if (fmt == 0xfffe) fmt = u16(body + 24);
        } else if (!std::memcmp(buf.data() + off, "data", 4)) {
            dataStart = body;
            dataLen = std::min<size_t>(len, buf.size() - body);
        }
        off = body + len + (len & 1);
    }
    if (!dataStart || !channels) return false;
    const int bps = bits / 8;
    const size_t frames = dataLen / (bps * channels);
    out.resize(frames);
    for (size_t i = 0; i < frames; ++i) {
        double s = 0;
        for (int c = 0; c < channels; ++c) {
            const size_t p = dataStart + (i * channels + c) * bps;
            double v = 0;
            if (fmt == 3 && bits == 32) { float x; std::memcpy(&x, &buf[p], 4); v = x; }
            else if (bits == 16) v = static_cast<int16_t>(u16(p)) / 32768.0;
            else if (bits == 24) v = (static_cast<int32_t>(u32(p) << 8) >> 8) / 8388608.0;
            else if (bits == 32) v = static_cast<int32_t>(u32(p)) / 2147483648.0;
            s += v;
        }
        out[i] = static_cast<float>(s / channels);
    }
    return true;
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) { std::fprintf(stderr, "usage: padchop_analyze file.wav\n"); return 2; }
    Signal mono;
    double rate = 0;
    if (!readWavMono(argv[1], mono, rate)) { std::fprintf(stderr, "cannot read %s\n", argv[1]); return 1; }
    const auto sig = resample(mono, rate, 22050);
    std::string name = argv[1];
    name = name.substr(name.find_last_of('/') + 1);
    const auto a = analyze(sig, 22050, parseNameHints(name));
    std::printf("{\"bpm\":%.3f,\"beats\":%zu,\"downbeat\":%d,\"tonic\":%d,\"minor\":%d,\"onsets\":%zu,\"regions\":%zu}\n",
                a.tempo.bpm, a.tempo.beats.size(), a.tempo.downbeatIndex, a.key.tonic, a.key.mode == Mode::Minor ? 1 : 0,
                a.onsets.size(), a.regions.size());
    return 0;
}
