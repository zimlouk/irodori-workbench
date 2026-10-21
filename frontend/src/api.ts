import type {
  Asset,
  CreateJobInput,
  InferenceCapabilities,
  Job,
  JobMode,
  JobReferenceSummary,
  JobResultMetadata,
  JobStatus,
  Lora,
  ServiceStatus,
} from './types'

const API_ROOT = '/api/v1'

export const MAX_ASSET_BYTES = 30 * 1024 * 1024
export const MAX_TEXT_LENGTH = 4096

const JOB_STATUSES = new Set<JobStatus>([
  'pending',
  'running',
  'succeeded',
  'failed',
  'interrupted',
  'cancelled',
])

const FIELD_LABELS: Record<string, string> = {
  text: '文本内容',
  lora_id: '模型',
  reference_asset_ids: '参考素材',
  caption: 'Caption',
  num_steps: '步数',
  seed: 'seed',
  max_ref_seconds: '参考上限',
  file: '文件',
}

export class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApiError'
    this.status = status
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return '发生了未知错误，请稍后重试。'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && JOB_STATUSES.has(value as JobStatus)
}

function isJobMode(value: unknown): value is JobMode {
  return value === 'fake' || value === 'irodori'
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeResultMetadata(value: unknown): JobResultMetadata | null {
  if (!isRecord(value)) {
    return null
  }

  const metadata: JobResultMetadata = {}

  if (isFiniteNumber(value.used_seed) || typeof value.used_seed === 'string') {
    metadata.used_seed = value.used_seed
  }
  if (isFiniteNumber(value.sample_rate)) {
    metadata.sample_rate = value.sample_rate
  }
  if (isFiniteNumber(value.audio_seconds)) {
    metadata.audio_seconds = value.audio_seconds
  }
  if (Array.isArray(value.messages)) {
    metadata.messages = value.messages.filter(
      (message): message is string => typeof message === 'string',
    )
  }

  if (isRecord(value.reference_summary)) {
    const summary = value.reference_summary
    if (
      isFiniteNumber(summary.selected_count) &&
      (summary.encoded_count === null || isFiniteNumber(summary.encoded_count)) &&
      (summary.max_ref_seconds === null ||
        isFiniteNumber(summary.max_ref_seconds))
    ) {
      const referenceSummary: JobReferenceSummary = {
        selected_count: summary.selected_count,
        encoded_count: summary.encoded_count as number | null,
        max_ref_seconds: summary.max_ref_seconds as number | null,
      }
      metadata.reference_summary = referenceSummary
    }
  }

  if (isRecord(value.effective_config)) {
    metadata.effective_config = value.effective_config
  }

  return metadata
}

function parseJob(value: unknown): Job | null {
  if (!isRecord(value)) {
    return null
  }

  if (
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    !isJobStatus(value.status) ||
    !isJobMode(value.mode) ||
    typeof value.created_at !== 'string' ||
    !isNullableString(value.error) ||
    !isNullableString(value.audio_url)
  ) {
    return null
  }

  if (
    value.request_config !== undefined &&
    value.request_config !== null &&
    !isRecord(value.request_config)
  ) {
    return null
  }
  if (
    value.result_metadata !== undefined &&
    value.result_metadata !== null &&
    !isRecord(value.result_metadata)
  ) {
    return null
  }

  return {
    id: value.id,
    text: value.text,
    status: value.status,
    mode: value.mode,
    created_at: value.created_at,
    error: value.error,
    audio_url: value.audio_url,
    request_config: isRecord(value.request_config) ? value.request_config : null,
    result_metadata: normalizeResultMetadata(value.result_metadata),
  }
}

function parseCapabilities(value: unknown): InferenceCapabilities | undefined {
  if (!isRecord(value) || !isRecord(value.defaults) || !isRecord(value.runtime)) {
    return undefined
  }

  const defaults = value.defaults
  const runtime = value.runtime

  if (
    value.protocol_version !== 1 ||
    value.multi_reference !== true ||
    value.managed_synthesis !== true ||
    typeof value.model !== 'string' ||
    !(defaults.max_ref_seconds === null || isFiniteNumber(defaults.max_ref_seconds)) ||
    typeof runtime.loaded !== 'boolean' ||
    typeof runtime.loading !== 'boolean' ||
    typeof runtime.busy !== 'boolean'
  ) {
    return undefined
  }

  return {
    protocol_version: 1,
    multi_reference: true,
    managed_synthesis: true,
    model: value.model,
    defaults: {
      max_ref_seconds: defaults.max_ref_seconds as number | null,
    },
    runtime: {
      loaded: runtime.loaded,
      loading: runtime.loading,
      busy: runtime.busy,
    },
  }
}

function parseServiceStatus(value: unknown): ServiceStatus | null {
  if (!isRecord(value) || !isRecord(value.inference)) {
    return null
  }

  if (
    typeof value.service !== 'string' ||
    !isJobMode(value.mode) ||
    typeof value.database !== 'string' ||
    typeof value.inference.available !== 'boolean' ||
    typeof value.inference.kind !== 'string' ||
    typeof value.version !== 'string'
  ) {
    return null
  }

  const inference: ServiceStatus['inference'] = {
    available: value.inference.available,
    kind: value.inference.kind,
  }

  if (
    typeof value.inference.error === 'string' &&
    value.inference.error.trim()
  ) {
    inference.error = value.inference.error.trim()
  }

  const capabilities = parseCapabilities(value.inference.capabilities)
  if (capabilities) {
    inference.capabilities = capabilities
  }

  return {
    service: value.service,
    mode: value.mode,
    database: value.database,
    inference,
    version: value.version,
  }
}

function parseLora(value: unknown): Lora | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.available !== 'boolean'
  ) {
    return null
  }
  return { id: value.id, name: value.name, available: value.available,
    model_version: typeof value.model_version === 'string' ? value.model_version : undefined,
    checkpoint: typeof value.checkpoint === 'string' ? value.checkpoint : undefined,
    relative_path: typeof value.relative_path === 'string' ? value.relative_path : undefined,
    family: typeof value.family === 'string' ? value.family : undefined }
}

function parseAsset(value: unknown): Asset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !isFiniteNumber(value.duration_seconds) ||
    !isFiniteNumber(value.sample_rate) ||
    !isFiniteNumber(value.channels) ||
    typeof value.audio_url !== 'string'
  ) {
    return null
  }

  return {
    id: value.id,
    name: value.name,
    duration_seconds: value.duration_seconds,
    sample_rate: value.sample_rate,
    channels: value.channels,
    audio_url: value.audio_url,
  }
}

function locationLabel(location: unknown): string {
  if (!Array.isArray(location)) {
    return ''
  }

  const fields = location
    .filter((part): part is string => typeof part === 'string')
    .filter((part) => part !== 'body' && part !== 'query' && part !== 'path')

  const field = fields[fields.length - 1]
  if (!field) {
    return ''
  }
  return FIELD_LABELS[field] ?? field
}

function detailMessage(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim()
  }

  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) => {
        if (typeof item === 'string') {
          return item.trim()
        }
        if (!isRecord(item)) {
          return ''
        }

        const message =
          typeof item.msg === 'string'
            ? item.msg
            : typeof item.message === 'string'
              ? item.message
              : ''
        const prefix = locationLabel(item.loc)

        if (!message.trim()) {
          return ''
        }
        return prefix ? prefix + '：' + message.trim() : message.trim()
      })
      .filter((message) => message.length > 0)

    const uniqueMessages = [...new Set(messages)]
    return uniqueMessages.length > 0 ? uniqueMessages.join('；') : null
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

function plainTextMessage(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('<') || trimmed.length > 600) {
    return null
  }
  return trimmed
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
    if (isAbortError(error)) {
      throw error
    }
    throw new ApiError(
      '无法连接到 Irodori 服务，请确认后端已启动后重试。',
      undefined,
      { cause: error },
    )
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
    const fallback = detail ? null : plainTextMessage(raw)
    throw new ApiError(
      detail
        ? '请求未完成：' + detail
        : fallback
          ? '请求未完成：' + fallback
          : '请求失败（HTTP ' + String(response.status) + '）。',
      response.status,
    )
  }

  return payload
}

export async function fetchStatus(signal?: AbortSignal): Promise<ServiceStatus> {
  const payload = await requestJson(API_ROOT + '/status', { signal })
  const status = parseServiceStatus(payload)
  if (!status) {
    throw new ApiError('服务状态返回的数据格式不正确。')
  }
  return status
}

export async function fetchLoras(signal?: AbortSignal): Promise<Lora[]> {
  const payload = await requestJson(API_ROOT + '/loras', { signal })
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError('模型列表返回的数据格式不正确。')
  }

  const items = payload.items.map(parseLora)
  if (items.some((item) => item === null)) {
    throw new ApiError('模型列表中含有无法识别的数据。')
  }
  return items as Lora[]
}

export async function fetchAssets(signal?: AbortSignal): Promise<Asset[]> {
  const payload = await requestJson(API_ROOT + '/assets', { signal })
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError('素材列表返回的数据格式不正确。')
  }

  const items = payload.items.map(parseAsset)
  if (items.some((item) => item === null)) {
    throw new ApiError('素材列表中含有无法识别的数据。')
  }
  return items as Asset[]
}

export async function uploadAsset(
  file: File,
  signal?: AbortSignal,
): Promise<Asset> {
  const body = new FormData()
  body.append('file', file)

  const payload = await requestJson(API_ROOT + '/assets', {
    method: 'POST',
    body,
    signal,
  })
  const asset = parseAsset(payload)
  if (!asset) {
    throw new ApiError('上传接口返回的素材数据格式不正确。')
  }
  return asset
}

export async function fetchJobs(
  signal?: AbortSignal,
): Promise<Job[]> {
  const payload = await requestJson(API_ROOT + '/jobs', { signal })
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new ApiError('任务列表返回的数据格式不正确。')
  }

  const items = payload.items.map(parseJob)
  if (items.some((item) => item === null)) {
    throw new ApiError('任务列表中含有无法识别的任务数据。')
  }
  return items as Job[]
}

export async function createJob(
  input: CreateJobInput,
  signal?: AbortSignal,
): Promise<Job> {
  const payload = await requestJson(API_ROOT + '/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  })

  const job = parseJob(payload)
  if (!job) {
    throw new ApiError('服务返回的任务数据格式不正确。')
  }
  return job
}
