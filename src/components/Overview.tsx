import { useEffect, useRef } from 'react'
import type { AnalysisResult } from '../dsp/types'
import { PAD_COLORS, type PadSlots } from '../model/slices'

interface Props {
  analysis: AnalysisResult
  slices: PadSlots
  view: { start: number; end: number }
  onView(view: { start: number; end: number }): void
  className?: string
}

/** Whole-sample strip above the LCD waveform, with a draggable zoom window. */
export function Overview({ analysis, slices, view, onView, className = '' }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const dur = analysis.duration

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Device pixels per layout pixel, including any CSS zoom on the page.
      const dpr = (window.devicePixelRatio || 1) * (canvas.getBoundingClientRect().width / w || 1)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)
      const lcd = getComputedStyle(canvas).getPropertyValue('--lcd').trim() || '#FFB547'
      g.fillStyle = lcd
      g.globalAlpha = 0.45
      const pps = analysis.peaksPerSecond
      const mid = 6 + (h - 6) / 2
      for (let x = 0; x < w; x++) {
        const i0 = Math.floor((x / w) * dur * pps)
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / w) * dur * pps))
        let p = 0
        for (let i = i0; i < Math.min(i1, analysis.peaks.length); i++) p = Math.max(p, analysis.peaks[i])
        const ph = Math.max(0.5, p * (h - 6) * 0.5)
        g.fillRect(x, mid - ph, 1, ph * 2)
      }
      g.globalAlpha = 1
      slices.forEach((s, i) => {
        if (!s) return
        g.fillStyle = PAD_COLORS[i]
        g.fillRect(Math.round((s.start / dur) * w), 0, 2, 5)
      })
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [analysis, slices, dur])

  const span = view.end - view.start
  const timeAt = (clientX: number) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return ((clientX - r.left) / r.width) * dur
  }
  const place = (start: number) => {
    const s = Math.max(0, Math.min(dur - span, start))
    onView({ start: s, end: s + span })
  }

  return (
    <div className={`overview ${className}`}>
      <canvas
        ref={canvasRef}
        aria-label="Sample overview. Drag to move the zoomed view."
        onPointerDown={(e) => {
          const t = timeAt(e.clientX)
          const inside = t >= view.start && t <= view.end
          drag.current = inside ? t - view.start : span / 2
          if (!inside) place(t - span / 2)
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => { if (drag.current !== null) place(timeAt(e.clientX) - drag.current) }}
        onPointerUp={() => { drag.current = null }}
      />
      <div className="overview__window" style={{ left: `${(view.start / dur) * 100}%`, width: `${(span / dur) * 100}%` }} />
    </div>
  )
}
