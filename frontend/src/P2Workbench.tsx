import { useEffect, useState } from 'react'
import {
  ApiError,
  errorMessage,
  fetchAssets,
  fetchLoras,
  fetchStatus,
  isAbortError,
} from './api'
import type { Asset, Lora, ServiceStatus } from './types'
import {
  createPreset,
  fetchPresets,
  renameAsset,
  updatePreset,
} from './p2-api'
import type {
  P2Preset,
  P2PresetInput,
  P2PresetUpdate,
} from './p2-api'
import { AssetPanel, PresetPanel } from './p2/Panels'
import { ProjectWorkspace } from './p2/ProjectWorkspace'
import { useProjectEditor } from './p2/useProjectEditor'
import './p2.css'

type Tab = 'projects' | 'presets' | 'assets'

function P2Workbench() {
  const [tab, setTab] = useState<Tab>('projects')

  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)

  const [loras, setLoras] = useState<Lora[]>([])
  const [lorasLoading, setLorasLoading] = useState(true)
  const [lorasError, setLorasError] = useState<string | null>(null)
  const [lorasVersion, setLorasVersion] = useState(0)

  const [assets, setAssets] = useState<Asset[]>([])
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [assetsError, setAssetsError] = useState<string | null>(null)
  const [assetsVersion, setAssetsVersion] = useState(0)

  const [presets, setPresets] = useState<P2Preset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [presetsVersion, setPresetsVersion] = useState(0)

  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let controller: AbortController | undefined

    setStatusLoading(true)
    setStatusError(null)

    const poll = async () => {
      controller = new AbortController()
      try {
        const next = await fetchStatus(controller.signal)
        if (!active) return
        setStatus(next)
        setStatusError(null)
      } catch (error) {
        if (!active || isAbortError(error)) return
        setStatus(null)
        setStatusError(errorMessage(error))
      } finally {
        if (active) {
          setStatusLoading(false)
          timer = window.setTimeout(() => {
            void poll()
          }, 5000)
        }
      }
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      controller?.abort()
    }
  }, [statusVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLorasLoading(true)
    setLorasError(null)
    void fetchLoras(controller.signal)
      .then((items) => {
        if (active) setLoras(items)
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setLorasError(errorMessage(error))
      })
      .finally(() => {
        if (active) setLorasLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [lorasVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAssetsLoading(true)
    setAssetsError(null)
    void fetchAssets(controller.signal)
      .then((items) => {
        if (active) setAssets(items)
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setAssetsError(errorMessage(error))
      })
      .finally(() => {
        if (active) setAssetsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [assetsVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setPresetsLoading(true)
    setPresetsError(null)
    void fetchPresets(controller.signal)
      .then((items) => {
        if (active) setPresets(items)
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setPresetsError(errorMessage(error))
        }
      })
      .finally(() => {
        if (active) setPresetsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [presetsVersion])

  const isRealMode = status?.mode === 'irodori'
  const inferenceAvailable = status?.inference.available === true
  let blockedReason: string | null = null
  if (statusLoading) {
    blockedReason = '正在读取服务状态，暂不能生成。'
  } else if (statusError) {
    blockedReason = '无法确认推理服务状态，暂不能生成。'
  } else if (!status) {
    blockedReason = '服务状态未知，暂不能生成。'
  } else if (!status.inference.available) {
    blockedReason = status.inference.error
      ? '推理服务不可用：' + status.inference.error
      : '推理服务当前不可用，暂不能生成。'
  }

  const editor = useProjectEditor({
    presets,
    blockedReason,
    setNotice,
    setActionError,
    setConflict,
    onShowProjects: () => setTab('projects'),
  })
  const {
    guard,
    guardBusy,
    guardSaveAndContinue,
    guardDiscardAndContinue,
    cancelGuard,
    ...workspace
  } = editor

  async function handleCreatePreset(input: P2PresetInput) {
    setPresetsError(null)
    try {
      const preset = await createPreset(input)
      setPresets((items) => [...items, preset])
      setNotice('已创建预设 ' + preset.voice_name + ' · ' + preset.name + '。')
      return preset
    } catch (error) {
      setPresetsError('创建预设失败：' + errorMessage(error))
      return null
    }
  }

  async function handleUpdatePreset(id: string, input: P2PresetUpdate) {
    setPresetsError(null)
    try {
      const preset = await updatePreset(id, input)
      setPresets((items) =>
        items.map((item) => (item.id === preset.id ? preset : item)),
      )
      setNotice(
        '已保存预设 ' +
          preset.voice_name +
          ' · ' +
          preset.name +
          ' 的新版本 v' +
          String(preset.version) +
          '。',
      )
      return preset
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPresetsError(
          '预设版本冲突（409）：' +
            errorMessage(error) +
            ' 当前编辑仍保留，请刷新预设后重试。',
        )
      } else {
        setPresetsError('保存预设失败：' + errorMessage(error))
      }
      return null
    }
  }

  async function handleRenameAsset(id: string, name: string) {
    setActionError(null)
    try {
      const updated = await renameAsset(id, name)
      setAssets((items) =>
        items.map((asset) => (asset.id === updated.id ? updated : asset)),
      )
      setNotice('素材已改名为「' + updated.name + '」。')
      return true
    } catch (error) {
      setActionError('素材改名失败：' + errorMessage(error))
      return false
    }
  }

  function handleAssetUploaded(asset: Asset) {
    setAssets((items) => [asset, ...items.filter((item) => item.id !== asset.id)])
    setAssetsError(null)
    setNotice('已上传素材「' + asset.name + '」。')
  }

  let bannerClass = 'mode-banner loading'
  let bannerCode = 'SYNC'
  let bannerTitle = '正在读取服务状态'
  let bannerBody = '确认推理服务与运行模式后即可生成语音。'
  if (statusError) {
    bannerClass = 'mode-banner offline'
    bannerCode = 'OFFLINE'
    bannerTitle = '无法读取服务状态'
    bannerBody = '暂时无法确认推理服务是否可用，生成已禁用。'
  } else if (statusLoading) {
    bannerClass = 'mode-banner loading'
    bannerCode = 'SYNC'
    bannerTitle = '正在读取服务状态'
    bannerBody = '确认推理服务与运行模式后即可生成语音。'
  } else if (status && !status.inference.available) {
    bannerClass = 'mode-banner offline'
    bannerCode = 'OFFLINE'
    bannerTitle = '推理服务不可用'
    bannerBody = status.inference.error ?? '当前不能生成语音。'
  } else if (status?.mode === 'irodori') {
    bannerClass = 'mode-banner real'
    bannerCode = 'REAL'
    bannerTitle = '真实语音模式'
    bannerBody = '任务会使用本机模型生成；保存草稿不会触发推理。'
  } else if (status?.mode === 'fake') {
    bannerClass = 'mode-banner fake'
    bannerCode = 'FAKE'
    bannerTitle = '测试音模式'
    bannerBody = '当前后端返回测试音，仅用于验证项目、队列和播放流程。'
  }

  return (
    <div className="p2-workbench app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="site-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">IRODORI · P2</p>
            <h1>项目与预设</h1>
          </div>
        </div>
        <div className={'header-note' + (inferenceAvailable ? '' : ' muted')}>
          <span className="header-dot" aria-hidden="true" />
          {statusLoading
            ? '正在读取服务状态'
            : statusError
              ? '服务状态异常'
              : status?.inference.available
                ? isRealMode
                  ? '本机模型可用'
                  : '测试音模式可用'
                : '推理服务不可用'}
        </div>
      </header>

      <section className={bannerClass} aria-label="运行模式提示">
        <div className="mode-signal" aria-hidden="true">
          <span />
        </div>
        <div className="mode-copy">
          <strong>{bannerTitle}</strong>
          <p>{bannerBody}</p>
          {statusError ? <p className="mode-reason">{statusError}</p> : null}
          {statusError ? (
            <button
              className="quiet-button"
              type="button"
              onClick={() => setStatusVersion((value) => value + 1)}
            >
              重新读取状态
            </button>
          ) : null}
        </div>
        <span className="mode-code">{bannerCode}</span>
      </section>

      <nav className="p2-tabs" aria-label="P2 分区">
        <button
          type="button"
          className={tab === 'projects' ? 'is-active' : ''}
          aria-current={tab === 'projects' ? 'page' : undefined}
          onClick={() => setTab('projects')}
        >
          项目
          {editor.dirty ? <span className="p2-tab-dirty">草稿</span> : null}
        </button>
        <button
          type="button"
          className={tab === 'presets' ? 'is-active' : ''}
          aria-current={tab === 'presets' ? 'page' : undefined}
          onClick={() => setTab('presets')}
        >
          音色预设
        </button>
        <button
          type="button"
          className={tab === 'assets' ? 'is-active' : ''}
          aria-current={tab === 'assets' ? 'page' : undefined}
          onClick={() => setTab('assets')}
        >
          素材管理
        </button>
      </nav>

      <div className="p2-message-stack" aria-live="polite">
        {actionError ? (
          <div className="inline-message error" role="alert">
            <span className="message-icon" aria-hidden="true">
              !
            </span>
            <p>{actionError}</p>
            <button
              className="message-action"
              type="button"
              onClick={() => setActionError(null)}
            >
              关闭
            </button>
          </div>
        ) : null}
        {notice ? (
          <div className="inline-message success" role="status">
            <span className="message-icon" aria-hidden="true">
              ✓
            </span>
            <p>{notice}</p>
          </div>
        ) : null}
        {conflict ? (
          <div className="p2-conflict" role="alert">
            <div>
              <strong>修订冲突</strong>
              <p>{conflict}</p>
            </div>
            <div className="p2-inline-row">
              <button
                className="quiet-button danger"
                type="button"
                onClick={editor.requestReload}
                disabled={editor.busy}
              >
                重新加载服务器
              </button>
              <button
                className="quiet-button"
                type="button"
                onClick={() => setConflict(null)}
              >
                保留草稿继续编辑
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <main hidden={tab !== 'projects'}>
        <ProjectWorkspace
          {...workspace}
          presets={presets}
          assets={assets}
          loras={loras}
          status={status}
          statusLoading={statusLoading}
          statusError={statusError}
          isRealMode={isRealMode}
          blockedReason={blockedReason}
          setActionError={setActionError}
        />
      </main>

      <main role="tabpanel" aria-label="音色预设" hidden={tab !== 'presets'}>
          <PresetPanel
            presets={presets}
            assets={assets}
            loras={loras}
            loading={presetsLoading}
            error={presetsError}
            busy={false}
            onRefresh={() => setPresetsVersion((value) => value + 1)}
            onCreate={handleCreatePreset}
            onUpdate={handleUpdatePreset}
          />
          {lorasLoading ? (
            <p className="p2-hint">正在读取 LoRA 列表……</p>
          ) : null}
          {lorasError ? (
            <div className="inline-message error" role="alert">
              <span className="message-icon" aria-hidden="true">
                !
              </span>
              <p>模型列表读取失败：{lorasError}</p>
              <button
                className="message-action"
                type="button"
                onClick={() => setLorasVersion((value) => value + 1)}
              >
                重试
              </button>
            </div>
          ) : null}
          {assetsError ? (
            <p className="p2-inline-error" role="alert">
              素材列表读取失败：{assetsError}
            </p>
          ) : null}
      </main>

      <main role="tabpanel" aria-label="素材管理" hidden={tab !== 'assets'}>
          <AssetPanel
            assets={assets}
            loading={assetsLoading}
            error={assetsError}
            onRefresh={() => setAssetsVersion((value) => value + 1)}
            onUploaded={handleAssetUploaded}
            onRename={handleRenameAsset}
          />
      </main>

      <footer className="site-footer">
        <span>Irodori 工作台 · P2</span>
        <span>
          {statusLoading
            ? '模式读取中'
            : statusError
              ? '模式未知'
              : isRealMode
                ? '本机模型推理'
                : '测试音环境'}
        </span>
      </footer>

      {guard ? (
        <div className="p2-modal-backdrop" role="presentation">
          <div
            className="p2-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="p2-guard-title"
          >
            <h2 id="p2-guard-title">当前项目有未保存草稿</h2>
            <p>
              {guard.kind === 'create'
                ? '创建新项目会切换当前页面。'
                : '切换或重新加载项目会离开当前草稿。'}
              请选择如何处理这份草稿。
            </p>
            <div className="p2-modal-actions">
              <button
                className="primary-button"
                type="button"
                onClick={guardSaveAndContinue}
                disabled={guardBusy || editor.saving}
              >
                {guardBusy ? '保存中……' : '保存并继续'}
              </button>
              <button
                className="quiet-button danger"
                type="button"
                onClick={guardDiscardAndContinue}
                disabled={guardBusy}
              >
                放弃草稿并继续
              </button>
              <button
                className="quiet-button"
                type="button"
                onClick={cancelGuard}
                disabled={guardBusy}
              >
                取消，留在当前项目
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default P2Workbench
