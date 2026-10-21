import type { BatchPreviewController } from './useBatchPreview'
import './preview.css'

function time(seconds: number): string {
  const rounded = Math.floor(Math.max(0, seconds))
  return String(Math.floor(rounded / 60)) + ':' + String(rounded % 60).padStart(2, '0')
}

export function PreviewBar({ player }: { player: BatchPreviewController }) {
  const { state } = player
  const playing = ['playing','gap','waiting'].includes(state.phase)
  const listening = !!player.sourceBatchId && state.phase !== 'idle'
  const track = state.tracks[state.index]
  return <section className="batch-preview-bar" aria-label="连续试听">
    <div className="batch-preview-controls">
      <strong>连续试听</strong>
      <button type="button" className="quiet-button" onClick={player.playBatch} disabled={!player.available}>从头试听整批</button>
      <button type="button" className="quiet-button" onClick={player.previous} disabled={state.index <= 0}>上一句</button>
      <button type="button" className="quiet-button accent" disabled={!listening}
        onClick={playing ? player.pause : player.resume}>{playing ? '暂停' : '播放'}</button>
      <button type="button" className="quiet-button" onClick={player.next}
        disabled={!track || state.index >= state.tracks.length - 1}>下一句</button>
      <button type="button" className="quiet-button" onClick={player.stop} disabled={!listening}>停止</button>
    </div>
    <div className="batch-preview-options">
      <label><input type="checkbox" checked={player.auto} onChange={(event) => player.setAuto(event.target.checked)} />首句生成后自动试听</label>
      <label htmlFor="batch-preview-gap">句间静音（秒）</label>
      <input id="batch-preview-gap" type="number" min="0" max="30" step="0.1" value={player.gap}
        onChange={(event) => player.setGap(event.target.value === '' ? 0 : Number(event.target.value))} />
      <small>仅影响试听，设置自动记住。</small>
    </div>
    <div className="batch-preview-current" role="status">
      {track ? <><span>{state.phase === 'waiting' ? '等待下一句生成' : state.phase === 'gap' ? '句间静音' : state.phase === 'ended' ? '试听结束' :
        state.phase === 'paused' || state.phase === 'blocked' ? '已暂停' : '正在试听'} · 第 {track.ordinal} 句 · {state.index + 1}/{state.tracks.length}</span>
        <span className="batch-preview-text" title={track.text}>{track.text}</span></> : <span>{state.phase==='waiting'?'等待首句生成…':state.phase==='paused'?'已暂停，等待生成结果。':'按正文顺序播放当前选中的有效版本。'}</span>}
    </div>
    {player.sourceBatchId?<small>试听批次 {player.sourceBatchId.slice(0,8)}{player.detached?' · 编辑区已切换，原批次继续试听。':''}</small>:null}
    {track ? <div className="batch-preview-progress">
      <span>{time(state.position)} / {time(state.duration)}</span>
      <input aria-label="试听进度" type="range" min="0" max={Math.max(state.duration, .01)} step=".01"
        value={Math.min(state.position, Math.max(state.duration, .01))} disabled={state.phase === 'gap' || state.phase==='waiting' || !state.duration}
        onChange={(event) => player.seek(Number(event.target.value))} />
    </div> : null}
    {state.message ? <p className="batch-inline-warn" role="status">{state.message}</p> : null}
    {player.syncError?<p className="batch-inline-warn" role="status">{player.syncError}</p>:null}
  </section>
}
