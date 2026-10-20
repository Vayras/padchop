// Bridge to the native plugin when the UI runs inside its WebView (JUCE 8
// WebBrowserComponent native integration). In a normal browser `inPlugin` is
// false and nothing here is used.

interface JuceBackend {
  addEventListener(event: string, fn: (payload: unknown) => void): unknown
  removeEventListener(token: unknown): void
  emitEvent(event: string, payload: unknown): void
}

declare global {
  interface Window {
    __JUCE__?: { backend: JuceBackend; initialisationData: Record<string, unknown> }
  }
}

export const inPlugin = typeof window !== 'undefined' && !!window.__JUCE__?.backend

let nextPromiseId = 0
const waiting = new Map<number, (result: unknown) => void>()
if (inPlugin) {
  window.__JUCE__!.backend.addEventListener('__juce__complete', (payload) => {
    const { promiseId, result } = payload as { promiseId: number; result: unknown }
    waiting.get(promiseId)?.(result)
    waiting.delete(promiseId)
  })
}

/** Call a native function registered with WebBrowserComponent::Options::withNativeFunction. */
export function native<T = unknown>(name: string, ...params: unknown[]): Promise<T> {
  if (!inPlugin) return Promise.reject(new Error('not running in the plugin'))
  const id = nextPromiseId++
  return new Promise<T>((resolve) => {
    waiting.set(id, resolve as (r: unknown) => void)
    window.__JUCE__!.backend.emitEvent('__juce__invoke', { name, params, resultId: id })
  })
}

/** Listen for an event the editor emits; returns an unsubscribe function. */
export function onNative<T = unknown>(event: string, fn: (payload: T) => void): () => void {
  if (!inPlugin) return () => {}
  const backend = window.__JUCE__!.backend
  const token = backend.addEventListener(event, fn as (p: unknown) => void)
  return () => backend.removeEventListener(token)
}

/** The engine's 30 Hz status tick. */
export interface Tick {
  step: number
  seqPlaying: boolean
  previewing: boolean
  playheadTrack: number
  playheadTime: number
  hostBpm: number
  stretching: boolean
  meters: number[]
  pads: number[]
}
