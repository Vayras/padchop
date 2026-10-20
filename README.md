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

## Develop

```sh
npm install
npm run dev     # http://localhost:5173
npm test
npm run build   # static site in dist/
```

Pushes to `master` deploy to GitHub Pages via `.github/workflows/deploy.yml`.
