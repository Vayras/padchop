import { useRef, useState } from 'react'
import { MAX_TRACKS, SLOT_NAMES, slotTag, TRACK_COLORS, type Track } from '../model/project'
import { keyLabel } from '../format'

interface Props {
  tracks: Track[]
  active: string | null
  anchor: string | null
  shiftOf(track: Track): number
  busy: boolean
  onSelect(id: string): void
  onAdd(file: File): void
  onRemove(id: string): void
  onAnchor(id: string): void
  onMute(id: string, muted: boolean): void
  onMatchKey(id: string, on: boolean): void
}

export function Header({ tracks, active, anchor, shiftOf, busy, onSelect, onAdd, onRemove, onAnchor, onMute, onMatchKey }: Props) {
  const input = useRef<HTMLInputElement>(null)
  // Removing a sample also drops its chops and sequence lane, so it takes two presses.
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <header className="header">
      <div className="brand">
        <span className="brand__name">padchop</span>
        <span className="label label--wide label--muted">Sample chopper · 16 pads</span>
      </div>

      <div className="slots">
        {tracks.map((t, i) => {
          const isAnchor = t.id === anchor
          const on = t.id === active
          const color = TRACK_COLORS[i]
          return (
            <div key={t.id} className={`slot ${on ? 'is-active' : ''}`}>
              <button type="button" className="slot__main" aria-pressed={on} onClick={() => onSelect(t.id)}>
                <span className={`led ${on ? 'is-on' : ''}`} style={{ '--led': color } as React.CSSProperties} />
                <span className="slot__text">
                  <span className="slot__name">{SLOT_NAMES[i]} · {t.name}</span>
                  <span className="slot__meta">
                    {keyLabel(t.analysis.key)} · <span className={`slot__tag ${isAnchor ? 'slot__tag--anchor' : ''}`}>{slotTag(t, isAnchor, shiftOf(t))}</span>
                  </span>
                </span>
              </button>
              <span className="slot__actions">
                {!isAnchor && (
                  <button type="button" className="slot__btn" aria-pressed={t.matchKey} onClick={() => onMatchKey(t.id, !t.matchKey)} title="Repitch into the anchor's key" aria-label={`Match ${t.name} to the anchor key`}>♯</button>
                )}
                {!isAnchor && (
                  <button type="button" className="slot__btn" onClick={() => onAnchor(t.id)} title="Make this the anchor: it sets the song's key and tempo" aria-label={`Make ${t.name} the anchor`}>⚓︎</button>
                )}
                <button type="button" className="slot__btn" aria-pressed={t.muted} onClick={() => onMute(t.id, !t.muted)} title="Mute in the sequence" aria-label={`Mute ${t.name}`}>M</button>
                {confirming === t.id ? (
                  <button
                    type="button"
                    className="slot__btn slot__btn--confirm"
                    autoFocus
                    onClick={() => { setConfirming(null); onRemove(t.id) }}
                    onBlur={() => setConfirming(null)}
                    aria-label={`Confirm removing ${t.name}`}
                  >
                    REMOVE?
                  </button>
                ) : (
                  <button type="button" className="slot__btn" onClick={() => setConfirming(t.id)} title="Remove sample" aria-label={`Remove ${t.name}`}>×</button>
                )}
              </span>
            </div>
          )
        })}
        {tracks.length === 0 && <span className="empty-slots">NO SAMPLES IN SLOTS</span>}
      </div>

      <div className="grille" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => <span key={i} />)}
      </div>
      <button
        type="button"
        className={`key-dark add-sample ${tracks.length === 0 ? 'is-calling' : ''}`}
        disabled={busy || tracks.length >= MAX_TRACKS}
        onClick={() => input.current?.click()}
        title={tracks.length >= MAX_TRACKS ? `All ${MAX_TRACKS} slots are full` : 'Load an audio file into the next slot'}
      >
        <span className={`led led--sm ${tracks.length === 0 || busy ? 'is-on' : ''}`} />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14" /><path d="M5 12h14" /></svg>
        ADD SAMPLE
      </button>
      <input
        ref={input}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onAdd(f)
          e.target.value = ''
        }}
      />
    </header>
  )
}
