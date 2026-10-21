export interface PreviewTrack {
  segmentId: string
  jobId: string
  url: string
  text: string
  ordinal: number
}

export type PreviewPhase = 'idle' | 'playing' | 'paused' | 'gap' | 'waiting' | 'blocked' | 'ended'
export interface PreviewState {
  tracks: PreviewTrack[]
  index: number
  phase: PreviewPhase
  position: number
  duration: number
  message: string
}

export interface AudioPort {
  src: string
  currentTime: number
  duration: number
  play(): Promise<void>
  pause(): void
  addEventListener(name: string, handler: () => void): void
  removeEventListener(name: string, handler: () => void): void
}

export interface PreviewClock {
  now(): number
  set(callback: () => void, milliseconds: number): unknown
  clear(timer: unknown): void
}

export const emptyPreview = (): PreviewState => ({
  tracks: [], index: -1, phase: 'idle', position: 0, duration: 0, message: '',
})

const browserClock: PreviewClock = {
  now: () => Date.now(),
  set: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clear: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
}

/** One audio element owns both sentence previews and the sequential batch queue. */
export class SequencePlayer {
  private state = emptyPreview()
  private timer: unknown = null
  private deadline = 0
  private gapRemaining: number | null = null
  private gapSeconds = 0.5
  private token = 0
  private disposed = false
  private streamOpen = false
  private endedAt: number | null = null
  private pausedWaiting = false

  constructor(private audio: AudioPort, private changed: (state: PreviewState) => void,
    private clock: PreviewClock = browserClock) {
    audio.addEventListener('ended', this.ended)
    audio.addEventListener('error', this.failed)
    audio.addEventListener('timeupdate', this.progress)
    audio.addEventListener('loadedmetadata', this.progress)
  }

  snapshot(): PreviewState { return { ...this.state, tracks: [...this.state.tracks] } }

  private emit(): void { if (!this.disposed) this.changed(this.snapshot()) }

  private clearTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
  }

  setGap(seconds: number): void {
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) this.gapSeconds = seconds
  }

  start(tracks: PreviewTrack[], index = 0, message = '', open = false): void {
    this.stop()
    this.streamOpen = open
    if (!tracks.length) {
      this.state.phase = open ? 'waiting' : 'ended'
      this.state.message = message || (open ? '' : '当前没有可试听的音频。')
      this.emit(); return
    }
    this.state = { tracks: [...tracks], index: Math.max(0, Math.min(index, tracks.length - 1)),
      phase: 'idle', position: 0, duration: 0, message }
    this.playTrack(true)
  }

  /** Append an ordered ready prefix without restarting audio already being heard. */
  updateStream(tracks: PreviewTrack[], open: boolean): void {
    const last = this.state.tracks.at(-1)?.ordinal ?? 0
    const known = new Set(this.state.tracks.map(track => track.segmentId))
    this.state.tracks.push(...tracks.filter(track => !known.has(track.segmentId) && track.ordinal > last))
    this.streamOpen = open
    if (this.state.phase === 'waiting') this.continueStream()
    else this.emit()
  }

  private continueStream(): void {
    if (this.state.index + 1 < this.state.tracks.length) {
      if (this.state.index < 0) { this.state.index = 0; this.playTrack(true) }
      else {
        const elapsed = this.endedAt === null ? 0 : this.clock.now() - this.endedAt
        this.waitGap(Math.max(0, this.gapSeconds * 1000 - elapsed))
      }
    } else {
      this.state.phase = this.streamOpen ? 'waiting' : 'ended'
      this.emit()
    }
  }

  private playTrack(reset: boolean): void {
    this.clearTimer()
    this.gapRemaining = null
    this.pausedWaiting = false
    this.endedAt = null
    const track = this.state.tracks[this.state.index]
    if (!track || this.disposed) return
    const token = ++this.token
    if (this.state.phase === 'blocked') this.state.message = ''
    if (reset) {
      this.audio.pause()
      this.audio.src = track.url
      this.audio.currentTime = 0
      this.state.position = 0
      this.state.duration = 0
    }
    this.state.phase = 'playing'
    this.emit()
    void this.audio.play().catch((error: unknown) => {
      if (token !== this.token || this.disposed) return
      this.audio.pause()
      if (error instanceof Error && error.name === 'NotAllowedError') {
        this.state.phase = 'blocked'
        this.state.message = '浏览器尚未允许自动播放，点击“播放”开始连续试听。'
        this.emit()
      } else if (!(error instanceof Error && error.name === 'AbortError')) this.failed()
    })
  }

  private progress = (): void => {
    if (this.state.phase === 'idle') return
    this.state.position = Number.isFinite(this.audio.currentTime) ? this.audio.currentTime : 0
    this.state.duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
    this.emit()
  }

  private ended = (): void => {
    if (this.state.phase !== 'playing') return
    if (this.state.index >= this.state.tracks.length - 1) {
      this.endedAt = this.clock.now()
      this.state.phase = this.streamOpen ? 'waiting' : 'ended'
      this.emit()
    } else this.waitGap(this.gapSeconds * 1000)
  }

  private waitGap(milliseconds: number): void {
    this.clearTimer()
    this.gapRemaining = milliseconds
    this.deadline = this.clock.now() + milliseconds
    this.state.phase = 'gap'
    this.emit()
    this.timer = this.clock.set(() => {
      this.timer = null
      if (this.state.phase !== 'gap' || this.disposed) return
      this.state.index += 1
      this.playTrack(true)
    }, milliseconds)
  }

  private failed = (): void => {
    if (this.disposed || !this.state.tracks.length || this.state.phase !== 'playing') return
    ++this.token
    this.audio.pause()
    const ordinal = this.state.tracks[this.state.index].ordinal
    this.state.message = '第 ' + String(ordinal) + ' 句音频无法播放，已跳过。'
    if (this.state.index < this.state.tracks.length - 1) {
      this.state.index += 1
      this.playTrack(true)
    } else {
      this.endedAt = this.clock.now()
      this.state.phase = this.streamOpen ? 'waiting' : 'ended'
      this.emit()
    }
  }

  pause(): void {
    if (!['playing','gap','waiting'].includes(this.state.phase)) return
    this.pausedWaiting = this.state.phase === 'waiting'
    if (this.state.phase === 'gap') this.gapRemaining = Math.max(0, this.deadline - this.clock.now())
    ++this.token
    this.clearTimer()
    this.audio.pause()
    this.state.phase = 'paused'
    this.emit()
  }

  resume(): void {
    if (this.pausedWaiting) {
      this.pausedWaiting = false
      this.state.phase = 'waiting'
      this.continueStream()
    } else if (!this.state.tracks.length) return
    else if (this.state.phase === 'ended') { this.state.index = 0; this.playTrack(true) }
    else if (this.gapRemaining !== null) this.waitGap(this.gapRemaining)
    else this.playTrack(false)
  }

  move(direction: -1 | 1): void {
    const next = this.state.index + direction
    if (next < 0 || next >= this.state.tracks.length) return
    this.state.index = next
    this.playTrack(true)
  }

  seek(seconds: number): void {
    if (!Number.isFinite(seconds) || this.state.phase === 'waiting' || this.pausedWaiting || this.gapRemaining !== null || !this.state.duration) return
    this.audio.currentTime = Math.max(0, Math.min(seconds, this.state.duration))
    this.progress()
  }

  stop(): void {
    ++this.token
    this.clearTimer()
    this.gapRemaining = null
    this.streamOpen = false
    this.endedAt = null
    this.pausedWaiting = false
    this.audio.pause()
    this.state = emptyPreview()
    this.emit()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.audio.removeEventListener('ended', this.ended)
    this.audio.removeEventListener('error', this.failed)
    this.audio.removeEventListener('timeupdate', this.progress)
    this.audio.removeEventListener('loadedmetadata', this.progress)
  }
}
