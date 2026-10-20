#include "padchop/dsp.h"

#include <cmath>
#include <stdexcept>

namespace padchop {

FFT::FFT(int size) : n_(size) {
    if (size < 2 || (size & (size - 1)) != 0) throw std::invalid_argument("FFT size must be a power of two");
    cos_.resize(size / 2);
    sin_.resize(size / 2);
    for (int i = 0; i < size / 2; ++i) {
        cos_[i] = std::cos(2 * M_PI * i / size);
        sin_[i] = -std::sin(2 * M_PI * i / size);
    }
    int bits = 0;
    while ((1 << bits) < size) ++bits;
    rev_.resize(size);
    for (int i = 0; i < size; ++i) {
        uint32_t r = 0;
        for (int b = 0; b < bits; ++b) r |= ((i >> b) & 1u) << (bits - 1 - b);
        rev_[i] = r;
    }
    re_.resize(size);
    im_.resize(size);
}

void FFT::magnitude(const float* input, int len, float* out) {
    for (int i = 0; i < n_; ++i) {
        re_[rev_[i]] = i < len ? input[i] : 0.0;
        im_[rev_[i]] = 0.0;
    }
    transform(re_.data(), im_.data(), false);
    for (int k = 0; k <= n_ / 2; ++k) out[k] = static_cast<float>(std::hypot(re_[k], im_[k]));
}

void FFT::complex(double* re, double* im, bool inverse) const {
    for (int i = 0; i < n_; ++i) {
        const auto j = static_cast<int>(rev_[i]);
        if (j > i) {
            std::swap(re[i], re[j]);
            std::swap(im[i], im[j]);
        }
    }
    transform(re, im, inverse);
}

void FFT::transform(double* re, double* im, bool inverse) const {
    const double sign = inverse ? -1.0 : 1.0;
    for (int len = 2; len <= n_; len <<= 1) {
        const int half = len >> 1;
        const int step = n_ / len;
        for (int start = 0; start < n_; start += len) {
            for (int j = 0; j < half; ++j) {
                const double wr = cos_[j * step];
                const double wi = sign * sin_[j * step];
                const int a = start + j;
                const int b = a + half;
                const double tr = re[b] * wr - im[b] * wi;
                const double ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}

std::vector<float> hann(int size) {
    std::vector<float> w(size);
    for (int i = 0; i < size; ++i) w[i] = static_cast<float>(0.5 - 0.5 * std::cos(2 * M_PI * i / size));
    return w;
}

} // namespace padchop
