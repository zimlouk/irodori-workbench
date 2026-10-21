import { useEffect, useRef, useState } from 'react'
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
  deletePreset,
  fetchPresets,
  renameAsset,
  updatePreset,
} from './p2-api'
import type {
  P2Preset,
  P2PresetInput,
  P2PresetUpdate,
} from './p2-api'
import { useBatchWorkbench } from './batch/useBatchWorkbench'
import { openSegmentOutput, fetchSavedRules, saveReplacementRules } from './batch-api'
import type { SavedReplacementRules } from './batch-api'
import { SettingsPanel } from './batch/SettingsPanel'
import { TextWorkspace } from './batch/TextWorkspace'
import { ConflictPanel } from './batch/ConflictPanel'
import { ResultPanel } from './batch/ResultPanel'
import { QueueFooter } from './batch/QueueFooter'
import { RecentDrawer } from './batch/RecentDrawer'
import { SentenceVoicePicker } from './batch/SentenceVoicePicker'
import { PreviewBar } from './batch/PreviewBar'
import { useBatchPreview } from './batch/useBatchPreview'
import {
  activeCount,
  displayOrigin,
  locateSegmentLine,
  needsGenerationCount,
} from './batch/model'
import './p2.css'
import './batch.css'
import './batch/results.css'

function pendingLabelCount(
  batch: ReturnType<typeof useBatchWorkbench>['state']['batch'],
  rightText: string,
  rightDirty: boolean,
): number {
  const base = needsGenerationCount(batch)
  if (!batch || !rightDirty) return base
  const lines = rightText.split('\n').filter((line) => line.trim().length > 0)
  let changed = Math.abs(lines.length - batch.segments.length)
  const shared = Math.min(lines.length, batch.segments.length)
  for (let index = 0; index < shared; index += 1) {
    if (lines[index] !== batch.segments[index].text) changed += 1
  }
  return Math.max(base, changed)
}

export default function BatchWorkbench() {
  const core = useBatchWorkbench()
  const { state } = core
  const rightRef = useRef<HTMLTextAreaElement | null>(null)
  const [recentOpen, setRecentOpen] = useState(false)
  const [sentenceIndex, setSentenceIndex] = useState<number | null>(null)
  const preview = useBatchPreview(state.batch, recentOpen)
  const [savedRules,setSavedRules] = useState<SavedReplacementRules|null>(null)
  const savedRulesRef = useRef(savedRules)
  savedRulesRef.current = savedRules
  useEffect(()=>{
    const controller=new AbortController()
    void fetchSavedRules(controller.signal).then(setSavedRules).catch(error=>{
      if(!isAbortError(error))core.setNotice('长期规则读取失败，可在保存时重试：'+errorMessage(error),'error')
    })
    return ()=>controller.abort()
  },[])

  async function handleSaveRules(value:string):Promise<boolean> {
    try {
      const current=savedRulesRef.current??await fetchSavedRules()
      const saved=await saveReplacementRules({revision:current.revision,persistent_rules:value})
      savedRulesRef.current=saved;setSavedRules(saved)
      return true
    } catch(error) {
      if(error instanceof ApiError&&error.status===409) {
        try {
          const latest=await fetchSavedRules()
          savedRulesRef.current=latest;setSavedRules(latest)
        } catch { /* Preserve the draft and show the original conflict. */ }
      }
      core.setNotice('保存长期规则失败：'+errorMessage(error),'error')
      return false
    }
  }
  useEffect(() => { setSentenceIndex(null) }, [state.batch?.id])

  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)

  const [loras, setLoras] = useState<Lora[]>([])
  const [lorasError, setLorasError] = useState<string | null>(null)

  const [assets, setAssets] = useState<Asset[]>([])
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [assetsError, setAssetsError] = useState<string | null>(null)
  const [assetsVersion, setAssetsVersion] = useState(0)

  const [presets, setPresets] = useState<P2Preset[]>([])
  const [presetsLoading, setPresetsLoading] = useState(true)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [presetsVersion, setPresetsVersion] = useState(0)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let controller: AbortController | undefined
    setStatusLoading(true)
    setStatusError(null)

    async function poll(): Promise<void> {
      controller = new AbortController()
      try {
        const next = await fetchStatus(controller.signal)
        if (!active) return
        setStatus(next)
        setStatusError(null)
      } catch (error) {
        if (!active || isAbortError(error)) return
        setStatusError(errorMessage(error))
      } finally {
        if (active) {
          setStatusLoading(false)
          timer = window.setTimeout(() => void poll(), 5000)
        }
      }
    }

    void poll()
    return () => {
      active = false
      controller?.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [statusVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    void fetchLoras(controller.signal)
      .then((items) => {
        if (!active) return
        setLoras(items)
        setLorasError(null)
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setLorasError(errorMessage(error))
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAssetsLoading(true)
    void fetchAssets(controller.signal)
      .then((items) => {
        if (!active) return
        setAssets(items)
        setAssetsError(null)
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
    void fetchPresets(controller.signal)
      .then((items) => {
        if (!active) return
        setPresets(items)
        setPresetsError(null)
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) setPresetsError(errorMessage(error))
      })
      .finally(() => {
        if (active) setPresetsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [presetsVersion])

  const inferenceBlocked = statusLoading
    ? '正在读取服务状态，暂不能生成。'
    : statusError
      ? '无法确认推理服务状态，暂不能生成。'
      : !status
        ? '服务状态未知，暂不能生成。'
        : !status.inference.available
          ? status.inference.error ?? '推理服务当前不可用，暂不能生成。'
          : null

  const canGenerate =
    inferenceBlocked === null &&
    state.batch !== null &&
    state.batch.segments.length > 0
  const generationCount = pendingLabelCount(
    state.batch,
    state.rightText,
    state.rightDirty,
  )
  const activeSegments = activeCount(state.batch)
  const conflictCount = state.batch?.conflicts.length ?? 0
  const externalOrigin = state.batch?.origin ?? 'workbench'

  async function handlePasteNewBatch(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        core.setNotice('剪贴板没有可用文本。', 'warning')
        return
      }
      await core.createNewBatch(text)
    } catch (error) {
      core.setNotice('无法读取剪贴板：' + errorMessage(error), 'error')
    }
  }

  function locateSegment(segmentId: string): void {
    if (!state.batch || !rightRef.current) return
    const line = locateSegmentLine(state.rightText, state.batch.segments, segmentId)
    if (line < 0) {
      core.setNotice('当前正文里没有找到这一句，可能还没有保存。', 'warning')
      return
    }
    const lines = state.rightText.split('\n')
    let start = 0
    for (let index = 0; index < line; index += 1) {
      start += lines[index].length + 1
    }
    const end = start + lines[line].length
    const textarea = rightRef.current
    textarea.focus()
    textarea.setSelectionRange(start, end)
    setSentenceIndex(state.rightText.slice(0, start).split('\n').filter((text) => text.trim()).length)
  }

  async function handleCreatePreset(
    input: P2PresetInput,
  ): Promise<P2Preset | null> {
    try {
      const preset = await createPreset(input)
      setPresets((items) => [...items, preset])
      setPresetsVersion(value=>value+1)
      setPresetsError(null)
      core.setNotice(
        '已保存常用音色 ' + preset.voice_name + ' · ' + preset.name + '。',
        'success',
      )
      return preset
    } catch (error) {
      setPresetsError('创建常用音色失败：' + errorMessage(error))
      return null
    }
  }

  async function handleUpdatePreset(
    id: string,
    input: P2PresetUpdate,
  ): Promise<P2Preset | null> {
    try {
      const preset = await updatePreset(id, input)
      setPresets((items) =>
        items.map((item) => (item.id === preset.id ? preset : item)),
      )
      setPresetsVersion(value=>value+1)
      setPresetsError(null)
      core.setNotice(
        '已保存常用音色新版本 v' + String(preset.version) + '。',
        'success',
      )
      return preset
    } catch (error) {
      setPresetsError('保存常用音色失败：' + errorMessage(error))
      return null
    }
  }

  async function handleDeletePreset(id: string, version: number): Promise<boolean> {
    try {
      await deletePreset(id, version)
      setPresets((items) => items.filter((item) => item.id !== id))
      setPresetsError(null)
      core.setNotice('已删除预设，当前正文配置和音频保留。', 'success')
      return true
    } catch (error) {
      setPresetsError('删除预设失败：' + errorMessage(error))
      return false
    }
  }

  async function handleOpenAudio(segmentId: string): Promise<void> {
    if (!state.batch) return
    try {
      await openSegmentOutput(state.batch.id, segmentId)
      core.setNotice('已在资源管理器中定位音频。', 'success')
    } catch (error) {
      core.setNotice('打开音频目录失败：' + errorMessage(error), 'error')
    }
  }

  async function handleRenameAsset(id: string, name: string): Promise<boolean> {
    try {
      const updated = await renameAsset(id, name)
      setAssets((items) =>
        items.map((item) => (item.id === updated.id ? updated : item)),
      )
      core.setNotice('素材已改名为「' + updated.name + '」。', 'success')
      return true
    } catch (error) {
      core.setNotice('素材改名失败：' + errorMessage(error), 'error')
      return false
    }
  }

  function handleAssetUploaded(asset: Asset): void {
    setAssets((items) => [asset, ...items.filter((item) => item.id !== asset.id)])
    core.setNotice('已上传素材「' + asset.name + '」。', 'success')
  }

  const modeCode = statusLoading
    ? 'SYNC'
    : statusError || !status
      ? 'OFFLINE'
      : status.mode === 'fake'
        ? 'FAKE'
        : 'REAL'
  const modeTitle = statusLoading
    ? '正在读取服务状态'
    : statusError || !status
      ? '无法读取服务状态'
      : status.mode === 'fake'
        ? '测试音模式'
        : '真实语音模式'
  const modeBody = statusLoading
    ? '确认运行模式和推理服务后即可生成。'
    : statusError || !status
      ? '暂时无法确认推理服务，生成按钮已禁用。保存与校对仍可继续。'
      : status.mode === 'fake'
        ? '当前后端返回测试音，只用于验证批次、队列、版本和播放流程。'
        : '任务会使用本机模型生成；保存草稿不会触发推理。'

  return (
    <div className="batch-workbench p2-workbench">
      <div className="batch-ambient batch-ambient-one" aria-hidden="true" />
      <div className="batch-ambient batch-ambient-two" aria-hidden="true" />

      <header className="batch-site-header">
        <div className="batch-brand">
          <div className="batch-brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="batch-eyebrow">IRODORI · BATCH VOICE</p>
            <h1>批量配音工作台</h1>
          </div>
        </div>
        <div className="batch-header-actions">
          <label className="batch-follow-toggle">
            <input
              type="checkbox"
              checked={state.follow}
              onChange={(event) => void core.setFollow(event.target.checked)}
              disabled={core.busy > 0 && !state.follow}
            />
            <span>跟随 API 请求</span>
          </label>
          <button
            className="quiet-button accent"
            type="button"
            onClick={() => setRecentOpen(true)}
          >
            最近记录
          </button>
        </div>
      </header>

      <section className={'batch-mode-banner ' + modeCode.toLowerCase()} aria-label="运行模式">
        <span className="batch-mode-code">{modeCode}</span>
        <div>
          <strong>{modeTitle}</strong>
          <p>{modeBody}</p>
          {status?.mode === 'fake' ? (
            <p className="batch-mode-detail">
              这里不会产生真实语音；需要真实音频时请切换到 Irodori 模式。
            </p>
          ) : null}
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
      </section>

      <div className="batch-messages" aria-live="polite">
        {core.loadError ? (
          <div className="batch-message error" role="alert">
            <strong>初始读取失败</strong>
            <p>{core.loadError}</p>
            <span>页面仍可编辑；首次保存时会尝试新建批次。</span>
          </div>
        ) : null}
        {core.revisionConflict ? (
          <div className="batch-message conflict" role="alert">
            <strong>保存遇到版本冲突</strong>
            <p>{core.revisionConflict}</p>
            <div className="batch-message-actions">
              <button
                className="quiet-button danger"
                type="button"
                onClick={() => void core.reloadCurrent()}
                disabled={core.busy > 0}
              >
                重新读取服务器
              </button>
              <button
                className="quiet-button"
                type="button"
                onClick={core.keepLocalAfterConflict}
              >
                保留本地草稿
              </button>
            </div>
          </div>
        ) : core.savePaused ? (
          <div className="batch-message warning" role="status">
            <strong>自动保存暂停</strong>
            <p>本地草稿仍保留。请重新读取服务器后再继续保存或切换批次。</p>
            <div className="batch-message-actions">
              <button
                className="quiet-button danger"
                type="button"
                onClick={() => void core.reloadCurrent()}
                disabled={core.busy > 0}
              >
                重新读取服务器
              </button>
            </div>
          </div>
        ) : null}
        {core.syncError ? (
          <div className="batch-message warning" role="status">
            <strong>同步暂时中断</strong>
            <p>{core.syncError} 本地编辑不会被轮询覆盖。</p>
          </div>
        ) : null}
        {state.batch && state.batch.warnings.length > 0 ? (
          <div className="batch-message warning" role="status">
            <strong>处理提示</strong>
            <ul>
              {state.batch.warnings.map((warning, index) => (
                <li key={String(index) + ':' + warning}>{warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {core.notice ? (
          <div className={'batch-message ' + core.notice.kind} role="status">
            <p>{core.notice.text}</p>
            <button className="quiet-button" type="button" onClick={core.clearNotice}>
              关闭
            </button>
          </div>
        ) : null}
        {inferenceBlocked && state.batch?.segments.length ? (
          <div className="batch-message warning" role="status">
            <strong>生成暂不可用</strong>
            <p>{inferenceBlocked}</p>
          </div>
        ) : null}
        {lorasError || presetsError || assetsError ? (
          <div className="batch-message warning" role="status">
            <strong>音色或素材读取不完整</strong>
            {lorasError ? <p>模型列表：{lorasError}</p> : null}
            {presetsError ? <p>常用音色：{presetsError}</p> : null}
            {assetsError ? <p>素材列表：{assetsError}</p> : null}
          </div>
        ) : null}
      </div>

      <main className="batch-main">
        <SettingsPanel
          config={state.config}
          outputDir={state.outputDir}
          assets={assets}
          loras={loras}
          presets={presets}
          presetsLoading={presetsLoading}
          presetsError={presetsError}
          assetsLoading={assetsLoading}
          assetsError={assetsError}
          busy={core.busy > 0}
          hasBatch={state.batch !== null}
          onConfigChange={core.updateConfig}
          onOutputDirChange={core.updateOutputDir}
          onOpenOutput={() => void core.openOutput()}
          onRefreshPresets={() => setPresetsVersion((value) => value + 1)}
          onCreatePreset={handleCreatePreset}
          onUpdatePreset={handleUpdatePreset}
          onDeletePreset={handleDeletePreset}
          onPresetOrderSaved={setPresets}
          onRefreshAssets={() => setAssetsVersion((value) => value + 1)}
          onAssetUploaded={handleAssetUploaded}
          onRenameAsset={handleRenameAsset}
        />

        <PreviewBar player={preview} />

        <TextWorkspace
          rulesScopeKey={String(state.editorSession)}
          savedPersistentRules={savedRules?.persistent_rules??null}
          onSavePersistentRules={handleSaveRules}
          leftText={state.leftText}
          rightText={state.rightText}
          leftDirty={state.leftDirty}
          rightDirty={state.rightDirty}
          processing={state.processing}
          generationCount={generationCount}
          activeSegments={activeSegments}
          conflictCount={conflictCount}
          follow={state.follow}
          origin={externalOrigin}
          busy={core.busy > 0}
          savePaused={core.savePaused}
          canGenerate={canGenerate}
          rightRef={rightRef}
          onSentenceFocus={setSentenceIndex}
          voiceControls={<SentenceVoicePicker
            index={sentenceIndex}
            text={sentenceIndex == null ? '' : state.rightText.split('\n').filter((line) => line.trim())[sentenceIndex] ?? ''}
            config={state.config}
            overrides={sentenceIndex == null || state.rightDirty ? {} :
              state.overrides[state.batch?.segments[sentenceIndex]?.id ?? ''] ?? {}}
            presets={presets}
            disabled={core.busy > 0 || core.savePaused || !state.batch}
            onChange={(id) => {
              if (sentenceIndex == null) return
              const preset = presets.find((item) => item.id === id)
              if (id && !preset) return
              void core.applySentenceVoice(sentenceIndex, preset?.config ?? null)
            }}
          />}
          onLeftChange={core.updateLeft}
          onRightChange={core.updateRight}
          onProcessingChange={core.updateProcessing}
          onPasteNewBatch={() => void handlePasteNewBatch()}
          onClearNewBatch={() => void core.createNewBatch('')}
          onGenerate={() => void core.generate(false)}
          onGenerateAll={() => void core.generate(true)}
        />

        <ConflictPanel
          conflicts={state.batch?.conflicts ?? []}
          segments={state.batch?.segments ?? []}
          busy={core.busy > 0}
          onResolve={(conflictId, choice, segmentId) =>
            void core.resolveConflict(conflictId, choice, segmentId)
          }
        />

        <ResultPanel
          onOpenOutput={(id) => void handleOpenAudio(id)}
          batch={state.batch}
          overrides={state.overrides}
          overridesDirty={state.overridesDirty}
          assets={assets}
          loras={loras}
          busy={core.busy > 0}
          savePaused={core.savePaused}
          onReroll={(segmentId) => void core.rerollSegment(segmentId)}
          onSelect={(segmentId, jobId) =>
            void core.selectVersion(segmentId, jobId)
          }
          onOverrideChange={core.updateOverride}
          onLocate={locateSegment}
          onPlay={preview.playVersion}
          presets={presets}
        />
      </main>

      <footer className="batch-site-footer">
        <span>Irodori 批量配音工作台</span>
        <span>
          {state.batch
            ? '批次 ' +
              state.batch.id.slice(0, 8) +
              ' · ' +
              displayOrigin(state.batch.origin,state.batch.generation_purpose)
            : '尚未建立批次'}
        </span>
      </footer>

      <QueueFooter
        queue={core.queue}
        queueError={core.queueError}
        queueLoading={core.queueLoading}
        busy={core.busy > 0}
        onCancel={(batchId) => void core.cancelTasks(batchId)}
        onRefresh={() => void core.refreshQueue()}
      />

      <RecentDrawer
        open={recentOpen}
        currentBatchId={state.batch?.id ?? null}
        busy={core.busy > 0}
        savePaused={core.savePaused}
        onClose={() => setRecentOpen(false)}
        onRestore={(id) => {
          void core.switchToBatch(id).then((ok) => {
            if (ok) setRecentOpen(false)
          })
        }}
        onReroll={(batchId, segmentId) => core.rerollSegment(segmentId, batchId)}
        onRestoreDeleted={core.restoreDeleted}
      />
    </div>
  )
}
