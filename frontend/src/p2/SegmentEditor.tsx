import type { Asset, Lora } from '../types'
import type { P2Job, P2JobStatus, P2Preset } from '../p2-api'
import { ConfigSummary } from './ConfigEditor'
import { OverridesEditor } from './ConfigEditor'
import type { DraftSegment } from './model'
import { configWithOverrides } from './model'

const STATUS_LABELS: Record<P2JobStatus, string> = {
  pending: '等待中',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
}

function shortId(value: string): string {
  return value.length > 14
    ? value.slice(0, 8) + '…' + value.slice(-4)
    : value
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '时间未知'
    : date.toLocaleString('zh-CN')
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-')
}

interface JobListProps {
  segment: DraftSegment
  index: number
  busy: boolean
  onSelectJob: (index: number, jobId: string) => void
}

function JobList({ segment, index, busy, onSelectJob }: JobListProps) {
  const sorted = [...segment.attempts].sort((a, b) => {
    const timeA = new Date(a.created_at).getTime()
    const timeB = new Date(b.created_at).getTime()
    if (Number.isFinite(timeA) && Number.isFinite(timeB) && timeA !== timeB) {
      return timeB - timeA
    }
    return b.id.localeCompare(a.id)
  })

  if (sorted.length === 0) {
    return <p className="p2-empty-line">尚无生成结果。保存后可生成新版本。</p>
  }

  return (
    <ul className="p2-job-list">
      {sorted.map((job) => {
        const currentInput = job.input_revision === segment.input_revision
        const selectable =
          job.status === 'succeeded' && currentInput && !job.stale
        const selected = segment.selected_job_id === job.id
        return (
          <li
            key={job.id}
            className={'p2-job' + (selected ? ' is-selected' : '')}
          >
            <div className="p2-job-top">
              <span className={'status-badge status-' + job.status}>
                <span aria-hidden="true" />
                {STATUS_LABELS[job.status]}
              </span>
              <span className="p2-mono" title={job.id}>
                #{shortId(job.id)}
              </span>
              <span className="p2-job-mode">
                {job.mode === 'irodori' ? '真实语音' : '测试音'}
              </span>
              <time dateTime={job.created_at}>{formatTime(job.created_at)}</time>
            </div>

            <div className="p2-job-tags">
              {selected ? <span className="p2-tag accent">当前选定版本</span> : null}
              {currentInput ? (
                <span className="p2-tag">输入修订 r{job.input_revision}</span>
              ) : (
                <span className="p2-tag muted">旧输入 r{job.input_revision}</span>
              )}
              {job.stale ? <span className="p2-tag warning">已过期</span> : null}
              {job.batch_id ? (
                <span className="p2-tag muted" title={job.batch_id}>
                  批次 #{shortId(job.batch_id)}
                </span>
              ) : null}
              {job.result_metadata?.used_seed !== undefined ? (
                <span
                  className="p2-tag p2-mono"
                  title={String(job.result_metadata.used_seed)}
                >
                  实际 seed {String(job.result_metadata.used_seed)}
                </span>
              ) : null}
            </div>

            {job.error ? (
              <div className="p2-job-error" role="alert">
                <strong>任务错误</strong>
                <p>{job.error}</p>
              </div>
            ) : null}

            {job.status === 'running' ? (
              <div className="running-track" aria-hidden="true">
                <span />
              </div>
            ) : null}

            {job.audio_url ? (
              <div className="p2-job-audio">
                <audio controls preload="none" src={job.audio_url}>
                  当前浏览器不支持音频播放。
                </audio>
                <span className="p2-hint">
                  可直接试听；历史版本试听不会自动改变选定版本。
                </span>
              </div>
            ) : job.status === 'succeeded' ? (
              <p className="p2-hint">任务已完成，但暂未提供音频链接。</p>
            ) : null}

            <div className="p2-job-actions">
              <button
                className="quiet-button accent"
                type="button"
                onClick={() => onSelectJob(index, job.id)}
                disabled={busy || selected || !selectable}
              >
                {selected
                  ? '已选定'
                  : selectable
                    ? '设为当前版本'
                    : job.status !== 'succeeded'
                      ? '完成后可选'
                      : '不可选（非当前输入版本）'}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

interface SegmentEditorProps {
  segments: DraftSegment[]
  presets: P2Preset[]
  assets: Asset[]
  loras: Lora[]
  selectedKeys: Set<string>
  defaultPresetId: string | null
  defaultPresetLabel: string
  busy: boolean
  onToggle: (key: string) => void
  onChange: (index: number, patch: Partial<DraftSegment>) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
  onGenerate: (index: number) => void
  onSelectJob: (index: number, jobId: string) => void
}

export function SegmentEditor({
  segments,
  presets,
  assets,
  loras,
  selectedKeys,
  defaultPresetId,
  defaultPresetLabel,
  busy,
  onToggle,
  onChange,
  onMove,
  onRemove,
  onGenerate,
  onSelectJob,
}: SegmentEditorProps) {
  const presetGroups = new Map<string, P2Preset[]>()
  presets.forEach((preset) => {
    const items = presetGroups.get(preset.voice_name) ?? []
    items.push(preset)
    presetGroups.set(preset.voice_name, items)
  })

  return (
    <div className="p2-segments">
      {segments.length === 0 ? (
        <div className="p2-empty-state">
          <h3>还没有段落</h3>
          <p>添加第一个段落，填写文本、手动 speaker 与音色预设。</p>
        </div>
      ) : null}

      {segments.map((segment, index) => {
        const id = safeKey(segment.key)
        const textId = 'p2-seg-text-' + id
        const speakerId = 'p2-seg-speaker-' + id
        const presetId = 'p2-seg-preset-' + id
        const unknownPreset =
          segment.preset_id !== null &&
          !presets.some((preset) => preset.id === segment.preset_id)
        const selectedPreset = segment.preset_id
          ? presets.find((preset) => preset.id === segment.preset_id) ?? null
          : null
        const newerPreset =
          selectedPreset !== null &&
          segment.snapshot.preset_version !== null &&
          selectedPreset.version > segment.snapshot.preset_version
        const pendingPreset =
          segment.preset_id === null
            ? defaultPresetId !== segment.snapshot.preset_id
            : segment.preset_id !== segment.snapshot.preset_id
        const effectivePreview = configWithOverrides(
          segment.snapshot.config,
          segment.overrides,
        )
        const selectedJob = segment.selected_job_id
          ? segment.attempts.find((job) => job.id === segment.selected_job_id) ??
            null
          : null
        const isNew = !segment.id

        return (
          <article className="p2-segment" key={segment.key}>
            <div className="p2-segment-head">
              <label className="p2-check">
                <input
                  type="checkbox"
                  checked={selectedKeys.has(segment.key)}
                  onChange={() => onToggle(segment.key)}
                  aria-label={'选择第 ' + String(index + 1) + ' 段'}
                />
                <span>第 {index + 1} 段</span>
              </label>

              <div className="p2-segment-badges">
                {isNew ? (
                  <span className="p2-tag warning">未保存新段</span>
                ) : (
                  <span className="p2-tag">已保存 r{segment.input_revision}</span>
                )}
                {segment.preset_id === null ? (
                  <span className="p2-tag muted">使用项目默认预设</span>
                ) : (
                  <span className="p2-tag muted">预设快照已锁定</span>
                )}
                {pendingPreset ? (
                  <span className="p2-tag warning">预设变更待保存</span>
                ) : null}
                {newerPreset && selectedPreset ? (
                  <span className="p2-tag warning">
                    预设已有 v{selectedPreset.version} 新版
                  </span>
                ) : null}
                {segment.selected_stale ? (
                  <span className="p2-tag warning">选定结果已过期</span>
                ) : null}
              </div>

              <div className="p2-segment-buttons">
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => onMove(index, -1)}
                  disabled={busy || index === 0}
                  aria-label={'上移第 ' + String(index + 1) + ' 段'}
                >
                  上移
                </button>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => onMove(index, 1)}
                  disabled={busy || index === segments.length - 1}
                  aria-label={'下移第 ' + String(index + 1) + ' 段'}
                >
                  下移
                </button>
                <button
                  className="quiet-button danger"
                  type="button"
                  onClick={() => onRemove(index)}
                  disabled={busy}
                  aria-label={'删除第 ' + String(index + 1) + ' 段'}
                >
                  删除
                </button>
              </div>
            </div>

            <div className="p2-segment-grid">
              <div className="p2-field p2-segment-text">
                <div className="p2-label-row">
                  <label htmlFor={textId}>段落文本</label>
                  <span>{segment.text.length} 字符（允许空草稿）</span>
                </div>
                <textarea
                  id={textId}
                  rows={3}
                  value={segment.text}
                  onChange={(event) =>
                    onChange(index, { text: event.target.value })
                  }
                  placeholder="输入这一段的文本。生成时会拒绝空白文本。"
                  disabled={busy}
                />
              </div>

              <div className="p2-field">
                <div className="p2-label-row">
                  <label htmlFor={speakerId}>说话者标签</label>
                  <span>手动填写</span>
                </div>
                <input
                  id={speakerId}
                  value={segment.speaker}
                  onChange={(event) =>
                    onChange(index, { speaker: event.target.value })
                  }
                  placeholder="例如：小春"
                  disabled={busy}
                />
              </div>

              <div className="p2-field">
                <div className="p2-label-row">
                  <label htmlFor={presetId}>音色预设</label>
                  <span>null = 项目默认</span>
                </div>
                <select
                  id={presetId}
                  value={segment.preset_id ?? ''}
                  onChange={(event) =>
                    onChange(index, {
                      preset_id: event.target.value || null,
                    })
                  }
                  disabled={busy}
                >
                  <option value="">使用项目默认预设（{defaultPresetLabel}）</option>
                  {unknownPreset ? (
                    <option value={segment.preset_id ?? ''}>
                      未知预设 {segment.preset_id}
                    </option>
                  ) : null}
                  {[...presetGroups.entries()].map(([voice, items]) => (
                    <optgroup key={voice} label={voice}>
                      {items.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.name} · v{preset.version}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <p className="p2-hint">
                  同一预设保持原快照；保存时改变预设才会复制该预设的当前版本。
                  {segment.preset_id === null && defaultPresetId !== null
                    ? ' 默认预设是 ' + defaultPresetLabel + '。'
                    : ''}
                </p>
              </div>
            </div>

            <div className="p2-segment-actions">
              <button
                className="quiet-button accent"
                type="button"
                onClick={() => onGenerate(index)}
                disabled={busy}
              >
                生成此段
              </button>
              <button
                className="quiet-button"
                type="button"
                onClick={() => onGenerate(index)}
                disabled={busy}
              >
                重抽（新版本）
              </button>
              <span className="p2-hint">
                生成前会自动保存；固定 seed 会复现，seed 为 null 时重抽才是随机。旧任务与旧音频会保留。
              </span>
            </div>

            <details className="p2-segment-details">
              <summary>
                逐段覆盖与继承
                <span className="p2-summary-note">
                  {Object.keys(segment.overrides).length > 0
                    ? '有覆盖'
                    : '全部继承'}
                </span>
              </summary>
              <OverridesEditor
                overrides={segment.overrides}
                inherited={segment.snapshot.config}
                onChange={(overrides) => onChange(index, { overrides })}
                assets={assets}
                loras={loras}
                idPrefix={'p2-ov-' + id}
                disabled={busy}
              />
            </details>

            <details className="p2-segment-details">
              <summary>快照与当前有效配置</summary>
              <div className="p2-config-columns">
                <div>
                  <h4>预设快照（保存时锁定）</h4>
                  <p className="p2-hint">
                    {segment.snapshot.preset_id === null
                      ? '项目默认快照'
                      : '预设 ' +
                        segment.snapshot.preset_id +
                        (segment.snapshot.preset_version === null
                          ? ''
                          : ' · v' + String(segment.snapshot.preset_version))}
                  </p>
                  <ConfigSummary
                    config={segment.snapshot.config}
                    assets={assets}
                    loras={loras}
                  />
                </div>
                <div>
                  <h4>本地覆盖后的预览</h4>
                  <p className="p2-hint">
                    基于快照和当前继承开关计算；保存后以后端返回为准。
                  </p>
                  <ConfigSummary
                    config={effectivePreview}
                    assets={assets}
                    loras={loras}
                  />
                </div>
              </div>
            </details>

            <div className="p2-jobs-block">
              <div className="p2-jobs-heading">
                <h4>生成版本</h4>
                <span>
                  {segment.attempts.length} 个任务
                  {selectedJob
                    ? ' · 已选定 #' + shortId(selectedJob.id)
                    : segment.selected_job_id
                      ? ' · 选定版本不在当前结果列表'
                      : ' · 未选定版本'}
                </span>
              </div>
              {segment.selected_stale ? (
                <p className="p2-warning" role="status">
                  当前选定结果基于旧输入，已标记过期；可以继续试听，但需要重新生成或选择当前修订的版本。
                </p>
              ) : null}
              <JobList
                segment={segment}
                index={index}
                busy={busy}
                onSelectJob={onSelectJob}
              />
            </div>
          </article>
        )
      })}
    </div>
  )
}

export function jobIsSelectable(job: P2Job, segment: DraftSegment): boolean {
  return (
    job.status === 'succeeded' &&
    !job.stale &&
    job.input_revision === segment.input_revision
  )
}
