import { useRef } from 'react'

interface Props {
  label: string
  value: number
  min: number
  max: number
  /** Value change per pixel of vertical drag (hold Shift for 10× finer). */
  perPixel: number
  /** Arrow-key / wheel step. */
  step: number
  display: string
  /** Arc colour; omit for a plain ring (position knobs). */
  accent?: string
  disabled?: boolean
  /** Hidden on phones, where the compact layout keeps two knobs. */
  secondary?: boolean
  onChange(value: number): void
}

const SWEEP = 270

/** Hardware-style knob: drag up/down, scroll, or use the arrow keys. */
export function Knob({ label, value, min, max, perPixel, step, display, accent, disabled, secondary, onChange }: Props) {
  const drag = useRef<{ y: number; v: number } | null>(null)
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const f = disabled ? 0 : (clamp(value) - min) / (max - min || 1)
  const deg = (f * SWEEP).toFixed(0)
  const ring = accent && !disabled
    ? `conic-gradient(from 225deg, ${accent} 0deg ${deg}deg, #A9A498 ${deg}deg 270deg, transparent 270deg 360deg)`
    : 'conic-gradient(#A9A498 0deg 360deg)'

  return (
    <button
      type="button"
      className={`knob ${secondary ? 'wide-only' : ''}`}
      disabled={disabled}
      aria-label={`${label} ${display}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { y: e.clientY, v: value }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const dy = drag.current.y - e.clientY
        onChange(clamp(drag.current.v + dy * perPixel * (e.shiftKey ? 0.1 : 1)))
      }}
      onPointerUp={() => { drag.current = null }}
      onWheel={(e) => { if (!disabled) onChange(clamp(value + (e.deltaY < 0 ? step : -step))) }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); onChange(clamp(value + step)) }
        if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); onChange(clamp(value - step)) }
      }}
    >
      <span className="knob__ring" style={{ background: ring }}>
        <span className="knob__cap" style={{ transform: `rotate(${((f - 0.5) * SWEEP).toFixed(0)}deg)` }} />
      </span>
      <span className="label">{label}</span>
      <span className="knob__value">{disabled ? '—' : display}</span>
    </button>
  )
}
