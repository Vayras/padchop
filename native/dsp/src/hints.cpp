// BPM / key hints from sample-pack filenames ("zulu_texture_Cm_73", "Break 90BPM",
// "F#min 120 bpm"), used like file tags: a BPM narrows the tempo search to ±12.5,
// and a key skips key analysis.
#include "padchop/dsp.h"

#include <regex>

namespace padchop {

NameHints parseNameHints(const std::string& filename) {
    static const std::string sep = R"([\s_\-()[\].,])";
    static const std::regex ext(R"(\.[a-zA-Z0-9]+$)");
    static const std::regex withUnit(R"((\d{2,3}(?:\.\d+)?)\s?bp+m)", std::regex::icase);
    static const std::regex bare("(?:^|" + sep + R"()(\d{2,3})(?=$|)" + sep + ")");
    // A key needs an explicit quality ("Cm", "C#min", "Eb major") so words and
    // section letters ("Break A") aren't mistaken for keys.
    static const std::regex key("(?:^|" + sep + R"()([A-Ga-g])(#|b|♯|♭)?\s?(minor|min|m|major|maj|M)(?=$|)" + sep + R"(|\d))");

    const std::string name = std::regex_replace(filename, ext, "");
    NameHints hints;

    std::vector<std::string> candidates;
    std::smatch m;
    if (std::regex_search(name, m, withUnit)) {
        candidates.push_back(m[1]);
    } else {
        for (std::sregex_iterator it(name.begin(), name.end(), bare), end; it != end; ++it) candidates.push_back((*it)[1]);
    }
    for (const auto& c : candidates) {
        const double v = std::stod(c);
        if (v >= 50 && v <= 200) { hints.bpm = v; break; }
    }

    if (std::regex_search(name, m, key)) {
        static const int letter[] = {9, 11, 0, 2, 4, 5, 7}; // a b c d e f g
        const char l = static_cast<char>(std::tolower(static_cast<unsigned char>(m[1].str()[0])));
        int tonic = letter[l - 'a'];
        const std::string acc = m[2];
        if (acc == "#" || acc == "♯") tonic += 1;
        if (acc == "b" || acc == "♭") tonic -= 1;
        const std::string q = m[3];
        const bool major = q == "M" || q.rfind("maj", 0) == 0;
        hints.key = std::make_pair((tonic + 12) % 12, major ? Mode::Major : Mode::Minor);
    }
    return hints;
}

} // namespace padchop
