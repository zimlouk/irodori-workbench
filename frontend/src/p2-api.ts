import type { Asset, Lora } from './types'
import { loraLabel } from './lora-label'
import { ApiError } from './api'
import type { AdvancedParameters } from './voice-parameters'
import { parseAdvanced } from './voice-parameters'

const API_ROOT = '/api/v1'

export const P2_MAX_SEGMENTS = 500
export const P2_SEED_MAX = 9223372036854775807n

export type P2JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type P2JobMode = 'fake' | 'irodori'

export interface P2ConfigParameters extends AdvancedParameters {
  num_steps: number
  seed: string | null
  max_ref_seconds: number | null
}

export interface P2Config {
  lora_id: string | null
  reference_asset_ids: string[]
  caption: string
  parameters: P2ConfigParameters
}

export interface P2Overrides {
  lora_id?: string | null
  reference_asset_ids?: string[]
  caption?: string
  parameters?: Partial<P2ConfigParameters>
}

export interface P2Preset {
  id: string
  voice_name: string
  name: string
  version: number
  config: P2Config
  created_at: string
  updated_at: string
  work?: string
}

export interface P2PresetInput {
  voice_name: string
  name: string
  config: P2Config
}

export interface P2PresetUpdate extends P2PresetInput {
  version: number
}

export interface P2JobResultMetadata {
  used_seed?: string | number
  sample_rate?: number
  audio_seconds?: number
  messages?: string[]
  reference_summary?: {
    selected_count: number
    encoded_count: number | null
    max_ref_seconds: number | null
  }
  effective_config?: Record<string, unknown>
}

export interface P2Job {
  id: string
  text: string
  status: P2JobStatus
  mode: P2JobMode
  created_at: string
  error: string | null
  audio_url: string | null
  request_config: Record<string, unknown> | null
  result_metadata: P2JobResultMetadata | null
  project_id: string
  segment_id: string
  input_revision: number
  batch_id: string | null
  stale: boolean
}

export interface P2SegmentSnapshot {
  preset_id: string | null
  preset_version: number | null
  config: P2Config
}

export interface P2Segment {
  id: string
  text: string
  speaker: string
  preset_id: string | null
  snapshot: P2SegmentSnapshot
  overrides: P2Overrides
  effective_config: P2Config
  input_revision: number
  selected_job_id: string | null
  selected_stale: boolean
  attempts: P2Job[]
}

export interface P2Project {
  id: string
  name: string
  revision: number
  default_preset_id: string | null
  default_snapshot: P2SegmentSnapshot
  segments: P2Segment[]
  created_at: string
  updated_at: string
}

export interface P2ProjectSummary {
  id: string
  name: string
  revision: number
  updated_at: string
  segment_count: number
}

export interface P2ProjectSegmentInput {
  id?: string
  text: string
  speaker: string
  preset_id: string | null
  overrides: P2Overrides
}

export interface P2SaveProjectInput {
  revision: number
  name: string
  default_preset_id: string | null
  segments: P2ProjectSegmentInput[]
}

export interface P2GenerateInput {
  revision: number
  segment_ids?: string[]
}

export interface P2GenerateResult {
  items: P2Job[]
  batch_id: string
}

export interface P2PresetChange {
  segment_id: string
  preset_id: string
  from_version: number
  to_version: number
  before: P2Config
  after: P2Config
}

export interface P2PresetPreview {
  revision: number
  changes: P2PresetChange[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStatus(value: unknown): value is P2JobStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'interrupted' ||
    value === 'cancelled'
  )
}

function isMode(value: unknown): value is P2JobMode {
  return value === 'fake' || value === 'irodori'
}

function parseSeed(value: unknown): string | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  return undefined
}

export function parseConfig(value: unknown): P2Config | null {
  if (!isRecord(value) || !isRecord(value.parameters)) {
    return null
  }
  if (
    !isNullableString(value.lora_id) ||
    !Array.isArray(value.reference_asset_ids) ||
    !value.reference_asset_ids.every((item) => typeof item === 'string') ||
    typeof value.caption !== 'string'
  ) {
    return null
  }

  const parameters = value.parameters
  const advanced = parseAdvanced(parameters)
  if (!advanced) return null
  const seed = parseSeed(parameters.seed)
  if (
    typeof parameters.num_steps !== 'number' ||
    !Number.isInteger(parameters.num_steps) ||
    seed === undefined ||
    !(
      parameters.max_ref_seconds === null ||
      isFiniteNumber(parameters.max_ref_seconds)
    )
  ) {
    return null
  }

  return {
    lora_id: value.lora_id,
    reference_asset_ids: [...value.reference_asset_ids],
    caption: value.caption,
    parameters: {
      ...advanced,
      num_steps: parameters.num_steps,
      seed,
      max_ref_seconds: parameters.max_ref_seconds as number | null,
    },
  }
}

export function parseOverrides(value: unknown): P2Overrides | null {
  if (!isRecord(value)) {
    return null
  }

  const overrides: P2Overrides = {}

  if (hasOwn(value, 'lora_id')) {
    if (!isNullableString(value.lora_id)) {
      return null
    }
    overrides.lora_id = value.lora_id
  }
  if (hasOwn(value, 'reference_asset_ids')) {
    if (
      !Array.isArray(value.reference_asset_ids) ||
      !value.reference_asset_ids.every((item) => typeof item === 'string')
    ) {
      return null
    }
    overrides.reference_asset_ids = [...value.reference_asset_ids]
  }
  if (hasOwn(value, 'caption')) {
    if (typeof value.caption !== 'string') {
      return null
    }
    overrides.caption = value.caption
  }
  if (hasOwn(value, 'parameters')) {
    if (!isRecord(value.parameters)) {
      return null
    }
    const advanced = parseAdvanced(value.parameters)
    if (!advanced) return null
    const parameters: NonNullable<P2Overrides['parameters']> = { ...advanced }
    if (hasOwn(value.parameters, 'num_steps')) {
      if (
        typeof value.parameters.num_steps !== 'number' ||
        !Number.isInteger(value.parameters.num_steps)
      ) {
        return null
      }
      parameters.num_steps = value.parameters.num_steps
    }
    if (hasOwn(value.parameters, 'seed')) {
      const seed = parseSeed(value.parameters.seed)
      if (seed === undefined) {
        return null
      }
      parameters.seed = seed
    }
    if (hasOwn(value.parameters, 'max_ref_seconds')) {
      if (
        !(
          value.parameters.max_ref_seconds === null ||
          isFiniteNumber(value.parameters.max_ref_seconds)
        )
      ) {
        return null
      }
      parameters.max_ref_seconds = value.parameters.max_ref_seconds as
        | number
        | null
    }
    overrides.parameters = parameters
  }

  return overrides
}

function parseSnapshot(value: unknown): P2SegmentSnapshot | null {
  if (!isRecord(value)) {
    return null
  }
  const config = parseConfig(value.config)
  if (
    !config ||
    !isNullableString(value.preset_id) ||
    !(
      value.preset_version === null ||
      (typeof value.preset_version === 'number' &&
        Number.isInteger(value.preset_version))
    )
  ) {
    return null
  }
  return {
    preset_id: value.preset_id,
    preset_version: value.preset_version as number | null,
    config,
  }
}

function parseMetadata(value: unknown): P2JobResultMetadata | null {
  if (!isRecord(value)) {
    return null
  }
  const metadata: P2JobResultMetadata = {}
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
      (item): item is string => typeof item === 'string',
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
      metadata.reference_summary = {
        selected_count: summary.selected_count,
        encoded_count: summary.encoded_count as number | null,
        max_ref_seconds: summary.max_ref_seconds as number | null,
      }
    }
  }
  if (isRecord(value.effective_config)) {
    metadata.effective_config = value.effective_config
  }
  return metadata
}

export function parseJob(value: unknown): P2Job | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    !isStatus(value.status) ||
    !isMode(value.mode) ||
    typeof value.created_at !== 'string' ||
    !isNullableString(value.error) ||
    !isNullableString(value.audio_url)
  ) {
    return null
  }
  if (
    value.request_config !== null &&
    value.request_config !== undefined &&
    !isRecord(value.request_config)
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
    result_metadata: parseMetadata(value.result_metadata),
    project_id: typeof value.project_id === 'string' ? value.project_id : '',
    segment_id: typeof value.segment_id === 'string' ? value.segment_id : '',
    input_revision:
      typeof value.input_revision === 'number' &&
      Number.isInteger(value.input_revision)
        ? value.input_revision
        : -1,
    batch_id: typeof value.batch_id === 'string' ? value.batch_id : null,
    stale: value.stale === true,
  }
}

function parseSegment(value: unknown): P2Segment | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.speaker !== 'string' ||
    !isNullableString(value.preset_id) ||
    typeof value.input_revision !== 'number' ||
    !isNullableString(value.selected_job_id) ||
    typeof value.selected_stale !== 'boolean' ||
    !Array.isArray(value.attempts)
  ) {
    return null
  }

  const snapshot = parseSnapshot(value.snapshot)
  const overrides = parseOverrides(value.overrides)
  const effectiveConfig = parseConfig(value.effective_config)
  if (!snapshot || !overrides || !effectiveConfig) {
    return null
  }
  const jobs = value.attempts.map(parseJob)
  if (jobs.some((job) => job === null)) {
    return null
  }

  return {
    id: value.id,
    text: value.text,
    speaker: value.speaker,
    preset_id: value.preset_id,
    snapshot,
    overrides,
    effective_config: effectiveConfig,
    input_revision: value.input_revision,
    selected_job_id: value.selected_job_id,
    selected_stale: value.selected_stale,
    attempts: jobs as P2Job[],
  }
}

export function parseProject(value: unknown): P2Project | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.revision !== 'number' ||
    !isNullableString(value.default_preset_id) ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string' ||
    !Array.isArray(value.segments)
  ) {
    return null
  }
  const defaultSnapshot = parseSnapshot(value.default_snapshot)
  if (!defaultSnapshot) {
    return null
  }
  const segments = value.segments.map(parseSegment)
  if (segments.some((segment) => segment === null)) {
    return null
  }
  return {
    id: value.id,
    name: value.name,
    revision: value.revision,
    default_preset_id: value.default_preset_id,
    default_snapshot: defaultSnapshot,
    segments: segments as P2Segment[],
    created_at: value.created_at,
    updated_at: value.updated_at,
  }
}

function parsePreset(value: unknown): P2Preset | null {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.voice_name !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.version !== 'number' ||
    typeof value.created_at !== 'string' ||
    typeof value.updated_at !== 'string'
  ) {
    return null
  }
  const config = parseConfig(value.config)
  if (!config) {
    return null
  }
  return {
    id: value.id,
    voice_name: value.voice_name,
    name: value.name,
    version: value.version,
    work: typeof value.work === 'string' ? value.work : '其他',
    config,
    created_at: value.created_at,
    updated_at: value.updated_at,
  }
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

function detailMessage(detail: unknown): string | null {
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim()
  }
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
      .filter((message) => message.length > 0)
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
    const generic = raw.trim() && raw.trim().length < 600 ? raw.trim() : null
    throw new ApiError(
      detail ?? generic ?? '请求失败（HTTP ' + String(response.status) + '）。',
      response.status,
    )
  }

  return payload
}

function itemsOf(payload: unknown): unknown[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return null
  }
  return payload.items
}

function parsePresetCatalog(payload: unknown): {items: P2Preset[]; revision: string} {
  const items = itemsOf(payload)
  if (!items) {
    throw new ApiError('预设列表返回的数据格式不正确。')
  }
  const presets = items.map(parsePreset)
  if (presets.some((preset) => preset === null)) {
    throw new ApiError('预设列表中含有无法识别的数据。')
  }
  if (!isRecord(payload) || typeof payload.order_revision !== 'string') {
    throw new ApiError('预设排序版本缺失，请刷新页面。')
  }
  return {items:presets as P2Preset[],revision:payload.order_revision}
}

export async function fetchPresetCatalog(signal?: AbortSignal) {
  return parsePresetCatalog(await requestJson(API_ROOT+'/presets',{signal}))
}

export async function fetchPresets(signal?: AbortSignal): Promise<P2Preset[]> {
  return (await fetchPresetCatalog(signal)).items
}

export async function reorderPresets(revision: string, ids: string[] | null) {
  return parsePresetCatalog(await requestJson(API_ROOT+'/presets/order',{
    method:'PUT',body:JSON.stringify({revision,ids}),
  }))
}

export async function createPreset(
  input: P2PresetInput,
  signal?: AbortSignal,
): Promise<P2Preset> {
  const payload = await requestJson(API_ROOT + '/presets', {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  })
  const preset = parsePreset(payload)
  if (!preset) {
    throw new ApiError('创建预设接口返回的数据格式不正确。')
  }
  return preset
}

export async function updatePreset(
  id: string,
  input: P2PresetUpdate,
  signal?: AbortSignal,
): Promise<P2Preset> {
  const payload = await requestJson(API_ROOT + '/presets/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  })
  const preset = parsePreset(payload)
  if (!preset) {
    throw new ApiError('更新预设接口返回的数据格式不正确。')
  }
  return preset
}

export async function deletePreset(
  id: string,
  version: number,
): Promise<void> {
  const payload = await requestJson(
    API_ROOT +
      '/presets/' +
      encodeURIComponent(id) +
      '?version=' +
      String(version),
    { method: 'DELETE' },
  )
  if (!isRecord(payload) || payload.deleted !== true) {
    throw new ApiError('删除预设接口返回的数据格式不正确。')
  }
}

export async function renameAsset(
  id: string,
  name: string,
  signal?: AbortSignal,
): Promise<Asset> {
  const payload = await requestJson(API_ROOT + '/assets/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify({ name }),
    signal,
  })
  const asset = parseAsset(payload)
  if (!asset) {
    throw new ApiError('素材改名接口返回的数据格式不正确。')
  }
  return asset
}

export async function fetchProjects(
  signal?: AbortSignal,
): Promise<P2ProjectSummary[]> {
  const payload = await requestJson(API_ROOT + '/projects', { signal })
  const items = itemsOf(payload)
  if (!items) {
    throw new ApiError('项目列表返回的数据格式不正确。')
  }
  const projects: P2ProjectSummary[] = []
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.revision !== 'number' ||
      typeof item.updated_at !== 'string' ||
      typeof item.segment_count !== 'number'
    ) {
      throw new ApiError('项目列表中含有无法识别的数据。')
    }
    projects.push({
      id: item.id,
      name: item.name,
      revision: item.revision,
      updated_at: item.updated_at,
      segment_count: item.segment_count,
    })
  }
  return projects
}

export async function createProject(
  name: string,
  defaultPresetId: string | null,
  signal?: AbortSignal,
): Promise<P2Project> {
  const payload = await requestJson(API_ROOT + '/projects', {
    method: 'POST',
    body: JSON.stringify({ name, default_preset_id: defaultPresetId }),
    signal,
  })
  const project = parseProject(payload)
  if (!project) {
    throw new ApiError('创建项目接口返回的数据格式不正确。')
  }
  return project
}

export async function fetchProject(
  id: string,
  signal?: AbortSignal,
): Promise<P2Project> {
  const payload = await requestJson(API_ROOT + '/projects/' + encodeURIComponent(id), {
    signal,
  })
  const project = parseProject(payload)
  if (!project) {
    throw new ApiError('项目详情返回的数据格式不正确。')
  }
  return project
}

export async function saveProject(
  id: string,
  input: P2SaveProjectInput,
  signal?: AbortSignal,
): Promise<P2Project> {
  const payload = await requestJson(API_ROOT + '/projects/' + encodeURIComponent(id), {
    method: 'PUT',
    body: JSON.stringify(input),
    signal,
  })
  const project = parseProject(payload)
  if (!project) {
    throw new ApiError('保存项目接口返回的数据格式不正确。')
  }
  return project
}

export async function generateProject(
  id: string,
  input: P2GenerateInput,
  signal?: AbortSignal,
): Promise<P2GenerateResult> {
  const payload = await requestJson(
    API_ROOT + '/projects/' + encodeURIComponent(id) + '/generate',
    { method: 'POST', body: JSON.stringify(input), signal },
  )
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    typeof payload.batch_id !== 'string'
  ) {
    throw new ApiError('生成接口返回的数据格式不正确。')
  }
  const items = payload.items.map(parseJob)
  if (items.some((job) => job === null)) {
    throw new ApiError('生成接口返回的任务数据无法识别。')
  }
  return { items: items as P2Job[], batch_id: payload.batch_id }
}

export async function cancelProjectTasks(
  id: string,
  batchId?: string,
  signal?: AbortSignal,
): Promise<number> {
  const payload = await requestJson(
    API_ROOT + '/projects/' + encodeURIComponent(id) + '/cancel',
    {
      method: 'POST',
      body: JSON.stringify(batchId ? { batch_id: batchId } : {}),
      signal,
    },
  )
  if (!isRecord(payload) || typeof payload.cancelled !== 'number') {
    throw new ApiError('取消任务接口返回的数据格式不正确。')
  }
  return payload.cancelled
}

export async function selectProjectJob(
  projectId: string,
  segmentId: string,
  revision: number,
  jobId: string,
  signal?: AbortSignal,
): Promise<P2Project> {
  const payload = await requestJson(
    API_ROOT +
      '/projects/' +
      encodeURIComponent(projectId) +
      '/segments/' +
      encodeURIComponent(segmentId) +
      '/select',
    {
      method: 'POST',
      body: JSON.stringify({ revision, job_id: jobId }),
      signal,
    },
  )
  const project = parseProject(payload)
  if (!project) {
    throw new ApiError('选择版本接口返回的数据格式不正确。')
  }
  return project
}

export async function previewProjectPresets(
  id: string,
  revision: number,
  segmentIds: string[],
  signal?: AbortSignal,
): Promise<P2PresetPreview> {
  const payload = await requestJson(
    API_ROOT + '/projects/' + encodeURIComponent(id) + '/preset-preview',
    {
      method: 'POST',
      body: JSON.stringify({ revision, segment_ids: segmentIds }),
      signal,
    },
  )
  if (!isRecord(payload) || typeof payload.revision !== 'number') {
    throw new ApiError('预设预览接口返回的数据格式不正确。')
  }
  if (!Array.isArray(payload.changes)) {
    throw new ApiError('预设预览接口缺少变更列表。')
  }
  const changes: P2PresetChange[] = []
  for (const item of payload.changes) {
    if (
      !isRecord(item) ||
      typeof item.segment_id !== 'string' ||
      typeof item.preset_id !== 'string' ||
      typeof item.from_version !== 'number' ||
      typeof item.to_version !== 'number'
    ) {
      throw new ApiError('预设预览中含有无法识别的变更。')
    }
    const before = parseConfig(item.before)
    const after = parseConfig(item.after)
    if (!before || !after) {
      throw new ApiError('预设预览中的配置无法识别。')
    }
    changes.push({
      segment_id: item.segment_id,
      preset_id: item.preset_id,
      from_version: item.from_version,
      to_version: item.to_version,
      before,
      after,
    })
  }
  return { revision: payload.revision, changes }
}

export async function applyProjectPresets(
  id: string,
  revision: number,
  versions: Record<string, number>,
  segmentIds: string[],
  signal?: AbortSignal,
): Promise<P2Project> {
  const payload = await requestJson(
    API_ROOT + '/projects/' + encodeURIComponent(id) + '/apply-presets',
    {
      method: 'POST',
      body: JSON.stringify({
        revision,
        versions,
        segment_ids: segmentIds,
      }),
      signal,
    },
  )
  const project = parseProject(payload)
  if (!project) {
    throw new ApiError('应用预设接口返回的数据格式不正确。')
  }
  return project
}

export function presetLabel(preset: P2Preset): string {
  return preset.voice_name + ' · ' + preset.name + ' · 预设第' + String(preset.version) + '版'
}

export function loraName(loras: Lora[], id: string | null): string {
  if (id === null) return '基础模型'
  const lora = loras.find((lora) => lora.id === id)
  return lora ? loraLabel(lora) : id
}

export function assetName(assets: Asset[], id: string): string {
  return assets.find((asset) => asset.id === id)?.name ?? '未知素材 ' + id
}
