#include "padchop/dsp.h"

#include <algorithm>
#include <cmath>

namespace padchop {

Signal resample(const Signal& x, double from, double to) {
    if (from == to) return x;
    const double ratio = to / from;
    const size_t n = static_cast<size_t>(std::floor(x.size() * ratio));
    Signal y(n);
    const double cutoff = std::min(1.0, ratio) * 0.95;
    const int half = 16;
    for (size_t i = 0; i < n; ++i) {
        const double t = i / ratio;
        const long c = static_cast<long>(std::floor(t));
        double s = 0, w = 0;
        for (long k = c - half + 1; k <= c + half; ++k) {
            if (k < 0 || k >= static_cast<long>(x.size())) continue;
            const double d = t - k;
            const double sinc = d == 0 ? 1 : std::sin(M_PI * cutoff * d) / (M_PI * cutoff * d);
            const double win = 0.5 + 0.5 * std::cos(M_PI * d / half);
            s += x[k] * sinc * win;
            w += sinc * win;
        }
        y[i] = static_cast<float>(w ? s / w : 0);
    }
    return y;
}

} // namespace padchop
