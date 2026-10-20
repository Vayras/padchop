import { CHOP_MODES, type ChopMode } from '../dsp/chop'
import { dbLabel, dbToGain, formatTime, gainDb, gainToDb, hzLabel, MIN_DB, panLabel, secondsLabel, semitoneLabel } from '../format'
import type { Envelope } from '../audio/engine'
import { PAD_COLORS, PAD_COUNT, PAD_KEYS, type Slice } from '../model/slices'
import { Knob } from './Knob'

/* ---------- Mode strip ---------- */

/** Phone-width labels, from the compact layout. */
const MODE_SHORT: Record<ChopMode, string> = { find: 'FIND', slicer: 'SLICE', random: 'RAND', transients: 'TRANS', keys: 'KEY' }

const MODE_LABELS: Record<ChopMode, string> = {
  find: 'FIND',
  slicer: 'SLICER',
  random: 'RANDOM',
  transients: 'TRANSIENT',
  keys: 'KEY SHIFT',
}

export function ModeStrip(props: {
  mode: ChopMode
  lit: boolean
  enabled: boolean
  zoomLabel: string
  showOnsets: boolean
  onMode(mode: ChopMode): void
  onZoom(factor: number | 'fit'): void
  onShowOnsets(on: boolean): void
}) {
  return (
    <div className="modestrip">
      {CHOP_MODES.map((m) => {
        const on = m.id === props.mode
        return (
          <button key={m.id} type="button" className="ledkey" aria-pressed={on} disabled={!props.enabled} onClick={() => props.onMode(m.id)} title={m.hint}>
            <span className={`led ${on && props.enabled ? 'is-on' : ''}`} style={on && !props.lit ? ({ '--led': '#B5553F' } as React.CSSProperties) : undefined} />
            <span className="ledkey__cap" />
            <span className="label">
              <span className="wide-only">{MODE_LABELS[m.id]}</span>
              <span className="phone-only">{MODE_SHORT[m.id]}</span>
            </span>
          </button>
        )
      })}
      <div className="grow" />
      <div className="zoom wide-only">
        <span className="zoom__value">{props.zoomLabel}</span>
        <div className="zoom__keys">
          <button type="button" className="key-light key--sq" aria-label="Zoom out" disabled={!props.enabled} onClick={() => props.onZoom(2)}>−</button>
          <button type="button" className="key-light" style={{ width: 52, padding: 0 }} aria-label="Fit whole sample" disabled={!props.enabled} onClick={() => props.onZoom('fit')}>FIT</button>
          <button type="button" className="key-light key--sq" aria-label="Zoom in" disabled={!props.enabled} onClick={() => props.onZoom(0.5)}>+</button>
        </div>
        <span className="label">ZOOM</span>
      </div>
      <button type="button" className="ledkey ledkey--light wide-only" aria-pressed={props.showOnsets} onClick={() => props.onShowOnsets(!props.showOnsets)}>
        <span className={`led ${props.showOnsets ? 'is-on' : ''}`} style={{ '--led': '#F5C042' } as React.CSSProperties} />
        <span className="ledkey__cap" />
        <span className="label">TRANSIENTS</span>
      </button>
    </div>
  )
}

/* ---------- Knobs + transport keys ---------- */

/** Envelope time knobs sweep 0 ms … 2 s on a log scale (fine control near zero). */
const TIME_MAX = 2
const TIME_CURVE = 1000
function knobToTime(v: number): number {
  return v <= 0 ? 0 : (TIME_MAX * (Math.pow(TIME_CURVE, v) - 1)) / (TIME_CURVE - 1)
}
function timeToKnob(t: number): number {
  return Math.log(1 + (t * (TIME_CURVE - 1)) / TIME_MAX) / Math.log(TIME_CURVE)
}

export type MixPatch = Partial<{ gain: number; pan: number; lowCut: number; highCut: number }>

export function KnobPanel(props: {
  /** TEMPO page turns the knobs into tempo and transpose. */
  tempo: { bpm: number; transpose: number; onBpm(bpm: number): void; onTranspose(n: number): void } | null
  /** AMP page turns the knobs into the selected pad's envelope. */
  env: { value: Envelope; color: string; onChange(patch: Partial<Envelope>): void } | null
  /** MIX page turns the knobs into the selected track's channel strip. */
  mix: { level: number; pan: number; lowCut: number; highCut: number; color: string; onChange(patch: MixPatch): void } | null
  slice: Slice | null
  padIndex: number
  duration: number
  enabled: boolean
  previewing: boolean
  seqPlaying: boolean
  onChange(patch: Partial<Slice>): void
  onPreview(): void
  onPlaySeq(): void
}) {
  const s = props.slice
  const accent = PAD_COLORS[props.padIndex]
  const t = props.tempo
  const m = props.mix
  const e = props.env
  return (
    <div className="knobpanel" style={{ '--accent': accent } as React.CSSProperties}>
      {e ? (
        <>
          {(['attack', 'decay'] as const).map((k) => (
            <Knob key={k} label={k.toUpperCase()} value={timeToKnob(e.value[k])} min={0} max={1} step={0.02} perPixel={0.004} accent={e.color}
              display={secondsLabel(e.value[k])} onChange={(v) => e.onChange({ [k]: knobToTime(v) })} />
          ))}
          <Knob label="SUSTAIN" value={e.value.sustain} min={0} max={1} step={0.05} perPixel={0.005} accent={e.color}
            display={`${Math.round(e.value.sustain * 100)}%`} onChange={(sustain) => e.onChange({ sustain })} />
          <Knob label="RELEASE" value={timeToKnob(e.value.release)} min={0} max={1} step={0.02} perPixel={0.004} accent={e.color}
            display={secondsLabel(e.value.release)} onChange={(v) => e.onChange({ release: knobToTime(v) })} />
        </>
      ) : m ? (
        <>
          <Knob label="LEVEL" value={Math.max(MIN_DB, gainToDb(m.level))} min={MIN_DB} max={6} step={1} perPixel={0.3} accent={m.color}
            display={dbLabel(m.level)} onChange={(db) => m.onChange({ gain: dbToGain(db) })} />
          <Knob label="PAN" value={m.pan} min={-1} max={1} step={0.04} perPixel={0.01} accent={m.color}
            display={panLabel(m.pan)} onChange={(pan) => m.onChange({ pan: Math.abs(pan) < 0.02 ? 0 : pan })} />
          <Knob label="LOW CUT" value={Math.log(m.lowCut / 20) / Math.log(50)} min={0} max={1} step={0.02} perPixel={0.005} accent={m.color}
            display={m.lowCut <= 21 ? 'off' : `${hzLabel(m.lowCut)} Hz`} onChange={(v) => m.onChange({ lowCut: 20 * Math.pow(50, v) })} />
          <Knob label="HIGH CUT" value={Math.log(m.highCut / 1000) / Math.log(20)} min={0} max={1} step={0.02} perPixel={0.005} accent={m.color}
            display={m.highCut >= 19999 ? 'off' : `${hzLabel(m.highCut)} Hz`} onChange={(v) => m.onChange({ highCut: 1000 * Math.pow(20, v) })} />
        </>
      ) : t ? (
        <>
          <Knob label="TEMPO" value={t.bpm} min={40} max={250} step={1} perPixel={0.25} accent="#FFB547"
            display={`${t.bpm.toFixed(1)} bpm`} onChange={(v) => t.onBpm(Math.round(v * 10) / 10)} />
          <Knob label="TRANSPOSE" value={t.transpose} min={-12} max={12} step={1} perPixel={0.12} accent="#FFB547"
            display={semitoneLabel(t.transpose).toLowerCase()} onChange={(v) => t.onTranspose(Math.round(v))} />
        </>
      ) : (
        <>
          <Knob label="PITCH" value={s?.semitones ?? 0} min={-12} max={12} step={1} perPixel={0.12} accent={accent} disabled={!s}
            display={s ? semitoneLabel(s.semitones).toLowerCase() : ''} onChange={(v) => props.onChange({ semitones: Math.round(v) })} />
          <Knob label="GAIN" value={s?.gain ?? 1} min={0} max={2} step={0.05} perPixel={0.01} accent={accent} disabled={!s}
            display={s ? gainDb(s.gain) : ''} onChange={(gain) => props.onChange({ gain })} />
          <Knob secondary label="TRIM START" value={s?.start ?? 0} min={0} max={Math.max(0.01, (s?.end ?? 1) - 0.01)} step={0.01} perPixel={0.004} disabled={!s}
            display={s ? formatTime(s.start) : ''} onChange={(start) => props.onChange({ start })} />
          <Knob secondary label="TRIM END" value={s?.end ?? 0} min={(s?.start ?? 0) + 0.01} max={props.duration} step={0.01} perPixel={0.004} disabled={!s}
            display={s ? formatTime(s.end) : ''} onChange={(end) => props.onChange({ end })} />
        </>
      )}
      <div className="grow" />
      <div className="transport-keys">
        <button type="button" className="bigkey" onClick={props.onPreview} disabled={!props.enabled} aria-label={props.previewing ? 'Stop preview' : 'Preview from the playhead (Space)'}>
          <span className={`bigkey__round ${props.previewing ? 'is-on' : ''}`}>
            {props.previewing ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#FFB547" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="#F2EFE8" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg>
            )}
          </span>
          <span className="label">{props.previewing ? 'STOP' : 'PREVIEW'}</span>
        </button>
        <button type="button" className="bigkey" onClick={props.onPlaySeq} disabled={!props.enabled} aria-label={props.seqPlaying ? 'Stop sequence' : 'Play sequence (Shift+Space)'}>
          <span className={`playseq__cap ${props.seqPlaying ? 'is-on' : ''}`}>
            {props.seqPlaying ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="#FFF6F2" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="#FFF6F2" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg>
            )}
          </span>
          <span className="label">{props.seqPlaying ? 'STOP SEQ' : 'PLAY SEQ'}</span>
        </button>
      </div>
    </div>
  )
}

/* ---------- Pads ---------- */

export interface PadView {
  lit: boolean
  color: string
  sub: string
  dim: boolean
}

export function PadPanel(props: {
  owner: string
  pads: PadView[]
  selected: number
  playing: Set<number>
  keyboard: boolean
  octave: number
  canKeyboard: boolean
  canDelete: boolean
  onTrigger(i: number): void
  onSelect(i: number): void
  onKeyboard(): void
  onOctave(o: number): void
  onDelete(): void
}) {
  return (
    <div className="well">
      <div className="well__head">
        <span className="label label--wide">PADS · {props.owner}</span>
        <span className="mono">KEYS 1–4 · Q–R · A–F · Z–V</span>
      </div>
      <div className={`pads ${props.keyboard ? 'is-kbd' : ''}`}>
        {Array.from({ length: PAD_COUNT }, (_, i) => {
          const p = props.pads[i]
          const cls = ['pad', p.lit ? 'is-lit' : '', i === props.selected && !props.keyboard ? 'is-selected' : '', props.playing.has(i) ? 'is-playing' : '', p.dim ? 'is-dim' : '']
          return (
            <button
              key={i}
              type="button"
              className={cls.filter(Boolean).join(' ')}
              style={{ '--c': p.color } as React.CSSProperties}
              onPointerDown={(e) => {
                e.preventDefault()
                if (p.lit) props.onTrigger(i)
                else props.onSelect(i)
              }}
              aria-label={p.lit ? `Pad ${i + 1}, ${p.sub}` : `Empty pad ${i + 1}`}
            >
              <span className="pad__n">{props.keyboard ? p.sub.split(' ')[0] : i + 1}</span>
              <span className="pad__foot">
                <span className="pad__sub">{props.keyboard ? p.sub.split(' ').slice(1).join(' ') : p.sub}</span>
                <span className="pad__key">{PAD_KEYS[i].toUpperCase()}</span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="well__foot">
        <button type="button" className="key-light" aria-pressed={props.keyboard} disabled={!props.canKeyboard} onClick={props.onKeyboard}>
          <span className={`led ${props.keyboard ? 'is-on' : ''}`} style={{ '--led': '#5BD08A' } as React.CSSProperties} />
          KEYBOARD MODE
          <span className="kbd-cap">K</span>
        </button>
        {props.keyboard && (
          <span className="octave">
            <button type="button" className="key-light key--sq" aria-label="Octave down (−)" disabled={props.octave <= -2} onClick={() => props.onOctave(props.octave - 1)}>−</button>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, minWidth: 54, textAlign: 'center' }}>OCT {props.octave > 0 ? `+${props.octave}` : props.octave}</span>
            <button type="button" className="key-light key--sq" aria-label="Octave up (=)" disabled={props.octave >= 2} onClick={() => props.onOctave(props.octave + 1)}>+</button>
          </span>
        )}
        <div className="grow" />
        <button type="button" className="key-dark" disabled={!props.canDelete} onClick={props.onDelete} aria-label="Delete selected pad (Backspace)">
          DELETE PAD <span className="mono" style={{ fontSize: 13 }}>⌫</span>
        </button>
      </div>
    </div>
  )
}
