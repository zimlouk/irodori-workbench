// Optional values deliberately follow the installed Irodori Server defaults.
export interface AdvancedParameters {
  cfg_scale_text?: number | null
  cfg_scale_caption?: number | null
  cfg_scale_speaker?: number | null
  cfg_guidance_mode?: 'independent' | 'joint' | 'alternating' | null
  cfg_scale?: number | null
  cfg_min_t?: number | null
  cfg_max_t?: number | null
  seconds?: number | null
  duration_scale?: number | null
  min_seconds?: number | null
  max_seconds?: number | null
  t_schedule_mode?: 'linear' | 'sway' | null
  sway_coeff?: number | null
  truncation_factor?: number | null
  rescale_k?: number | null
  rescale_sigma?: number | null
  context_kv_cache?: boolean | null
  speaker_kv_scale?: number | null
  ref_normalize_db?: number | null
  ref_ensure_max?: boolean | null
  trim_tail?: boolean | null
}

export interface ParameterSpec {
  key: keyof AdvancedParameters
  label: string
  hint: string
  kind?: 'boolean' | 'select'
  choices?: string[]
  min?: number
  max?: number
  positive?: boolean
}

export const ADVANCED_PARAMETERS: ParameterSpec[] = [
  { key: 'cfg_scale_text', label: 'CFG Scale Text', min: 0, max: 10, hint: '文本引导强度；运行时默认 3。' },
  { key: 'cfg_scale_caption', label: 'CFG Scale Caption', min: 0, max: 10, hint: 'Caption 引导强度；运行时默认 3。' },
  { key: 'cfg_scale_speaker', label: 'CFG Scale Speaker', min: 0, max: 10, hint: '参考音色引导强度；运行时默认 5，无参考时忽略。' },
  { key: 'cfg_guidance_mode', label: 'CFG Guidance Mode', kind: 'select', choices: ['independent', 'joint', 'alternating'], hint: '默认 independent；joint 要求启用的引导强度相同，或设置统一 CFG Override。' },
  { key: 'cfg_scale', label: 'CFG Scale Override', min: 0, max: 10, hint: '填写后统一覆盖 Text、Caption、Speaker 三个强度；留空分别控制。' },
  { key: 'cfg_min_t', label: 'CFG Min t', min: 0, max: 1, hint: '引导生效区间起点；默认 0.5。' },
  { key: 'cfg_max_t', label: 'CFG Max t', min: 0, max: 1, hint: '引导生效区间终点；默认 1。' },
  { key: 'duration_scale', label: 'Duration Scale', positive: true, hint: '自动预测时长倍率；默认 1。数值越大，音频通常越长。' },
  { key: 'seconds', label: '固定时长（秒）', positive: true, hint: '留空自动预测；填写后使用固定时长，并受最小／最大时长限制。' },
  { key: 'min_seconds', label: '最小时长（秒）', positive: true, hint: '默认 0.5 秒。' },
  { key: 'max_seconds', label: '最大时长（秒）', positive: true, hint: '默认 30 秒，须不小于最小时长。' },
  { key: 't_schedule_mode', label: 'Time Schedule', kind: 'select', choices: ['linear', 'sway'], hint: '采样时间调度；默认 linear。' },
  { key: 'sway_coeff', label: 'Sway Coeff', hint: 'Time Schedule 为 sway 时使用；默认 -1。' },
  { key: 'truncation_factor', label: 'Truncation Factor', positive: true, hint: '可选采样截断系数；留空采用模型设置。' },
  { key: 'rescale_k', label: 'Rescale k', positive: true, hint: '须与 Rescale sigma 同时填写，或同时留空。' },
  { key: 'rescale_sigma', label: 'Rescale sigma', positive: true, hint: '须与 Rescale k 同时填写，或同时留空。' },
  { key: 'context_kv_cache', label: 'Context KV Cache', kind: 'boolean', hint: '上下文 KV 缓存；默认开启。' },
  { key: 'speaker_kv_scale', label: 'Speaker KV Scale', positive: true, hint: '可选 Speaker KV 强度；无参考时忽略。' },
  { key: 'ref_normalize_db', label: '参考响度（dB）', hint: '参考音频归一化目标；默认 -16 dB。' },
  { key: 'ref_ensure_max', label: '限制参考峰值', kind: 'boolean', hint: '参考音频峰值保护；默认开启。' },
  { key: 'trim_tail', label: 'Trim Tail', kind: 'boolean', hint: '裁剪结尾静音；默认开启。' },
]

export function parseAdvanced(value: Record<string, unknown>): AdvancedParameters | null {
  const result: AdvancedParameters = {}
  for (const spec of ADVANCED_PARAMETERS) {
    if (!Object.prototype.hasOwnProperty.call(value, spec.key)) continue
    const field = value[spec.key]
    if (field !== null) {
      if (spec.kind === 'boolean') {
        if (typeof field !== 'boolean') return null
      } else if (spec.kind === 'select') {
        if (typeof field !== 'string' || !spec.choices?.includes(field)) return null
      } else if (typeof field !== 'number' || !Number.isFinite(field)) return null
    }
    Object.assign(result, { [spec.key]: field })
  }
  return result
}

export function validateAdvanced(value: AdvancedParameters): string | null {
  for (const spec of ADVANCED_PARAMETERS) {
    const field = value[spec.key]
    if (field == null) continue
    if (spec.kind === 'boolean') {
      if (typeof field !== 'boolean') return spec.label + ' 请选择开启、关闭或运行时默认。'
    } else if (spec.kind === 'select') {
      if (typeof field !== 'string' || !spec.choices?.includes(field)) return spec.label + ' 选项无效。'
    } else if (typeof field !== 'number' || !Number.isFinite(field) ||
      (spec.min !== undefined && field < spec.min) || (spec.max !== undefined && field > spec.max) ||
      (spec.positive && field <= 0)) return spec.label + ' 数值无效，请检查范围。'
  }
  return null
}

export function parameterLabel(value: unknown): string {
  return value == null ? '运行时默认' : typeof value === 'boolean' ? (value ? '开启' : '关闭') : String(value)
}
