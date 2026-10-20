import { useEffect, useRef } from 'react'
import type { AnalysisResult } from '../dsp/types'
import { PAD_COLORS, type PadSlots } from '../model/slices'

interface Props {
  analysis: AnalysisResult
  slices: PadSlots
  selected: number
  /** Visible window in seconds. */
  view: { start: number; end: number }
  playhead: number
  showOnsets: boolean
  /** Key-shift mode: one region labelled 1–16 instead of one per pad. */
  single: boolean
  onSeek(time: number): void
  onSelect(index: number): void
  onMoveSliceStart(index: number, time: number): void
}

const EDGE_GRAB_PX = 6
const FLAG_W = 18
const FLAG_H = 16

/** LCD waveform: beatgrid, chop regions with numbered flags, transient ticks, playhead. */
export function Waveform({ analysis, slices, selected, view, playhead, showOnsets, single, onSeek, onSelect, onMoveSliceStart }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<number | null>(null)
  const widthRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const draw = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      // Device pixels per layout pixel, including any CSS zoom on the page.
      const dpr = (window.devicePixelRatio || 1) * (canvas.getBoundingClientRect().width / w || 1)
      widthRef.current = w
      const cw = Math.round(w * dpr)
      const ch = Math.round(h * dpr)
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw
        canvas.height = ch
      }
      const g = canvas.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const lcd = getComputedStyle(canvas).getPropertyValue('--lcd').trim() || '#FFB547'
      drawLcd(g, w, h, lcd, { analysis, slices, selected, view, playhead, showOnsets, single })
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [analysis, slices, selected, view, playhead, showOnsets, single])

  const span = view.end - view.start
  const timeAt = (clientX: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return view.start + ((clientX - rect.left) / rect.width) * span
  }
  const xOf = (t: number) => ((t - view.start) / span) * widthRef.current
  /** Pointer x in layout pixels (the page may be zoomed). */
  const xAt = (canvas: HTMLCanvasElement, clientX: number) => {
    const rect = canvas.getBoundingClientRect()
    return ((clientX - rect.left) / rect.width) * widthRef.current
  }
  const edgeNear = (x: number) => (single ? -1 : slices.findIndex((s) => s && Math.abs(xOf(s.start) - x) <= EDGE_GRAB_PX))

  return (
    <canvas
      ref={canvasRef}
      className="waveform"
      aria-label="Waveform. Click to move the playhead; drag a marker to move a pad's start."
      onPointerDown={(e) => {
        const x = xAt(e.currentTarget, e.clientX)
        const edge = edgeNear(x)
        if (edge >= 0) {
          dragRef.current = edge
          e.currentTarget.setPointerCapture(e.pointerId)
          onSelect(edge)
          return
        }
        const t = timeAt(e.clientX)
        const inside = single ? -1 : slices.findIndex((s) => s && t >= s.start && t < s.end)
        if (inside >= 0) onSelect(inside)
        onSeek(t)
      }}
      onPointerMove={(e) => {
        if (dragRef.current !== null) {
          onMoveSliceStart(dragRef.current, Math.max(0, Math.min(analysis.duration, timeAt(e.clientX))))
          return
        }
        const x = xAt(e.currentTarget, e.clientX)
        e.currentTarget.style.cursor = edgeNear(x) >= 0 ? 'ew-resize' : 'crosshair'
      }}
      onPointerUp={() => { dragRef.current = null }}
    />
  )
}

interface DrawState {
  analysis: AnalysisResult
  slices: PadSlots
  selected: number
  view: { start: number; end: number }
  playhead: number
  showOnsets: boolean
  single: boolean
}

function drawLcd(g: CanvasRenderingContext2D, w: number, h: number, lcd: string, s: DrawState) {
  const { analysis: a, view } = s
  const span = view.end - view.start
  const xOf = (t: number) => ((t - view.start) / span) * w
  g.clearRect(0, 0, w, h)
  g.font = '10px "IBM Plex Mono", ui-monospace, monospace'
  g.textBaseline = 'top'

  // Beatgrid: bars always, single beats once there is room for them.
  const { beats, downbeatIndex } = a.tempo
  const beatPx = beats.length > 1 ? ((beats[1] - beats[0]) / span) * w : 0
  g.fillStyle = lcd
  for (let i = 0; i < beats.length; i++) {
    const x = Math.round(xOf(beats[i]))
    if (x < 0 || x > w) continue
    const bar = ((((i - downbeatIndex) % 4) + 4) % 4) === 0
    if (!bar && beatPx < 14) continue
    g.globalAlpha = bar ? 0.2 : 0.08
    g.fillRect(x, 0, 1, h)
    if (bar && i >= downbeatIndex) {
      g.globalAlpha = 0.55
      g.fillText(String((i - downbeatIndex) / 4 + 1), x + 4, 3)
    }
  }
  g.globalAlpha = 1

  // Chop regions.
  const first = s.slices.find((r) => r !== null)
  const regions = s.single
    ? first ? [{ i: s.selected, start: first.start, end: first.end, label: '1–16' }] : []
    : s.slices.flatMap((r, i) => (r ? [{ i, start: r.start, end: r.end, label: String(i + 1) }] : []))
  for (const r of regions) {
    const x0 = xOf(r.start)
    const x1 = xOf(r.end)
    if (x1 < 0 || x0 > w) continue
    g.fillStyle = PAD_COLORS[r.i]
    g.globalAlpha = r.i === s.selected ? 0.28 : 0.12
    g.fillRect(x0, 0, x1 - x0, h)
    g.globalAlpha = 1
    if (x0 >= 0) g.fillRect(Math.round(x0), 0, 2, h)
  }

  // Waveform body.
  const top = 22
  const bottom = h - 28
  const mid = (top + bottom) / 2
  const amp = (bottom - top) / 2
  g.fillStyle = lcd
  const pps = a.peaksPerSecond
  for (let x = 0; x < w; x++) {
    const t0 = view.start + (x / w) * span
    const t1 = view.start + ((x + 1) / w) * span
    const i0 = Math.max(0, Math.floor(t0 * pps))
    const i1 = Math.min(a.peaks.length, Math.max(i0 + 1, Math.ceil(t1 * pps)))
    let p = 0
    for (let i = i0; i < i1; i++) p = Math.max(p, a.peaks[i])
    const ph = Math.max(0.5, p * amp)
    g.fillRect(x, mid - ph, 1, ph * 2)
  }

  // Transient ticks under the top edge.
  if (s.showOnsets) {
    g.globalAlpha = 0.6
    for (const o of a.onsets) {
      const x = xOf(o.time)
      if (x >= 0 && x <= w) g.fillRect(Math.round(x), 18, 1.5, 7)
    }
    g.globalAlpha = 1
  }

  // Numbered flags along the bottom, stacked so neighbours don't collide.
  const rowsEnd: number[] = []
  g.font = '600 10px "IBM Plex Mono", ui-monospace, monospace'
  g.textBaseline = 'middle'
  g.textAlign = 'center'
  for (const r of [...regions].sort((p, q) => p.start - q.start)) {
    const x = xOf(r.start)
    if (x < 0 || x > w) continue
    const fw = Math.max(FLAG_W, g.measureText(r.label).width + 8)
    let row = 0
    while (rowsEnd[row] !== undefined && rowsEnd[row] > x && row < 3) row++
    rowsEnd[row] = x + fw + 4
    const y = h - 4 - FLAG_H - row * 19
    g.fillStyle = PAD_COLORS[r.i]
    g.fillRect(x, y, fw, FLAG_H)
    if (r.i === s.selected) {
      g.strokeStyle = '#F2EFE8'
      g.lineWidth = 2
      g.strokeRect(x - 1, y - 1, fw + 2, FLAG_H + 2)
    }
    g.fillStyle = '#0F1310'
    g.fillText(r.label, x + fw / 2, y + FLAG_H / 2 + 0.5)
  }
  g.textAlign = 'start'

  const px = xOf(s.playhead)
  if (px >= 0 && px <= w) {
    g.fillStyle = '#F2EFE8'
    g.fillRect(Math.round(px), 0, 2, h)
  }
}
