import { useEffect, useRef, useState } from 'react'
import { ApiError, errorMessage, isAbortError } from '../api'
import { parseConfig } from '../p2-api'
import type { P2Config, P2Overrides } from '../p2-api'
import { cleanOverrides } from '../p2/model'
import {
  cancelBatch,
  createBatch,
  fetchBatch,
  fetchBatches,
  fetchPreferences,
  generateBatch,
  openBatchOutput,
  resolveBatchConflict,
  savePreferences,
  selectBatchJob,
  updateBatch,
  restoreDeletedSegment,
} from '../batch-api'
import type { Batch, Processing } from '../batch-api'
import {
  cloneConfig,
  cloneOverrides,
  cloneProcessing,
  isExternalOrigin,
  segmentsToScript,
} from './model'
import type { CachedDraft } from './model'
import {
  cacheKeyFor,
  cachedDraftFrom,
  hasDirtyDraft,
  initialDraft,
  readDraftCache,
  snapshotVersions,
  versionsDiffer,
  writeDraftCache,
} from './workbench-types'
import type {
  BatchWorkbenchController,
  DraftVersions,
  NoticeKind,
  PreferencesDefaults,
  WorkbenchNotice,
  WorkbenchState,
} from './workbench-types'
import { useQueuePolling } from './useQueuePolling'
import { useBatchPolling } from './useBatchPolling'
import { useDraftCachePersistence } from './useDraftCache'
import { voiceOverrides } from './voice-selection'

export function useBatchWorkbench(): BatchWorkbenchController {
  const [state, setState] = useState<WorkbenchState>(initialDraft)
  const stateRef = useRef(state)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(0)
  const [notice, setNoticeState] = useState<WorkbenchNotice | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [revisionConflict, setRevisionConflict] = useState<string | null>(null)
  const [savePaused, setSavePaused] = useState(false)
  const {
    queue,
    queueError,
    queueLoading,
    refreshQueue,
  } = useQueuePolling()

  const mountedRef = useRef(true)
  const batchIdRef = useRef<string | null>(null)
  const revisionRef = useRef(0)
  const leftVersionRef = useRef(0)
  const rightVersionRef = useRef(0)
  const settingsVersionRef = useRef(0)
  const overrideVersionRef = useRef<Record<string, number>>({})
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const savePausedRef = useRef(false)
  const prefsRevisionRef = useRef<number | null>(null)
  const defaultsRef = useRef<PreferencesDefaults | null>(null)
  const noticeTimerRef = useRef<number | undefined>(undefined)
  const cacheRef = useRef<Record<string, CachedDraft>>({})

  function commit(updater: (current: WorkbenchState) => WorkbenchState): void {
    const next = updater(stateRef.current)
    stateRef.current = next
    if (mountedRef.current) setState(next)
  }

  function showNotice(text: string, kind: NoticeKind = 'info'): void {
    if (!mountedRef.current) return
    if (noticeTimerRef.current !== undefined) {
      window.clearTimeout(noticeTimerRef.current)
    }
    setNoticeState({ kind, text })
    if (kind !== 'error') {
      noticeTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) setNoticeState(null)
      }, 7000)
    }
  }

  function clearNotice(): void {
    if (noticeTimerRef.current !== undefined) {
      window.clearTimeout(noticeTimerRef.current)
    }
    setNoticeState(null)
  }

  function persistCache(): void {
    cacheRef.current = readDraftCache()
    const draft = cachedDraftFrom(stateRef.current)
    const key = cacheKeyFor(stateRef.current)
    if (draft) cacheRef.current[key] = draft
    else delete cacheRef.current[key]
    writeDraftCache(cacheRef.current)
  }

  function clearCachedBatch(id: string): void {
    cacheRef.current = readDraftCache()
    delete cacheRef.current[id]
    writeDraftCache(cacheRef.current)
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queueRef.current.then(task, task)
    queueRef.current = run.then(() => undefined, () => undefined)
    return run
  }

  function versionSnapshot(): DraftVersions {
    return snapshotVersions(leftVersionRef.current, rightVersionRef.current, settingsVersionRef.current, overrideVersionRef.current)
  }

  function versionsChanged(snapshot: DraftVersions): boolean {
    return versionsDiffer(snapshot, leftVersionRef.current, rightVersionRef.current, settingsVersionRef.current, overrideVersionRef.current)
  }

  async function withBusy<T>(task: () => Promise<T>): Promise<T> {
    if (mountedRef.current) setBusy((value) => value + 1)
    try {
      return await task()
    } finally {
      if (mountedRef.current) setBusy((value) => Math.max(0, value - 1))
    }
  }

  function fail(error: unknown, context: string): void {
    if (isAbortError(error)) return
    if (error instanceof ApiError && error.status === 409) {
      savePausedRef.current = true
      setSavePaused(true)
      setRevisionConflict(
        context +
          '遇到版本冲突（409）。本地草稿与未保存设置均已保留，没有自动重试。请重新读取服务器后再继续。',
      )
      showNotice(context + '失败：版本冲突（409），本地草稿已保留。', 'error')
      return
    }
    showNotice(context + '失败：' + errorMessage(error), 'error')
  }

  function applyServerBatch(batch: Batch): void {
    if (batchIdRef.current !== null && batchIdRef.current !== batch.id) return
    batchIdRef.current = batch.id
    revisionRef.current = batch.revision
    const current = stateRef.current
    const nextOverrides: Record<string, P2Overrides> = {}
    const nextDirty: Record<string, boolean> = {}
    for (const segment of batch.segments) {
      const local = current.overrides[segment.id]
      const dirty = current.overridesDirty[segment.id] === true
      nextOverrides[segment.id] = dirty && local ? local : cloneOverrides(segment.overrides)
      if (dirty && local) nextDirty[segment.id] = true
    }
    commit((value) => ({
      ...value,
      batch,
      leftText: value.leftDirty ? value.leftText : batch.source,
      rightText: value.rightDirty ? value.rightText : segmentsToScript(batch.segments),
      config: value.settingsDirty ? value.config : cloneConfig(batch.config),
      processing: value.settingsDirty
        ? value.processing
        : cloneProcessing(batch.processing),
      outputDir: value.settingsDirty ? value.outputDir : batch.output_dir,
      overrides: nextOverrides,
      overridesDirty: nextDirty,
    }))
  }

  function loadBatchState(batch: Batch, cached?: CachedDraft | null): void {
    batchIdRef.current = batch.id
    revisionRef.current = batch.revision
    const cachedConfig = cached ? parseConfig(cached.config) : null
    const overrides: Record<string, P2Overrides> = {}
    const overridesDirty: Record<string, boolean> = {}
    for (const segment of batch.segments) {
      const dirty = cached?.overridesDirty[segment.id] === true
      const local = cached?.overrides[segment.id]
      overrides[segment.id] = dirty && local ? cloneOverrides(local) : cloneOverrides(segment.overrides)
      if (dirty && local) overridesDirty[segment.id] = true
    }
    commit((value) => ({
      ...value,
      editorSession: value.editorSession + 1,
      batch,
      leftText: cached?.leftDirty ? cached.leftText : batch.source,
      rightText: cached?.rightDirty ? cached.rightText : segmentsToScript(batch.segments),
      config:
        cached?.settingsDirty && cachedConfig
          ? cachedConfig
          : cloneConfig(batch.config),
      processing:
        cached?.settingsDirty && cached
          ? cloneProcessing(cached.processing)
          : cloneProcessing(batch.processing),
      outputDir:
        cached?.settingsDirty && cached ? cached.outputDir : batch.output_dir,
      overrides,
      overridesDirty,
      leftDirty: cached?.leftDirty === true,
      rightDirty: cached?.rightDirty === true,
      settingsDirty: cached?.settingsDirty === true,
    }))
  }

  async function saveDefaults(
    config: P2Config,
    processing: Processing,
    outputDir: string,
  ): Promise<boolean> {
    const revision = prefsRevisionRef.current
    if (revision === null) return false
    const saved = await savePreferences({
      revision,
      config: cloneConfig(config),
      processing: cloneProcessing(processing),
      output_dir: outputDir,
      last_batch_id: batchIdRef.current,
    })
    prefsRevisionRef.current = saved.revision
    defaultsRef.current = {
      config: cloneConfig(saved.config),
      processing: cloneProcessing(saved.processing),
      outputDir: saved.output_dir,
    }
    return true
  }

  async function persistLastBatch(id: string): Promise<void> {
    const revision = prefsRevisionRef.current
    const defaults = defaultsRef.current
    if (revision === null || !defaults) return
    try {
      const saved = await savePreferences({
        revision,
        config: cloneConfig(defaults.config),
        processing: cloneProcessing(defaults.processing),
        output_dir: defaults.outputDir,
        last_batch_id: id,
      })
      prefsRevisionRef.current = saved.revision
    } catch (error) {
      if (!isAbortError(error)) {
        showNotice('上次打开的批次位置未能记住：' + errorMessage(error), 'warning')
      }
    }
  }

  async function rawSaveScript(): Promise<void> {
    if (!stateRef.current.rightDirty || savePausedRef.current) return
    let id = batchIdRef.current
    const current = stateRef.current
    if (!id) {
      const created = await createBatch({
        source: '',
        config: cloneConfig(current.config),
        processing: cloneProcessing(current.processing),
        output_dir: current.outputDir,
      })
      if (batchIdRef.current !== null) return
      applyServerBatch(created)
      id = created.id
      clearCachedBatch('__new__')
      await persistLastBatch(created.id)
    }
    const captured = stateRef.current.rightText
    const version = rightVersionRef.current
    const server = await updateBatch(id, {
      revision: revisionRef.current,
      script: captured,
    })
    if (batchIdRef.current !== id) return
    if (rightVersionRef.current === version) {
      commit((value) => ({ ...value, rightDirty: false }))
    }
    applyServerBatch(server)
  }

  async function rawSaveSource(): Promise<void> {
    if (!stateRef.current.leftDirty || savePausedRef.current) return
    let id = batchIdRef.current
    const current = stateRef.current
    if (!id) {
      const capturedSource = current.leftText
      const version = leftVersionRef.current
      const created = await createBatch({
        source: capturedSource,
        config: cloneConfig(current.config),
        processing: cloneProcessing(current.processing),
        output_dir: current.outputDir,
      })
      if (batchIdRef.current !== null) return
      if (leftVersionRef.current === version) {
        commit((value) => ({ ...value, leftDirty: false }))
      }
      applyServerBatch(created)
      id = created.id
      clearCachedBatch('__new__')
      await persistLastBatch(created.id)
      if (stateRef.current.rightDirty) await rawSaveScript()
      return
    } else if (stateRef.current.rightDirty) {
      await rawSaveScript()
      id = batchIdRef.current
      if (!id) return
    }

    const captured = stateRef.current.leftText
    const version = leftVersionRef.current
    const server = await updateBatch(id, {
      revision: revisionRef.current,
      source: captured,
    })
    if (batchIdRef.current !== id) return
    if (leftVersionRef.current === version) {
      commit((value) => ({ ...value, leftDirty: false }))
    }
    applyServerBatch(server)
  }

  async function rawSaveSettings(): Promise<void> {
    if (!stateRef.current.settingsDirty || savePausedRef.current) return
    const current = stateRef.current
    const config = cloneConfig(current.config)
    const processing = cloneProcessing(current.processing)
    const outputDir = current.outputDir
    const version = settingsVersionRef.current
    const id = batchIdRef.current
    if (id) {
      const server = await updateBatch(id, {
        revision: revisionRef.current,
        config,
        processing,
        output_dir: outputDir,
      })
      if (batchIdRef.current !== id) return
      if (settingsVersionRef.current === version) {
        commit((value) => ({ ...value, settingsDirty: false }))
      }
      applyServerBatch(server)
    }
    try {
      const savedDefaults = await saveDefaults(config, processing, outputDir)
      if (!id && savedDefaults && settingsVersionRef.current === version) {
        commit((value) => ({ ...value, settingsDirty: false }))
      }
    } catch (error) {
      if (!id) {
        if (!isAbortError(error)) {
          showNotice('常用默认设置暂未保存；当前设置会在建立批次时一并保存。', 'warning')
        }
        return
      }
      if (!isAbortError(error)) {
        showNotice(
          '整批设置已保存到当前批次，但常用默认设置保存失败：' + errorMessage(error),
          'warning',
        )
      }
    }
  }

  async function rawSaveOverrides(): Promise<void> {
    if (savePausedRef.current) return
    const dirtyIds = Object.keys(stateRef.current.overridesDirty).filter(
      (id) => stateRef.current.overridesDirty[id],
    )
    const id = batchIdRef.current
    if (dirtyIds.length === 0 || !id) return
    const payload: Record<string, P2Overrides> = {}
    const versions: Record<string, number> = {}
    for (const segmentId of dirtyIds) {
      payload[segmentId] = cleanOverrides(
        stateRef.current.overrides[segmentId] ?? {},
      )
      versions[segmentId] = overrideVersionRef.current[segmentId] ?? 0
    }
    const server = await updateBatch(id, {
      revision: revisionRef.current,
      overrides: payload,
    })
    if (batchIdRef.current !== id) return
    commit((value) => {
      const nextDirty = { ...value.overridesDirty }
      for (const segmentId of dirtyIds) {
        if ((overrideVersionRef.current[segmentId] ?? 0) === versions[segmentId]) {
          delete nextDirty[segmentId]
        }
      }
      return { ...value, overridesDirty: nextDirty }
    })
    applyServerBatch(server)
  }

  async function rawFlush(): Promise<void> {
    if (savePausedRef.current) {
      throw new ApiError('保存已因版本冲突暂停，请先重新读取服务器。', 409)
    }
    if (stateRef.current.settingsDirty) await rawSaveSettings()
    if (Object.values(stateRef.current.overridesDirty).some(Boolean)) {
      await rawSaveOverrides()
    }
    if (stateRef.current.rightDirty) await rawSaveScript()
    if (stateRef.current.leftDirty) await rawSaveSource()
    const pending = stateRef.current
    if (pending.leftDirty || pending.rightDirty || Object.values(pending.overridesDirty).some(Boolean)) throw new ApiError('草稿仍在保存，请稍后重试。')
  }

  async function runWrite<T>(task: () => Promise<T>): Promise<T> {
    return enqueue(() => withBusy(task))
  }

  useEffect(() => {
    mountedRef.current = true
    cacheRef.current = readDraftCache()
    const controller = new AbortController()
    let active = true

    async function boot(): Promise<void> {
      try {
        const preferences = await fetchPreferences(controller.signal)
        if (!active) return
        prefsRevisionRef.current = preferences.revision
        defaultsRef.current = {
          config: cloneConfig(preferences.config),
          processing: cloneProcessing(preferences.processing),
          outputDir: preferences.output_dir,
        }
        let batch: Batch | null = null
        if (preferences.last_batch_id) {
          try {
            batch = await fetchBatch(preferences.last_batch_id, controller.signal)
          } catch (error) {
            if (!isAbortError(error)) {
              showNotice(
                '上次打开的批次无法读取，已使用默认设置：' + errorMessage(error),
                'warning',
              )
            }
          }
        }
        if (!active) return
        if (batch) {
          loadBatchState(batch, cacheRef.current[batch.id] ?? null)
        } else {
          const newDraft = cacheRef.current.__new__ ?? null
          commit((value) => ({
            ...value,
            config: newDraft?.settingsDirty
              ? cloneConfig(newDraft.config)
              : cloneConfig(preferences.config),
            processing:
              newDraft?.settingsDirty && newDraft
                ? cloneProcessing(newDraft.processing)
                : cloneProcessing(preferences.processing),
            outputDir:
              newDraft?.settingsDirty && newDraft
                ? newDraft.outputDir
                : preferences.output_dir,
            leftText: newDraft?.leftDirty ? newDraft.leftText : '',
            rightText: newDraft?.rightDirty ? newDraft.rightText : '',
            leftDirty: newDraft?.leftDirty === true,
            rightDirty: newDraft?.rightDirty === true,
            settingsDirty: newDraft?.settingsDirty === true,
          }))
        }
        setLoadError(null)
      } catch (error) {
        if (!active || isAbortError(error)) return
        setLoadError(errorMessage(error))
        prefsRevisionRef.current = null
      } finally {
        if (active) setLoading(false)
      }
    }

    void boot()
    return () => {
      active = false
      mountedRef.current = false
      controller.abort()
    }
  }, [])

  useEffect(() => {
    if (!state.leftDirty || loading || savePaused) return
    const timer = window.setTimeout(() => {
      void runWrite(rawSaveSource).catch((error) => fail(error, '自动保存原文'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [state.leftText, state.leftDirty, loading, savePaused, state.batch?.id])

  useEffect(() => {
    if (!state.rightDirty || loading || savePaused) return
    const timer = window.setTimeout(() => {
      void runWrite(rawSaveScript).catch((error) => fail(error, '自动保存配音正文'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [state.rightText, state.rightDirty, loading, savePaused, state.batch?.id])

  useEffect(() => {
    if (!state.settingsDirty || loading || savePaused) return
    const timer = window.setTimeout(() => {
      void runWrite(rawSaveSettings).catch((error) => fail(error, '保存整批设置'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    state.config,
    state.processing,
    state.outputDir,
    state.settingsDirty,
    loading,
    savePaused,
    state.batch?.id,
  ])

  useEffect(() => {
    if (!Object.values(state.overridesDirty).some(Boolean) || loading || savePaused) {
      return
    }
    const timer = window.setTimeout(() => {
      void runWrite(rawSaveOverrides).catch((error) => fail(error, '保存单句设置'))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [state.overrides, state.overridesDirty, loading, savePaused, state.batch?.id])

  useBatchPolling(batchIdRef, revisionRef, applyServerBatch, setSyncError)

  useEffect(() => {
    if (!state.follow || loading) return
    let active = true
    let timer: number | undefined

    async function poll(): Promise<void> {
      try {
        const items = await fetchBatches()
        if (!active || !stateRef.current.follow) return
        const latest = items.find((item) => isExternalOrigin(item.origin))
        if (latest && latest.id !== batchIdRef.current) {
          await enqueue(() =>
            withBusy(async () => {
              if (!stateRef.current.follow || savePausedRef.current) return
              await rawFlush()
              const server = await fetchBatch(latest.id)
              if (!stateRef.current.follow) return
              loadBatchState(server)
              clearCachedBatch(latest.id)
              await persistLastBatch(latest.id)
            }),
          )
          showNotice('已跟随最新外部请求：' + latest.preview, 'info')
        }
      } catch (error) {
        if (active && stateRef.current.follow && !isAbortError(error)) {
          showNotice('读取外部请求失败：' + errorMessage(error), 'warning')
        }
      }
      if (active && stateRef.current.follow) {
        timer = window.setTimeout(() => void poll(), 3500)
      }
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [state.follow, loading])

  useDraftCachePersistence(state, loading, persistCache)

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent): void {
      if (!hasDirtyDraft(stateRef.current)) return
      persistCache()
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [])

  function updateLeft(text: string): void {
    leftVersionRef.current += 1
    commit((value) => ({ ...value, leftText: text, leftDirty: true, follow: false }))
  }

  function updateRight(text: string): void {
    rightVersionRef.current += 1
    commit((value) => ({ ...value, rightText: text, rightDirty: true, follow: false }))
  }

  function updateConfig(config: P2Config): void {
    settingsVersionRef.current += 1
    commit((value) => ({
      ...value,
      config,
      settingsDirty: true,
      follow: false,
    }))
  }

  function updateProcessing(processing: Processing): void {
    settingsVersionRef.current += 1
    commit((value) => ({
      ...value,
      processing,
      settingsDirty: true,
      follow: false,
    }))
  }

  function updateOutputDir(outputDir: string): void {
    settingsVersionRef.current += 1
    commit((value) => ({
      ...value,
      outputDir,
      settingsDirty: true,
      follow: false,
    }))
  }

  function updateOverride(segmentId: string, overrides: P2Overrides): void {
    overrideVersionRef.current[segmentId] =
      (overrideVersionRef.current[segmentId] ?? 0) + 1
    commit((value) => ({
      ...value,
      overrides: { ...value.overrides, [segmentId]: overrides },
      overridesDirty: { ...value.overridesDirty, [segmentId]: true },
      follow: false,
    }))
  }

  async function flushDrafts(): Promise<void> {
    try {
      await runWrite(rawFlush)
    } catch (error) {
      fail(error, '保存草稿')
      throw error
    }
  }

  async function applySentenceVoice(index: number, config: P2Config | null): Promise<void> {
    const batchId = batchIdRef.current
    const version = rightVersionRef.current
    const text = stateRef.current.rightText.split('\n').filter((line) => line.trim())[index]?.trim()
    try {
      await runWrite(async () => {
        await rawFlush()
        if (batchIdRef.current !== batchId || rightVersionRef.current !== version) {
          throw new ApiError('正文已变化，请重新选择要换音色的句子。')
        }
        const segment = stateRef.current.batch?.segments[index]
        if (!text || !segment || segment.text.trim() !== text) {
          throw new ApiError('句子位置已变化，请重新定位后选择音色。')
        }
        updateOverride(segment.id, config ? voiceOverrides(config) : {})
        await rawSaveOverrides()
      })
      showNotice('已更新第 ' + String(index + 1) + ' 句音色；其他句子不变。', 'success')
    } catch (error) {
      fail(error, '设置本句音色')
    }
  }

  async function generate(all: boolean): Promise<void> {
    if (savePausedRef.current) {
      showNotice('保存因版本冲突暂停，请先重新读取服务器。', 'error')
      return
    }
    try {
      const result = await runWrite(async () => {
        await rawFlush()
        const id = batchIdRef.current
        if (!id) throw new ApiError('当前还没有可生成的台词。')
        return generateBatch(id, {
          revision: revisionRef.current,
          all,
        })
      })
      try {
        const id = batchIdRef.current
        if (!id) return
        const server = await fetchBatch(id)
        applyServerBatch(server)
      } catch {
        // The job response is enough to keep the queue visible; polling will catch up.
      }
      const conflictNote =
        stateRef.current.batch && stateRef.current.batch.conflicts.length > 0
          ? ' 有未解决冲突，本次采用右侧校对正文。'
          : ''
      if (result.items.length === 0) {
        showNotice('没有需要生成或重新生成的句子。', 'info')
      } else {
        showNotice(
          (all ? '已提交全部重新生成：' : '已提交未完成／已修改的句子：') +
            String(result.items.length) +
            ' 句。' +
            conflictNote,
          'success',
        )
      }
    } catch (error) {
      fail(error, all ? '全部重新生成' : '生成')
    }
  }

  async function rerollSegment(segmentId: string, batchId?: string): Promise<void> {
    if (savePausedRef.current) {
      showNotice('保存因版本冲突暂停，请先重新读取服务器。', 'error')
      return
    }
    try {
      await runWrite(async () => {
        await rawFlush()
        let targetId = batchId ?? batchIdRef.current
        let revision = revisionRef.current
        if (batchId && batchId !== batchIdRef.current) {
          const latest = await fetchBatch(batchId)
          targetId = latest.id
          revision = latest.revision
        }
        if (!targetId) throw new ApiError('找不到要重抽的批次。')
        return generateBatch(targetId, {
          revision,
          segment_ids: [segmentId],
          reroll: true,
        })
      })
      showNotice('已提交单句重抽，优先于普通批次排队；编辑区保持当前内容。', 'success')
    } catch (error) {
      fail(error, '单句重抽')
    }
  }

  async function selectVersion(segmentId: string, jobId: string): Promise<void> {
    try {
      await runWrite(async () => {
        await rawFlush()
        const id = batchIdRef.current
        if (!id) throw new ApiError('当前批次尚未保存。')
        const server = await selectBatchJob(
          id,
          segmentId,
          revisionRef.current,
          jobId,
        )
        applyServerBatch(server)
      })
      showNotice('已切换当前版本，并更新该句输出文件。', 'success')
    } catch (error) {
      fail(error, '选择版本')
    }
  }

  async function resolveConflict(
    conflictId: string,
    choice: 'keep' | 'replace',
    segmentId?: string,
  ): Promise<void> {
    try {
      await runWrite(async () => {
        await rawFlush()
        const id = batchIdRef.current
        if (!id) throw new ApiError('当前批次尚未保存。')
        const input: {
          revision: number
          conflict_id: string
          choice: 'keep' | 'replace'
          segment_id?: string
        } = { revision: revisionRef.current, conflict_id: conflictId, choice }
        if (segmentId) input.segment_id = segmentId
        const server = await resolveBatchConflict(id, input)
        applyServerBatch(server)
      })
      showNotice(choice === 'keep' ? '已保留当前内容。' : '已采用重新处理结果。', 'success')
    } catch (error) {
      fail(error, '处理冲突')
    }
  }

  async function createNewBatch(source: string): Promise<boolean> {
    if (savePausedRef.current) {
      showNotice('当前草稿保存因版本冲突暂停，请先重新读取服务器再新建批次。', 'error')
      return false
    }
    try {
      const switched = await runWrite(async () => {
        await rawFlush()
        const versions = versionSnapshot()
        const current = stateRef.current
        const created = await createBatch({
          source,
          config: cloneConfig(current.config),
          processing: cloneProcessing(current.processing),
          output_dir: current.outputDir,
        })
        if (versionsChanged(versions)) {
          showNotice(
            '新建过程中检测到新的编辑，已保留当前草稿；新批次已建立，可从最近记录打开。',
            'warning',
          )
          return false
        }
        loadBatchState(created)
        commit((value) => ({ ...value, follow: false }))
        setRevisionConflict(null)
        setSavePaused(false)
        savePausedRef.current = false
        clearCachedBatch(created.id)
        await persistLastBatch(created.id)
        return true
      })
      if (!switched) return false
      showNotice(
        source.trim()
          ? '已从剪贴板新建一批，上一批继续在队列中。'
          : '已新建空批次，可以开始输入。',
        'success',
      )
      return true
    } catch (error) {
      fail(error, '新建批次')
      return false
    }
  }

  async function switchToBatch(id: string): Promise<boolean> {
    if (id === batchIdRef.current) return true
    if (savePausedRef.current) {
      showNotice('当前草稿保存因版本冲突暂停，请先重新读取服务器再切换。', 'error')
      return false
    }
    try {
      const switched = await runWrite(async () => {
        await rawFlush()
        const versions = versionSnapshot()
        const server = await fetchBatch(id)
        if (versionsChanged(versions)) {
          showNotice(
            '恢复过程中检测到新的编辑，已保留当前内容，未切换批次。请确认后重试。',
            'warning',
          )
          return false
        }
        const cached = readDraftCache()[id] ?? null
        loadBatchState(server, cached)
        if (cached && hasDirtyDraft(stateRef.current)) {
          showNotice('已恢复该批次之前保留的本地未保存草稿。', 'warning')
        } else {
          clearCachedBatch(id)
        }
        setRevisionConflict(null)
        setSavePaused(false)
        savePausedRef.current = false
        commit((value) => ({ ...value, follow: false }))
        await persistLastBatch(id)
        return true
      })
      if (!switched) return false
      showNotice('已恢复到编辑区，历史批次保持原样。', 'success')
      return true
    } catch (error) {
      fail(error, '恢复批次')
      return false
    }
  }

  async function reloadCurrent(): Promise<void> {
    const id = batchIdRef.current
    if (!id) return
    try {
      const reloaded = await runWrite(async () => {
        const versions = versionSnapshot()
        const server = await fetchBatch(id)
        if (versionsChanged(versions)) {
          showNotice(
            '重新读取期间检测到新的编辑，已保留本地内容，没有覆盖当前草稿。',
            'warning',
          )
          return false
        }
        loadBatchState(server)
        clearCachedBatch(id)
        setRevisionConflict(null)
        setSavePaused(false)
        savePausedRef.current = false
        return true
      })
      if (!reloaded) return
      showNotice('已重新读取服务器内容，本地未保存草稿已丢弃。', 'success')
    } catch (error) {
      fail(error, '重新读取批次')
    }
  }

  function keepLocalAfterConflict(): void {
    setRevisionConflict(null)
    showNotice('本地草稿已保留；自动保存仍暂停，重新读取服务器后才能继续保存。', 'warning')
  }

  async function setFollow(follow: boolean): Promise<void> {
    if (!follow) {
      commit((value) => ({ ...value, follow: false }))
      showNotice('已关闭跟随，当前编辑内容保留。', 'info')
      return
    }
    try {
      const enabled = await runWrite(async () => {
        await rawFlush()
        const versions = versionSnapshot()
        const items = await fetchBatches()
        const latest = items.find((item) => isExternalOrigin(item.origin))
        if (versionsChanged(versions)) {
          showNotice(
            '开启跟随期间检测到新的编辑，已保留当前草稿并保持跟随关闭。',
            'warning',
          )
          return false
        }
        if (latest) {
          const server = await fetchBatch(latest.id)
          if (versionsChanged(versions)) {
            showNotice(
              '读取外部请求期间检测到新的编辑，已保留当前草稿并保持跟随关闭。',
              'warning',
            )
            return false
          }
          loadBatchState(server)
          clearCachedBatch(latest.id)
          await persistLastBatch(latest.id)
        }
        commit((value) => ({ ...value, follow: true }))
        showNotice(
          latest
            ? '已开启跟随并显示最新外部请求：' + latest.preview
            : '已开启跟随，正在等待外部请求。',
          'info',
        )
        return true
      })
      if (!enabled) return
    } catch (error) {
      commit((value) => ({ ...value, follow: false }))
      fail(error, '开启跟随')
    }
  }

  async function openOutput(): Promise<void> {
    const id = batchIdRef.current
    if (!id) {
      showNotice('当前还没有已保存的批次。', 'warning')
      return
    }
    try {
      const opened = await runWrite(() => openBatchOutput(id))
      showNotice(opened ? '已请求打开输出目录。' : '后端未打开输出目录。', opened ? 'success' : 'warning')
    } catch (error) {
      fail(error, '打开输出目录')
    }
  }

  async function cancelTasks(batchId?: string): Promise<void> {
    const id = batchId ?? batchIdRef.current
    if (!id) return
    try {
      const cancelled = await runWrite(() => cancelBatch(id))
      showNotice('已取消 ' + String(cancelled) + ' 个尚未开始的任务。', 'success')
      await refreshQueue()
    } catch (error) {
      fail(error, '取消任务')
    }
  }

  async function restoreDeleted(batchId: string, segmentId: string): Promise<void> {
    try {
      await runWrite(async () => {
        await rawFlush()
        const latest = await fetchBatch(batchId)
        const restored = await restoreDeletedSegment(batchId, latest.revision, segmentId)
        if (batchIdRef.current === batchId) applyServerBatch(restored)
      })
      showNotice('已恢复台词；仍在保留期内的音频已恢复输出。', 'success')
    } catch (error) { fail(error, '恢复台词') }
  }

  return {
    state,
    loading,
    loadError,
    busy,
    notice,
    syncError,
    revisionConflict,
    savePaused,
    queue,
    queueError,
    queueLoading,
    updateLeft,
    updateRight,
    updateConfig,
    updateProcessing,
    updateOutputDir,
    updateOverride,
    applySentenceVoice,
    flushDrafts,
    generate,
    rerollSegment,
    restoreDeleted,
    selectVersion,
    resolveConflict,
    createNewBatch,
    switchToBatch,
    reloadCurrent,
    keepLocalAfterConflict,
    setFollow,
    openOutput,
    cancelTasks,
    refreshQueue,
    clearNotice,
    setNotice: showNotice,
  }
}
