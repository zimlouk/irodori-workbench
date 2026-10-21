import { ApiError } from './api'
import {
  parseConfig,
  parseJob,
  parseOverrides,
} from './p2-api'
import type {
  P2Config,
  P2Job,
  P2Overrides,
} from './p2-api'

const API_ROOT = '/api/v1'

export interface SavedReplacementRules { revision:number; persistent_rules:string }
function parseSavedRules(payload:unknown):SavedReplacementRules {
  if(!isRecord(payload)||typeof payload.revision!=='number'||typeof payload.persistent_rules!=='string') {
    throw new ApiError('长期替换规则返回的数据格式不正确。')
  }
  return {revision:payload.revision,persistent_rules:payload.persistent_rules}
}
export async function fetchSavedRules(signal?:AbortSignal):Promise<SavedReplacementRules> {
  return parseSavedRules(await requestJson(API_ROOT+'/replacement-rules',{signal}))
}
export async function saveReplacementRules(input:SavedReplacementRules):Promise<SavedReplacementRules> {
  return parseSavedRules(await requestJson(API_ROOT+'/replacement-rules',{
    method:'PUT',body:JSON.stringify(input),
  }))
}

export async function restoreDeletedSegment(id: string, revision: number, segment_id: string): Promise<Batch> {
  const result = parseBatch(await requestJson(API_ROOT + '/batches/' + id + '/restore-segment', {
    method: 'POST', body: JSON.stringify({revision, segment_id}),
  }))
  if (!result) throw new ApiError('恢复台词返回格式不正确')
  return result
}

export type ProcessingMode = 'article' | 'lines' | 'passthrough'

export interface Processing {
  mode: ProcessingMode
  limit: number
  short: number
  merge_short: boolean
  persistent_rules: string
  temporary_rules: string
  include_double: boolean
}

export interface BatchJob extends P2Job {
  expires_at: string | null
  purged: boolean
}

export interface BatchSegment {
  id: string
  text: string
  overrides: P2Overrides
  input_revision: number
  selected_job_id: string | null
  selected_stale: boolean
  effective_config: P2Config
  attempts: BatchJob[]
  output_path: string | null
  output_error: string | null
}

export interface BatchConflict {
  id: string
  kind: 'source' | 'overrides'
  segment_ids: string[]
  before: string
  after: string
  choices?: {segment_id: string; text: string; overrides: P2Overrides}[]
}

export interface Batch {
  id: string
  revision: number
  source: string
  origin: string
  generation_purpose?: string | null
  created_at: string
  updated_at: string
  config: P2Config
  processing: Processing
  output_dir: string
  segments: BatchSegment[]
  deleted_segments: BatchSegment[]
  conflicts: BatchConflict[]
  warnings: string[]
}

export interface BatchSummary {
  id: string
  origin: string
  generation_purpose?: string | null
  source: string
  preview: string
  updated_at: string
  segment_count: number
  completed_count: number
  active_count: number
}

export interface BatchCreateInput {
  source?: string
  config?: P2Config
  processing?: Processing
  output_dir?: string
}

export interface BatchUpdateInput {
  revision: number
  source?: string
  script?: string
  config?: P2Config
  processing?: Processing
  output_dir?: string
  overrides?: Record<string, P2Overrides>
}

export interface BatchGenerateInput {
  revision: number
  segment_ids?: string[]
  all?: boolean
  reroll?: boolean
}

export interface BatchGenerateResult {
  items: BatchJob[]
  batch_id: string
}

export interface QueueItem {
  id: string
  text: string
  status: P2Job['status']
  mode: P2Job['mode']
  created_at: string
  error: string | null
  audio_url: string | null
  stale: boolean
  expires_at: string | null
  purged: boolean
  workbench_batch_id: string | null
  origin: string
  priority: number
  segment_id: string | null
}

export interface Preferences {
  revision: number
  config: P2Config
  processing: Processing
  output_dir: string
  last_batch_id: string | null
}

export interface PreferencesInput {
  revision: number
  config: P2Config
  processing: Processing
  output_dir: string
  last_batch_id: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function detailMessage(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim()) return detail.trim()
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') return item.trim()
        if (!isRecord(item)) return ''
        return typeof item.msg === 'string'
          ? item.msg.trim()
          : typeof item.message === 'string'
            ? item.message.trim()
            : ''
      })
      .filter((item) => item.length > 0)
    return messages.length > 0 ? [...new Set(messages)].join('；') : null
  }
  if (isRecord(detail)) {
    if (typeof detail.msg === 'string' && detail.msg.trim()) {
      return detail.msg.trim()
    }
    if (typeof detail.message === 'string' && detail.message.trim()) {
      return detail.message.trim()
    }
  }
  return null
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const headers = new Headers(init?.headers)
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  let response: Response
  try {
    response = await fetch(path, { ...init, headers })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new ApiError('无法连接到 Irodori 服务，请确认后端已启动后重试。', undefined, {
      cause: error,
    })
  }

  const raw = await response.text()
  let payload: unknown = null
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as unknown
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const detail = isRecord(payload) ? detailMessage(payload.detail) : null
    const fallback =
      raw.trim() && !raw.trim().startsWith('<') && raw.trim().length <= 600
        ? raw.trim()
        : null
    throw new ApiError(
      detail ?? fallback ?? '请求失败（HTTP ' + String(response.status) + '）。',
      response.status,
    )
  }

  return payload
}

function parseProcessing(value: unknown): Processing | null {
  if (!isRecord(value)) return null
  const mode =
    value.mode === 'article' || value.mode === 'lines' || value.mode === 'passthrough'
      ? value.mode
      : null
  if (!mode) return null
  return {
    mode,
    limit: isFiniteNumber(value.limit) ? value.limit : 120,
    short: isFiniteNumber(value.short) ? value.short : 20,
    merge_short: typeof value.merge_short === 'boolean' ? value.merge_short : true,
    persistent_rules:
      typeof value.persistent_rules === 'string' ? value.persistent_rules : '',
    temporary_rules:
      typeof value.temporary_rules === 'string' ? value.temporary_rules : '',
    include_double:
      typeof value.include_double === 'boolean' ? value.include_double : false,
  }
}

function parseBatchJob(value: unknown): BatchJob | null {
  const job = parseJob(value)
  if (!job || !isRecord(value)) return null
  return {
    ...job,
    expires_at: nullableString(value.expires_at),
    purged: value.purged === true,
  }
}

function parseSegment(value: unknown): BatchSegment | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.input_revision !== 'number' ||
    typeof value.selected_stale !== 'boolean' ||
    !Array.isArray(value.attempts)
  ) {
    return null
  }
  const overrides = parseOverrides(value.overrides)
  const effectiveConfig = parseConfig(value.effective_config)
  if (!overrides || !effectiveConfig) return null
  const attempts = value.attempts.map(parseBatchJob)
  if (attempts.some((job) => job === null)) return null
  return {
    id: value.id,
    text: value.text,
    overrides,
    input_revision: value.input_revision,
    selected_job_id: nullableString(value.selected_job_id),
    selected_stale: value.selected_stale,
    effective_config: effectiveConfig,
    attempts: attempts as BatchJob[],
    output_path: nullableString(value.output_path),
    output_error: nullableString(value.output_error),
  }
}

function parseConflict(value: unknown): BatchConflict | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.kind !== 'source' && value.kind !== 'overrides') ||
    !Array.isArray(value.segment_ids) ||
    !value.segment_ids.every((id) => typeof id === 'string') ||
    typeof value.before !== 'string' ||
    typeof value.after !== 'string'
  ) {
    return null
  }
  return {
    id: value.id,
    kind: value.kind,
    segment_ids: [...value.segment_ids],
    before: value.before,
    after: value.after,
    choices: Array.isArray(value.choices) ? value.choices.filter(isRecord).map(c => ({
      segment_id: String(c.segment_id), text: String(c.text), overrides: parseOverrides(c.overrides) ?? {},
    })) : undefined,
  }
}

export function parseBatch(value: unknown): Batch | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.source !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string' ||
    typeof value.output_dir !== 'string' ||
    !Array.isArray(value.segments) ||
    !Array.isArray(value.conflicts)
  ) {
    return null
  }
  const config = parseConfig(value.config)
  const processing = parseProcessing(value.processing)
  if (!config || !processing) return null
  const segments = value.segments.map(parseSegment)
  const conflicts = value.conflicts.map(parseConflict)
  if (segments.some((item) => item === null)) return null
  if (conflicts.some((item) => item === null)) return null
  return {
    id: value.id,
    revision: value.revision,
    source: value.source,
    origin: value.origin,
    generation_purpose: nullableString(value.generation_purpose),
    created_at: value.created_at,
    updated_at: value.updated_at,
    config,
    processing,
    output_dir: value.output_dir,
    segments: segments as BatchSegment[],
    deleted_segments: Array.isArray(value.deleted_segments) ? value.deleted_segments.map(parseSegment).filter((s): s is BatchSegment => s !== null) : [],
    conflicts: conflicts as BatchConflict[],
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((item): item is string => typeof item === 'string')
      : [],
  }
}

function parseSummary(value: unknown): BatchSummary | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.origin !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.preview !== 'string' ||
    typeof value.updated_at !== 'string' ||
    typeof value.segment_count !== 'number' ||
    typeof value.completed_count !== 'number' ||
    typeof value.active_count !== 'number'
  ) {
    return null
  }
  return {
    id: value.id,
    origin: value.origin,
    generation_purpose: nullableString(value.generation_purpose),
    source: value.source,
    preview: value.preview,
    updated_at: value.updated_at,
    segment_count: value.segment_count,
    completed_count: value.completed_count,
    active_count: value.active_count,
  }
}

function parseQueueItem(value: unknown): QueueItem | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.created_at !== 'string'
  ) {
    return null
  }
  const parsed = parseJob(value)
  if (!parsed) return null
  return {
    id: parsed.id,
    text: parsed.text,
    status: parsed.status,
    mode: parsed.mode,
    created_at: parsed.created_at,
    error: parsed.error,
    audio_url: parsed.audio_url,
    stale: value.stale === true,
    expires_at: nullableString(value.expires_at),
    purged: value.purged === true,
    workbench_batch_id: nullableString(value.workbench_batch_id),
    origin: typeof value.origin === 'string' ? value.origin : '',
    priority: isFiniteNumber(value.priority) ? value.priority : 0,
    segment_id: nullableString(value.segment_id),
  }
}

function parsePreferences(value: unknown): Preferences | null {
  if (
    !isRecord(value) ||
    typeof value.revision !== 'number' ||
    typeof value.output_dir !== 'string'
  ) {
    return null
  }
  const config = parseConfig(value.config)
  const processing = parseProcessing(value.processing)
  if (!config || !processing) return null
  if (value.last_batch_id !== null && typeof value.last_batch_id !== 'string') {
    return null
  }
  return {
    revision: value.revision,
    config,
    processing,
    output_dir: value.output_dir,
    last_batch_id: value.last_batch_id,
  }
}

export async function fetchBatches(
  search = '',
  signal?: AbortSignal,
): Promise<BatchSummary[]> {
  const query = new URLSearchParams()
  if (search.trim()) query.set('search', search.trim())
  const suffix = query.size > 0 ? '?' + query.toString() : ''
  const payload = await requestJson(API_ROOT + '/batches' + suffix, { signal })
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError('批次列表返回的数据格式不正确。')
  }
  const items = payload.items.map(parseSummary)
  if (items.some((item) => item === null)) {
    throw new ApiError('批次列表中含有无法识别的数据。')
  }
  return items as BatchSummary[]
}

export async function fetchBatch(id: string, signal?: AbortSignal): Promise<Batch> {
  const payload = await requestJson(API_ROOT + '/batches/' + encodeURIComponent(id), {
    signal,
  })
  const batch = parseBatch(payload)
  if (!batch) throw new ApiError('批次详情返回的数据格式不正确。')
  return batch
}

export async function createBatch(
  input: BatchCreateInput,
  signal?: AbortSignal,
): Promise<Batch> {
  const payload = await requestJson(API_ROOT + '/batches', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  })
  const batch = parseBatch(payload)
  if (!batch) throw new ApiError('新建批次接口返回的数据格式不正确。')
  return batch
}

export async function updateBatch(
  id: string,
  input: BatchUpdateInput,
  signal?: AbortSignal,
): Promise<Batch> {
  const payload = await requestJson(API_ROOT + '/batches/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  })
  const batch = parseBatch(payload)
  if (!batch) throw new ApiError('保存批次接口返回的数据格式不正确。')
  return batch
}

export async function resolveBatchConflict(
  id: string,
  input: {
    revision: number
    conflict_id: string
    choice: 'keep' | 'replace'
    segment_id?: string
  },
  signal?: AbortSignal,
): Promise<Batch> {
  const payload = await requestJson(
    API_ROOT + '/batches/' + encodeURIComponent(id) + '/resolve',
    { method: 'POST', body: JSON.stringify(input), signal },
  )
  const batch = parseBatch(payload)
  if (!batch) throw new ApiError('冲突处理接口返回的数据格式不正确。')
  return batch
}

export async function generateBatch(
  id: string,
  input: BatchGenerateInput,
  signal?: AbortSignal,
): Promise<BatchGenerateResult> {
  const payload = await requestJson(
    API_ROOT + '/batches/' + encodeURIComponent(id) + '/generate',
    { method: 'POST', body: JSON.stringify(input), signal },
  )
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    typeof payload.batch_id !== 'string'
  ) {
    throw new ApiError('生成接口返回的数据格式不正确。')
  }
  const items = payload.items.map(parseBatchJob)
  if (items.some((item) => item === null)) {
    throw new ApiError('生成接口返回的任务数据无法识别。')
  }
  return { items: items as BatchJob[], batch_id: payload.batch_id }
}

export async function cancelBatch(
  id: string,
  signal?: AbortSignal,
): Promise<number> {
  const payload = await requestJson(
    API_ROOT + '/batches/' + encodeURIComponent(id) + '/cancel',
    { method: 'POST', body: JSON.stringify({}), signal },
  )
  if (!isRecord(payload) || typeof payload.cancelled !== 'number') {
    throw new ApiError('取消任务接口返回的数据格式不正确。')
  }
  return payload.cancelled
}

export async function selectBatchJob(
  id: string,
  segmentId: string,
  revision: number,
  jobId: string,
  signal?: AbortSignal,
): Promise<Batch> {
  const payload = await requestJson(
    API_ROOT +
      '/batches/' +
      encodeURIComponent(id) +
      '/segments/' +
      encodeURIComponent(segmentId) +
      '/select',
    {
      method: 'POST',
      body: JSON.stringify({ revision, job_id: jobId }),
      signal,
    },
  )
  const batch = parseBatch(payload)
  if (!batch) throw new ApiError('选择版本接口返回的数据格式不正确。')
  return batch
}

export async function openBatchOutput(
  id: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const payload = await requestJson(
    API_ROOT + '/batches/' + encodeURIComponent(id) + '/open-output',
    { method: 'POST', body: JSON.stringify({}), signal },
  )
  if (!isRecord(payload) || typeof payload.opened !== 'boolean') {
    throw new ApiError('打开输出目录接口返回的数据格式不正确。')
  }
  return payload.opened
}

export async function openSegmentOutput(id: string, segmentId: string): Promise<void> {
  const payload = await requestJson(
    API_ROOT + '/batches/' + encodeURIComponent(id) + '/segments/' +
      encodeURIComponent(segmentId) + '/open-output',
    { method: 'POST', body: JSON.stringify({}) },
  )
  if (!isRecord(payload) || payload.opened !== true) {
    throw new ApiError('打开音频目录接口返回的数据格式不正确。')
  }
}

export async function fetchQueue(signal?: AbortSignal): Promise<QueueItem[]> {
  const payload = await requestJson(API_ROOT + '/queue', { signal })
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError('队列返回的数据格式不正确。')
  }
  const items = payload.items.map(parseQueueItem)
  if (items.some((item) => item === null)) {
    throw new ApiError('队列中含有无法识别的任务数据。')
  }
  return items as QueueItem[]
}

export async function fetchPreferences(
  signal?: AbortSignal,
): Promise<Preferences> {
  const payload = await requestJson(API_ROOT + '/preferences', { signal })
  const preferences = parsePreferences(payload)
  if (!preferences) throw new ApiError('偏好设置返回的数据格式不正确。')
  return preferences
}

export async function savePreferences(
  input: PreferencesInput,
  signal?: AbortSignal,
): Promise<Preferences> {
  const payload = await requestJson(API_ROOT + '/preferences', {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  })
  const preferences = parsePreferences(payload)
  if (!preferences) throw new ApiError('保存偏好设置接口返回的数据格式不正确。')
  return preferences
}
