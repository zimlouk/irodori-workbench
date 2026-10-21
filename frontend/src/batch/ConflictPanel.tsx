import { useState } from 'react'
import type { BatchConflict, BatchSegment } from '../batch-api'

interface ConflictPanelProps {
  conflicts: BatchConflict[]
  segments: BatchSegment[]
  busy: boolean
  onResolve: (
    conflictId: string,
    choice: 'keep' | 'replace',
    segmentId?: string,
  ) => void
}

export function ConflictPanel({
  conflicts,
  segments,
  busy,
  onResolve,
}: ConflictPanelProps) {
  const [replaceTargets, setReplaceTargets] = useState<Record<string, string>>({})

  if (conflicts.length === 0) return null

  return (
    <section className="batch-conflicts" aria-labelledby="batch-conflicts-title">
      <div className="batch-section-head">
        <div>
          <p className="batch-kicker">需要确认</p>
          <h2 id="batch-conflicts-title">原文更新有 {conflicts.length} 处待确认</h2>
        </div>
        <p className="batch-section-note">
          手工校对不会被静默覆盖。冲突未解决时，生成仍采用右侧当前正文。
        </p>
      </div>

      <div className="batch-conflict-list">
        {conflicts.map((conflict) => {
          const target = replaceTargets[conflict.id] ?? ''
          const requiresTarget = conflict.kind === 'overrides'
          return (
            <article className="batch-conflict-card" key={conflict.id}>
              <div className="batch-conflict-head">
                <strong>
                  {conflict.kind === 'source' ? '原文与校对不一致' : '单句设置冲突'}
                </strong>
                <span>{String(conflict.segment_ids.length)} 句相关</span>
              </div>
              <div className="batch-conflict-compare">
                <div>
                  <span className="batch-conflict-label">
                    {conflict.kind === 'source' ? '你的校对' : '当前设置'}
                  </span>
                  <pre>{conflict.before || '（空）'}</pre>
                </div>
                <div>
                  <span className="batch-conflict-label">
                    {conflict.kind === 'source' ? '重新处理结果' : '候选设置'}
                  </span>
                  <pre>{conflict.after || '（空）'}</pre>
                </div>
              </div>
              {requiresTarget ? (
                <label className="batch-field batch-conflict-target">
                  <span>采用哪一句的原设置</span>
                  <select
                    value={target}
                    onChange={(event) =>
                      setReplaceTargets((value) => ({
                        ...value,
                        [conflict.id]: event.target.value,
                      }))
                    }
                    disabled={busy}
                  >
                    <option value="">请明确选择一句</option>
                    {(conflict.choices?.map(c => c.segment_id) ?? conflict.segment_ids).map((segmentId) => {
                      const segment = segments.find((item) => item.id === segmentId)
                      return (
                        <option key={segmentId} value={segmentId}>
                          {segment ? segment.text.slice(0, 48) : conflict.choices?.find(c => c.segment_id === segmentId)?.text.slice(0,48) ?? segmentId}
                        </option>
                      )
                    })}
                  </select>
                </label>
              ) : null}
              <div className="batch-conflict-actions">
                <button
                  className="quiet-button"
                  type="button"
                  disabled={busy}
                  onClick={() => onResolve(conflict.id, 'keep')}
                >
                  保留当前
                </button>
                <button
                  className="quiet-button accent"
                  type="button"
                  disabled={busy || (requiresTarget && !target)}
                  onClick={() =>
                    onResolve(
                      conflict.id,
                      'replace',
                      requiresTarget ? target : undefined,
                    )
                  }
                >
                  使用重新处理结果
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
