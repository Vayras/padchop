import { useEffect, useRef, useState, type ReactNode } from 'react'
import { PAD_COLORS } from '../model/slices'
import type { Pattern, Step, Track } from '../model/project'
import { SLOT_NAMES, TRACK_COLORS } from '../model/project'
import { dbLabel, dbToGain, gainToDb, hzLabel, MIN_DB, noteName, panLabel, secondsLabel } from '../format'
import type { Envelope } from '../audio/engine'

export type Page = 'chop' | 'amp' | 'seq' | 'tempo' | 'mix'

export interface SoftKey {
  label: string
  act?: () => void
}

interface Props {
  fileLabel: string
  bpmLabel: string
  keyLabel: string
  modeLabel: string
  info: ReactNode
  time: string
  softkeys: SoftKey[]
  page: Page
  pagesEnabled: boolean
  onPage(page: Page): void
  children: ReactNode
}

const PAGES: { id: Page; label: string }[] = [
  { id: 'chop', label: 'CHOP' },
  { id: 'amp', label: 'AMP' },
  { id: 'seq', label: 'SEQ' },
  { id: 'tempo', label: 'TEMPO' },
  { id: 'mix', label: 'MIX' },
]

/** The bezel: LCD with six soft keys under it, page keys beside it. */
export function Screen({ fileLabel, bpmLabel, keyLabel, modeLabel, info, time, softkeys, page, pagesEnabled, onPage, children }: Props) {
  const keys = Array.from({ length: 6 }, (_, i) => softkeys[i] ?? { label: '' })
  return (
    <div className="bezel">
      <div className="bezel__screen">
        <div className="lcd">
          <div className="lcd__top">
            <span className="lcd__file">▸ {fileLabel}</span>
            <span className="lcd__top-right">
              {bpmLabel && <span>{bpmLabel}</span>}
              {keyLabel && <span>{keyLabel}</span>}
              <span className="lcd__chip">{modeLabel}</span>
            </span>
          </div>
          <div className="lcd__page">{children}</div>
          <div className="lcd__info">
            {info}
            <span style={{ fontWeight: 600 }}>{time}</span>
          </div>
          <div className="lcd__softlabels" aria-hidden="true">
            {keys.map((k, i) => <span key={i}>{k.label}</span>)}
          </div>
        </div>
        <div className="softkeys">
          {keys.map((k, i) => (
            <span key={i}>
              <button
                type="button"
                className="softkey"
                disabled={!k.act}
                onClick={k.act}
                aria-label={k.label ? `Soft key: ${k.label}` : `Unused soft key ${i + 1}`}
              />
            </span>
          ))}
        </div>
      </div>

      <div className="pagekeys">
        <span className="pagekeys__title">PAGE</span>
        {PAGES.map((p) => {
          const on = page === p.id
          return (
            <button key={p.id} type="button" className="pagekey" aria-pressed={on} disabled={!pagesEnabled} onClick={() => onPage(p.id)}>
              <span className="pagekey__cap" />
              <span className="pagekey__side">
                <span className={`led led--sm ${on && pagesEnabled ? 'is-on' : ''}`} />
                <span className="pagekey__label">{p.label}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** SEQ page: the step editor. Press or drag across steps to place the armed pad; press a lit step to clear it. */
export function LcdSequence(props: {
  tracks: Track[]
  active: string | null
  pattern: Pattern
  /** Step under the playhead, -1 when stopped. */
  step: number
  /** 16-step page shown while stopped. */
  view: number
  rootPc: number
  brushOf(track: Track): Step
  onSelectTrack(id: string): void
  onSetStep(trackId: string, index: number, step: Step | null): void
  onView(page: number): void
}) {
  const { pattern, step, rootPc } = props
  const total = pattern.bars * pattern.stepsPerBar
  const pages = Math.ceil(total / 16)
  // Follow the playhead while playing; otherwise show the page the user picked.
  const page = step >= 0 ? Math.floor(step / 16) : Math.min(props.view, pages - 1)
  const pageStart = page * 16
  const cols = Math.min(16, total)
  const idx = Array.from({ length: cols }, (_, i) => pageStart + i).filter((i) => i < total)
  const paint = useRef<{ trackId: string; erase: boolean } | null>(null)

  useEffect(() => {
    const up = () => { paint.current = null }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])
  const apply = (t: Track, i: number) => {
    if (paint.current?.trackId === t.id) props.onSetStep(t.id, i, paint.current.erase ? null : props.brushOf(t))
  }

  return (
    <div className="lcdseq">
      <div className="lcdseq__row">
        <span />
        <div className="lcdseq__cells lcdseq__ruler" style={{ '--cols': cols } as React.CSSProperties}>
          {idx.map((i) => <span key={i}>{i % pattern.stepsPerBar === 0 ? i / pattern.stepsPerBar + 1 : '·'}</span>)}
        </div>
      </div>
      {props.tracks.map((t, ti) => {
        const lane = pattern.lanes[t.id] ?? []
        const on = t.id === props.active
        return (
          <div key={t.id} className={`lcdseq__row ${t.muted ? 'is-muted' : ''}`} style={{ '--track': TRACK_COLORS[ti] } as React.CSSProperties}>
            <button type="button" className={`lcdseq__name ${on ? 'is-active' : ''}`} aria-pressed={on} onClick={() => props.onSelectTrack(t.id)}>
              {SLOT_NAMES[ti]} {t.name.slice(0, 3)}
            </button>
            <div className="lcdseq__cells" style={{ '--cols': cols } as React.CSSProperties}>
              {idx.map((i) => {
                const s = lane[i]
                const label = s ? (s.note ? noteName(rootPc + s.semitones) : String(s.pad + 1)) : ''
                const beat = i % Math.max(1, pattern.stepsPerBar / 4) === 0
                return (
                  <button
                    key={i}
                    type="button"
                    className={['lcdseq__cell', s ? 'is-on' : '', beat ? 'is-beat' : '', i === step ? 'is-now' : ''].filter(Boolean).join(' ')}
                    style={s ? ({ '--cell': PAD_COLORS[s.pad] } as React.CSSProperties) : undefined}
                    aria-label={`Track ${SLOT_NAMES[ti]} step ${i + 1}${s ? `, ${label}` : ', empty'}`}
                    onPointerDown={(e) => {
                      e.preventDefault()
                      paint.current = { trackId: t.id, erase: !!s }
                      apply(t, i)
                    }}
                    onPointerEnter={() => apply(t, i)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {props.tracks.length === 0 && <span className="lcd-note">NO TRACKS — ADD A SAMPLE TO START A SEQUENCE</span>}
      <span className="lcd-note lcdseq__foot">
        <span>{total} STEPS · 1/{pattern.stepsPerBar} GRID</span>
        {pages > 1 && (
          <span className="lcdseq__pager">
            <button type="button" disabled={page === 0 || step >= 0} onClick={() => props.onView(page - 1)} aria-label="Previous 16 steps">◂</button>
            PAGE {page + 1}/{pages}
            <button type="button" disabled={page >= pages - 1 || step >= 0} onClick={() => props.onView(page + 1)} aria-label="Next 16 steps">▸</button>
          </span>
        )}
      </span>
    </div>
  )
}

/** TEMPO page: big project tempo (press to type), tap indicator, project key and transpose. */
export function LcdTempo(props: { bpm: number; taps: number; projectKey: string; transpose: string; onBpm(bpm: number): void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const v = Number(draft)
    if (draft !== null && v >= 40 && v <= 250) props.onBpm(v)
    setDraft(null)
  }
  return (
    <div className="lcdtempo">
      <div className="lcdtempo__stats">
        <label className="lcdtempo__stat">
          <span className="lcdtempo__k">PROJECT TEMPO</span>
          <input
            className="lcdtempo__bpm"
            inputMode="decimal"
            aria-label="Project tempo"
            value={draft ?? props.bpm.toFixed(1)}
            onFocus={(e) => { setDraft(props.bpm.toFixed(1)); e.target.select() }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
            }}
          />
        </label>
        <div className="lcdtempo__stat">
          <span className="lcdtempo__k">TAP</span>
          <span className="tapdots" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <span key={i} className={i < props.taps ? 'is-on' : ''} />)}
          </span>
        </div>
        <div className="lcdtempo__stat">
          <span className="lcdtempo__k">PROJECT KEY</span>
          <span className="lcdtempo__v">{props.projectKey}</span>
        </div>
        <div className="lcdtempo__stat">
          <span className="lcdtempo__k">TRANSPOSE</span>
          <span className="lcdtempo__v">{props.transpose}</span>
        </div>
      </div>
    </div>
  )
}

const FADER_MAX_DB = 6

/** Fader position 0..1 on a dB scale (−60 dB … +6 dB). */
function faderPos(gain: number): number {
  const db = gainToDb(gain)
  return db <= MIN_DB ? 0 : Math.min(1, (db - MIN_DB) / (FADER_MAX_DB - MIN_DB))
}

/** MIX page: a channel strip per track with fader, live meter, pan, mute and solo. */
export function LcdMixer(props: {
  tracks: Track[]
  active: string | null
  meterOf(id: string): number
  onSelect(id: string): void
  onLevel(id: string, gain: number): void
  onToggle(id: string, field: 'muted' | 'solo' | 'sync'): void
}) {
  const [levels, setLevels] = useState<Record<string, number>>({})
  const drag = useRef<{ id: string; rect: DOMRect } | null>(null)
  const { tracks, meterOf } = props

  // Meters read the audio graph directly, ~30 fps, with a little fall-off.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      setLevels((prev) => {
        const next: Record<string, number> = {}
        for (const t of tracks) next[t.id] = Math.max(meterOf(t.id), (prev[t.id] ?? 0) * 0.86)
        return next
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tracks, meterOf])

  const setFromPointer = (id: string, rect: DOMRect, clientY: number) => {
    const f = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height))
    props.onLevel(id, f <= 0.001 ? 0 : dbToGain(MIN_DB + f * (FADER_MAX_DB - MIN_DB)))
  }
  const anySolo = tracks.some((t) => t.solo)

  return (
    <div className="lcdmix">
      {tracks.map((t, i) => {
        const on = t.id === props.active
        const silent = t.muted || (anySolo && !t.solo)
        const meter = faderPos(levels[t.id] ?? 0)
        return (
          <div key={t.id} className={`lcdmix__strip ${on ? 'is-active' : ''} ${silent ? 'is-silent' : ''}`} style={{ '--track': TRACK_COLORS[i] } as React.CSSProperties}>
            <button type="button" className="lcdmix__name" aria-pressed={on} onClick={() => props.onSelect(t.id)}>
              {SLOT_NAMES[i]} · {t.name.slice(0, 8)}
            </button>
            <div className="lcdmix__body">
              <div
                className="lcdmix__fader"
                role="slider"
                tabIndex={0}
                aria-label={`${t.name} level`}
                aria-valuetext={dbLabel(t.gain)}
                aria-valuemin={MIN_DB}
                aria-valuemax={FADER_MAX_DB}
                aria-valuenow={Math.max(MIN_DB, gainToDb(t.gain))}
                onPointerDown={(e) => {
                  props.onSelect(t.id)
                  const rect = e.currentTarget.getBoundingClientRect()
                  drag.current = { id: t.id, rect }
                  e.currentTarget.setPointerCapture(e.pointerId)
                  setFromPointer(t.id, rect, e.clientY)
                }}
                onPointerMove={(e) => { if (drag.current?.id === t.id) setFromPointer(t.id, drag.current.rect, e.clientY) }}
                onPointerUp={() => { drag.current = null }}
                onKeyDown={(e) => {
                  const db = Math.max(MIN_DB, gainToDb(t.gain))
                  if (e.key === 'ArrowUp') { e.preventDefault(); props.onLevel(t.id, dbToGain(Math.min(FADER_MAX_DB, db + 1))) }
                  if (e.key === 'ArrowDown') { e.preventDefault(); props.onLevel(t.id, dbToGain(db - 1)) }
                }}
              >
                <span className="lcdmix__unity" style={{ bottom: `${faderPos(1) * 100}%` }} />
                <span className="lcdmix__fill" style={{ height: `${faderPos(t.gain) * 100}%` }} />
                <span className="lcdmix__cap" style={{ bottom: `${faderPos(t.gain) * 100}%` }} />
              </div>
              <div className="lcdmix__meter" aria-hidden="true">
                <span style={{ height: `${meter * 100}%` }} className={meter > faderPos(1) ? 'is-hot' : ''} />
              </div>
            </div>
            <span className="lcdmix__db">{dbLabel(t.gain)}</span>
            <span className="lcdmix__pan" aria-label={`Pan ${panLabel(t.pan)}`}>
              <span style={{ left: `${(t.pan + 1) * 50}%` }} />
            </span>
            <span className="lcdmix__row">
              <span>{panLabel(t.pan)}</span>
              <span>{t.lowCut > 21 ? `LC ${hzLabel(t.lowCut)}` : ''}{t.highCut < 19999 ? ` HC ${hzLabel(t.highCut)}` : ''}</span>
            </span>
            <span className="lcdmix__ms">
              <button type="button" aria-pressed={t.muted} onClick={() => props.onToggle(t.id, 'muted')} aria-label={`Mute ${t.name}`}>M</button>
              <button type="button" aria-pressed={t.solo} onClick={() => props.onToggle(t.id, 'solo')} aria-label={`Solo ${t.name}`}>S</button>
              <button type="button" aria-pressed={t.sync} onClick={() => props.onToggle(t.id, 'sync')} title="Time-stretch to the project tempo" aria-label={`Sync ${t.name} to the project tempo`}>SYNC</button>
            </span>
          </div>
        )
      })}
      {tracks.length === 0 && <span className="lcd-note">NO TRACKS</span>}
    </div>
  )
}

/** AMP page: the selected pad's envelope drawn over its length. */
export function LcdEnvelope({ env, length, color }: { env: Envelope | null; length: number; color: string }) {
  if (!env) {
    return (
      <div className="lcd-centre">
        <span className="lcd-big">EMPTY PAD</span>
        <span className="lcd-sub">SELECT A PAD WITH A CHOP TO SHAPE IT</span>
      </div>
    )
  }
  // Same fitting as the engine: attack and release shrink if the chop is too short.
  let a = Math.max(0.002, env.attack)
  let r = Math.max(0.002, env.release)
  if (a + r > length) {
    const k = length / (a + r)
    a *= k
    r *= k
  }
  const d = Math.min(env.decay, Math.max(0, length - a - r))
  const x = (t: number) => (t / length) * 1000
  const y = (v: number) => 92 - v * 84
  const pts = [[0, 0], [a, 1], [a + d, env.sustain], [length - r, env.sustain], [length, 0]]
  const path = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const marks: [string, number][] = [['A', a / 2], ['D', a + d / 2], ['S', (a + d + length - r) / 2], ['R', length - r / 2]]
  return (
    <div className="lcdenv">
      <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="lcdenv__graph" aria-hidden="true">
        <path d={`${path} Z`} fill={color} opacity="0.18" />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
        {[a, a + d, length - r].map((t, i) => (
          <line key={i} x1={x(t)} x2={x(t)} y1="0" y2="100" stroke="currentColor" strokeDasharray="3 4" opacity="0.35" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="lcdenv__marks" aria-hidden="true">
        {marks.map(([l, t]) => <span key={l} style={{ left: `${(t / length) * 100}%` }}>{l}</span>)}
      </div>
      <div className="lcdenv__values">
        <span>ATTACK {secondsLabel(env.attack)}</span>
        <span>DECAY {secondsLabel(env.decay)}</span>
        <span>SUSTAIN {Math.round(env.sustain * 100)}%</span>
        <span>RELEASE {secondsLabel(env.release)}</span>
      </div>
    </div>
  )
}
