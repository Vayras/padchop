# padchop

A browser sample chopper with a hardware-sampler interface. Drop in a sample and
padchop finds its tempo, key and transients, then sets 16 pads for you.

- **Chop modes:** find samples, slicer, random, transients, key shift.
- **Up to four sample tracks.** The anchor track sets the song key; other tracks
  are repitched to match.
- **Time-stretch:** a phase vocoder keeps every track at the project tempo.
- **Pads:** per-pad pitch, gain, trim and ADSR envelope, plus keyboard mode for
  playing one chop chromatically.
- **Step sequencer, mixer** (level, pan, low/high cut, mute, solo) and tap tempo.

Everything runs in the browser. Audio files never leave your machine.

## Keys

| Key | Action |
| --- | --- |
| 1–4, Q–R, A–F, Z–V | Pads |
| Space | Preview from the playhead |
| Shift+Space | Play / stop the sequence |
| Enter | Set the selected pad at the playhead |
| K | Keyboard mode (− / = change octave) |
| Backspace | Delete the selected pad |

## Plugin (macOS: VST3, AU, Standalone)

The same interface runs inside a native JUCE plugin. Analysis, chopping,
time-stretch and playback are a C++ port of the web DSP (`native/dsp`), so the
plugin doesn't depend on the browser's audio engine.

- **MIDI:** channels 1–4 play tracks A–D. Notes 36–51 (C1–D#2) are pads 1–16; a
  track in keyboard mode plays its selected chop chromatically around note 60.
- **Host sync:** the sequencer and time-stretch follow the host's tempo and
  transport. The standalone app uses its own tempo and the PLAY SEQ key.
- **Sessions:** the project and sample file paths are saved with the host session.

```sh
./native/build.sh          # web UI + plugin, installs to ~/Library/Audio/Plug-Ins
./native/build.sh --auv3   # also the AUv3 extension (needs an Apple Developer team)
```

Needs Xcode and CMake. JUCE 8 is fetched automatically (or put a checkout at
`native/third_party/JUCE`). Builds go to `~/Library/Developer/padchop-build`,
outside iCloud-synced folders, whose extended attributes break code signing.

Native tests: `cmake -S native -B build-dsp -DPADCHOP_BUILD_PLUGIN=OFF && cmake --build build-dsp && build-dsp/padchop_tests`.
`padchop_host_test <plugin> <sample.wav>` loads a built VST3/AU like a DAW and
checks MIDI playback, time-stretch to the host tempo, and host-synced sequencing.

JUCE is used under the AGPLv3, so distributed plugin builds must make their
source available under the same licence.

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm test
npm run build   # static site in dist/
```

Pushes to `master` deploy to GitHub Pages via `.github/workflows/deploy.yml`.
