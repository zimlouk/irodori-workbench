import { useEffect, useRef, useState } from 'react'
import { errorMessage, isAbortError } from '../api'
import { fetchBatch, fetchBatches } from '../batch-api'
import type { Batch, BatchSummary } from '../batch-api'
import {
  currentJob,
  displayOrigin,
  formatTime,
  segmentStatus,
  statusLabel,
} from './model'

interface RecentDrawerProps {
  open: boolean
  currentBatchId: string | null
  busy: boolean
  savePaused: boolean
  onClose: () => void
  onRestore: (id: string) => void
  onReroll: (batchId: string, segmentId: string) => Promise<void>
  onRestoreDeleted: (batchId: string, segmentId: string) => Promise<void>
}

export function RecentDrawer({
  open,
  currentBatchId,
  busy,
  savePaused,
  onClose,
  onRestore,
  onReroll,
  onRestoreDeleted,
}: RecentDrawerProps) {
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<BatchSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, Batch>>({})
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({})
  const [audio, setAudio] = useState<{ key: string; url: string; label: string } | null>(
    null,
  )
  const activeRef = useRef(true)
  useEffect(() => { if (!open) setAudio(null) }, [open])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      void fetchBatches(search, controller.signal)
        .then((results) => {
          if (active) setItems(results)
        })
        .catch((reason: unknown) => {
          if (active && !isAbortError(reason)) setError(errorMessage(reason))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 280)
    return () => {
      active = false
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, search])

  async function loadDetail(id: string): Promise<void> {
    try {
      const batch = await fetchBatch(id)
      if (!activeRef.current) return
      setDetails((value) => ({ ...value, [id]: batch }))
      setDetailErrors((value) => {
        const next = { ...value }
        delete next[id]
        return next
      })
    } catch (reason) {
      if (!activeRef.current) return
      setDetailErrors((value) => ({ ...value, [id]: errorMessage(reason) }))
    }
  }

  useEffect(() => {
    if (!open) return
    const ids = Object.keys(openIds).filter(id => openIds[id])
    if (!ids.length) return
    const timer = window.setInterval(() => {
      ids.forEach(id => void loadDetail(id))
    }, 2500)
    return () => window.clearInterval(timer)
  }, [open, openIds])

  function toggleDetail(id: string): void {
    const next = !openIds[id]
    setOpenIds((value) => ({ ...value, [id]: next }))
    if (next) void loadDetail(id)
  }

  async function reroll(batchId: string, segmentId: string): Promise<void> {
    await onReroll(batchId, segmentId)
    await loadDetail(batchId)
  }

  if (!open) return null

  return (
    <div className="batch-drawer-layer">
      <button
        className="batch-drawer-backdrop"
        type="button"
        aria-label="关闭最近记录"
        onClick={onClose}
      />
      <aside className="batch-drawer" aria-labelledby="batch-drawer-title">
        <header className="batch-drawer-head">
          <div>
            <p className="batch-kicker">自动保留</p>
            <h2 id="batch-drawer-title">最近记录</h2>
          </div>
          <button className="quiet-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <label className="batch-field batch-search-field">
          <span>搜索台词或原文</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="输入文字后搜索全部记录"
          />
        </label>

        {error ? (
          <p className="batch-inline-error" role="alert">
            记录读取失败：{error}
          </p>
        ) : null}
        {loading ? <p className="batch-hint">正在读取记录……</p> : null}
        {!loading && items.length === 0 ? (
          <p className="batch-empty">没有匹配的记录。</p>
        ) : null}

        <div className="batch-recent-list">
          {items.map((item) => {
            const detail = details[item.id]
            const isOpen = openIds[item.id] === true
            return (
              <article
                className={
                  'batch-recent-row' + (item.id === currentBatchId ? ' current' : '')
                }
                key={item.id}
              >
                <div className="batch-recent-summary">
                  <div className="batch-recent-main">
                    <strong title={item.preview || item.source}>
                      {item.preview || item.source || '（空批次）'}
                    </strong>
                    <span className="batch-recent-meta">
                      {formatTime(item.updated_at)} · {item.segment_count} 句 ·{' '}
                      {item.completed_count} 就绪
                      {item.active_count > 0
                        ? ' · ' + String(item.active_count) + ' 生成中'
                        : ''}
                    </span>
                    <span className="batch-recent-origin">
                      {displayOrigin(item.origin,item.generation_purpose)}
                      {item.id === currentBatchId ? ' · 当前批次' : ''}
                    </span>
                  </div>
                  <div className="batch-recent-actions">
                    <button
                      className="quiet-button"
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggleDetail(item.id)}
                    >
                      {isOpen ? '收起' : '展开'}
                    </button>
                    <button
                      className="quiet-button accent"
                      type="button"
                      disabled={busy || savePaused || item.id === currentBatchId}
                      onClick={() => onRestore(item.id)}
                    >
                      恢复到编辑区
                    </button>
                  </div>
                </div>

                {isOpen ? (
                  <div className="batch-recent-detail">
                    {detailErrors[item.id] ? (
                      <p className="batch-inline-error">
                        {detailErrors[item.id]}
                      </p>
                    ) : null}
                    {!detail ? (
                      <p className="batch-hint">正在读取这一批的台词……</p>
                    ) : (
                      <>
                        <p className="batch-recent-source">
                          原文摘要：{detail.source.slice(0, 180) || '（空）'}
                        </p>
                        {detail.deleted_segments.length > 0 && <details><summary>已移除台词（可恢复） {detail.deleted_segments.length}</summary>
                          {detail.deleted_segments.map(segment => <div className="batch-recent-segment" key={segment.id}>
                            <span>{segment.text}</span>
                            <button type="button" className="quiet-button" disabled={busy || savePaused}
                              onClick={() => void onRestoreDeleted(item.id, segment.id).then(() => loadDetail(item.id))}>恢复台词</button>
                          </div>)}
                        </details>}
                        {detail.segments.length === 0 ? (
                          <p className="batch-empty-line">这一批还没有台词。</p>
                        ) : (
                          <div className="batch-recent-segments">
                            {detail.segments.map((segment, index) => {
                              const job = currentJob(segment)
                              return (
                                <div className="batch-recent-segment" key={segment.id}>
                                  <span className="batch-result-index">
                                    {index + 1}
                                  </span>
                                  <span className="batch-recent-text" title={segment.text}>
                                    {segment.text}
                                  </span>
                                  <span
                                    className={
                                      'batch-status ' + segmentStatus(segment)
                                    }
                                  >
                                    {statusLabel(segmentStatus(segment))}
                                  </span>
                                  <button
                                    className="quiet-button"
                                    type="button"
                                    disabled={!job || !job.audio_url || job.purged}
                                    onClick={() => {
                                      if (!job || !job.audio_url) return
                                      setAudio({
                                        key: job.id,
                                        url: job.audio_url,
                                        label: segment.text.slice(0, 30),
                                      })
                                    }}
                                  >
                                    试听
                                  </button>
                                  <button
                                    className="quiet-button accent"
                                    type="button"
                                    disabled={busy || savePaused}
                                    onClick={() => void reroll(item.id, segment.id)}
                                  >
                                    重抽这一句
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>

        {audio ? (
          <div className="batch-audio-strip">
            <span>试听：{audio.label}</span>
            <audio key={audio.key} controls autoPlay preload="metadata" src={audio.url}>
              当前浏览器不支持音频播放。
            </audio>
            <button className="quiet-button" type="button" onClick={() => setAudio(null)}>
              关闭
            </button>
          </div>
        ) : null}
        <p className="batch-hint">
          重抽使用该记录已保存的正文和配置，不会切换主编辑区；恢复整批前会先保存当前草稿。
        </p>
      </aside>
    </div>
  )
}
