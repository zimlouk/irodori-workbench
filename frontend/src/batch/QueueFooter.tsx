import { useMemo, useState } from 'react'
import type { QueueItem } from '../batch-api'
import { displayOrigin, shortId } from './model'

interface QueueFooterProps {
  queue: QueueItem[]
  queueError: string | null
  queueLoading: boolean
  busy: boolean
  onCancel: (batchId: string) => void
  onRefresh: () => void
}

function queueStatusLabel(status: QueueItem['status']): string {
  switch (status) {
    case 'pending':
      return '排队'
    case 'running':
      return '生成中'
    case 'succeeded':
      return '完成'
    case 'failed':
      return '失败'
    case 'interrupted':
      return '中断'
    default:
      return '取消'
  }
}

export function QueueFooter({
  queue,
  queueError,
  queueLoading,
  busy,
  onCancel,
  onRefresh,
}: QueueFooterProps) {
  const [open, setOpen] = useState(false)
  const groups = useMemo(() => {
    const map = new Map<string, QueueItem[]>()
    for (const item of queue) {
      const key = item.workbench_batch_id ?? 'external'
      const items = map.get(key) ?? []
      items.push(item)
      map.set(key, items)
    }
    return [...map.entries()]
  }, [queue])
  const running = queue.filter((item) => item.status === 'running').length
  const pending = queue.filter((item) => item.status === 'pending').length
  const current = queue.find((item) => item.status === 'running') ?? queue[0]

  return (
    <aside className="batch-queue" aria-label="生成队列">
      <div className="batch-queue-bar">
        <div className="batch-queue-summary">
          <span className="batch-queue-dot" aria-hidden="true" />
          <strong>队列</strong>
          <span>
            {queueLoading
              ? '读取中'
              : String(running) + ' 句生成中 · ' + String(pending) + ' 句排队'}
          </span>
          {current ? (
            <span className="batch-queue-current" title={current.text}>
              {queueStatusLabel(current.status)}：{current.text.slice(0, 42)}
            </span>
          ) : (
            <span className="batch-queue-current">当前没有等待或进行中的任务</span>
          )}
        </div>
        <div className="batch-queue-actions">
          <button className="quiet-button" type="button" onClick={onRefresh}>
            刷新
          </button>
          <button
            className="quiet-button"
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? '收起' : '展开队列'}
          </button>
        </div>
      </div>

      {queueError ? (
        <p className="batch-queue-error" role="alert">
          队列读取失败：{queueError}
        </p>
      ) : null}

      {open ? (
        <div className="batch-queue-body">
          {queue.length === 0 ? (
            <p className="batch-empty-line">队列为空。</p>
          ) : (
            groups.map(([batchId, items]) => {
              const cancelable = items.some(
                (item) => item.status === 'pending' && item.workbench_batch_id,
              )
              return (
                <section className="batch-queue-group" key={batchId}>
                  <div className="batch-queue-group-head">
                    <strong>
                      {batchId === 'external'
                        ? '外部调用'
                        : '批次 ' + shortId(batchId)}
                    </strong>
                    <span>{displayOrigin(items[0]?.origin ?? '')}</span>
                    {cancelable ? (
                      <button
                        className="quiet-button danger"
                        type="button"
                        disabled={busy}
                        onClick={() => onCancel(batchId)}
                      >
                        取消该批未开始任务
                      </button>
                    ) : null}
                  </div>
                  <div className="batch-queue-items">
                    {items.map((item) => (
                      <div className="batch-queue-item" key={item.id}>
                        <span className={'batch-status ' + item.status}>
                          {queueStatusLabel(item.status)}
                        </span>
                        <span className="batch-queue-priority">
                          {item.priority > 0 ? '优先' : '普通'}
                        </span>
                        <span className="batch-queue-text" title={item.text}>
                          {item.text}
                        </span>
                        {item.error ? (
                          <span className="batch-inline-error">{item.error}</span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </section>
              )
            })
          )}
          <p className="batch-hint">
            取消只影响尚未开始的任务；当前正在推理的一句会正常完成并保留结果。
          </p>
        </div>
      ) : null}
    </aside>
  )
}
