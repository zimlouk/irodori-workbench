import { useState } from 'react'
import { loraLabel } from '../lora-label'
import type { Asset, Lora } from '../types'
import type {
  P2Config,
  P2Overrides,
  P2PresetChange,
} from '../p2-api'
import { assetName, loraName } from '../p2-api'
import {
  cloneConfig,
  configWithOverrides,
  diffConfigs,
  hasOwn,
} from './model'
import type { ConfigDiffField } from './model'
import { ParameterFields, ParameterOverrides } from './ParameterFields'
import { ADVANCED_PARAMETERS, parameterLabel } from '../voice-parameters'

function fieldId(prefix: string, name: string): string {
  return prefix + '-' + name
}

interface ReferenceEditorProps {
  ids: string[]
  onChange: (ids: string[]) => void
  assets: Asset[]
  idPrefix: string
  disabled?: boolean
}

function ReferenceEditor({
  ids,
  onChange,
  assets,
  idPrefix,
  disabled = false,
}: ReferenceEditorProps) {
  const [pickId, setPickId] = useState('')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const allKnown = assets.length > 0
  const selectId = fieldId(idPrefix, 'reference-pick')

  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= ids.length) return
    const next = [...ids]
    const item = next[index]
    next[index] = next[target]
    next[target] = item
    onChange(next)
  }

  function add() {
    if (!pickId) return
    if (ids.includes(pickId)) {
      setPickId('')
      return
    }
    onChange([...ids, pickId])
    setPickId('')
  }

  const preview = previewId
    ? assets.find((asset) => asset.id === previewId) ?? null
    : null

  return (
    <div className="p2-reference-editor">
      <div className="p2-reference-picker">
        <label htmlFor={selectId}>选择参考素材</label>
        <div className="p2-inline-row">
          <select
            id={selectId}
            value={pickId}
            onChange={(event) => setPickId(event.target.value)}
            disabled={disabled || !allKnown}
          >
            <option value="">
              {allKnown ? '选择一个素材' : '暂无素材，请先上传'}
            </option>
            {assets.map((asset) => (
              <option
                key={asset.id}
                value={asset.id}
                disabled={ids.includes(asset.id)}
              >
                {asset.name}
                {ids.includes(asset.id) ? '（已加入）' : ''}
              </option>
            ))}
          </select>
          <button
            className="quiet-button accent"
            type="button"
            onClick={add}
            disabled={disabled || !pickId || ids.includes(pickId)}
          >
            加入参考
          </button>
          <button
            className="quiet-button"
            type="button"
            onClick={() => onChange([])}
            disabled={disabled || ids.length === 0}
          >
            清空顺序
          </button>
        </div>
      </div>

      <p className="p2-hint">
        参考按列表顺序传入。空列表表示不使用参考（清空该字段）。
      </p>

      {ids.length === 0 ? (
        <p className="p2-empty-line">当前参考列表为空。</p>
      ) : (
        <ol className="p2-reference-list">
          {ids.map((id, index) => {
            const asset = assets.find((item) => item.id === id)
            const label = asset?.name ?? '未知素材（' + id + '）'
            return (
              <li key={id}>
                <span className="p2-order">{index + 1}</span>
                <span className="p2-reference-name" title={label}>
                  {label}
                </span>
                <span className="p2-reference-actions">
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => setPreviewId(id)}
                    disabled={disabled || !asset}
                    aria-label={'试听参考 ' + label}
                  >
                    试听
                  </button>
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={disabled || index === 0}
                    aria-label={'上移参考 ' + label}
                  >
                    上移
                  </button>
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={disabled || index === ids.length - 1}
                    aria-label={'下移参考 ' + label}
                  >
                    下移
                  </button>
                  <button
                    className="quiet-button danger"
                    type="button"
                    onClick={() => onChange(ids.filter((item) => item !== id))}
                    disabled={disabled}
                    aria-label={'移除参考 ' + label}
                  >
                    移除
                  </button>
                </span>
              </li>
            )
          })}
        </ol>
      )}

      {preview ? (
        <div className="p2-audio-preview">
          <span>试听：{preview.name}</span>
          <audio
            key={preview.id}
            controls
            autoPlay
            preload="metadata"
            src={preview.audio_url}
          >
            当前浏览器不支持音频播放。
          </audio>
          <button
            className="quiet-button"
            type="button"
            onClick={() => setPreviewId(null)}
          >
            关闭试听
          </button>
        </div>
      ) : null}
    </div>
  )
}

interface ConfigEditorProps {
  value: P2Config
  onChange: (value: P2Config) => void
  assets: Asset[]
  loras: Lora[]
  idPrefix: string
  disabled?: boolean
  showSemantics?: boolean
  showCaption?: boolean
  showLora?: boolean
  captionLabel?: string
}

export function ConfigEditor({
  value,
  onChange,
  assets,
  loras,
  idPrefix,
  disabled = false,
  showSemantics = true,
  showCaption = true,
  showLora = true,
  captionLabel = 'Caption',
}: ConfigEditorProps) {
  function patch(next: Partial<P2Config>) {
    onChange({ ...value, ...next })
  }

  function patchParameters(
    next: Partial<P2Config['parameters']>,
  ) {
    onChange({
      ...value,
      parameters: { ...value.parameters, ...next },
    })
  }

  const loraId = fieldId(idPrefix, 'lora')
  const captionId = fieldId(idPrefix, 'caption')
  const stepsId = fieldId(idPrefix, 'steps')
  const seedId = fieldId(idPrefix, 'seed')
  const refLimitId = fieldId(idPrefix, 'ref-limit')

  return (
    <div className="p2-config-editor">
      <div className="p2-field-grid">
        {showLora ? <div className="p2-field">
          <div className="p2-label-row">
            <label htmlFor={loraId}>LoRA / 模型</label>
            <span>null = 基础模型</span>
          </div>
          <select
            id={loraId}
            value={value.lora_id ?? ''}
            onChange={(event) => patch({ lora_id: event.target.value || null })}
            disabled={disabled}
          >
            <option value="">基础模型（不加载 LoRA）</option>
            {value.lora_id !== null &&
            !loras.some((lora) => lora.id === value.lora_id) ? (
              <option value={value.lora_id}>
                未知 LoRA（{value.lora_id}）
              </option>
            ) : null}
            {loras.map((lora) => (
              <option key={lora.id} value={lora.id}>
                {loraLabel(lora)}
                {lora.available ? '' : '（当前不可用）'}
              </option>
            ))}
          </select>
        </div> : null}

        <div className="p2-field">
          <div className="p2-label-row">
            <label htmlFor={stepsId}>生成步数</label>
            <span>1–100</span>
          </div>
          <input
            id={stepsId}
            type="number"
            min="1"
            max="100"
            step="1"
            value={value.parameters.num_steps}
            onChange={(event) =>
              patchParameters({ num_steps: Number(event.target.value) })
            }
            disabled={disabled}
          />
        </div>

        <div className="p2-field">
          <div className="p2-label-row">
            <label htmlFor={seedId}>seed</label>
            <span>留空 = 随机</span>
          </div>
          <input
            id={seedId}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={19}
            value={value.parameters.seed ?? ''}
            onChange={(event) =>
              patchParameters({
                seed: event.target.value.trim() ? event.target.value : null,
              })
            }
            placeholder="随机（null）"
            disabled={disabled}
          />
          <p className="p2-hint">
            按原始十进制字符串保存，19 位 seed 不会被转换成浮点数。
          </p>
        </div>

        <div className="p2-field">
          <div className="p2-label-row">
            <label htmlFor={refLimitId}>参考时长上限</label>
            <span>秒；留空 = 运行时默认</span>
          </div>
          <input
            id={refLimitId}
            type="number"
            inputMode="decimal"
            min="0.01"
            step="any"
            value={value.parameters.max_ref_seconds ?? ''}
            onChange={(event) =>
              patchParameters({
                max_ref_seconds: event.target.value
                  ? Number(event.target.value)
                  : null,
              })
            }
            placeholder="运行时默认（null）"
            disabled={disabled}
          />
        </div>
      </div>

      {showCaption ? <div className="p2-field">
        <div className="p2-label-row">
          <label htmlFor={captionId}>{captionLabel}</label>
          <span>空字符串 = 清空</span>
        </div>
        <textarea
          id={captionId}
          rows={2}
          value={value.caption}
          onChange={(event) => patch({ caption: event.target.value })}
          placeholder="可选的风格或内容描述"
          disabled={disabled}
        />
      </div> : null}

      <ParameterFields value={value.parameters} onChange={(parameters) => patchParameters(parameters)}
        idPrefix={idPrefix} disabled={disabled} />

      <fieldset className="p2-fieldset" disabled={disabled}>
        <legend>参考素材（有序）</legend>
        <ReferenceEditor
          ids={value.reference_asset_ids}
          onChange={(ids) => patch({ reference_asset_ids: ids })}
          assets={assets}
          idPrefix={idPrefix}
          disabled={disabled}
        />
      </fieldset>

      {showSemantics ? (
        <details className="p2-semantics">
          <summary>字段与 null / 空值语义</summary>
          <ul>
            <li>LoRA 为 null 表示基础模型。</li>
            <li>参考为空数组表示不使用参考；列表顺序就是传入顺序。</li>
            <li>Caption 为空字符串表示清空描述。</li>
            <li>seed 为 null 表示随机；固定 seed 时保留完整字符串。</li>
            <li>参考时长上限为 null 表示使用运行时默认值。</li>
          </ul>
        </details>
      ) : null}
    </div>
  )
}

interface OverridesEditorProps {
  overrides: P2Overrides
  inherited: P2Config
  onChange: (overrides: P2Overrides) => void
  assets: Asset[]
  loras: Lora[]
  idPrefix: string
  disabled?: boolean
}

export function OverridesEditor({
  overrides,
  inherited,
  onChange,
  assets,
  loras,
  idPrefix,
  disabled = false,
}: OverridesEditorProps) {
  const parameters = overrides.parameters ?? {}

  function patch(next: P2Overrides) {
    onChange(next)
  }

  function setField<K extends keyof P2Overrides>(
    key: K,
    value: P2Overrides[K],
  ) {
    patch({ ...overrides, [key]: value })
  }

  function removeField(key: keyof P2Overrides) {
    const next = { ...overrides }
    delete next[key]
    patch(next)
  }

  function setParameter<K extends keyof NonNullable<P2Overrides['parameters']>>(
    key: K,
    value: NonNullable<P2Overrides['parameters']>[K],
  ) {
    patch({
      ...overrides,
      parameters: { ...parameters, [key]: value },
    })
  }

  function removeParameter(
    key: keyof NonNullable<P2Overrides['parameters']>,
  ) {
    const nextParameters = { ...parameters }
    delete nextParameters[key]
    const next = { ...overrides }
    if (Object.keys(nextParameters).length === 0) {
      delete next.parameters
    } else {
      next.parameters = nextParameters
    }
    patch(next)
  }

  const loraOn = hasOwn(overrides, 'lora_id')
  const refsOn = hasOwn(overrides, 'reference_asset_ids')
  const captionOn = hasOwn(overrides, 'caption')
  const stepsOn = hasOwn(parameters, 'num_steps')
  const seedOn = hasOwn(parameters, 'seed')
  const limitOn = hasOwn(parameters, 'max_ref_seconds')
  const effective = configWithOverrides(inherited, overrides)

  const ids = {
    lora: fieldId(idPrefix, 'ov-lora'),
    caption: fieldId(idPrefix, 'ov-caption'),
    steps: fieldId(idPrefix, 'ov-steps'),
    seed: fieldId(idPrefix, 'ov-seed'),
    limit: fieldId(idPrefix, 'ov-limit'),
  }

  return (
    <div className="p2-overrides">
      <p className="p2-hint">
        每一项都可单独继承或覆盖。关闭开关会删除该字段，让后端按快照继承。
      </p>

      <div className="p2-override-row">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={loraOn}
            onChange={(event) => {
              if (event.target.checked) {
                setField('lora_id', inherited.lora_id)
              } else {
                removeField('lora_id')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖 LoRA / 模型</span>
        </label>
        {loraOn ? (
          <select
            id={ids.lora}
            aria-label="覆盖的 LoRA 或基础模型"
            value={overrides.lora_id ?? ''}
            onChange={(event) => setField('lora_id', event.target.value || null)}
            disabled={disabled}
          >
            <option value="">基础模型（null）</option>
            {overrides.lora_id &&
            !loras.some((lora) => lora.id === overrides.lora_id) ? (
              <option value={overrides.lora_id}>
                未知 LoRA（{overrides.lora_id}）
              </option>
            ) : null}
            {loras.map((lora) => (
              <option key={lora.id} value={lora.id}>
                {loraLabel(lora)}
                {lora.available ? '' : '（当前不可用）'}
              </option>
            ))}
          </select>
        ) : (
          <span className="p2-inherited-value">
            继承：{loraName(loras, inherited.lora_id)}
          </span>
        )}
      </div>

      <div className="p2-override-block">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={refsOn}
            onChange={(event) => {
              if (event.target.checked) {
                setField('reference_asset_ids', [
                  ...inherited.reference_asset_ids,
                ])
              } else {
                removeField('reference_asset_ids')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖参考顺序</span>
        </label>
        {refsOn ? (
          <ReferenceEditor
            ids={overrides.reference_asset_ids ?? []}
            onChange={(refs) => setField('reference_asset_ids', refs)}
            assets={assets}
            idPrefix={fieldId(idPrefix, 'ov-ref')}
            disabled={disabled}
          />
        ) : (
          <p className="p2-inherited-value">
            继承：
            {inherited.reference_asset_ids.length === 0
              ? '空列表（无参考）'
              : inherited.reference_asset_ids
                  .map((id) => assetName(assets, id))
                  .join(' → ')}
          </p>
        )}
      </div>

      <div className="p2-override-row">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={captionOn}
            onChange={(event) => {
              if (event.target.checked) {
                setField('caption', inherited.caption)
              } else {
                removeField('caption')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖 Caption</span>
        </label>
        {captionOn ? (
          <input
            id={ids.caption}
            aria-label="覆盖的 Caption"
            value={overrides.caption ?? ''}
            onChange={(event) => setField('caption', event.target.value)}
            placeholder="空字符串表示清空"
            disabled={disabled}
          />
        ) : (
          <span className="p2-inherited-value">
            继承：{inherited.caption || '（空）'}
          </span>
        )}
      </div>

      <div className="p2-override-row">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={stepsOn}
            onChange={(event) => {
              if (event.target.checked) {
                setParameter('num_steps', inherited.parameters.num_steps)
              } else {
                removeParameter('num_steps')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖步数</span>
        </label>
        {stepsOn ? (
          <input
            id={ids.steps}
            aria-label="覆盖的生成步数"
            type="number"
            min="1"
            max="100"
            step="1"
            value={parameters.num_steps ?? 40}
            onChange={(event) =>
              setParameter('num_steps', Number(event.target.value))
            }
            disabled={disabled}
          />
        ) : (
          <span className="p2-inherited-value">
            继承：{inherited.parameters.num_steps} 步
          </span>
        )}
      </div>

      <div className="p2-override-row">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={seedOn}
            onChange={(event) => {
              if (event.target.checked) {
                setParameter('seed', inherited.parameters.seed)
              } else {
                removeParameter('seed')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖 seed</span>
        </label>
        {seedOn ? (
          <input
            id={ids.seed}
            aria-label="覆盖的 seed"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={19}
            value={parameters.seed ?? ''}
            onChange={(event) =>
              setParameter(
                'seed',
                event.target.value.trim() ? event.target.value : null,
              )
            }
            placeholder="随机（null）"
            disabled={disabled}
          />
        ) : (
          <span className="p2-inherited-value p2-mono">
            继承：{inherited.parameters.seed ?? '随机（null）'}
          </span>
        )}
      </div>

      <div className="p2-override-row">
        <label className="p2-switch">
          <input
            type="checkbox"
            checked={limitOn}
            onChange={(event) => {
              if (event.target.checked) {
                setParameter(
                  'max_ref_seconds',
                  inherited.parameters.max_ref_seconds,
                )
              } else {
                removeParameter('max_ref_seconds')
              }
            }}
            disabled={disabled}
          />
          <span>覆盖参考上限</span>
        </label>
        {limitOn ? (
          <input
            id={ids.limit}
            aria-label="覆盖的参考时长上限"
            type="number"
            min="0.01"
            step="any"
            value={parameters.max_ref_seconds ?? ''}
            onChange={(event) =>
              setParameter(
                'max_ref_seconds',
                event.target.value ? Number(event.target.value) : null,
              )
            }
            placeholder="运行时默认（null）"
            disabled={disabled}
          />
        ) : (
          <span className="p2-inherited-value">
            继承：
            {inherited.parameters.max_ref_seconds === null
              ? '运行时默认（null）'
              : inherited.parameters.max_ref_seconds + ' 秒'}
          </span>
        )}
      </div>

      <ParameterOverrides value={parameters} inherited={inherited.parameters}
        onChange={(advanced) => {
          const next = { ...overrides }
          if (Object.keys(advanced).length) next.parameters = advanced
          else delete next.parameters
          patch(next)
        }} idPrefix={idPrefix} disabled={disabled} />

      <details className="p2-semantics">
        <summary>当前覆盖后的有效配置预览</summary>
        <ConfigSummary config={effective} assets={assets} loras={loras} />
      </details>
    </div>
  )
}

export function ConfigSummary({
  config,
  assets,
  loras,
}: {
  config: P2Config
  assets: Asset[]
  loras: Lora[]
}) {
  const references = config.reference_asset_ids.map((id) => assetName(assets, id))
  return (
    <dl className="p2-config-summary">
      <div>
        <dt>模型</dt>
        <dd>{loraName(loras, config.lora_id)}</dd>
      </div>
      <div>
        <dt>步数</dt>
        <dd>{config.parameters.num_steps}</dd>
      </div>
      <div>
        <dt>seed</dt>
        <dd className="p2-mono" title={config.parameters.seed ?? '随机'}>
          {config.parameters.seed ?? '随机（null）'}
        </dd>
      </div>
      <div>
        <dt>参考上限</dt>
        <dd>
          {config.parameters.max_ref_seconds === null
            ? '运行时默认'
            : config.parameters.max_ref_seconds + ' 秒'}
        </dd>
      </div>
      <div className="p2-summary-wide">
        <dt>参考（{references.length}）</dt>
        <dd title={references.join(' → ')}>
          {references.length === 0 ? '无' : references.join(' → ')}
        </dd>
      </div>
      <div className="p2-summary-wide">
        <dt>Caption</dt>
        <dd>{config.caption || '（空）'}</dd>
      </div>
      {ADVANCED_PARAMETERS.filter((spec) => config.parameters[spec.key] != null).map((spec) => (
        <div key={spec.key}><dt>{spec.label}</dt><dd>{parameterLabel(config.parameters[spec.key])}</dd></div>
      ))}
    </dl>
  )
}

function DiffRows({
  fields,
}: {
  fields: ConfigDiffField[]
}) {
  if (fields.length === 0) {
    return (
      <p className="p2-empty-line">有效配置内容相同，无需重新生成。</p>
    )
  }
  return (
    <table className="p2-diff-table">
      <thead>
        <tr>
          <th scope="col">字段</th>
          <th scope="col">当前快照</th>
          <th scope="col">最新预设</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => (
          <tr key={field.key}>
            <th scope="row">{field.label}</th>
            <td>{field.before}</td>
            <td>{field.after}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ConfigDiffView({
  changes,
  assets,
  loras,
  segmentLabels,
}: {
  changes: P2PresetChange[]
  assets: Asset[]
  loras: Lora[]
  segmentLabels: Record<string, string>
}) {
  return (
    <div className="p2-diff-list">
      {changes.map((change) => (
        <section className="p2-diff-card" key={change.segment_id}>
          <div className="p2-diff-heading">
            <strong>
              {segmentLabels[change.segment_id] ?? '段落 ' + change.segment_id}
            </strong>
            <span>
              v{change.from_version} → v{change.to_version}
            </span>
          </div>
          <DiffRows
            fields={diffConfigs(change.before, change.after, assets, loras)}
          />
        </section>
      ))}
    </div>
  )
}

export function configForPreview(
  inherited: P2Config,
  overrides: P2Overrides,
): P2Config {
  return cloneConfig(configWithOverrides(inherited, overrides))
}
