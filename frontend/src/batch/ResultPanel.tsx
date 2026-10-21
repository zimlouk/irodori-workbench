import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { Asset, Lora } from '../types'
import type { P2Overrides, P2Preset } from '../p2-api'
import type { Batch, BatchJob, BatchSegment } from '../batch-api'
import { ConfigSummary, OverridesEditor } from '../p2/ConfigEditor'
import {
  currentJob,
  effectiveConfigFor,
  formatDuration,
  formatExpiry,
  formatFullTime,
  jobCanSelect,
  segmentStatus,
  statusLabel,
} from './model'
import { matchingVoice, voiceName } from './voice-selection'

interface ResultPanelProps {
  batch: Batch | null
  overrides: Record<string, P2Overrides>
  overridesDirty: Record<string, boolean>
  assets: Asset[]
  loras: Lora[]
  busy: boolean
  savePaused: boolean
  onReroll: (segmentId: string) => void
  onSelect: (segmentId: string, jobId: string) => void
  onOverrideChange: (segmentId: string, overrides: P2Overrides) => void
  onLocate: (segmentId: string) => void
  onPlay: (segment: BatchSegment, job: BatchJob) => void
  onOpenOutput: (segmentId: string) => void
  presets: P2Preset[]
}

export function ResultPanel({
  batch,
  overrides,
  overridesDirty,
  assets,
  loras,
  busy,
  savePaused,
  onReroll,
  onSelect,
  onOverrideChange,
  onLocate,
  onPlay,
  onOpenOutput,
  presets,
}: ResultPanelProps) {
  const [expandedSettings, setExpandedSettings] = useState<Record<string, boolean>>({})
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({})

  if (!batch) {
    return (
      <section className="batch-results" aria-labelledby="batch-results-title">
        <div className="batch-section-head">
          <div>
            <p className="batch-kicker">结果</p>
            <h2 id="batch-results-title">当前批次结果</h2>
          </div>
        </div>
        <p className="batch-empty">还没有批次。在左侧输入或粘贴文本后会自动保留。</p>
      </section>
    )
  }

  const completed = batch.segments.filter(
    (segment) => segmentStatus(segment) === 'ready',
  ).length

  function toggle(
    setter: Dispatch<SetStateAction<Record<string, boolean>>>,
    id: string,
  ): void {
    setter((value) => ({ ...value, [id]: !value[id] }))
  }

  function playCurrent(segment: BatchSegment): void {
    const job = currentJob(segment)
    if (!job || !job.audio_url) return
    onPlay(segment, job)
  }

  function playJob(segment: BatchSegment, job: BatchJob): void {
    if (!job.audio_url) return
    onPlay(segment, job)
  }

  return (
    <section className="batch-results" aria-labelledby="batch-results-title">
      <div className="batch-section-head">
        <div>
          <p className="batch-kicker">结果</p>
          <h2 id="batch-results-title">当前批次结果</h2>
        </div>
        <p className="batch-section-note">
          {completed} / {batch.segments.length} 句就绪 · 点台词可定位右侧正文行
        </p>
      </div>

      {batch.segments.length === 0 ? (
        <p className="batch-empty">右侧还没有非空台词。保存正文后，这里会按句显示状态。</p>
      ) : (
        <div className="batch-result-table" role="list">
          {batch.segments.map((segment, index) => {
            const status = segmentStatus(segment)
            const job = currentJob(segment)
            const settingsOpen = expandedSettings[segment.id] === true
            const versionsOpen = expandedVersions[segment.id] === true
            const localOverrides = overrides[segment.id] ?? segment.overrides
            const effective = effectiveConfigFor(batch.config, localOverrides)
            const preset = matchingVoice(effective, presets)
            return (
              <article className="batch-result-block" key={segment.id} role="listitem">
                <div className="batch-result-row">
                  <span className="batch-result-index">{index + 1}</span>
                  <div className="batch-result-copy"><button
                    className="batch-result-text"
                    type="button"
                    onClick={() => onLocate(segment.id)}
                    title={segment.text}
                  >
                    {segment.text}
                  </button>
                  {Object.keys(localOverrides).length > 0 ? <span className="batch-voice-label"
                    title={preset ? voiceName(preset) : '本句自定义音色／参数'}>
                    {preset ? preset.voice_name : '独立音色／参数'}
                  </span> : null}</div>
                  <span className={'batch-status ' + status}>
                    {statusLabel(status)}
                  </span>
                  {overridesDirty[segment.id] ? (
                    <span className="batch-chip warn">设置待保存</span>
                  ) : null}
                  <span className="batch-result-actions">
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={!segment.output_path}
                      onClick={() => onOpenOutput(segment.id)}
                      title="打开资源管理器并选中这句当前输出的音频"
                    >
                      定位音频
                    </button>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => playCurrent(segment)}
                      disabled={!job || !job.audio_url || job.purged}
                    >
                      播放
                    </button>
                    <button
                      className="quiet-button accent"
                      type="button"
                      onClick={() => onReroll(segment.id)}
                      disabled={busy || savePaused}
                    >
                      重抽
                    </button>
                    <button
                      className="quiet-button"
                      type="button"
                      aria-expanded={versionsOpen}
                      onClick={() => toggle(setExpandedVersions, segment.id)}
                    >
                      版本 {segment.attempts.length}
                    </button>
                    <button
                      className="quiet-button"
                      type="button"
                      aria-expanded={settingsOpen}
                      onClick={() => toggle(setExpandedSettings, segment.id)}
                    >
                      设置
                    </button>
                  </span>
                </div>

                {segment.output_error ? (
                  <p className="batch-inline-error" role="alert">
                    输出失败：{segment.output_error}
                  </p>
                ) : null}
                {segment.selected_stale ? (
                  <p className="batch-inline-warn">
                    这一句的正文已修改，当前音频来自旧正文；重新生成成功后会替换输出。
                  </p>
                ) : null}

                {versionsOpen ? (
                  <div className="batch-versions">
                    {segment.attempts.length === 0 ? (
                      <p className="batch-empty-line">这一句还没有生成记录。</p>
                    ) : (
                      [...segment.attempts]
                        .sort((a, b) => b.created_at.localeCompare(a.created_at))
                        .map((attempt) => {
                          const selected = segment.selected_job_id === attempt.id
                          const selectable = jobCanSelect(segment, attempt)
                          return (
                            <div className="batch-version-row" key={attempt.id}>
                              <span className={'batch-status ' + attempt.status}>
                                {attempt.status === 'succeeded'
                                  ? selected
                                    ? attempt.stale
                                      ? '旧选中'
                                      : '当前'
                                    : '成功'
                                  : attempt.status === 'pending'
                                    ? '排队'
                                    : attempt.status === 'running'
                                      ? '生成中'
                                      : attempt.status === 'failed'
                                        ? '失败'
                                        : attempt.status === 'interrupted'
                                          ? '中断'
                                          : '取消'}
                              </span>
                              <span className="batch-version-time">
                                {formatFullTime(attempt.created_at)}
                              </span>
                              <span className="batch-version-meta">
                                {formatDuration(attempt.result_metadata?.audio_seconds)}
                                {attempt.result_metadata?.used_seed !== undefined
                                  ? ' · seed ' +
                                    String(attempt.result_metadata.used_seed)
                                  : ''}
                              </span>
                              {attempt.stale ? (
                                <span className="batch-chip warn">旧版本</span>
                              ) : null}
                              {attempt.purged ? (
                                <span className="batch-chip">音频已清理</span>
                              ) : (
                                <span className="batch-version-expiry">
                                  {selected
                                    ? attempt.stale
                                      ? '当前选中（旧正文）'
                                      : '当前版本'
                                    : formatExpiry(attempt.expires_at)}
                                </span>
                              )}
                              {attempt.error ? (
                                <span className="batch-inline-error">{attempt.error}</span>
                              ) : null}
                              <span className="batch-version-actions">
                                <button
                                  className="quiet-button"
                                  type="button"
                                  disabled={!attempt.audio_url || attempt.purged}
                                  onClick={() => playJob(segment, attempt)}
                                >
                                  试听
                                </button>
                                <button
                                  className="quiet-button accent"
                                  type="button"
                                  disabled={selected || !selectable || busy || savePaused}
                                  onClick={() => onSelect(segment.id, attempt.id)}
                                >
                                  {selected ? '当前版本' : '设为当前'}
                                </button>
                              </span>
                            </div>
                          )
                        })
                    )}
                    <p className="batch-hint">
                      旧版本可试听；只有与当前正文一致且未清理的成功版本能设为当前。
                    </p>
                  </div>
                ) : null}

                {settingsOpen ? (
                  <div className="batch-segment-settings">
                    <div className="batch-segment-settings-head">
                      <div>
                        <strong>这一句的设置</strong>
                        <p>未覆盖的字段继承整批配置。</p>
                      </div>
                      {segment.output_path ? (
                        <span className="batch-output-path" title={segment.output_path}>
                          当前输出：{segment.output_path}
                        </span>
                      ) : null}
                    </div>
                    <OverridesEditor
                      overrides={localOverrides}
                      inherited={batch.config}
                      onChange={(next) => onOverrideChange(segment.id, next)}
                      assets={assets}
                      loras={loras}
                      idPrefix={'batch-segment-' + segment.id}
                      disabled={false}
                    />
                    <details className="batch-effective-preview">
                      <summary>有效配置预览</summary>
                      <ConfigSummary
                        config={effective}
                        assets={assets}
                        loras={loras}
                      />
                    </details>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}

      <div className="batch-results-foot">
        <span>批次短编号：{batch.id.slice(0, 8)}</span>
        <span>处理方式：{batch.processing.mode === 'article' ? '文章提取' : batch.processing.mode === 'lines' ? '一行一个音频' : '原样直通'}</span>
      </div>
    </section>
  )
}
