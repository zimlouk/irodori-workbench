import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Asset, Lora } from '../types'
import {
  MAX_ASSET_BYTES,
  errorMessage,
  uploadAsset,
} from '../api'
import type {
  P2Preset,
  P2PresetInput,
  P2PresetUpdate,
} from '../p2-api'
import { ConfigEditor } from './ConfigEditor'
import { emptyConfig, validateConfig } from './model'

function shortNumber(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '时长未知'
  if (seconds < 60) return seconds.toFixed(2) + ' 秒'
  const minutes = Math.floor(seconds / 60)
  return (
    String(minutes) + ' 分 ' + (seconds - minutes * 60).toFixed(1) + ' 秒'
  )
}

interface PresetPanelProps {
  presets: P2Preset[]
  assets: Asset[]
  loras: Lora[]
  loading: boolean
  error: string | null
  busy: boolean
  onRefresh: () => void
  onCreate: (input: P2PresetInput) => Promise<P2Preset | null>
  onUpdate: (id: string, input: P2PresetUpdate) => Promise<P2Preset | null>
  onDelete?: (id: string, version: number) => Promise<boolean>
}

export function PresetPanel({
  presets,
  assets,
  loras,
  loading,
  error,
  busy,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
}: PresetPanelProps) {
  const [mode, setMode] = useState<'new' | 'edit'>('new')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editVersion, setEditVersion] = useState(1)
  const [voiceName, setVoiceName] = useState('')
  const [name, setName] = useState('')
  const [config, setConfig] = useState(() => emptyConfig())
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localNotice, setLocalNotice] = useState<string | null>(null)

  const selected = presets.find((preset) => preset.id === selectedId) ?? null
  const locked = saving || busy || deleting

  const groups = useMemo(() => {
    const groups: [string,P2Preset[]][] = []
    presets.forEach((preset) => {
      const prior = groups[groups.length-1]
      if(prior?.[0]===preset.voice_name) prior[1].push(preset)
      else groups.push([preset.voice_name,[preset]])
    })
    return groups
  }, [presets])

  function markDirty() {
    setDirty(true)
    setLocalError(null)
    setLocalNotice(null)
  }

  function startNew() {
    if (deleting) return
    if (dirty && !window.confirm('当前预设编辑尚未保存，确定放弃并新建吗？')) {
      return
    }
    setMode('new')
    setSelectedId(null)
    setVoiceName('')
    setName('')
    setConfig(emptyConfig())
    setDirty(false)
    setLocalError(null)
    setLocalNotice(null)
  }

  function editPreset(preset: P2Preset) {
    if (deleting) return
    if (
      dirty &&
      !window.confirm('当前预设编辑尚未保存，确定放弃并切换吗？')
    ) {
      return
    }
    setMode('edit')
    setSelectedId(preset.id)
    setEditVersion(preset.version)
    setVoiceName(preset.voice_name)
    setName(preset.name)
    setConfig({
      lora_id: preset.config.lora_id,
      reference_asset_ids: [...preset.config.reference_asset_ids],
      caption: preset.config.caption,
      parameters: { ...preset.config.parameters },
    })
    setDirty(false)
    setLocalError(null)
    setLocalNotice(null)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked) return
    setLocalError(null)
    setLocalNotice(null)

    if (!voiceName.trim()) {
      setLocalError('请填写角色名。')
      return
    }
    if (!name.trim()) {
      setLocalError('请填写预设名。')
      return
    }
    const configError = validateConfig(config)
    if (configError) {
      setLocalError(configError)
      return
    }

    setSaving(true)
    try {
      if (mode === 'edit' && selected) {
        const saved = await onUpdate(selected.id, {
          version: editVersion,
          voice_name: voiceName.trim(),
          name: name.trim(),
          config,
        })
        if (saved) {
          setSelectedId(saved.id)
          setEditVersion(saved.version)
          setVoiceName(saved.voice_name)
          setName(saved.name)
          setConfig({
            lora_id: saved.config.lora_id,
            reference_asset_ids: [...saved.config.reference_asset_ids],
            caption: saved.config.caption,
            parameters: { ...saved.config.parameters },
          })
          setDirty(false)
          setLocalNotice('预设已保存为 v' + String(saved.version) + '。')
        }
      } else {
        const saved = await onCreate({
          voice_name: voiceName.trim(),
          name: name.trim(),
          config,
        })
        if (saved) {
          setMode('edit')
          setSelectedId(saved.id)
          setEditVersion(saved.version)
          setVoiceName(saved.voice_name)
          setName(saved.name)
          setDirty(false)
          setLocalNotice('已创建预设 v' + String(saved.version) + '。')
        }
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!onDelete || !selected || locked) return
    const preset = selected
    const unsavedNote = dirty ? '\n当前未保存的编辑也会放弃。' : ''
    const confirmed = window.confirm(
      '确定删除预设「' +
        preset.voice_name +
        ' · ' +
        preset.name +
        '」吗？\n只删除模板，已有正文配置和音频保留。' +
        unsavedNote,
    )
    if (!confirmed) return

    setDeleting(true)
    try {
      const deleted = await onDelete(preset.id, editVersion)
      if (!deleted) return
      setMode('new')
      setSelectedId(null)
      setEditVersion(1)
      setVoiceName('')
      setName('')
      setConfig(emptyConfig())
      setDirty(false)
      setLocalError(null)
      setLocalNotice(
        '已删除预设「' +
          preset.name +
          '」。只删除了模板，已有正文配置和音频保留。',
      )
    } catch (error) {
      setLocalError(errorMessage(error))
      setLocalNotice(null)
    } finally {
      setDeleting(false)
    }
  }

  const editorTitle =
    mode === 'edit' && selected
      ? '编辑预设：' + selected.voice_name + ' · ' + selected.name
      : '新建音色预设'

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  return (
    <div className="p2-preset-layout">
      <aside className="p2-subpanel p2-preset-list">
        <div className="p2-subheading">
          <div>
            <p className="kicker">VOICE PRESETS</p>
            <h2>音色预设</h2>
          </div>
          <button
            className="quiet-button"
            type="button"
            onClick={onRefresh}
            disabled={loading || locked}
          >
            刷新
          </button>
        </div>
        <p className="p2-hint">
          预设是可重复载入的声音模板。选择常用音色时，会把 Caption、参考和参数复制到整批设置。
        </p>
        <button
          className="quiet-button accent p2-full-button"
          type="button"
          onClick={startNew}
          disabled={locked}
        >
          新建预设
        </button>

        {loading && presets.length === 0 ? (
          <p className="p2-empty-line">正在读取预设……</p>
        ) : error ? (
          <div className="inline-message error" role="alert">
            <span className="message-icon" aria-hidden="true">
              !
            </span>
            <p>{error}</p>
          </div>
        ) : presets.length === 0 ? (
          <p className="p2-empty-line">还没有预设。可以先创建一个角色预设。</p>
        ) : (
          <div className="p2-preset-groups">
            {groups.map(([group, items], index) => (
              <section key={index}>
                <h3>{group} <small>{items[0]?.work??'其他'}</small></h3>
                <ul>
                  {items.map((preset) => (
                    <li key={preset.id}>
                      <button
                        type="button"
                        className={
                          'p2-preset-item' +
                          (preset.id === selectedId && mode === 'edit'
                            ? ' is-active'
                            : '')
                        }
                        onClick={() => editPreset(preset)}
                        disabled={locked}
                      >
                        <span>
                          <strong>{preset.name}</strong>
                          <small>预设第{String(preset.version)}版</small>
                        </span>
                        <span className="p2-preset-time">
                          {preset.updated_at
                            ? new Date(preset.updated_at).toLocaleString('zh-CN')
                            : '时间未知'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </aside>

      <form className="p2-subpanel p2-preset-editor" onSubmit={handleSubmit}>
        <div className="p2-subheading">
          <div>
            <p className="kicker">PRESET CONFIG</p>
            <h2>{editorTitle}</h2>
          </div>
          {mode === 'edit' && selected ? (
            <span className="p2-version-chip">已保存 v{selected.version}</span>
          ) : (
            <span className="p2-version-chip">未保存</span>
          )}
        </div>

        <div className="p2-field-grid">
          <div className="p2-field">
            <label htmlFor="p2-preset-voice">角色名</label>
            <input
              id="p2-preset-voice"
              value={voiceName}
              onChange={(event) => {
                setVoiceName(event.target.value)
                markDirty()
              }}
              placeholder="例如：小春"
              disabled={locked}
            />
          </div>
          <div className="p2-field">
            <label htmlFor="p2-preset-name">预设名</label>
            <input
              id="p2-preset-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                markDirty()
              }}
              placeholder="例如：柔和叙述"
              disabled={locked}
            />
          </div>
        </div>

        <ConfigEditor
          value={config}
          onChange={(next) => {
            setConfig(next)
            markDirty()
          }}
          assets={assets}
          loras={loras}
          idPrefix="p2-preset-config"
          captionLabel="预设 Caption（保存到模板）"
          disabled={locked}
        />

        {localError ? (
          <div className="inline-message error" role="alert">
            <span className="message-icon" aria-hidden="true">
              !
            </span>
            <p>{localError}</p>
          </div>
        ) : null}
        {localNotice ? (
          <div className="inline-message success" role="status">
            <span className="message-icon" aria-hidden="true">
              ✓
            </span>
            <p>{localNotice}</p>
          </div>
        ) : null}

        <div className="p2-form-actions">
          <p className="p2-hint">
            修改这里只更新预设模板；当前批次不会自动改变，需要重新载入常用音色才会应用。
          </p>
          <div className="p2-inline-row">
            {onDelete && mode === 'edit' && selected ? (
              <button
                className="quiet-button danger"
                type="button"
                onClick={handleDelete}
                disabled={locked}
              >
                {deleting ? '删除中……' : '删除此预设'}
              </button>
            ) : null}
            <button className="primary-button" type="submit" disabled={locked}>
              {saving ? (
                <>
                  <span className="spinner" aria-hidden="true" /> 保存中……
                </>
              ) : mode === 'edit' ? (
                '保存预设新版本'
              ) : (
                '创建预设'
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

interface AssetPanelProps {
  assets: Asset[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  onUploaded: (asset: Asset) => void
  onRename: (id: string, name: string) => Promise<boolean>
}

interface UploadIssue {
  fileName: string
  message: string
}

export function AssetPanel({
  assets,
  loading,
  error,
  onRefresh,
  onUploaded,
  onRename,
}: AssetPanelProps) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    current: number
    total: number
    name: string
  } | null>(null)
  const [uploadIssues, setUploadIssues] = useState<UploadIssue[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const preview = previewId
    ? assets.find((asset) => asset.id === previewId) ?? null
    : null

  async function handleFiles(fileList: FileList | null) {
    const files = fileList ? Array.from(fileList) : []
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (files.length === 0 || uploading) return

    setUploading(true)
    setUploadIssues([])
    const issues: UploadIssue[] = []

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      setUploadProgress({
        current: index + 1,
        total: files.length,
        name: file.name,
      })
      const lower = file.name.toLowerCase()
      const isWav =
        lower.endsWith('.wav') ||
        file.type === 'audio/wav' ||
        file.type === 'audio/x-wav' ||
        file.type === 'audio/wave'
      if (!isWav) {
        issues.push({ fileName: file.name, message: '仅支持 WAV 文件。' })
        setUploadIssues([...issues])
        continue
      }
      if (file.size === 0) {
        issues.push({ fileName: file.name, message: '文件为空。' })
        setUploadIssues([...issues])
        continue
      }
      if (file.size > MAX_ASSET_BYTES) {
        issues.push({ fileName: file.name, message: '文件超过 30 MiB 上限。' })
        setUploadIssues([...issues])
        continue
      }
      try {
        const asset = await uploadAsset(file)
        onUploaded(asset)
      } catch (uploadError) {
        issues.push({ fileName: file.name, message: errorMessage(uploadError) })
        setUploadIssues([...issues])
      }
    }

    setUploadProgress(null)
    setUploading(false)
  }

  function startRename(asset: Asset) {
    setRenameId(asset.id)
    setRenameValue(asset.name)
    setRenameError(null)
  }

  async function submitRename(asset: Asset) {
    if (renaming) return
    if (!renameValue.trim()) {
      setRenameError('素材名称不能为空。')
      return
    }
    setRenaming(true)
    setRenameError(null)
    try {
      const ok = await onRename(asset.id, renameValue.trim())
      if (ok) {
        setRenameId(null)
        setRenameValue('')
      }
    } finally {
      setRenaming(false)
    }
  }

  return (
    <section className="p2-subpanel p2-assets-panel">
      <div className="p2-subheading">
        <div>
          <p className="kicker">ASSET LIBRARY</p>
          <h2>素材管理</h2>
        </div>
        <div className="p2-inline-row">
          <button
            className="quiet-button"
            type="button"
            onClick={onRefresh}
            disabled={loading || uploading}
          >
            刷新
          </button>
          <label
            className={
              'upload-button' + (uploading ? ' is-disabled' : '')
            }
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".wav,audio/wav,audio/x-wav,audio/wave"
              multiple
              disabled={uploading}
              onChange={(event) => {
                void handleFiles(event.target.files)
              }}
            />
            {uploading ? '上传中……' : '上传 WAV'}
          </label>
        </div>
      </div>

      <p className="p2-hint">
        单个 WAV 最大 30 MiB；可多选串行上传。P2 范围内不提供删除素材。
      </p>

      {uploadProgress ? (
        <div className="p2-upload-progress" role="status">
          <span className="spinner dark" aria-hidden="true" />
          正在上传 {uploadProgress.current} / {uploadProgress.total}：
          {uploadProgress.name}
        </div>
      ) : null}

      {uploadIssues.length > 0 ? (
        <div className="inline-message error" role="alert">
          <span className="message-icon" aria-hidden="true">
            !
          </span>
          <div>
            <strong>部分素材上传失败</strong>
            <ul>
              {uploadIssues.map((issue, index) => (
                <li key={String(index) + ':' + issue.fileName}>
                  {issue.fileName}：{issue.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      {loading && assets.length === 0 ? (
        <p className="p2-empty-line">正在读取素材列表……</p>
      ) : error ? (
        <div className="inline-message error" role="alert">
          <span className="message-icon" aria-hidden="true">
            !
          </span>
          <p>{error}</p>
        </div>
      ) : assets.length === 0 ? (
        <p className="p2-empty-line">还没有素材。上传 WAV 后可试听、改名并加入参考。</p>
      ) : (
        <ul className="p2-asset-grid">
          {assets.map((asset) => (
            <li key={asset.id} className="p2-asset-card">
              <div className="p2-asset-top">
                <strong title={asset.name}>{asset.name}</strong>
                <span className="p2-mono">{asset.id.slice(0, 8)}</span>
              </div>
              <p className="p2-asset-meta">
                {formatDuration(asset.duration_seconds)} ·{' '}
                {shortNumber(asset.sample_rate)} Hz · {asset.channels} 声道
              </p>

              {renameId === asset.id ? (
                <div className="p2-rename-row">
                  <label htmlFor={'p2-asset-rename-' + asset.id}>
                    素材名称
                  </label>
                  <input
                    id={'p2-asset-rename-' + asset.id}
                    value={renameValue}
                    onChange={(event) => {
                      setRenameValue(event.target.value)
                      setRenameError(null)
                    }}
                    maxLength={200}
                    disabled={renaming}
                  />
                  <button
                    className="quiet-button accent"
                    type="button"
                    onClick={() => void submitRename(asset)}
                    disabled={renaming}
                  >
                    {renaming ? '保存中……' : '保存名称'}
                  </button>
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => {
                      setRenameId(null)
                      setRenameError(null)
                    }}
                    disabled={renaming}
                  >
                    取消
                  </button>
                  {renameError ? (
                    <span className="p2-inline-error" role="alert">
                      {renameError}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="p2-inline-row">
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => setPreviewId(asset.id)}
                  >
                    试听
                  </button>
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => startRename(asset)}
                  >
                    改名
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {preview ? (
        <div className="p2-asset-preview">
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
            关闭
          </button>
        </div>
      ) : null}
    </section>
  )
}
