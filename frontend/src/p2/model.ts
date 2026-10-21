import type { Asset, Lora } from '../types'
import type {
  P2Config,
  P2Job,
  P2Overrides,
  P2Preset,
  P2Project,
  P2ProjectSegmentInput,
  P2SaveProjectInput,
  P2Segment,
} from '../p2-api'
import { P2_SEED_MAX } from '../p2-api'
import { ADVANCED_PARAMETERS, parameterLabel, parseAdvanced, validateAdvanced } from '../voice-parameters'

export interface DraftSegment {
  key: string
  id?: string
  text: string
  speaker: string
  preset_id: string | null
  overrides: P2Overrides
  snapshot: P2Segment['snapshot']
  effective_config: P2Config
  input_revision: number
  selected_job_id: string | null
  selected_stale: boolean
  attempts: P2Job[]
}

export interface ProjectDraft {
  name: string
  default_preset_id: string | null
  segments: DraftSegment[]
}

let localKeyCounter = 0

export function nextSegmentKey(): string {
  localKeyCounter += 1
  return 'new:' + String(localKeyCounter)
}

export function emptyConfig(): P2Config {
  return {
    lora_id: null,
    reference_asset_ids: [],
    caption: '',
    parameters: {
      num_steps: 40,
      seed: null,
      max_ref_seconds: null,
    },
  }
}

export function cloneConfig(config: P2Config): P2Config {
  return {
    lora_id: config.lora_id,
    reference_asset_ids: [...config.reference_asset_ids],
    caption: config.caption,
    parameters: { ...config.parameters },
  }
}

export function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function segmentKey(segment: P2Segment): string {
  return 'seg:' + segment.id
}

export function segmentToDraft(segment: P2Segment): DraftSegment {
  return {
    key: segmentKey(segment),
    id: segment.id,
    text: segment.text,
    speaker: segment.speaker,
    preset_id: segment.preset_id,
    overrides: cloneOverrides(segment.overrides),
    snapshot: {
      preset_id: segment.snapshot.preset_id,
      preset_version: segment.snapshot.preset_version,
      config: cloneConfig(segment.snapshot.config),
    },
    effective_config: cloneConfig(segment.effective_config),
    input_revision: segment.input_revision,
    selected_job_id: segment.selected_job_id,
    selected_stale: segment.selected_stale,
    attempts: [...segment.attempts],
  }
}

export function newDraftSegment(defaultConfig: P2Config): DraftSegment {
  return {
    key: nextSegmentKey(),
    text: '',
    speaker: '',
    preset_id: null,
    overrides: {},
    snapshot: {
      preset_id: null,
      preset_version: null,
      config: cloneConfig(defaultConfig),
    },
    effective_config: cloneConfig(defaultConfig),
    input_revision: 0,
    selected_job_id: null,
    selected_stale: false,
    attempts: [],
  }
}

export function projectToDraft(
  project: P2Project,
  previous?: ProjectDraft | null,
): ProjectDraft {
  const oldKeys = new Map<string, string>()
  previous?.segments.forEach((segment) => {
    if (segment.id) oldKeys.set(segment.id, segment.key)
  })

  return {
    name: project.name,
    default_preset_id: project.default_preset_id,
    segments: project.segments.map((segment) => {
      const draft = segmentToDraft(segment)
      const oldKey = oldKeys.get(segment.id)
      if (oldKey) draft.key = oldKey
      return draft
    }),
  }
}

export function cloneOverrides(overrides: P2Overrides): P2Overrides {
  const next: P2Overrides = {}
  if (hasOwn(overrides, 'lora_id')) next.lora_id = overrides.lora_id ?? null
  if (hasOwn(overrides, 'reference_asset_ids')) {
    next.reference_asset_ids = [...(overrides.reference_asset_ids ?? [])]
  }
  if (hasOwn(overrides, 'caption')) next.caption = overrides.caption ?? ''
  if (hasOwn(overrides, 'parameters')) {
    next.parameters = { ...(overrides.parameters ?? {}) }
  }
  return next
}

export function cleanOverrides(overrides: P2Overrides): P2Overrides {
  const next: P2Overrides = {}
  if (hasOwn(overrides, 'lora_id')) next.lora_id = overrides.lora_id ?? null
  if (hasOwn(overrides, 'reference_asset_ids')) {
    next.reference_asset_ids = [...(overrides.reference_asset_ids ?? [])]
  }
  if (hasOwn(overrides, 'caption')) next.caption = overrides.caption ?? ''
  if (overrides.parameters) {
    const parameters: NonNullable<P2Overrides['parameters']> = { ...parseAdvanced(overrides.parameters) }
    if (hasOwn(overrides.parameters, 'num_steps')) {
      parameters.num_steps = overrides.parameters.num_steps
    }
    if (hasOwn(overrides.parameters, 'seed')) {
      parameters.seed = overrides.parameters.seed ?? null
    }
    if (hasOwn(overrides.parameters, 'max_ref_seconds')) {
      parameters.max_ref_seconds = overrides.parameters.max_ref_seconds ?? null
    }
    if (Object.keys(parameters).length > 0) {
      next.parameters = parameters
    }
  }
  return next
}

export function draftToPayload(
  draft: ProjectDraft,
  revision: number,
): P2SaveProjectInput {
  return {
    revision,
    name: draft.name.trim(),
    default_preset_id: draft.default_preset_id,
    segments: draft.segments.map((segment): P2ProjectSegmentInput => {
      const item: P2ProjectSegmentInput = {
        text: segment.text,
        speaker: segment.speaker,
        preset_id: segment.preset_id,
        overrides: cleanOverrides(segment.overrides),
      }
      if (segment.id) item.id = segment.id
      return item
    }),
  }
}

export function mergeServerAttempts(
  draft: ProjectDraft,
  server: P2Project,
): ProjectDraft {
  const byId = new Map(server.segments.map((segment) => [segment.id, segment]))
  return {
    ...draft,
    segments: draft.segments.map((segment) => {
      if (!segment.id) return segment
      const remote = byId.get(segment.id)
      if (!remote) return segment
      return {
        ...segment,
        attempts: [...remote.attempts],
        selected_job_id: remote.selected_job_id,
        selected_stale: remote.selected_stale,
      }
    }),
  }
}

export function mergeJobsIntoDraft(
  draft: ProjectDraft,
  jobs: P2Job[],
): ProjectDraft {
  if (jobs.length === 0) return draft
  const bySegment = new Map<string, P2Job[]>()
  jobs.forEach((job) => {
    if (!job.segment_id) return
    const current = bySegment.get(job.segment_id) ?? []
    current.push(job)
    bySegment.set(job.segment_id, current)
  })

  return {
    ...draft,
    segments: draft.segments.map((segment) => {
      if (!segment.id) return segment
      const incoming = bySegment.get(segment.id)
      if (!incoming) return segment
      const byId = new Map(segment.attempts.map((job) => [job.id, job]))
      incoming.forEach((job) => byId.set(job.id, job))
      return { ...segment, attempts: [...byId.values()] }
    }),
  }
}

export function rebaseDraftAfterSave(
  draft: ProjectDraft,
  server: P2Project,
  submitted: ProjectDraft,
): ProjectDraft {
  const byKey = new Map<string, P2Segment>()
  submitted.segments.forEach((segment, index) => {
    const saved = server.segments[index]
    if (saved) byKey.set(segment.key, saved)
  })

  return {
    ...draft,
    segments: draft.segments.map((segment) => {
      const remote = byKey.get(segment.key)
      if (!remote) return segment
      return {
        ...segment,
        id: segment.id ?? remote.id,
        snapshot: {
          preset_id: remote.snapshot.preset_id,
          preset_version: remote.snapshot.preset_version,
          config: cloneConfig(remote.snapshot.config),
        },
        effective_config: cloneConfig(remote.effective_config),
        input_revision: remote.input_revision,
        selected_job_id: remote.selected_job_id,
        selected_stale: remote.selected_stale,
        attempts: [...remote.attempts],
      }
    }),
  }
}

export function validateSeed(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'seed 为空时应使用 null 表示随机。'
  if (trimmed !== value) return 'seed 不能包含空格。'
  if (!/^\d{1,19}$/.test(trimmed)) {
    return 'seed 必须是 0–9223372036854775807 的整数，且不能使用科学计数法。'
  }
  try {
    if (BigInt(trimmed) > P2_SEED_MAX) {
      return 'seed 不能大于 9223372036854775807。'
    }
  } catch {
    return 'seed 必须是十进制整数。'
  }
  return null
}

export function validateConfig(config: P2Config): string | null {
  const advancedError = validateAdvanced(config.parameters)
  if (advancedError) return advancedError
  if (
    !Number.isInteger(config.parameters.num_steps) ||
    config.parameters.num_steps < 1 ||
    config.parameters.num_steps > 100
  ) {
    return '步数必须是 1–100 的整数。'
  }
  if (config.parameters.seed !== null) {
    const seedError = validateSeed(config.parameters.seed)
    if (seedError) return seedError
  }
  if (
    config.parameters.max_ref_seconds !== null &&
    (!Number.isFinite(config.parameters.max_ref_seconds) ||
      config.parameters.max_ref_seconds <= 0 || config.parameters.max_ref_seconds > 180)
  ) {
    return '参考时长上限须大于 0 且不超过 180 秒，或留空使用运行时默认值。'
  }
  return null
}

export function validateOverrides(overrides: P2Overrides): string | null {
  const parameters = overrides.parameters
  const advancedError = validateAdvanced(parameters ?? {})
  if (advancedError) return advancedError
  if (parameters && hasOwn(parameters, 'num_steps')) {
    if (
      typeof parameters.num_steps !== 'number' ||
      !Number.isInteger(parameters.num_steps) ||
      parameters.num_steps < 1 ||
      parameters.num_steps > 100
    ) {
      return '覆盖步数必须是 1–100 的整数。'
    }
  }
  if (parameters && hasOwn(parameters, 'seed') && parameters.seed !== null) {
    const seedError = validateSeed(parameters.seed ?? '')
    if (seedError) return seedError
  }
  if (
    parameters &&
    hasOwn(parameters, 'max_ref_seconds') &&
    parameters.max_ref_seconds !== null &&
    (typeof parameters.max_ref_seconds !== 'number' ||
      !Number.isFinite(parameters.max_ref_seconds) ||
      parameters.max_ref_seconds <= 0 || parameters.max_ref_seconds > 180)
  ) {
    return '覆盖的参考时长上限须大于 0 且不超过 180 秒，或使用运行时默认值。'
  }
  return null
}

export function configWithOverrides(
  base: P2Config,
  overrides: P2Overrides,
): P2Config {
  const next = cloneConfig(base)
  if (hasOwn(overrides, 'lora_id')) next.lora_id = overrides.lora_id ?? null
  if (hasOwn(overrides, 'reference_asset_ids')) {
    next.reference_asset_ids = [...(overrides.reference_asset_ids ?? [])]
  }
  if (hasOwn(overrides, 'caption')) next.caption = overrides.caption ?? ''
  const parameters = overrides.parameters
  if (parameters) {
    Object.assign(next.parameters, parseAdvanced(parameters))
    if (hasOwn(parameters, 'num_steps') && parameters.num_steps !== undefined) {
      next.parameters.num_steps = parameters.num_steps
    }
    if (hasOwn(parameters, 'seed')) {
      next.parameters.seed = parameters.seed ?? null
    }
    if (hasOwn(parameters, 'max_ref_seconds')) {
      next.parameters.max_ref_seconds = parameters.max_ref_seconds ?? null
    }
  }
  return next
}

// Mirror snapshot selection only for preview; the server still owns persisted snapshots.
export function previewDraftSnapshots(draft: ProjectDraft, saved: P2Project | null, presets: P2Preset[]): ProjectDraft {
  const defaultUnchanged = saved?.default_preset_id === draft.default_preset_id
  const fromPreset = (id: string | null): P2Segment['snapshot'] => {
    const preset = presets.find(p => p.id === id)
    return {preset_id: id, preset_version: preset?.version ?? null,
      config: preset ? cloneConfig(preset.config) : emptyConfig()}
  }
  const defaultSnapshot = defaultUnchanged && saved ? saved.default_snapshot : fromPreset(draft.default_preset_id)
  return {...draft, segments: draft.segments.map(segment => {
    const prior = saved?.segments.find(s => s.id === segment.id)
    const keep = prior && prior.preset_id === segment.preset_id && (segment.preset_id !== null || defaultUnchanged)
    const snapshot = keep ? prior.snapshot : segment.preset_id === null ? defaultSnapshot : fromPreset(segment.preset_id)
    return {...segment, snapshot, effective_config: configWithOverrides(snapshot.config, segment.overrides)}
  })}
}

export interface ConfigDiffField {
  key: string
  label: string
  before: string
  after: string
}

export function diffConfigs(
  before: P2Config,
  after: P2Config,
  assets: Asset[],
  loras: Lora[],
): ConfigDiffField[] {
  const loraLabel = (id: string | null): string => {
    if (id === null) return '基础模型'
    return loras.find((lora) => lora.id === id)?.name ?? id
  }
  const assetLabel = (ids: string[]): string => {
    if (ids.length === 0) return '（空，无参考）'
    return ids
      .map((id) => assets.find((asset) => asset.id === id)?.name ?? id)
      .join(' → ')
  }

  const fields: ConfigDiffField[] = []
  if (before.lora_id !== after.lora_id) {
    fields.push({
      key: 'lora_id',
      label: 'LoRA / 模型',
      before: loraLabel(before.lora_id),
      after: loraLabel(after.lora_id),
    })
  }
  const sameReferences =
    before.reference_asset_ids.length === after.reference_asset_ids.length &&
    before.reference_asset_ids.every(
      (id, index) => id === after.reference_asset_ids[index],
    )
  if (!sameReferences) {
    fields.push({
      key: 'reference_asset_ids',
      label: '参考顺序',
      before: assetLabel(before.reference_asset_ids),
      after: assetLabel(after.reference_asset_ids),
    })
  }
  if (before.caption !== after.caption) {
    fields.push({
      key: 'caption',
      label: 'Caption',
      before: before.caption || '（空）',
      after: after.caption || '（空）',
    })
  }
  if (before.parameters.num_steps !== after.parameters.num_steps) {
    fields.push({
      key: 'num_steps',
      label: '步数',
      before: String(before.parameters.num_steps),
      after: String(after.parameters.num_steps),
    })
  }
  if (before.parameters.seed !== after.parameters.seed) {
    fields.push({
      key: 'seed',
      label: 'seed',
      before: before.parameters.seed ?? '随机（null）',
      after: after.parameters.seed ?? '随机（null）',
    })
  }
  if (before.parameters.max_ref_seconds !== after.parameters.max_ref_seconds) {
    fields.push({
      key: 'max_ref_seconds',
      label: '参考上限',
      before:
        before.parameters.max_ref_seconds === null
          ? '运行时默认（null）'
          : String(before.parameters.max_ref_seconds) + ' 秒',
      after:
        after.parameters.max_ref_seconds === null
          ? '运行时默认（null）'
          : String(after.parameters.max_ref_seconds) + ' 秒',
    })
  }
  for (const spec of ADVANCED_PARAMETERS) {
    if ((before.parameters[spec.key] ?? null) !== (after.parameters[spec.key] ?? null)) {
      fields.push({ key: spec.key, label: spec.label,
        before: parameterLabel(before.parameters[spec.key]), after: parameterLabel(after.parameters[spec.key]) })
    }
  }
  return fields
}
