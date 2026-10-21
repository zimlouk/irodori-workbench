import type { Asset, Lora } from '../types'
import type {
  P2Config,
  P2Preset,
  P2PresetInput,
  P2PresetUpdate,
} from '../p2-api'
import { ConfigEditor } from '../p2/ConfigEditor'
import { AssetPanel, PresetPanel } from '../p2/Panels'
import { cloneConfig } from './model'
import { matchingVoice } from './voice-selection'
import { PresetOptions } from './PresetOptions'
import { PresetOrderPanel } from './PresetOrderPanel'
import { loraLabel } from '../lora-label'
import './voice-settings.css'

interface SettingsPanelProps {
  config: P2Config
  outputDir: string
  assets: Asset[]
  loras: Lora[]
  presets: P2Preset[]
  presetsLoading: boolean
  presetsError: string | null
  assetsLoading: boolean
  assetsError: string | null
  busy: boolean
  hasBatch: boolean
  onConfigChange: (config: P2Config) => void
  onOutputDirChange: (value: string) => void
  onOpenOutput: () => void
  onRefreshPresets: () => void
  onCreatePreset: (input: P2PresetInput) => Promise<P2Preset | null>
  onUpdatePreset: (
    id: string,
    input: P2PresetUpdate,
  ) => Promise<P2Preset | null>
  onDeletePreset?: (id: string, version: number) => Promise<boolean>
  onPresetOrderSaved: (presets:P2Preset[]) => void
  onRefreshAssets: () => void
  onAssetUploaded: (asset: Asset) => void
  onRenameAsset: (id: string, name: string) => Promise<boolean>
}

export function SettingsPanel({
  config,
  outputDir,
  assets,
  loras,
  presets,
  presetsLoading,
  presetsError,
  assetsLoading,
  assetsError,
  busy,
  hasBatch,
  onConfigChange,
  onOutputDirChange,
  onOpenOutput,
  onRefreshPresets,
  onCreatePreset,
  onUpdatePreset,
  onDeletePreset,
  onPresetOrderSaved,
  onRefreshAssets,
  onAssetUploaded,
  onRenameAsset,
}: SettingsPanelProps) {
  const referenceLabel =
    config.reference_asset_ids.length === 0
      ? '无参考'
      : String(config.reference_asset_ids.length) + ' 个参考'
  const selectedVoice = matchingVoice(config, presets)
  const selectedLora = loras.find(item=>item.id===config.lora_id)

  function loadPreset(id: string): void {
    const preset = presets.find((item) => item.id === id)
    if (!preset) return
    onConfigChange(cloneConfig(preset.config))
  }

  return (
    <section className="batch-settings" aria-labelledby="batch-settings-title">
      <div className="batch-section-head">
        <div>
          <p className="batch-kicker">整批设置</p>
          <h2 id="batch-settings-title">声音与生成参数</h2>
        </div>
        <p className="batch-section-note">
          当前设置自动保存；新一批会继承整批配置与临时替换。
        </p>
      </div>

      <div className="batch-settings-grid voice-settings-grid">
        <label className="batch-field voice-settings-voice">
          <span>常用音色</span>
          <select
            value={selectedVoice?.id ?? '__custom__'}
            onChange={(event) => loadPreset(event.target.value)}
            disabled={busy || presets.length === 0}
            aria-label="选择常用音色并载入配置"
          >
            <option value="">
              {presets.length === 0 ? '暂无常用音色' : '选择常用音色以载入配置'}
            </option>
            {!selectedVoice ? <option value="__custom__" disabled>当前自定义配置（可载入常用音色）</option> : null}
            <PresetOptions presets={presets} />
          </select>
          <small className="batch-hint">载入预设会复制模型、参考、Caption 和参数。</small>
        </label>
        <div className="batch-field voice-settings-model">
          <label htmlFor="batch-current-lora">当前 LoRA / 训练版本</label>
          <select id="batch-current-lora" value={config.lora_id??''} disabled={busy}
            onChange={event=>onConfigChange({...config,lora_id:event.target.value||null})}>
            <option value="">基础模型（不加载 LoRA）</option>
            {config.lora_id&&!selectedLora?<option value={config.lora_id}>未找到当前 LoRA</option>:null}
            {loras.map(item=><option key={item.id} value={item.id} disabled={!item.available}>
              {loraLabel(item)}{item.available?'':'（不可用）'}
            </option>)}
          </select>
          <small title={selectedLora?.relative_path}>
            {selectedLora?.relative_path??(config.lora_id?'当前模型不在可用目录中':'使用基础模型')}
          </small>
        </div>
      </div>

      <div className="batch-caption-card">
        <div className="batch-caption-heading">
          <label htmlFor="batch-caption">整批 Caption</label>
          <span>未单独覆盖的句子使用此处</span>
        </div>
        <textarea id="batch-caption" rows={2} value={config.caption}
          onChange={event=>onConfigChange({...config,caption:event.target.value})}
          placeholder="描述声音、情绪或语气；可选，留空清除" />
        <p className="batch-caption-help">载入常用音色会填入其 Caption；修改此处只影响当前整批，不会改写预设。参考音频：{referenceLabel}。</p>
      </div>

      <details className="batch-settings-details">
        <summary>展开生成参数与参考顺序</summary>
        <ConfigEditor
          value={config}
          onChange={onConfigChange}
          assets={assets}
          loras={loras}
          idPrefix="batch-global"
          disabled={false}
          showCaption={false}
          showLora={false}
        />
      </details>

      <PresetOrderPanel presets={presets} onSaved={onPresetOrderSaved} />

      <div className="batch-settings-details-row">
        <details className="batch-settings-details">
          <summary>常用音色管理</summary>
          <PresetPanel
            presets={presets}
            assets={assets}
            loras={loras}
            loading={presetsLoading}
            error={presetsError}
            busy={busy}
            onRefresh={onRefreshPresets}
            onCreate={onCreatePreset}
            onUpdate={onUpdatePreset}
            onDelete={onDeletePreset}
          />
        </details>
        <details className="batch-settings-details">
          <summary>参考素材管理</summary>
          <AssetPanel
            assets={assets}
            loading={assetsLoading}
            error={assetsError}
            onRefresh={onRefreshAssets}
            onUploaded={onAssetUploaded}
            onRename={onRenameAsset}
          />
        </details>
      </div>

      <div className="batch-output-row">
        <label className="batch-field">
          <span>输出目录</span>
          <input
            type="text"
            value={outputDir}
            onChange={(event) => onOutputDirChange(event.target.value)}
            placeholder="例如 D:\voice-output"
            spellCheck={false}
          />
        </label>
        <button
          className="quiet-button"
          type="button"
          onClick={onOpenOutput}
          disabled={busy || !hasBatch}
        >
          打开文件夹
        </button>
      </div>
      <p className="batch-hint">
        所有批次写入同一目录；每句只保留当前选中版本的输出文件。打开文件夹只会在点击后执行。
      </p>
    </section>
  )
}
