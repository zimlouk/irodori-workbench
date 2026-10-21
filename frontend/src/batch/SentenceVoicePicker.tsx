import type { P2Config, P2Overrides, P2Preset } from '../p2-api'
import { configWithOverrides } from '../p2/model'
import { matchingVoice } from './voice-selection'
import { PresetOptions } from './PresetOptions'
import './voice-selection.css'

export function SentenceVoicePicker({ index, text, config, overrides, presets, disabled, onChange }: {
  index: number | null
  text: string
  config: P2Config
  overrides: P2Overrides
  presets: P2Preset[]
  disabled: boolean
  onChange: (presetId: string) => void
}) {
  const independent = Object.keys(overrides).length > 0
  const match = independent ? matchingVoice(configWithOverrides(config, overrides), presets) : undefined
  const selected = independent ? match?.id ?? '__custom__' : ''
  return <div className="batch-sentence-voice">
    <label htmlFor="batch-sentence-voice-pick">
      {index == null ? '本句音色' : '第 ' + String(index + 1) + ' 句音色'}
    </label>
    <select id="batch-sentence-voice-pick" value={selected} disabled={disabled || index == null}
      onChange={(event) => onChange(event.target.value)}>
      <option value="">跟随整批常用音色</option>
      {selected === '__custom__' ? <option value="__custom__" disabled>本句自定义音色／参数</option> : null}
      <PresetOptions presets={presets} />
    </select>
    <small title={text}>{index == null ? '将光标放到正文中的一句，即可快捷换音色。' :
      '只改这一句；载入 Caption、参考和参数。选择跟随会恢复整批设置。'}</small>
  </div>
}
