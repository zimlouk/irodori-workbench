import type { AdvancedParameters, ParameterSpec } from '../voice-parameters'
import { ADVANCED_PARAMETERS, parameterLabel } from '../voice-parameters'

function ParameterInput({ spec, value, id, disabled, onChange }: {
  spec: ParameterSpec
  value: AdvancedParameters[keyof AdvancedParameters] | undefined
  id: string
  disabled: boolean
  onChange: (value: number | string | boolean | null) => void
}) {
  if (spec.kind) return (
    <select id={id} value={value == null ? '' : String(value)} disabled={disabled}
      onChange={(event) => onChange(event.target.value === '' ? null : spec.kind === 'boolean' ? event.target.value === 'true' : event.target.value)}>
      <option value="">运行时默认</option>
      {spec.kind === 'boolean' ? <><option value="true">开启</option><option value="false">关闭</option></> :
        spec.choices?.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
    </select>
  )
  return <input id={id} type="number" step="any" min={spec.positive ? '0.000001' : spec.min} max={spec.max}
    value={typeof value === 'number' ? value : ''} placeholder="运行时默认" disabled={disabled}
    onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />
}

export function ParameterFields({ value, onChange, idPrefix, disabled = false }: {
  value: AdvancedParameters
  onChange: (value: AdvancedParameters) => void
  idPrefix: string
  disabled?: boolean
}) {
  const common = new Set(['cfg_scale_text', 'cfg_scale_caption', 'cfg_scale_speaker', 'cfg_guidance_mode', 'duration_scale'])
  function fields(specs: ParameterSpec[]) {
    return <div className="p2-field-grid">{specs.map((spec) => {
      const id = idPrefix + '-' + spec.key
      return <div className="p2-field" key={spec.key}>
        <label htmlFor={id}>{spec.label}</label>
        <ParameterInput spec={spec} id={id} value={value[spec.key]} disabled={disabled}
          onChange={(field) => onChange(Object.assign({}, value, { [spec.key]: field }))} />
        <p className="p2-hint">{spec.hint}</p>
      </div>
    })}</div>
  }
  return <fieldset className="p2-fieldset" disabled={disabled}>
    <legend>Irodori 推理参数</legend>
    <p className="p2-hint">留空使用当前推理服务／模型默认值；设置会随音色预设保存，也可在单句设置中覆盖。</p>
    {fields(ADVANCED_PARAMETERS.filter((spec) => common.has(spec.key)))}
    <details className="p2-semantics">
      <summary>更多 Irodori 参数（引导区间、时长、采样与缓存）</summary>
      {fields(ADVANCED_PARAMETERS.filter((spec) => !common.has(spec.key)))}
    </details>
  </fieldset>
}

export function ParameterOverrides({ value, inherited, onChange, idPrefix, disabled = false }: {
  value: AdvancedParameters
  inherited: AdvancedParameters
  onChange: (value: AdvancedParameters) => void
  idPrefix: string
  disabled?: boolean
}) {
  return <details className="p2-semantics">
    <summary>Irodori 推理参数：单句覆盖</summary>
    <p className="p2-hint">关闭覆盖时继承整批值；开启后可独立设置，留空则使用运行时默认值。</p>
    {ADVANCED_PARAMETERS.map((spec) => {
      const enabled = Object.prototype.hasOwnProperty.call(value, spec.key)
      const id = idPrefix + '-ov-' + spec.key
      return <div className="p2-override-block" key={spec.key}>
        <label className="p2-switch"><input type="checkbox" checked={enabled} disabled={disabled}
          onChange={(event) => {
            const next = { ...value }
            if (event.target.checked) Object.assign(next, { [spec.key]: inherited[spec.key] ?? null })
            else delete next[spec.key]
            onChange(next)
          }} /><span>覆盖 {spec.label}</span></label>
        {enabled ? <><label htmlFor={id}>{spec.label}</label>
          <ParameterInput spec={spec} id={id} value={value[spec.key]} disabled={disabled}
            onChange={(field) => onChange(Object.assign({}, value, { [spec.key]: field }))} />
          <p className="p2-hint">{spec.hint}</p></> :
          <span className="p2-inherited-value">继承：{parameterLabel(inherited[spec.key])}</span>}
      </div>
    })}
  </details>
}
