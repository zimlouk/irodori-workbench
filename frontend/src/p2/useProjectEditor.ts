import { useEffect, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import {
  ApiError,
  errorMessage,
  isAbortError,
} from '../api'
import {
  P2_MAX_SEGMENTS,
  applyProjectPresets,
  cancelProjectTasks,
  createProject,
  fetchProject,
  fetchProjects,
  generateProject,
  previewProjectPresets,
  presetLabel,
  saveProject,
  selectProjectJob,
} from '../p2-api'
import type {
  P2Preset,
  P2Project,
  P2ProjectSummary,
} from '../p2-api'
import {
  draftToPayload,
  emptyConfig,
  mergeJobsIntoDraft,
  mergeServerAttempts,
  newDraftSegment,
  projectToDraft,
  previewDraftSnapshots,
  rebaseDraftAfterSave,
  validateOverrides,
} from './model'
import type { DraftSegment, ProjectDraft } from './model'
import type { P2PreviewState } from './ProjectWorkspace'

export type GuardTarget =
  | { kind: 'project'; id: string }
  | { kind: 'reload'; id: string }
  | { kind: 'create'; name: string; presetId: string | null }

interface UseProjectEditorOptions {
  presets: P2Preset[]
  blockedReason: string | null
  setNotice: Dispatch<SetStateAction<string | null>>
  setActionError: Dispatch<SetStateAction<string | null>>
  setConflict: Dispatch<SetStateAction<string | null>>
  onShowProjects: () => void
}

function shortText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return '（空白）'
  return compact.length > max ? compact.slice(0, max) + '…' : compact
}

export function useProjectEditor(options: UseProjectEditorOptions) {
  const {
    presets,
    blockedReason,
    setNotice,
    setActionError,
    setConflict,
    onShowProjects,
  } = options

  const [projects, setProjects] = useState<P2ProjectSummary[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectsVersion, setProjectsVersion] = useState(0)

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [baseProject, setBaseProject] = useState<P2Project | null>(null)
  const [draft, setDraftState] = useState<ProjectDraft | null>(null)
  const [dirty, setDirtyState] = useState(false)
  const [revision, setRevision] = useState(0)
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [previewState, setPreviewState] = useState<P2PreviewState | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [lastBatchId, setLastBatchId] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [selectingJobId, setSelectingJobId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)


  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDefault, setNewProjectDefault] = useState<string>('')
  const [batchSpeaker, setBatchSpeaker] = useState('')
  const [batchPreset, setBatchPreset] = useState('keep')
  const [guard, setGuard] = useState<GuardTarget | null>(null)
  const [guardBusy, setGuardBusy] = useState(false)

  const selectedProjectIdRef = useRef<string | null>(null)
  const baseProjectRef = useRef<P2Project | null>(null)
  const draftRef = useRef<ProjectDraft | null>(null)
  const dirtyRef = useRef(false)
  const revisionRef = useRef(0)
  const editSeqRef = useRef(0)
  const projectSeqRef = useRef(0)
  const autoSelectedRef = useRef(false)
  const saveLockRef = useRef(false)
  const generateLockRef = useRef(false)
  const previewLockRef = useRef(false)
  const applyLockRef = useRef(false)
  const selectLockRef = useRef(false)
  const cancelLockRef = useRef(false)
  const createLockRef = useRef(false)


  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setProjectsLoading(true)
    setProjectsError(null)
    void fetchProjects(controller.signal)
      .then((items) => {
        if (!active) return
        setProjects(items)
        if (
          !selectedProjectIdRef.current &&
          !autoSelectedRef.current &&
          items.length > 0
        ) {
          autoSelectedRef.current = true
          void loadProject(items[0].id)
        }
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setProjectsError(errorMessage(error))
        }
      })
      .finally(() => {
        if (active) setProjectsLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [projectsVersion])

  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  useEffect(() => {
    const id = selectedProjectId
    if (!id) return
    let active = true
    let timer: number | undefined
    let controller: AbortController | undefined

    const tick = async () => {
      controller = new AbortController()
      try {
        const remote = await fetchProject(id, controller.signal)
        if (!active || selectedProjectIdRef.current !== id) return
        if (remote.revision < revisionRef.current) return

        if (dirtyRef.current && draftRef.current) {
          const merged = mergeServerAttempts(draftRef.current, remote)
          draftRef.current = merged
          setDraftState(merged)
          if (remote.revision !== revisionRef.current) {
            setConflict(
              '服务器修订已变为 r' +
                String(remote.revision) +
                '，本地草稿仍保留，未自动覆盖。请重新加载或手动保存以处理冲突。',
            )
          }
        } else {
          applyServerProject(remote, false)
        }
        setPollError(null)
      } catch (error) {
        if (active && !isAbortError(error)) {
          setPollError(errorMessage(error))
        }
      } finally {
        if (active) {
          timer = window.setTimeout(() => {
            void tick()
          }, 1500)
        }
      }
    }

    void tick()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      controller?.abort()
    }
  }, [selectedProjectId])



  function publishDraft(next: ProjectDraft | null, markDirty: boolean) {
    draftRef.current = next
    setDraftState(next)
    if (markDirty) {
      dirtyRef.current = true
      setDirtyState(true)
      editSeqRef.current += 1
      setPreviewState(null)
      setActionError(null)
      setNotice(null)
    } else {
      dirtyRef.current = false
      setDirtyState(false)
    }
  }

  function applyServerProject(project: P2Project, resetSelection: boolean) {
    const previousRevision = revisionRef.current
    baseProjectRef.current = project
    setBaseProject(project)
    revisionRef.current = project.revision
    setRevision(project.revision)
    const previousDraft = draftRef.current
    publishDraft(projectToDraft(project, previousDraft), false)
    if (resetSelection) {
      setSelectedKeys(new Set())
    }
    if (project.revision !== previousRevision) {
      setPreviewState(null)
    }
    setProjectError(null)
    setPollError(null)
  }

  function adoptCreatedProject(project: P2Project) {
    projectSeqRef.current += 1
    selectedProjectIdRef.current = project.id
    setSelectedProjectId(project.id)
    autoSelectedRef.current = true
    applyServerProject(project, true)
    setProjectLoading(false)
    setConflict(null)
    setSelectedKeys(new Set())
    setLastBatchId(null)
  }

  async function loadProject(id: string) {
    const seq = projectSeqRef.current + 1
    projectSeqRef.current = seq
    selectedProjectIdRef.current = id
    setSelectedProjectId(id)
    setProjectLoading(true)
    setProjectError(null)
    setPollError(null)
    setActionError(null)
    setNotice(null)
    setConflict(null)
    setPreviewState(null)
    setSelectedKeys(new Set())
    setDraftState(null)
    draftRef.current = null
    dirtyRef.current = false
    setDirtyState(false)
    baseProjectRef.current = null
    setBaseProject(null)
    revisionRef.current = 0
    setRevision(0)

    try {
      const project = await fetchProject(id)
      if (seq !== projectSeqRef.current) return
      applyServerProject(project, true)
      setLastBatchId(null)
    } catch (error) {
      if (seq !== projectSeqRef.current) return
      setProjectError(errorMessage(error))
    } finally {
      if (seq === projectSeqRef.current) setProjectLoading(false)
    }
  }

  async function performCreate(name: string, presetId: string | null) {
    if (createLockRef.current) return
    createLockRef.current = true
    setCreating(true)
    setActionError(null)
    setNotice(null)
    setConflict(null)
    try {
      const project = await createProject(name, presetId)
      adoptCreatedProject(project)
      setNewProjectName('')
      setNewProjectDefault('')
      setNotice('已创建项目「' + project.name + '」，修订 r' + project.revision + '。')
      setProjectsVersion((value) => value + 1)
      onShowProjects()
      return true
    } catch (error) {
      setActionError('创建项目失败：' + errorMessage(error))
      return false
    } finally {
      createLockRef.current = false
      setCreating(false)
    }
  }

  async function refreshProjectQuietly(id: string) {
    try {
      const remote = await fetchProject(id)
      if (selectedProjectIdRef.current !== id) return
      if (remote.revision < revisionRef.current) return
      if (dirtyRef.current && draftRef.current) {
        const merged = mergeServerAttempts(draftRef.current, remote)
        draftRef.current = merged
        setDraftState(merged)
      } else {
        applyServerProject(remote, false)
      }
      setPollError(null)
    } catch (error) {
      setPollError(errorMessage(error))
    }
  }

  function resolveDefaultConfig(projectDraft: ProjectDraft) {
    const preset = presets.find(
      (item) => item.id === projectDraft.default_preset_id,
    )
    if (preset) {
      return {
        lora_id: preset.config.lora_id,
        reference_asset_ids: [...preset.config.reference_asset_ids],
        caption: preset.config.caption,
        parameters: { ...preset.config.parameters },
      }
    }
    const base = baseProjectRef.current
    if (base) {
      return {
        lora_id: base.default_snapshot.config.lora_id,
        reference_asset_ids: [...base.default_snapshot.config.reference_asset_ids],
        caption: base.default_snapshot.config.caption,
        parameters: { ...base.default_snapshot.config.parameters },
      }
    }
    return emptyConfig()
  }

  function mutateDraft(mutator: (current: ProjectDraft) => ProjectDraft) {
    const current = draftRef.current
    if (!current) return
    publishDraft(previewDraftSnapshots(mutator(current), baseProjectRef.current, presets), true)
  }

  function changeProjectName(name: string) {
    mutateDraft((current) => ({ ...current, name }))
  }

  function changeDefaultPreset(id: string | null) {
    mutateDraft((current) => ({ ...current, default_preset_id: id }))
  }

  function addSegment() {
    const current = draftRef.current
    if (!current) return
    if (current.segments.length >= P2_MAX_SEGMENTS) {
      setActionError('项目最多 ' + String(P2_MAX_SEGMENTS) + ' 段。')
      return
    }
    const config = resolveDefaultConfig(current)
    mutateDraft((value) => ({
      ...value,
      segments: [...value.segments, newDraftSegment(config)],
    }))
  }

  function changeSegment(index: number, patch: Partial<DraftSegment>) {
    mutateDraft((current) => ({
      ...current,
      segments: current.segments.map((segment, itemIndex) =>
        itemIndex === index ? { ...segment, ...patch } : segment,
      ),
    }))
  }

  function moveSegment(index: number, direction: -1 | 1) {
    mutateDraft((current) => {
      const target = index + direction
      if (target < 0 || target >= current.segments.length) return current
      const segments = [...current.segments]
      const item = segments[index]
      segments[index] = segments[target]
      segments[target] = item
      return { ...current, segments }
    })
  }

  function removeSegment(index: number) {
    const current = draftRef.current
    if (!current) return
    const removed = current.segments[index]
    mutateDraft((value) => ({
      ...value,
      segments: value.segments.filter((_, itemIndex) => itemIndex !== index),
    }))
    if (removed) {
      setSelectedKeys((keys) => {
        const next = new Set(keys)
        next.delete(removed.key)
        return next
      })
    }
  }

  function toggleSelected(key: string) {
    setSelectedKeys((keys) => {
      const next = new Set(keys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function selectAllSegments() {
    if (!draftRef.current) return
    setSelectedKeys(new Set(draftRef.current.segments.map((segment) => segment.key)))
  }

  function applyBatchSpeaker() {
    const current = draftRef.current
    if (!current) return
    if (selectedCount === 0) {
      setActionError('请先勾选要批量设置 speaker 的段落。')
      return
    }
    mutateDraft((value) => ({
      ...value,
      segments: value.segments.map((segment) =>
        selectedKeys.has(segment.key)
          ? { ...segment, speaker: batchSpeaker }
          : segment,
      ),
    }))
    setNotice(
      '已把 ' +
        String(selectedCount) +
        ' 个选中段的 speaker 设为「' +
        (batchSpeaker || '空') +
        '」，保存后生效。',
    )
  }

  function applyBatchPreset() {
    if (batchPreset === 'keep') {
      setActionError('请选择要批量分配的预设。')
      return
    }
    const current = draftRef.current
    if (!current) return
    if (selectedCount === 0) {
      setActionError('请先勾选要批量分配预设的段落。')
      return
    }
    const presetId = batchPreset === 'default' ? null : batchPreset
    mutateDraft((value) => ({
      ...value,
      segments: value.segments.map((segment) =>
        selectedKeys.has(segment.key)
          ? { ...segment, preset_id: presetId }
          : segment,
      ),
    }))
    const preset = presets.find((item) => item.id === presetId)
    setNotice(
      '已把 ' +
        String(selectedCount) +
        ' 个选中段设为' +
        (preset ? ' ' + presetLabel(preset) : '项目默认预设') +
        '；保存时会复制新的预设快照。',
    )
  }

  async function saveCurrent(): Promise<P2Project | null> {
    if (saveLockRef.current) return null
    const id = selectedProjectIdRef.current
    const current = draftRef.current
    if (!id || !current) {
      setActionError('请先打开一个项目。')
      return null
    }
    if (!current.name.trim()) {
      setActionError('项目名称不能为空。')
      return null
    }
    if (current.segments.length > P2_MAX_SEGMENTS) {
      setActionError('项目最多 ' + String(P2_MAX_SEGMENTS) + ' 段。')
      return null
    }
    for (let index = 0; index < current.segments.length; index += 1) {
      const error = validateOverrides(current.segments[index].overrides)
      if (error) {
        setActionError('第 ' + String(index + 1) + ' 段覆盖配置无效：' + error)
        return null
      }
    }

    saveLockRef.current = true
    setSaving(true)
    setActionError(null)
    setNotice(null)
    const editSequence = editSeqRef.current
    const payload = draftToPayload(current, revisionRef.current)

    try {
      const saved = await saveProject(id, payload)
      if (selectedProjectIdRef.current !== id) return saved

      baseProjectRef.current = saved
      setBaseProject(saved)
      revisionRef.current = saved.revision
      setRevision(saved.revision)

      if (editSeqRef.current === editSequence) {
        applyServerProject(saved, true)
        setConflict(null)
        setNotice('已保存项目修订 r' + String(saved.revision) + '。')
      } else if (draftRef.current) {
        const rebased = rebaseDraftAfterSave(draftRef.current, saved, current)
        draftRef.current = rebased
        setDraftState(rebased)
        dirtyRef.current = true
        setDirtyState(true)
        setConflict(null)
        setNotice(
          '已保存修订 r' +
            String(saved.revision) +
            '；保存期间的新编辑仍保留为未保存草稿。',
        )
      }
      setProjectsVersion((value) => value + 1)
      return saved
    } catch (error) {
      const message = errorMessage(error)
      if (error instanceof ApiError && error.status === 409) {
        setConflict(
          '保存项目遇到修订冲突（409）：' +
            message +
            ' 本地草稿已保留，没有自动覆盖服务器。',
        )
        setActionError('保存未完成：服务器修订冲突，草稿仍在本页。')
      } else {
        setActionError('保存项目失败：' + message)
      }
      return null
    } finally {
      saveLockRef.current = false
      setSaving(false)
    }
  }

  async function ensureSaved(): Promise<P2Project | null> {
    if (!selectedProjectIdRef.current || !draftRef.current) {
      setActionError('请先打开一个项目。')
      return null
    }
    if (!dirtyRef.current && baseProjectRef.current) {
      return baseProjectRef.current
    }
    if (saveLockRef.current) {
      setActionError('正在保存，请稍后重试。')
      return null
    }
    return saveCurrent()
  }

  function writeError(prefix: string, error: unknown) {
    const message = errorMessage(error)
    setNotice(null)
    if (error instanceof ApiError && error.status === 409) {
      setActionError(
        prefix +
          '遇到 409 冲突：' +
          message +
          ' 本地草稿已保留，未自动覆盖服务器。',
      )
    } else {
      setActionError(prefix + '失败：' + message)
    }
  }

  async function runGenerate(
    kind: 'all' | 'selected' | 'single',
    singleIndex?: number,
  ) {
    if (generateLockRef.current) return
    const current = draftRef.current
    const id = selectedProjectIdRef.current
    if (!current || !id) {
      setActionError('请先打开一个项目。')
      return
    }

    let indices: number[] = []
    if (kind === 'all') {
      indices = current.segments.map((_, index) => index)
    } else if (kind === 'single') {
      if (singleIndex !== undefined && current.segments[singleIndex]) {
        indices = [singleIndex]
      }
    } else {
      indices = current.segments
        .map((segment, index) =>
          selectedKeys.has(segment.key) ? index : -1,
        )
        .filter((index) => index >= 0)
    }

    if (indices.length === 0) {
      setActionError('请先勾选要生成的段落。')
      return
    }

    for (const index of indices) {
      if (!current.segments[index].text.trim()) {
        setActionError(
          '第 ' + String(index + 1) + ' 段文本为空，生成前请补充文本。',
        )
        return
      }
    }

    if (blockedReason) {
      setActionError(blockedReason)
      return
    }

    generateLockRef.current = true
    setGenerating(true)
    setActionError(null)
    setNotice(null)
    try {
      const saved = await ensureSaved()
      if (!saved) return

      let segmentIds: string[] | undefined
      if (kind !== 'all') {
        segmentIds = indices.map((index) => saved.segments[index]?.id ?? '')
        if (segmentIds.some((segmentId) => !segmentId)) {
          setActionError('段落保存后缺少 id，无法生成。请重新加载项目。')
          return
        }
      }

      const result = await generateProject(id, {
        revision: saved.revision,
        segment_ids: segmentIds,
      })
      if (selectedProjectIdRef.current !== id) return

      setLastBatchId(result.batch_id)
      if (draftRef.current) {
        const merged = mergeJobsIntoDraft(draftRef.current, result.items)
        draftRef.current = merged
        setDraftState(merged)
      }
      setNotice(
        '已提交 ' +
          String(result.items.length) +
          ' 个生成任务（批次 ' +
          result.batch_id.slice(0, 8) +
          '）。任务状态会自动刷新。',
      )
      void refreshProjectQuietly(id)
    } catch (error) {
      writeError('生成', error)
    } finally {
      generateLockRef.current = false
      setGenerating(false)
    }
  }

  async function selectVersion(index: number, jobId: string) {
    if (selectLockRef.current) return
    const id = selectedProjectIdRef.current
    const current = draftRef.current
    if (!id || !current || !current.segments[index]) {
      setActionError('请先打开一个项目。')
      return
    }

    selectLockRef.current = true
    setSelectingJobId(jobId)
    setActionError(null)
    setNotice(null)
    try {
      const saved = await ensureSaved()
      if (!saved) return
      const segment = saved.segments[index]
      if (!segment) {
        setActionError('保存后找不到该段落，请重新加载项目。')
        return
      }
      const job = segment.attempts.find((item) => item.id === jobId)
      if (
        !job ||
        job.status !== 'succeeded' ||
        job.stale ||
        job.input_revision !== segment.input_revision
      ) {
        setActionError('该结果不是当前输入修订的成功版本，不能设为选定版本。')
        return
      }
      const project = await selectProjectJob(
        id,
        segment.id,
        saved.revision,
        jobId,
      )
      if (selectedProjectIdRef.current !== id) return
      applyServerProject(project, false)
      setNotice('已选择任务 #' + jobId.slice(0, 8) + ' 作为当前版本。')
      setProjectsVersion((value) => value + 1)
    } catch (error) {
      writeError('选择版本', error)
    } finally {
      selectLockRef.current = false
      setSelectingJobId(null)
    }
  }

  async function previewLatestPresets(scope: 'selected' | 'all') {
    if (previewLockRef.current) return
    const id = selectedProjectIdRef.current
    const current = draftRef.current
    if (!id || !current) {
      setActionError('请先打开一个项目。')
      return
    }
    const indices = current.segments
      .map((segment, index) =>
        scope === 'all' || selectedKeys.has(segment.key) ? index : -1,
      )
      .filter((index) => index >= 0)
    if (indices.length === 0) {
      setActionError('请先勾选要检查预设的段落。')
      return
    }

    previewLockRef.current = true
    setPreviewLoading(true)
    setPreviewState(null)
    setActionError(null)
    setNotice(null)
    try {
      const saved = await ensureSaved()
      if (!saved) return
      const segmentIds = indices.map((index) => saved.segments[index]?.id ?? '')
      if (segmentIds.some((segmentId) => !segmentId)) {
        setActionError('保存后缺少段落 id，请重新加载项目。')
        return
      }
      const result = await previewProjectPresets(
        id,
        saved.revision,
        segmentIds,
      )
      if (selectedProjectIdRef.current !== id) return
      const labels: Record<string, string> = {}
      saved.segments.forEach((segment, index) => {
        labels[segment.id] =
          '第 ' +
          String(index + 1) +
          ' 段 · ' +
          shortText(segment.text, 28)
      })
      setPreviewState({ preview: result, labels, scope })
      if (result.changes.length === 0) {
        setNotice('所选段落已使用最新预设，没有需要应用的变更。')
      }
    } catch (error) {
      writeError('检查最新预设', error)
    } finally {
      previewLockRef.current = false
      setPreviewLoading(false)
    }
  }

  async function applyLatestPresets() {
    if (applyLockRef.current || !previewState) return
    const id = selectedProjectIdRef.current
    if (!id) return
    if (dirtyRef.current) {
      setActionError('项目有未保存改动，请先保存后重新预览预设。')
      setPreviewState(null)
      return
    }

    const changes = previewState.preview.changes
    if (changes.length === 0) return
    const versions: Record<string, number> = {}
    changes.forEach((change) => {
      const current = versions[change.preset_id] ?? 0
      versions[change.preset_id] = Math.max(current, change.to_version)
    })
    const segmentIds = changes.map((change) => change.segment_id)

    applyLockRef.current = true
    setApplying(true)
    setActionError(null)
    setNotice(null)
    try {
      const project = await applyProjectPresets(
        id,
        previewState.preview.revision,
        versions,
        segmentIds,
      )
      if (selectedProjectIdRef.current !== id) return
      applyServerProject(project, false)
      setPreviewState(null)
      setProjectsVersion((value) => value + 1)
      setNotice(
        '已应用 ' + String(changes.length) + ' 个段落的最新预设快照。',
      )
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setPreviewState(null)
        setActionError(
          '预设版本已变化（409），请重新预览后再应用；本地草稿未改动。',
        )
      } else {
        writeError('应用最新预设', error)
      }
    } finally {
      applyLockRef.current = false
      setApplying(false)
    }
  }

  async function cancelQueue(batchId?: string) {
    if (cancelLockRef.current) return
    const id = selectedProjectIdRef.current
    if (!id) return
    cancelLockRef.current = true
    setCancelling(true)
    setActionError(null)
    setNotice(null)
    try {
      const cancelled = await cancelProjectTasks(id, batchId)
      if (selectedProjectIdRef.current !== id) return
      setNotice(
        '已取消 ' +
          String(cancelled) +
          ' 个未开始任务' +
          (batchId ? '（批次 ' + batchId.slice(0, 8) + '）' : '') +
          '；正在运行的任务会继续完成。',
      )
      if (batchId && batchId === lastBatchId) setLastBatchId(null)
      void refreshProjectQuietly(id)
    } catch (error) {
      writeError('取消任务', error)
    } finally {
      cancelLockRef.current = false
      setCancelling(false)
    }
  }

  function requestOpenProject(id: string) {
    if (id === selectedProjectIdRef.current) {
      if (!draftRef.current) void loadProject(id)
      onShowProjects()
      return
    }
    if (dirtyRef.current) {
      setGuard({ kind: 'project', id })
      return
    }
    void loadProject(id)
  }

  function requestReload() {
    const id = selectedProjectIdRef.current
    if (!id) return
    if (dirtyRef.current) {
      setGuard({ kind: 'reload', id })
      return
    }
    void loadProject(id)
  }

  async function executeGuardTarget(target: GuardTarget) {
    if (target.kind === 'create') {
      await performCreate(target.name, target.presetId)
      return
    }
    await loadProject(target.id)
  }

  async function guardSaveAndContinue() {
    if (!guard || guardBusy) return
    const target = guard
    setGuardBusy(true)
    try {
      const saved = await saveCurrent()
      if (!saved) {
        setGuard(null)
        return
      }
      setGuard(null)
      await executeGuardTarget(target)
    } finally {
      setGuardBusy(false)
    }
  }

  async function guardDiscardAndContinue() {
    if (!guard || guardBusy) return
    const target = guard
    setGuard(null)
    await executeGuardTarget(target)
  }

  function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = newProjectName.trim()
    if (!name) {
      setActionError('请填写项目名称。')
      return
    }
    const presetId = newProjectDefault || null
    if (dirtyRef.current) {
      setGuard({ kind: 'create', name, presetId })
      return
    }
    void performCreate(name, presetId)
  }



  const selectedCount = draft
    ? draft.segments.filter((segment) => selectedKeys.has(segment.key)).length
    : 0
  const defaultLabel = draft?.default_preset_id
    ? presetLabel(
        presets.find((preset) => preset.id === draft.default_preset_id) ?? {
          id: draft.default_preset_id,
          voice_name: '未知',
          name: draft.default_preset_id,
          version: 0,
          config: emptyConfig(),
          created_at: '',
          updated_at: '',
        },
      )
    : '基础模型默认'
  const busy =
    saving ||
    creating ||
    generating ||
    cancelling ||
    selectingJobId !== null ||
    applying ||
    previewLoading ||
    guardBusy

  return {
    projects,
    projectsLoading,
    projectsError,
    selectedProjectId,
    projectError,
    projectLoading,
    pollError,
    draft,
    baseProject,
    revision,
    dirty,
    selectedKeys,
    previewState,
    previewLoading,
    lastBatchId,
    saving,
    creating,
    generating,
    cancelling,
    applying,
    newProjectName,
    newProjectDefault,
    batchSpeaker,
    batchPreset,
    selectedCount,
    defaultLabel,
    busy,
    guard,
    guardBusy,
    setProjectsVersion,
    setNewProjectName,
    setNewProjectDefault,
    setBatchSpeaker,
    setBatchPreset,
    setSelectedKeys,
    setPreviewState,
    handleCreateProject,
    requestOpenProject,
    requestReload,
    saveCurrent: () => void saveCurrent(),
    runGenerate: (kind: 'all' | 'selected' | 'single', singleIndex?: number) =>
      void runGenerate(kind, singleIndex),
    changeProjectName,
    changeDefaultPreset,
    applyBatchSpeaker,
    applyBatchPreset,
    selectAllSegments,
    previewLatestPresets: (scope: 'selected' | 'all') =>
      void previewLatestPresets(scope),
    cancelQueue: (batchId?: string) => void cancelQueue(batchId),
    addSegment,
    applyLatestPresets: () => void applyLatestPresets(),
    toggleSelected,
    changeSegment,
    moveSegment,
    removeSegment,
    selectVersion: (index: number, jobId: string) =>
      void selectVersion(index, jobId),
    loadProject: (id: string) => void loadProject(id),
    refreshProjectQuietly: (id: string) => void refreshProjectQuietly(id),
    guardSaveAndContinue: () => void guardSaveAndContinue(),
    guardDiscardAndContinue: () => void guardDiscardAndContinue(),
    cancelGuard: () => setGuard(null),
  }
}
