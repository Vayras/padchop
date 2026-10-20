import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { runAnalysis } from './analysis/client'
import { AudioEngine, DEFAULT_ENVELOPE, toMono, type Envelope, type Voice } from './audio/engine'
import { playChop, prepareChop, requireBuffer } from './audio/playChop'
import { RenderCache } from './audio/renderCache'
import { Sequencer as Clock } from './audio/sequencer'
import { Header } from './components/Header'
import { Overview } from './components/Overview'
import { KnobPanel, ModeStrip, PadPanel, type PadView } from './components/Panels'
import { LcdEnvelope, LcdMixer, LcdSequence, LcdTempo, Screen, type Page, type SoftKey } from './components/Screen'
import { Waveform } from './components/Waveform'
import { autoChop, BEAT_STEPS, initialChop, type ChopMode, type ChopSettings } from './dsp/chop'
import { parseNameHints } from './dsp/hints'
import type { AnalysisResult } from './dsp/types'
import { inPlugin, native, onNative, type Tick } from './host/juce'
import { camelot, dbLabel, formatTime, gainDb, hzLabel, keyLabel, noteName, panLabel, secondsLabel, semitoneLabel, shortName } from './format'
import {
  inScale, keyMatchShift, makeTrack, MAX_TRACKS, resizeLane, SLOT_NAMES, TRACK_COLORS,
  type Pattern, type Step, type Track,
} from './model/project'
import { keyboardSemitone, makeSlice, PAD_COLORS, PAD_COUNT, PAD_KEYS, type Slice } from './model/slices'

const ANALYSIS_RATE = 22050
const DEFAULT_PATTERN: Pattern = { bars: 2, stepsPerBar: 8, lanes: {} }
// Rough share of total analysis time reached when each stage starts.
const STAGE_PROGRESS: Record<string, number> = {
  Decoding: 5,
  Preparing: 15,
  'Finding transients': 25,
  'Detecting tempo': 40,
  'Detecting key': 75,
  'Finding sample regions': 90,
}

// Dev-only autoload guard (StrictMode runs mount effects twice).
let devLoaded = false

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null)
  const engine = useCallback(() => (engineRef.current ??= new AudioEngine()), [])
  const [stretching, setStretching] = useState(false)
  const cacheRef = useRef<RenderCache | null>(null)
  const cache = useCallback(() => (cacheRef.current ??= new RenderCache(engine().ctx, setStretching)), [engine])

  const [tracks, setTracks] = useState<Track[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [anchorId, setAnchorId] = useState<string | null>(null)
  const [keyShift, setKeyShift] = useState(0)
  const [bpmOverride, setBpmOverride] = useState<number | null>(null)
  const [pattern, setPattern] = useState<Pattern>(DEFAULT_PATTERN)
  const [brushes, setBrushes] = useState<Record<string, Step>>({})
  const [page, setPage] = useState<Page>('chop')
  const [status, setStatus] = useState<{ stage: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playingPads, setPlayingPads] = useState<Set<number>>(new Set())
  const [playhead, setPlayhead] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [seqPlaying, setSeqPlaying] = useState(false)
  const [clockStep, setClockStep] = useState(-1)
  const [showOnsets, setShowOnsets] = useState(true)
  const [taps, setTaps] = useState<number[]>([])
  const [seqView, setSeqView] = useState(0)
  const [dropping, setDropping] = useState(false)
  // Plugin only: host tempo (0 = none), the latest engine tick, active-pad bitmask.
  const [hostBpm, setHostBpm] = useState(0)
  const [padMask, setPadMask] = useState(0)
  const tickRef = useRef<Tick | null>(null)
  const restoredRef = useRef(!inPlugin)
  const voiceRef = useRef<Voice | null>(null)
  const clockRef = useRef<Clock | null>(null)

  const active = tracks.find((t) => t.id === activeId) ?? tracks[0]
  const activeIndex = active ? tracks.indexOf(active) : -1
  const anchor = tracks.find((t) => t.id === anchorId) ?? tracks[0]
  const bpm = hostBpm > 0 ? hostBpm : (bpmOverride ?? anchor?.analysis.tempo.bpm ?? 120)
  const anchorKey = anchor?.analysis.key
  const songKey = useMemo(
    () => (anchorKey ? { ...anchorKey, tonic: (anchorKey.tonic + keyShift + 1200) % 12 } : null),
    [anchorKey, keyShift],
  )

  /** Semitones that put a track in the anchor's key. */
  const shiftOf = useCallback(
    (t: Track) => (!anchor || t.id === anchor.id || !t.matchKey ? 0 : keyMatchShift(t.analysis.key, anchor.analysis.key)),
    [anchor],
  )

  const updateTrack = useCallback((id: string, patch: Partial<Track> | ((t: Track) => Partial<Track>)) => {
    setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  }, [])

  // ---------- Loading ----------
  const addTrack = useCallback(
    async (file: File) => {
      if (tracks.length >= MAX_TRACKS) return
      const name = file.name.replace(/\.[^.]+$/, '')
      setError(null)
      try {
        setStatus({ stage: 'Decoding', name })
        const eng = engine()
        // Don't await: resume stays pending until a user gesture, and decoding doesn't need it.
        void eng.resume()
        const buffer = await eng.decode(file)
        setStatus({ stage: 'Preparing', name })
        const mono = await toMono(buffer, ANALYSIS_RATE)
        const analysis = await runAnalysis(mono, ANALYSIS_RATE, (stage) => setStatus({ stage, name }), parseNameHints(file.name))
        const chop = initialChop(analysis)
        const track = makeTrack(name, buffer, analysis, autoChop(analysis, chop), chop)
        setTracks((ts) => (ts.length >= MAX_TRACKS ? ts : [...ts, track]))
        setActiveId(track.id)
        setAnchorId((a) => a ?? track.id)
        setPage('chop')
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setStatus(null)
      }
    },
    [engine, tracks.length],
  )

  // Plugin: the native side picks, decodes and analyses the file.
  /** A track the plugin decoded and analysed (from ADD SAMPLE or a file dropped on the window). */
  const adoptNativeTrack = useCallback((t: NativeTrack) => {
    setStatus(null)
    const analysis = analysisFromNative(t.analysis)
    const chop = initialChop(analysis)
    const track = makeTrack(t.name, null, analysis, autoChop(analysis, chop), chop, t.id)
    setTracks((ts) => (ts.length >= MAX_TRACKS ? ts : [...ts, track]))
    setActiveId(track.id)
    setAnchorId((a) => a ?? track.id)
    setPage('chop')
  }, [])

  const addNativeTrack = useCallback(async () => {
    if (tracks.length >= MAX_TRACKS) return
    setError(null)
    const t = await native<NativeTrack | null>('openFile')
    setStatus(null)
    if (t) adoptNativeTrack(t)
  }, [tracks.length, adoptNativeTrack])

  // Dev only: ?load=<url> loads a sample on start (for testing layouts in frames).
  useEffect(() => {
    if (!import.meta.env.DEV || devLoaded) return
    const url = new URLSearchParams(location.search).get('load')
    if (!url) return
    devLoaded = true
    void fetch(url)
      .then((r) => r.blob())
      .then((b) => addTrack(new File([b], url.split('/').pop() ?? 'sample.wav')))
    // Only on first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopSequence = useCallback(() => {
    clockRef.current?.stop()
    engineRef.current?.stopAll()
    setSeqPlaying(false)
  }, [])

  const removeTrack = (id: string) => {
    const rest = tracks.filter((t) => t.id !== id)
    if (inPlugin) void native('removeTrack', id)
    else {
      engine().stopAll()
      engine().removeBus(id)
      cacheRef.current?.dropTrack(id)
    }
    setTracks(rest)
    if (activeId === id || !activeId) setActiveId(rest[0]?.id ?? null)
    if (anchor?.id === id) { setAnchorId(rest[0]?.id ?? null); setBpmOverride(null) }
    setPattern((p) => {
      const lanes = { ...p.lanes }
      delete lanes[id]
      return { ...p, lanes }
    })
    if (rest.length === 0) { stopSequence(); setPage('chop') }
  }

  // ---------- Mixer ----------
  useEffect(() => {
    if (!engineRef.current) return
    const anySolo = tracks.some((t) => t.solo)
    for (const t of tracks) {
      engineRef.current.setMix(t.id, {
        level: t.gain,
        pan: t.pan,
        lowCut: t.lowCut,
        highCut: t.highCut,
        silent: t.muted || (anySolo && !t.solo),
      })
    }
  }, [tracks])
  const trackIdsRef = useRef<string[]>([])
  useEffect(() => { trackIdsRef.current = tracks.map((t) => t.id) })
  const meterOf = useCallback(
    (id: string) => (inPlugin ? tickRef.current?.meters[trackIdsRef.current.indexOf(id)] ?? 0 : engineRef.current?.meter(id) ?? 0),
    [],
  )

  // ---------- Time-stretch renders ----------
  // Pre-render every chop that can be played (active track first) once knob drags settle.
  useEffect(() => {
    if (!engineRef.current || tracks.length === 0) return
    const timer = setTimeout(() => {
      const c = cache()
      const ordered = [...tracks].sort((a, b) => Number(b.id === activeId) - Number(a.id === activeId))
      for (const t of ordered) {
        const shift = shiftOf(t) + keyShift
        const sel = t.slices[t.selected]
        if (t.keyboard && sel) {
          for (let i = 0; i < PAD_COUNT; i++) prepareChop(c, t, sel.start, sel.end, sel.semitones + keyboardSemitone(i, t.octave) + shift, bpm)
        }
        for (const s of t.slices) if (s) prepareChop(c, t, s.start, s.end, s.semitones + shift, bpm)
        for (const step of pattern.lanes[t.id] ?? []) {
          const s = step && t.slices[step.pad]
          if (step?.note && s) prepareChop(c, t, s.start, s.end, s.semitones + step.semitones + shift, bpm)
        }
      }
    }, 150)
    return () => clearTimeout(timer)
  }, [tracks, activeId, pattern, bpm, keyShift, shiftOf, cache])

  // ---------- Playback ----------
  const startVoice = useCallback(
    (t: Track, slice: Pick<Slice, 'start' | 'end' | 'semitones' | 'gain'> & { env?: Slice['env'] }, semis: number, channel: string, pad?: number, preview = false) => {
      const eng = engine()
      void eng.resume()
      if (pad !== undefined) setPlayingPads((p) => new Set(p).add(pad))
      const onEnded = () => {
        if (pad !== undefined) setPlayingPads((p) => { const n = new Set(p); n.delete(pad); return n })
        if (voiceRef.current === voice) { voiceRef.current = null; setPlayhead(null); setPreviewing(false) }
      }
      const semitones = slice.semitones + semis + shiftOf(t) + keyShift
      const voice: Voice = preview
        ? eng.play(requireBuffer(t), channel, { start: slice.start, end: slice.end, semitones, gain: slice.gain, bus: t.id, onEnded })
        : playChop(eng, cache(), { track: t, start: slice.start, end: slice.end, semitones, gain: slice.gain, envelope: slice.env, channel, projectBpm: bpm, onEnded })
      voiceRef.current = voice
      setPreviewing(preview)
    },
    [engine, cache, shiftOf, keyShift, bpm],
  )

  const triggerPad = useCallback(
    (i: number) => {
      if (!active) return
      if (active.keyboard) {
        const slice = active.slices[active.selected]
        if (!slice) return
        const semis = keyboardSemitone(i, active.octave)
        setBrushes((b) => ({ ...b, [active.id]: { pad: active.selected, semitones: semis, note: true } }))
        if (inPlugin) void native('triggerPad', activeIndex, i)
        else startVoice(active, slice, semis, `${active.id}:kb:${i}`, i)
      } else {
        const slice = active.slices[i]
        if (!slice) { updateTrack(active.id, { selected: i }); return }
        updateTrack(active.id, { selected: i })
        setBrushes((b) => ({ ...b, [active.id]: { pad: i, semitones: 0, note: false } }))
        if (inPlugin) void native('triggerPad', activeIndex, i)
        else startVoice(active, slice, 0, `${active.id}:pads`, i)
      }
    },
    [active, activeIndex, startVoice, updateTrack],
  )

  const togglePreview = useCallback(() => {
    if (!active) return
    if (inPlugin) {
      void (previewing ? native('stopAll') : native('preview', activeIndex, active.cursor))
      return
    }
    if (voiceRef.current && previewing) { voiceRef.current.stop(); return }
    startVoice(active, { start: active.cursor, end: active.analysis.duration, semitones: 0, gain: 1 }, 0, `${active.id}:pads`, undefined, true)
  }, [active, activeIndex, startVoice, previewing])

  // Playhead animation for the most recent voice.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      if (voiceRef.current) setPlayhead(voiceRef.current.position())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---------- Plugin bridge ----------
  // The native engine plays everything; the UI streams it the project and
  // takes meters, steps, the playhead and pad lights from its 30 Hz tick.
  const activeIndexRef = useRef(activeIndex)
  useEffect(() => { activeIndexRef.current = activeIndex })
  useEffect(() => {
    if (!inPlugin) return
    const offTick = onNative<Tick>('tick', (t) => {
      tickRef.current = t
      setClockStep(t.step)
      setSeqPlaying(t.seqPlaying)
      setPreviewing(t.previewing)
      setHostBpm(t.hostBpm)
      setStretching(t.stretching)
      setPlayhead(t.playheadTrack === activeIndexRef.current && t.playheadTime >= 0 ? t.playheadTime : null)
      setPadMask(t.pads[activeIndexRef.current] ?? 0)
    })
    const offLoading = onNative<string>('loading', (name) => setStatus({ stage: 'Analysing', name }))
    const offError = onNative<string>('loadError', (message) => { setStatus(null); setError(message) })
    const offAdded = onNative<NativeTrack>('trackAdded', adoptNativeTrack)
    const offDragging = onNative<boolean>('dragging', setDropping)
    const restore = (data: NativeRestore) => {
      const saved = data.project?.tracks ?? []
      const loaded = new Map(data.tracks.map((t) => [t.id, t]))
      // Wait until every saved track has finished loading before taking over.
      if (saved.some((t) => !loaded.has(t.id))) return
      const entries: (Partial<Track> & { id: string })[] = saved.length ? saved : data.tracks.map((t) => ({ id: t.id }))
      const rebuilt = entries.flatMap((st) => {
        const nt = loaded.get(st.id)
        if (!nt) return []
        const analysis = analysisFromNative(nt.analysis)
        const chop = st.chop ?? initialChop(analysis)
        const base = makeTrack(nt.name, null, analysis, autoChop(analysis, chop), chop, nt.id)
        return [{ ...base, ...st, id: nt.id, name: nt.name, buffer: null, analysis }]
      })
      setTracks(rebuilt)
      setActiveId(rebuilt[0]?.id ?? null)
      setAnchorId(data.project?.anchorId ?? rebuilt[0]?.id ?? null)
      setBpmOverride(data.project?.bpmOverride ?? null)
      setKeyShift(data.project?.keyShift ?? 0)
      if (data.project?.pattern) setPattern(data.project.pattern)
      restoredRef.current = true
    }
    const offRestore = onNative<NativeRestore>('restore', restore)
    void native<NativeRestore>('uiReady').then(restore)
    return () => { offTick(); offLoading(); offError(); offAdded(); offDragging(); offRestore() }
  }, [adoptNativeTrack])

  useEffect(() => {
    if (!inPlugin || !restoredRef.current) return
    const project = {
      tracks: tracks.map(({ buffer: _buffer, analysis: _analysis, ...rest }) => rest),
      anchorId: anchor?.id ?? null,
      bpmOverride,
      keyShift,
      pattern,
    }
    const timer = setTimeout(() => void native('setProject', JSON.stringify(project)), 30)
    return () => clearTimeout(timer)
  }, [tracks, anchor, bpmOverride, keyShift, pattern])

  // ---------- Sequencer ----------
  // The clock reads the latest state through a ref so edits apply while playing.
  const live = useRef({ tracks, pattern, bpm, keyShift, shiftOf })
  useEffect(() => { live.current = { tracks, pattern, bpm, keyShift, shiftOf } })

  const toggleSequence = useCallback(() => {
    if (inPlugin) {
      void native('setSequencePlaying', !seqPlaying)
      return
    }
    const eng = engine()
    void eng.resume()
    clockRef.current ??= new Clock(eng.ctx, {
      timing: () => {
        const { pattern, bpm } = live.current
        return { bpm, stepsPerBar: pattern.stepsPerBar, totalSteps: pattern.bars * pattern.stepsPerBar }
      },
      fire: (step, when) => {
        const { tracks, pattern, keyShift, shiftOf } = live.current
        for (const t of tracks) {
          const s = pattern.lanes[t.id]?.[step]
          const slice = s && t.slices[s.pad]
          if (!s || !slice) continue
          // Chops choke each other per track; keyboard notes ring per pitch.
          const channel = s.note ? `${t.id}:seq:${s.semitones}` : `${t.id}:pads`
          playChop(eng, cache(), {
            track: t,
            start: slice.start,
            end: slice.end,
            semitones: slice.semitones + s.semitones + shiftOf(t) + keyShift,
            gain: slice.gain,
            envelope: slice.env,
            channel,
            projectBpm: live.current.bpm,
            when,
          })
        }
      },
    })
    if (clockRef.current.playing) stopSequence()
    else { clockRef.current.start(); setSeqPlaying(true) }
  }, [engine, cache, stopSequence, seqPlaying])

  useEffect(() => {
    if (!seqPlaying) return
    let raf = 0
    const tick = () => { setClockStep(clockRef.current?.currentStep() ?? -1); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [seqPlaying])

  const changePattern = useCallback((next: Pattern) => {
    setPattern((p) => {
      const total = next.bars * next.stepsPerBar
      const lanes: Pattern['lanes'] = {}
      for (const [id, lane] of Object.entries(p.lanes)) {
        // Keep each step at the same musical position when the grid resolution changes.
        const remapped: (Step | null)[] = new Array(total).fill(null)
        lane.forEach((s, i) => {
          if (!s) return
          const pos = (i * next.stepsPerBar) / p.stepsPerBar
          if (Number.isInteger(pos) && pos < total) remapped[pos] = s
        })
        lanes[id] = remapped
      }
      return { ...next, lanes }
    })
  }, [])
  const setStep = (trackId: string, index: number, step: Step | null) => {
    setPattern((p) => {
      const lane = resizeLane(p.lanes[trackId], p.bars * p.stepsPerBar)
      lane[index] = step
      return { ...p, lanes: { ...p.lanes, [trackId]: lane } }
    })
  }
  const clearSequence = () => setPattern((p) => ({ ...p, lanes: {} }))

  // ---------- Tempo ----------
  const setBpm = (v: number) => setBpmOverride(Math.round(Math.min(250, Math.max(40, v)) * 100) / 100)
  const tap = () => {
    const now = performance.now()
    const recent = [...taps.filter((t) => now - t < 2500), now].slice(-8)
    setTaps(recent)
    if (recent.length >= 4) setBpm(((recent.length - 1) * 60000) / (recent[recent.length - 1] - recent[0]))
  }

  // ---------- Editing ----------
  const setSliceAtCursor = useCallback(() => {
    if (!active) return
    updateTrack(active.id, (t) => {
      const slices = [...t.slices]
      const later = t.slices.flatMap((s) => (s && s.start > t.cursor ? [s.start] : []))
      const end = later.length ? Math.min(...later) : t.analysis.duration
      slices[t.selected] = { ...makeSlice(t.cursor, end), semitones: t.slices[t.selected]?.semitones ?? 0 }
      return { slices }
    })
  }, [active, updateTrack])

  /** Empty a pad (its slot stays) and drop its steps from the sequence. */
  const deletePad = useCallback(
    (trackId: string, pad: number) => {
      updateTrack(trackId, (t) => ({
        slices: t.slices.map((s, j) => (j === pad ? null : s)),
        keyboard: t.selected === pad ? false : t.keyboard,
      }))
      setPattern((p) => {
        const lane = p.lanes[trackId]
        if (!lane) return p
        return { ...p, lanes: { ...p.lanes, [trackId]: lane.map((s) => (s?.pad === pad ? null : s)) } }
      })
      engineRef.current?.stopChannel(`${trackId}:pads`)
    },
    [updateTrack],
  )

  const chop = (patch: Partial<ChopSettings>) => {
    if (!active) return
    updateTrack(active.id, (t) => {
      const next = { ...t.chop, ...patch }
      return { chop: next, slices: autoChop(t.analysis, next, t.cursor), keyboard: false }
    })
  }

  const updateEnvelope = (patch: Partial<Envelope>, allPads = false) => {
    if (!active) return
    updateTrack(active.id, (t) => {
      const base = t.slices[t.selected]?.env
      return {
        slices: t.slices.map((s, j) => {
          if (!s) return s
          if (allPads && base) return { ...s, env: { ...base, ...patch } }
          return j === t.selected ? { ...s, env: { ...s.env, ...patch } } : s
        }),
      }
    })
  }

  /** Step the selection through the pads that hold a chop. */
  const selectPadOffset = (d: number) => {
    if (!active) return
    const filled = active.slices.flatMap((s, i) => (s ? [i] : []))
    if (!filled.length) return
    const at = filled.indexOf(active.selected)
    const next = filled[((at < 0 ? 0 : at + d) % filled.length + filled.length) % filled.length]
    updateTrack(active.id, { selected: next, keyboard: false })
  }

  const toggleKeyboard = useCallback(() => {
    if (!active || !active.slices[active.selected]) return
    updateTrack(active.id, (t) => ({ keyboard: !t.keyboard }))
  }, [active, updateTrack])

  const zoom = (factor: number | 'fit') => {
    if (!active) return
    const dur = active.analysis.duration
    updateTrack(active.id, (t) => {
      if (factor === 'fit') return { view: { start: 0, end: dur } }
      const span = Math.min(dur, Math.max(0.25, (t.view.end - t.view.start) * factor))
      const centre = t.cursor
      const start = Math.max(0, Math.min(dur - span, centre - span / 2))
      return { view: { start, end: start + span } }
    })
  }

  const selectTrackOffset = (d: number) => {
    if (!tracks.length || activeIndex < 0) return
    setActiveId(tracks[(activeIndex + d + tracks.length) % tracks.length].id)
  }

  // ---------- Computer keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTextEntry(e.target)) return
      const k = e.key.toLowerCase()
      const pad = PAD_KEYS.indexOf(k)
      const handled = pad >= 0 || [' ', 'enter', 'k', '-', '=', 'backspace', 'delete'].includes(k)
      if (!handled || !active) return
      // Keys and knobs keep focus after use; don't let them swallow pad keys
      // (or let Space/Enter re-press the focused key).
      if (e.target instanceof HTMLElement && e.target !== document.body) e.target.blur()
      e.preventDefault()
      if (pad >= 0) triggerPad(pad)
      else if (k === ' ') (e.shiftKey ? toggleSequence : togglePreview)()
      else if (k === 'enter') setSliceAtCursor()
      else if (k === 'k') toggleKeyboard()
      else if (k === 'backspace' || k === 'delete') deletePad(active.id, active.selected)
      else if (active.keyboard) updateTrack(active.id, (t) => ({ octave: Math.max(-2, Math.min(2, t.octave + (k === '=' ? 1 : -1))) }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, triggerPad, togglePreview, toggleSequence, setSliceAtCursor, toggleKeyboard, updateTrack, deletePad])

  // ---------- Derived view data ----------
  const loaded = !!active
  const seqStep = seqPlaying ? clockStep : -1
  const sel = active?.slices[active.selected] ?? null
  const selN = String((active?.selected ?? 0) + 1).padStart(2, '0')
  const total = pattern.bars * pattern.stepsPerBar
  const span = active ? active.view.end - active.view.start : 1
  const zoomFactor = active ? Math.round(active.analysis.duration / span) : 1
  const playheadAt = playhead ?? active?.cursor ?? 0

  const pads: PadView[] = Array.from({ length: PAD_COUNT }, (_, i) => {
    if (active?.keyboard && songKey) {
      const semis = keyboardSemitone(i, active.octave)
      const pc = songKey.tonic + semis
      return { lit: true, color: PAD_COLORS[active.selected], sub: `${noteName(pc)} ${semis > 0 ? '+' : ''}${semis}`, dim: !inScale(pc, songKey) }
    }
    const s = active?.slices[i]
    return {
      lit: !!s,
      color: PAD_COLORS[i],
      sub: !s ? '' : active?.chop.mode === 'keys' ? semitoneLabel(s.semitones).toLowerCase() : formatTime(s.start),
      dim: false,
    }
  })

  const mode = active?.chop.mode ?? 'find'
  const filled = active?.slices.filter(Boolean).length ?? 0
  const stepIndex = BEAT_STEPS.findIndex((b) => b.beats === active?.chop.beatStep)
  const modeText: Record<ChopMode, string> = {
    find: `FIND · ${filled}/16 PADS`,
    slicer: `SLICE · DIV ${BEAT_STEPS[stepIndex]?.label ?? '1'} ${active?.chop.beatStep === 1 ? 'BEAT' : 'BEATS'}`,
    random: `RANDOM · ${filled} HITS`,
    transients: `TRANSIENT · GAP ${Math.round((active?.chop.minGap ?? 0) * 1000)}MS`,
    keys: 'KEY SHIFT · −7…+8 ST',
  }
  const modeLabel = !loaded
    ? status ? 'ANALYSING' : 'STANDBY'
    : page === 'seq' ? `SEQ · ${pattern.bars} ${pattern.bars === 1 ? 'BAR' : 'BARS'} · 1/${pattern.stepsPerBar}`
    : page === 'tempo' ? 'TEMPO & KEY'
    : page === 'mix' ? `MIX · ${tracks.length} ${tracks.length === 1 ? 'TRACK' : 'TRACKS'}`
    : page === 'amp' ? 'AMP ENVELOPE'
    : modeText[mode] + (zoomFactor > 1 ? ` · ${zoomFactor}×` : '')

  const audition: SoftKey = { label: 'AUDITION', act: sel ? () => triggerPad(active!.selected) : undefined }
  const fromCursor: SoftKey = { label: 'FROM CUR', act: () => chop({}) }
  const blank: SoftKey = { label: '' }
  const chopKeys: Record<ChopMode, SoftKey[]> = {
    find: [{ label: 'SHUFFLE', act: () => chop({ seed: (active?.chop.seed ?? 1) + 1 }) }, blank, blank, blank, blank, audition],
    slicer: [
      { label: 'DIV −', act: stepIndex > 0 ? () => chop({ beatStep: BEAT_STEPS[stepIndex - 1].beats }) : undefined },
      { label: 'DIV +', act: stepIndex < BEAT_STEPS.length - 1 ? () => chop({ beatStep: BEAT_STEPS[stepIndex + 1].beats }) : undefined },
      { label: '◂ SHIFT', act: () => chop({ offset: (active?.chop.offset ?? 0) - 1 }) },
      { label: 'SHIFT ▸', act: () => chop({ offset: (active?.chop.offset ?? 0) + 1 }) },
      fromCursor,
      audition,
    ],
    random: [{ label: 'RE-ROLL', act: () => chop({ seed: (active?.chop.seed ?? 1) + 1 }) }, blank, blank, blank, blank, audition],
    transients: [
      { label: 'GAP −', act: () => chop({ minGap: Math.max(0.05, (active?.chop.minGap ?? 0.25) - 0.05) }) },
      { label: 'GAP +', act: () => chop({ minGap: Math.min(1, (active?.chop.minGap ?? 0.25) + 0.05) }) },
      blank, blank, blank, audition,
    ],
    keys: [fromCursor, blank, blank, blank, blank, audition],
  }
  const softkeys: SoftKey[] = !loaded
    ? []
    : page === 'seq'
      ? [
          { label: 'BARS −', act: pattern.bars > 1 ? () => changePattern({ ...pattern, bars: pattern.bars / 2 }) : undefined },
          { label: 'BARS +', act: pattern.bars < 8 ? () => changePattern({ ...pattern, bars: pattern.bars * 2 }) : undefined },
          { label: 'GRID', act: () => changePattern({ ...pattern, stepsPerBar: pattern.stepsPerBar === 16 ? 4 : pattern.stepsPerBar * 2 }) },
          { label: 'CLEAR', act: clearSequence },
          { label: '◂ TRACK', act: tracks.length > 1 ? () => selectTrackOffset(-1) : undefined },
          { label: 'TRACK ▸', act: tracks.length > 1 ? () => selectTrackOffset(1) : undefined },
        ]
      : page === 'tempo'
        ? [
            { label: '÷2', act: () => setBpm(bpm / 2) },
            { label: '×2', act: () => setBpm(bpm * 2) },
            { label: 'TAP', act: tap },
            { label: 'KEY −', act: () => setKeyShift((k) => Math.max(-12, k - 1)) },
            { label: 'KEY +', act: () => setKeyShift((k) => Math.min(12, k + 1)) },
            { label: 'BACK', act: () => setPage('chop') },
          ]
        : page === 'amp'
          ? [
              { label: '◂ PAD', act: () => selectPadOffset(-1) },
              { label: 'PAD ▸', act: () => selectPadOffset(1) },
              { label: 'ALL PADS', act: sel ? () => updateEnvelope({}, true) : undefined },
              { label: 'RESET', act: sel ? () => updateEnvelope({ ...DEFAULT_ENVELOPE }) : undefined },
              audition,
              { label: 'BACK', act: () => setPage('chop') },
            ]
        : page === 'mix'
          ? [
              { label: '◂ TRACK', act: tracks.length > 1 ? () => selectTrackOffset(-1) : undefined },
              { label: 'TRACK ▸', act: tracks.length > 1 ? () => selectTrackOffset(1) : undefined },
              { label: 'MUTE', act: () => updateTrack(active!.id, (t) => ({ muted: !t.muted })) },
              { label: 'SOLO', act: () => updateTrack(active!.id, (t) => ({ solo: !t.solo })) },
              { label: 'RESET', act: () => updateTrack(active!.id, { gain: 1, pan: 0, lowCut: 20, highCut: 20000, muted: false, solo: false }) },
              { label: 'BACK', act: () => setPage('chop') },
            ]
          : chopKeys[mode]

  const accent = PAD_COLORS[active?.selected ?? 0]
  let info: React.ReactNode = <span style={{ opacity: 0.85 }}>PADS 0/16</span>
  let timeText = status ? '— / —' : '— / —'
  if (loaded && page === 'chop') {
    timeText = `${formatTime(playheadAt)} / ${formatTime(active.analysis.duration)}`
    info = sel ? (
      <span className="lcd__info-left">
        <span className="lcd__pad" style={{ background: accent }}>PAD {selN}</span>
        <span>START {formatTime(sel.start)}</span>
        <span className="wide-only">LEN {(sel.end - sel.start).toFixed(2)}S · {(((sel.end - sel.start) * bpm) / 60).toFixed(1)} BT</span>
        <span>PITCH {semitoneLabel(sel.semitones)}</span>
        <span className="wide-only">GAIN {gainDb(sel.gain).toUpperCase()}</span>
      </span>
    ) : (
      <span className="lcd__info-left">
        <span className="lcd__pad lcd__pad--empty">PAD {selN} · EMPTY</span>
        <span>MOVE PLAYHEAD, PRESS ↵ TO SET IT</span>
      </span>
    )
  } else if (loaded && page === 'seq') {
    const brush = brushes[active.id]
    info = <span style={{ opacity: 0.85 }}>{SLOT_NAMES[activeIndex]} · {brush?.note && songKey ? `NOTE ${noteName(songKey.tonic + brush.semitones)}` : `PAD ${String((brush?.pad ?? active.selected) + 1).padStart(2, '0')}`} ARMED · PRESS STEPS TO PLACE</span>
    timeText = seqPlaying && seqStep >= 0 ? `BAR ${Math.floor(seqStep / pattern.stepsPerBar) + 1} · STEP ${seqStep + 1}/${total}` : `STOPPED · ${total} STEPS`
  } else if (loaded && page === 'tempo') {
    info = <span style={{ opacity: 0.85 }}>{hostBpm > 0 ? 'TEMPO FOLLOWS THE HOST · SYNCED SAMPLES STRETCH TO IT' : 'TAP 4× TO SET · SYNCED SAMPLES STRETCH TO THIS TEMPO'}</span>
    timeText = stretching ? 'STRETCHING…' : ''
  } else if (loaded && page === 'amp') {
    info = sel ? (
      <span className="lcd__info-left">
        <span className="lcd__pad" style={{ background: accent }}>PAD {selN}</span>
        <span>ALL PADS COPIES THIS SHAPE TO THE TRACK</span>
      </span>
    ) : <span className="lcd__info-left"><span className="lcd__pad lcd__pad--empty">PAD {selN} · EMPTY</span></span>
    timeText = sel ? `LEN ${secondsLabel(sel.end - sel.start).toUpperCase()}` : ''
  } else if (loaded && page === 'mix') {
    info = (
      <span className="lcd__info-left">
        <span>{SLOT_NAMES[activeIndex]} · {dbLabel(active.gain).toUpperCase()}</span>
        <span>PAN {panLabel(active.pan)}</span>
        <span>LC {active.lowCut <= 21 ? 'OFF' : hzLabel(active.lowCut).toUpperCase()}</span>
        <span>HC {active.highCut >= 19999 ? 'OFF' : hzLabel(active.highCut).toUpperCase()}</span>
      </span>
    )
    timeText = stretching ? 'STRETCHING…' : active.muted ? 'MUTED' : active.solo ? 'SOLO' : ''
  }

  const lcdKey = active
    ? `${keyLabel(active.analysis.key)} ${camelot(active.analysis.key.tonic, active.analysis.key.mode)}${active.id === anchor?.id ? ' ⚓' : shiftOf(active) ? ' ' + semitoneLabel(shiftOf(active)) : ''}`
    : '— KEY'

  const progress = status ? STAGE_PROGRESS[status.stage] ?? 50 : 0

  return (
    <div className="desk">
      <div
        className={`chassis ${dropping ? 'is-drop' : ''}`}
        onDragOver={(e) => { if (inPlugin) return; e.preventDefault(); setDropping(true) }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDropping(false) }}
        onDrop={(e) => {
          e.preventDefault()
          setDropping(false)
          const f = e.dataTransfer.files[0]
          if (f) void addTrack(f)
        }}
      >
        <Header
          tracks={tracks}
          active={active?.id ?? null}
          anchor={anchor?.id ?? null}
          shiftOf={shiftOf}
          busy={status !== null}
          onSelect={setActiveId}
          onAdd={addTrack}
          onAddClick={inPlugin ? () => void addNativeTrack() : undefined}
          onRemove={removeTrack}
          onAnchor={(id) => { setAnchorId(id); setBpmOverride(null) }}
          onMute={(id, muted) => updateTrack(id, { muted })}
          onMatchKey={(id, matchKey) => updateTrack(id, { matchKey })}
        />

        <div className="row">
          <div className="col-main">
            <Screen
              fileLabel={
                status && !loaded ? `${SLOT_NAMES[tracks.length]} · ${shortName(status.name, 36)}`
                : !active ? '— NO FILE —'
                : page === 'seq' ? `SEQUENCE · ${bpm.toFixed(1)} BPM`
                : page === 'tempo' ? 'PROJECT'
                : page === 'mix' ? 'MIXER'
                : page === 'amp' ? `${SLOT_NAMES[activeIndex]} · PAD ${selN}`
                : `${SLOT_NAMES[activeIndex]} · ${shortName(active.name, 36)}`
              }
              bpmLabel={page !== 'chop' && active ? '' : active ? `${active.analysis.tempo.bpm.toFixed(1)}${active.sync && Math.abs(bpm - active.analysis.tempo.bpm) > 0.05 ? ` → ${bpm.toFixed(1)}` : ''} BPM` : '---.- BPM'}
              keyLabel={page !== 'chop' && active ? '' : lcdKey}
              modeLabel={modeLabel}
              info={info}
              time={timeText}
              softkeys={softkeys}
              page={page}
              pagesEnabled={loaded}
              onPage={setPage}
            >
              {page === 'chop' && (
                <>
                  {active ? (
                    <>
                      <Overview className="wide-only" analysis={active.analysis} slices={active.slices} view={active.view} onView={(view) => updateTrack(active.id, { view })} />
                      <div className="wave-wrap">
                        <Waveform
                          analysis={active.analysis}
                          slices={active.slices}
                          selected={active.selected}
                          view={active.view}
                          playhead={playheadAt}
                          showOnsets={showOnsets}
                          single={mode === 'keys'}
                          onSeek={(t) => {
                            updateTrack(active.id, { cursor: t })
                            if (previewing && inPlugin) void native('preview', activeIndex, t)
                            else if (previewing) {
                              startVoice(active, { start: t, end: active.analysis.duration, semitones: 0, gain: 1 }, 0, `${active.id}:pads`, undefined, true)
                            }
                          }}
                          onSelect={(i) => updateTrack(active.id, { selected: i })}
                          onMoveSliceStart={(i, t) =>
                            updateTrack(active.id, (tr) => ({ slices: tr.slices.map((s, j) => (j === i && s ? { ...s, start: Math.min(t, s.end - 0.01) } : s)) }))
                          }
                        />
                      </div>
                    </>
                  ) : status ? (
                    <div className="lcd-centre">
                      <div className="lcd-progress">
                        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.08em' }}>ANALYSING SLOT {SLOT_NAMES[tracks.length]}…</span>
                        <span className="lcd-progress__bar"><span style={{ width: `${progress}%` }} /></span>
                        <span className="lcd-progress__row"><span>{status.stage}</span><span>{progress}%</span></span>
                      </div>
                    </div>
                  ) : (
                    <div className="lcd-centre">
                      <span className="lcd-big">NO AUDIO LOADED</span>
                      <span className="lcd-sub">PRESS ADD SAMPLE · OR DROP A FILE ON THE DEVICE</span>
                      {error && <span className="lcd-sub">ERROR: {error}</span>}
                    </div>
                  )}
                </>
              )}
              {page === 'seq' && (
                <LcdSequence
                  tracks={tracks}
                  active={active?.id ?? null}
                  pattern={pattern}
                  step={seqStep}
                  view={seqView}
                  rootPc={songKey?.tonic ?? 0}
                  brushOf={(t) => brushes[t.id] ?? { pad: t.selected, semitones: 0, note: false }}
                  onSelectTrack={setActiveId}
                  onSetStep={setStep}
                  onView={setSeqView}
                />
              )}
              {page === 'amp' && active && (
                <LcdEnvelope env={sel?.env ?? null} length={sel ? sel.end - sel.start : 1} color={accent} />
              )}
              {page === 'mix' && (
                <LcdMixer
                  tracks={tracks}
                  active={active?.id ?? null}
                  meterOf={meterOf}
                  onSelect={setActiveId}
                  onLevel={(id, gain) => updateTrack(id, { gain })}
                  onToggle={(id, field) => updateTrack(id, (t) => ({ [field]: !t[field] }))}
                />
              )}
              {page === 'tempo' && songKey && (
                <LcdTempo
                  bpm={bpm}
                  onBpm={setBpm}
                  taps={Math.min(4, taps.length)}
                  projectKey={`${keyLabel(songKey)} · ${camelot(songKey.tonic, songKey.mode)}`}
                  transpose={semitoneLabel(keyShift)}
                />
              )}
            </Screen>

            <ModeStrip
              mode={mode}
              lit={page === 'chop'}
              enabled={loaded}
              zoomLabel={zoomFactor > 1 ? `${zoomFactor}×` : 'FIT'}
              showOnsets={showOnsets}
              onMode={(m) => { chop({ mode: m }); setPage('chop') }}
              onZoom={zoom}
              onShowOnsets={setShowOnsets}
            />

            <KnobPanel
              env={sel && page === 'amp' ? { value: sel.env, color: accent, onChange: (patch) => updateEnvelope(patch) } : null}
              mix={active && page === 'mix'
                ? {
                    level: active.gain,
                    pan: active.pan,
                    lowCut: active.lowCut,
                    highCut: active.highCut,
                    color: TRACK_COLORS[activeIndex],
                    onChange: (patch) => updateTrack(active.id, patch),
                  }
                : null}
              tempo={loaded && page === 'tempo'
                ? { bpm, transpose: keyShift, onBpm: setBpm, onTranspose: (n) => setKeyShift(Math.max(-12, Math.min(12, n))) }
                : null}
              slice={sel}
              padIndex={active?.selected ?? 0}
              duration={active?.analysis.duration ?? 1}
              enabled={loaded}
              previewing={previewing}
              seqPlaying={seqPlaying}
              onChange={(patch) => active && updateTrack(active.id, (t) => ({ slices: t.slices.map((s, j) => (j === t.selected && s ? { ...s, ...patch } : s)) }))}
              onPreview={togglePreview}
              onPlaySeq={toggleSequence}
            />
          </div>

          <div className="col-side">
            <PadPanel
              owner={active ? `${SLOT_NAMES[activeIndex]} ${shortName(active.name, 22).toUpperCase()}` : 'NO SAMPLE'}
              pads={pads}
              selected={active ? active.selected : -1}
              playing={inPlugin ? maskToSet(padMask) : playingPads}
              keyboard={!!active?.keyboard}
              octave={active?.octave ?? 0}
              canKeyboard={!!sel}
              canDelete={!!sel}
              onTrigger={triggerPad}
              onSelect={(i) => active && updateTrack(active.id, { selected: i, keyboard: false })}
              onKeyboard={toggleKeyboard}
              onOctave={(octave) => active && updateTrack(active.id, { octave })}
              onDelete={() => active && deletePad(active.id, active.selected)}
            />
          </div>
        </div>
      </div>
      {loaded && status && <div className="toast" role="status">ANALYSING {shortName(status.name, 28).toUpperCase()} · {status.stage.toUpperCase()}…</div>}
      {loaded && error && <div className="toast toast--error" role="alert">{error}</div>}
    </div>
  )
}

function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return !['range', 'checkbox', 'radio', 'button', 'file'].includes(target.type)
}

interface NativeTrack {
  id: string
  name: string
  analysis: Omit<AnalysisResult, 'peaks'> & { peaks: number[] }
}

interface NativeRestore {
  tracks: NativeTrack[]
  project: null | {
    tracks?: (Partial<Track> & { id: string })[]
    anchorId?: string | null
    bpmOverride?: number | null
    keyShift?: number
    pattern?: Pattern
  }
}

function analysisFromNative(a: NativeTrack['analysis']): AnalysisResult {
  return { ...a, peaks: Float32Array.from(a.peaks) }
}

function maskToSet(mask: number): Set<number> {
  const s = new Set<number>()
  for (let i = 0; i < PAD_COUNT; i++) if (mask & (1 << i)) s.add(i)
  return s
}
