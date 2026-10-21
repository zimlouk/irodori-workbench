import type { P2Config, P2Overrides } from '../p2-api'
import { configWithOverrides } from '../p2/model'
import type { Batch, BatchJob, BatchSegment, Processing } from '../batch-api'

export const DEFAULT_PROCESSING: Processing = {
  mode: 'lines',
  limit: 120,
  short: 20,
  merge_short: true,
  persistent_rules: '',
  temporary_rules: '',
  include_double: false,
}

export type SegmentUiStatus = 'active' | 'ready' | 'stale' | 'failed' | 'missing'

export interface CachedDraft {
  leftText: string
  rightText: string
  config: P2Config
  processing: Processing
  outputDir: string
  overrides: Record<string, P2Overrides>
  leftDirty: boolean
  rightDirty: boolean
  settingsDirty: boolean
  overridesDirty: Record<string, boolean>
  updatedAt: string
}

export function cloneConfig(config: P2Config): P2Config {
  return {
    lora_id: config.lora_id,
    reference_asset_ids: [...config.reference_asset_ids],
    caption: config.caption,
    parameters: { ...config.parameters },
  }
}

export function cloneProcessing(processing: Processing): Processing {
  return { ...processing }
}

export function cloneOverrides(overrides: P2Overrides): P2Overrides {
  const next: P2Overrides = {}
  if (Object.prototype.hasOwnProperty.call(overrides, 'lora_id')) {
    next.lora_id = overrides.lora_id ?? null
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'reference_asset_ids')) {
    next.reference_asset_ids = [...(overrides.reference_asset_ids ?? [])]
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'caption')) {
    next.caption = overrides.caption ?? ''
  }
  if (overrides.parameters) {
    next.parameters = { ...overrides.parameters }
  }
  return next
}

export function segmentsToScript(segments: BatchSegment[]): string {
  return segments.map((segment) => segment.text).join('\n')
}

export function effectiveConfigFor(
  base: P2Config,
  overrides: P2Overrides,
): P2Config {
  return configWithOverrides(base, overrides)
}

export function currentJob(segment: BatchSegment): BatchJob | null {
  if (!segment.selected_job_id) return null
  return (
    segment.attempts.find((job) => job.id === segment.selected_job_id) ?? null
  )
}

export function segmentStatus(segment: BatchSegment): SegmentUiStatus {
  if (segment.attempts.some((job) => job.status === 'pending' || job.status === 'running')) {
    return 'active'
  }
  if (segment.selected_stale) return 'stale'
  const job = currentJob(segment)
  if (job && job.status === 'succeeded' && !job.stale && !job.purged) return 'ready'
  if (job && (job.status === 'failed' || job.status === 'interrupted')) return 'failed'
  if (!job && segment.output_error) return 'failed'
  if (segment.attempts.some((item) => item.status === 'failed')) return 'failed'
  return 'missing'
}

export function needsGenerationCount(batch: Batch | null): number {
  if (!batch) return 0
  return batch.segments.filter((segment) => {
    const status = segmentStatus(segment)
    return status === 'stale' || status === 'failed' || status === 'missing'
  }).length
}

export function activeCount(batch: Batch | null): number {
  if (!batch) return 0
  return batch.segments.filter((segment) => segmentStatus(segment) === 'active').length
}

export function jobCanSelect(segment: BatchSegment, job: BatchJob): boolean {
  return (
    job.status === 'succeeded' &&
    !job.stale &&
    !job.purged &&
    job.audio_url !== null &&
    job.input_revision === segment.input_revision
  )
}

export function statusLabel(status: SegmentUiStatus): string {
  switch (status) {
    case 'active':
      return '生成中'
    case 'ready':
      return '已就绪'
    case 'stale':
      return '正文已改'
    case 'failed':
      return '失败'
    default:
      return '待生成'
  }
}

export function processingLabel(mode: Processing['mode']): string {
  switch (mode) {
    case 'article':
      return '文章提取'
    case 'passthrough':
      return '原样直通'
    default:
      return '一行一个音频'
  }
}

export function displayOrigin(origin: string, purpose?: string | null): string {
  const label = !origin || origin === 'workbench' ? '工作台' : origin
  return label + (purpose === 'call' ? ' · 通话' : purpose === 'preview' ? ' · 试听' : '')
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

export function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function formatFullTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

export function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return '长期保留'
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  const remaining = date.getTime() - Date.now()
  if (remaining <= 0) return '保留期已到'
  const days = Math.ceil(remaining / 86_400_000)
  return '剩余 ' + String(days) + ' 天'
}

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '时长未知'
  return seconds.toFixed(2) + ' 秒'
}

export function countCharacters(text: string): number {
  return Array.from(text).length
}

export function countNonemptyLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length
}

export function locateSegmentLine(
  text: string,
  segments: BatchSegment[],
  segmentId: string,
): number {
  const lines = text.split('\n')
  let cursor = 0
  for (const segment of segments) {
    for (let index = cursor; index < lines.length; index += 1) {
      if (lines[index].trim() === segment.text.trim()) {
        if (segment.id === segmentId) return index
        cursor = index + 1
        break
      }
    }
  }
  return -1
}

export function findSegment(segments: BatchSegment[], id: string): BatchSegment | null {
  return segments.find((segment) => segment.id === id) ?? null
}

export function isExternalOrigin(origin: string): boolean {
  return origin !== 'workbench'
}
