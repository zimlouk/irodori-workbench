import type { Dispatch, FormEvent, SetStateAction } from 'react'
import type { Asset, Lora, ServiceStatus } from '../types'
import type {
  P2Preset,
  P2PresetPreview,
  P2Project,
  P2ProjectSummary,
} from '../p2-api'
import { P2_MAX_SEGMENTS, presetLabel } from '../p2-api'
import { ConfigDiffView, ConfigSummary } from './ConfigEditor'
import { SegmentEditor } from './SegmentEditor'
import type { DraftSegment, ProjectDraft } from './model'

export interface P2PreviewState {
  preview: P2PresetPreview
  labels: Record<string, string>
  scope: 'selected' | 'all'
}

export interface ProjectWorkspaceProps {
  projects: P2ProjectSummary[]
  projectsLoading: boolean
  projectsError: string | null
  selectedProjectId: string | null
  projectError: string | null
  projectLoading: boolean
  draft: ProjectDraft | null
  baseProject: P2Project | null
  revision: number
  dirty: boolean
  presets: P2Preset[]
  assets: Asset[]
  loras: Lora[]
  status: ServiceStatus | null
  statusLoading: boolean
  statusError: string | null
  isRealMode: boolean
  busy: boolean
  blockedReason: string | null
  selectedCount: number
  defaultLabel: string
  previewState: P2PreviewState | null
  previewLoading: boolean
  lastBatchId: string | null
  pollError: string | null
  saving: boolean
  creating: boolean
  generating: boolean
  cancelling: boolean
  applying: boolean
  newProjectName: string
  newProjectDefault: string
  batchSpeaker: string
  batchPreset: string
  selectedKeys: Set<string>
  setProjectsVersion: Dispatch<SetStateAction<number>>
  setNewProjectName: Dispatch<SetStateAction<string>>
  setNewProjectDefault: Dispatch<SetStateAction<string>>
  setBatchSpeaker: Dispatch<SetStateAction<string>>
  setBatchPreset: Dispatch<SetStateAction<string>>
  setActionError: Dispatch<SetStateAction<string | null>>
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>
  setPreviewState: Dispatch<SetStateAction<P2PreviewState | null>>
  handleCreateProject: (event: FormEvent<HTMLFormElement>) => void
  requestOpenProject: (id: string) => void
  requestReload: () => void
  saveCurrent: () => void
  runGenerate: (
    kind: 'all' | 'selected' | 'single',
    singleIndex?: number,
  ) => void
  changeProjectName: (name: string) => void
  changeDefaultPreset: (id: string | null) => void
  applyBatchSpeaker: () => void
  applyBatchPreset: () => void
  selectAllSegments: () => void
  previewLatestPresets: (scope: 'selected' | 'all') => void
  cancelQueue: (batchId?: string) => void
  addSegment: () => void
  applyLatestPresets: () => void
  toggleSelected: (key: string) => void
  changeSegment: (index: number, patch: Partial<DraftSegment>) => void
  moveSegment: (index: number, direction: -1 | 1) => void
  removeSegment: (index: number) => void
  selectVersion: (index: number, jobId: string) => void
  loadProject: (id: string) => void
  refreshProjectQuietly: (id: string) => void
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return date.toLocaleString('zh-CN')
}

export function ProjectWorkspace(props: ProjectWorkspaceProps) {
  const {
    projects,
    projectsLoading,
    projectsError,
    selectedProjectId,
    projectError,
    projectLoading,
    draft,
    baseProject,
    revision,
    dirty,
    presets,
    assets,
    loras,
    status,
    statusLoading,
    statusError,
    isRealMode,
    busy,
    blockedReason,
    selectedCount,
    defaultLabel,
    previewState,
    previewLoading,
    lastBatchId,
    pollError,
    saving,
    creating,
    generating,
    cancelling,
    applying,
    newProjectName,
    newProjectDefault,
    batchSpeaker,
    batchPreset,
    selectedKeys,
    setProjectsVersion,
    setNewProjectName,
    setNewProjectDefault,
    setBatchSpeaker,
    setBatchPreset,
    setActionError,
    setSelectedKeys,
    setPreviewState,
    handleCreateProject,
    requestOpenProject,
    requestReload,
    saveCurrent,
    runGenerate,
    changeProjectName,
    changeDefaultPreset,
    applyBatchSpeaker,
    applyBatchPreset,
    selectAllSegments,
    previewLatestPresets,
    cancelQueue,
    addSegment,
    applyLatestPresets,
    toggleSelected,
    changeSegment,
    moveSegment,
    removeSegment,
    selectVersion,
    loadProject,
    refreshProjectQuietly,
  } = props

  return (
        <div className="p2-project-layout">
          <aside className="p2-subpanel p2-project-sidebar">
            <div className="p2-subheading">
              <div>
                <p className="kicker">PROJECTS</p>
                <h2>项目列表</h2>
              </div>
              <button
                className="quiet-button"
                type="button"
                onClick={() => setProjectsVersion((value) => value + 1)}
                disabled={projectsLoading}
              >
                刷新
              </button>
            </div>

            <form className="p2-new-project" onSubmit={handleCreateProject}>
              <div className="p2-field">
                <label htmlFor="p2-new-project-name">新项目名称</label>
                <input
                  id="p2-new-project-name"
                  value={newProjectName}
                  onChange={(event) => {
                    setNewProjectName(event.target.value)
                    setActionError(null)
                  }}
                  placeholder="例如：第一话"
                  disabled={creating || busy}
                />
              </div>
              <div className="p2-field">
                <label htmlFor="p2-new-project-preset">默认音色预设</label>
                <select
                  id="p2-new-project-preset"
                  value={newProjectDefault}
                  onChange={(event) => setNewProjectDefault(event.target.value)}
                  disabled={creating || busy}
                >
                  <option value="">基础模型默认（40 步 / 随机 seed）</option>
                  {presets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {presetLabel(preset)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="quiet-button accent p2-full-button"
                type="submit"
                disabled={creating || busy}
              >
                {creating ? '创建中……' : '创建项目'}
              </button>
            </form>

            {projectsError ? (
              <div className="inline-message error" role="alert">
                <span className="message-icon" aria-hidden="true">
                  !
                </span>
                <p>{projectsError}</p>
              </div>
            ) : null}
            {projectsLoading && projects.length === 0 ? (
              <p className="p2-empty-line">正在读取项目……</p>
            ) : projects.length === 0 ? (
              <p className="p2-empty-line">还没有项目，先在上方创建。</p>
            ) : (
              <ul className="p2-project-list">
                {projects.map((project) => (
                  <li key={project.id}>
                    <button
                      type="button"
                      className={
                        'p2-project-item' +
                        (project.id === selectedProjectId ? ' is-active' : '')
                      }
                      onClick={() => requestOpenProject(project.id)}
                      disabled={busy}
                    >
                      <span className="p2-project-name">{project.name}</span>
                      <span className="p2-project-meta">
                        r{project.revision} · {project.segment_count} 段 ·{' '}
                        {formatTime(project.updated_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="p2-service-card">
              <h3>运行模式</h3>
              <p>
                {statusLoading
                  ? '读取中……'
                  : statusError
                    ? '状态不可用'
                    : isRealMode
                      ? '真实语音（本机模型）'
                      : '测试音'}
              </p>
              <p className="p2-hint">
                {status?.inference.capabilities?.model ?? '模型信息未报告'}
              </p>
            </div>
          </aside>

          <section className="p2-project-main">
            {projectError ? (
              <div className="p2-subpanel">
                <div className="inline-message error" role="alert">
                  <span className="message-icon" aria-hidden="true">
                    !
                  </span>
                  <div>
                    <strong>项目加载失败</strong>
                    <p>{projectError}</p>
                  </div>
                  <button
                    className="message-action"
                    type="button"
                    onClick={() => {
                      if (selectedProjectId) loadProject(selectedProjectId)
                    }}
                  >
                    重试
                  </button>
                </div>
              </div>
            ) : null}

            {!selectedProjectId ? (
              <div className="p2-subpanel p2-empty-state">
                <h2>选择或新建项目</h2>
                <p>项目列表为空时，先在左侧创建项目并配置默认预设。</p>
              </div>
            ) : projectLoading ? (
              <div className="p2-subpanel p2-empty-state">
                <span className="spinner" aria-hidden="true" />
                <p>正在读取项目……</p>
              </div>
            ) : draft && baseProject ? (
              <>
                <div className="p2-subpanel">
                  <div className="p2-project-head">
                    <div>
                      <p className="kicker">PROJECT WORKSPACE</p>
                      <h2>项目设置</h2>
                    </div>
                    <div className="p2-revision-row">
                      <span className="p2-tag">已保存 r{revision}</span>
                      {dirty ? (
                        <span className="p2-tag warning">未保存草稿</span>
                      ) : (
                        <span className="p2-tag accent">已同步</span>
                      )}
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={requestReload}
                        disabled={busy}
                      >
                        重新加载
                      </button>
                    </div>
                  </div>

                  <div className="p2-field-grid">
                    <div className="p2-field">
                      <label htmlFor="p2-project-name">项目名称</label>
                      <input
                        id="p2-project-name"
                        value={draft.name}
                        onChange={(event) => changeProjectName(event.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <div className="p2-field">
                      <label htmlFor="p2-project-default-preset">
                        项目默认预设
                      </label>
                      <select
                        id="p2-project-default-preset"
                        value={draft.default_preset_id ?? ''}
                        onChange={(event) =>
                          changeDefaultPreset(event.target.value || null)
                        }
                        disabled={busy}
                      >
                        <option value="">基础模型默认</option>
                        {draft.default_preset_id &&
                        !presets.some(
                          (preset) => preset.id === draft.default_preset_id,
                        ) ? (
                          <option value={draft.default_preset_id}>
                            未知预设（{draft.default_preset_id}）
                          </option>
                        ) : null}
                        {presets.map((preset) => (
                          <option key={preset.id} value={preset.id}>
                            {presetLabel(preset)}
                          </option>
                        ))}
                      </select>
                      <p className="p2-hint">
                        预设库：{defaultLabel}。项目默认快照仍为 v{baseProject.default_snapshot.preset_version ?? '基础'}；改变默认预设后保存，使用默认快照的段落会显式更新。
                      </p>
                    </div>
                  </div>

                  <div className="p2-form-actions">
                    <div className="p2-inline-row">
                      <button
                        className="primary-button"
                        type="button"
                        onClick={() => void saveCurrent()}
                        disabled={busy}
                      >
                        {saving ? (
                          <>
                            <span className="spinner" aria-hidden="true" /> 保存中……
                          </>
                        ) : (
                          '保存项目'
                        )}
                      </button>
                      <button
                        className="quiet-button accent"
                        type="button"
                        onClick={() => void runGenerate('all')}
                        disabled={busy || !!blockedReason || draft.segments.length === 0}
                      >
                        {generating ? '提交中……' : '生成全部段落'}
                      </button>
                      <button
                        className="quiet-button accent"
                        type="button"
                        onClick={() => void runGenerate('selected')}
                        disabled={busy || !!blockedReason || selectedCount === 0}
                      >
                        生成选中（{selectedCount}）
                      </button>
                    </div>
                    <p className="p2-hint">
                      {blockedReason ??
                        '生成前会自动保存；新任务会按项目顺序冻结当前配置。'}
                    </p>
                  </div>

                  <details className="p2-semantics">
                    <summary>项目默认快照</summary>
                    <ConfigSummary
                      config={baseProject.default_snapshot.config}
                      assets={assets}
                      loras={loras}
                    />
                  </details>
                </div>

                {pollError ? (
                  <div className="inline-message error" role="alert">
                    <span className="message-icon" aria-hidden="true">
                      !
                    </span>
                    <div>
                      <strong>任务轮询失败</strong>
                      <p>{pollError} 系统会自动继续重试。</p>
                    </div>
                    <button
                      className="message-action"
                      type="button"
                      onClick={() => {
                        if (selectedProjectId) {
                          refreshProjectQuietly(selectedProjectId)
                        }
                      }}
                    >
                      立即重试
                    </button>
                  </div>
                ) : null}

                <div className="p2-subpanel">
                  <div className="p2-batch-bar">
                    <div>
                      <p className="kicker">SEGMENTS</p>
                      <h2>
                        段落 <span className="p2-count">{draft.segments.length}</span>
                        <span className="p2-total-limit">/ {P2_MAX_SEGMENTS}</span>
                      </h2>
                    </div>
                    <div className="p2-inline-row p2-wrap">
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={selectAllSegments}
                        disabled={draft.segments.length === 0}
                      >
                        全选
                      </button>
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={() => setSelectedKeys(new Set())}
                        disabled={selectedCount === 0}
                      >
                        清除选择
                      </button>
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={() => void previewLatestPresets('selected')}
                        disabled={busy || selectedCount === 0}
                      >
                        {previewLoading ? '检查中……' : '检查选中段最新预设'}
                      </button>
                      <button
                        className="quiet-button"
                        type="button"
                        onClick={() => void previewLatestPresets('all')}
                        disabled={busy || draft.segments.length === 0}
                      >
                        检查全部最新预设
                      </button>
                      <button
                        className="quiet-button danger"
                        type="button"
                        onClick={() => void cancelQueue()}
                        disabled={cancelling}
                      >
                        {cancelling ? '取消中……' : '取消未开始任务'}
                      </button>
                      {lastBatchId ? (
                        <button
                          className="quiet-button"
                          type="button"
                          onClick={() => void cancelQueue(lastBatchId)}
                          disabled={cancelling}
                          title={'批次 ' + lastBatchId}
                        >
                          取消最近一批
                        </button>
                      ) : null}
                      <button
                        className="quiet-button accent"
                        type="button"
                        onClick={addSegment}
                        disabled={busy || draft.segments.length >= P2_MAX_SEGMENTS}
                      >
                        添加段落
                      </button>
                    </div>
                  </div>

                  <div className="p2-batch-assign">
                    <div className="p2-batch-field">
                      <label htmlFor="p2-batch-speaker">
                        批量 speaker（应用到选中段）
                      </label>
                      <div className="p2-inline-row">
                        <input
                          id="p2-batch-speaker"
                          value={batchSpeaker}
                          onChange={(event) => setBatchSpeaker(event.target.value)}
                          placeholder="留空会清空选中段的 speaker"
                          disabled={busy || selectedCount === 0}
                        />
                        <button
                          className="quiet-button"
                          type="button"
                          onClick={applyBatchSpeaker}
                          disabled={busy || selectedCount === 0}
                        >
                          应用 speaker
                        </button>
                      </div>
                    </div>
                    <div className="p2-batch-field">
                      <label htmlFor="p2-batch-preset">
                        批量音色预设（应用到选中段）
                      </label>
                      <div className="p2-inline-row">
                        <select
                          id="p2-batch-preset"
                          value={batchPreset}
                          onChange={(event) => setBatchPreset(event.target.value)}
                          disabled={busy || selectedCount === 0}
                        >
                          <option value="keep">不修改预设</option>
                          <option value="default">项目默认预设（null）</option>
                          {presets.map((preset) => (
                            <option key={preset.id} value={preset.id}>
                              {presetLabel(preset)}
                            </option>
                          ))}
                        </select>
                        <button
                          className="quiet-button"
                          type="button"
                          onClick={applyBatchPreset}
                          disabled={
                            busy || selectedCount === 0 || batchPreset === 'keep'
                          }
                        >
                          应用预设
                        </button>
                      </div>
                    </div>
                    <p className="p2-hint">
                      批次只修改当前草稿；点保存后生效。改变 preset_id 会在保存时复制该预设当前快照。
                    </p>
                  </div>

                  {previewState ? (
                    <section className="p2-preview-panel" aria-labelledby="p2-preview-title">
                      <div className="p2-preview-head">
                        <div>
                          <h3 id="p2-preview-title">最新预设差异预览</h3>
                          <p className="p2-hint">
                            预览基于已保存修订 r{previewState.preview.revision}；
                            {previewState.scope === 'all' ? '全部段落' : '选中段落'}，
                            共 {previewState.preview.changes.length} 个变化。
                          </p>
                        </div>
                        <div className="p2-inline-row">
                          <button
                            className="primary-button"
                            type="button"
                            onClick={() => void applyLatestPresets()}
                            disabled={
                              applying ||
                              previewState.preview.changes.length === 0 ||
                              dirty
                            }
                          >
                            {applying ? '应用中……' : '应用这些最新预设'}
                          </button>
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => setPreviewState(null)}
                            disabled={applying}
                          >
                            关闭预览
                          </button>
                        </div>
                      </div>
                      {previewState.preview.changes.length === 0 ? (
                        <p className="p2-empty-line">没有需要应用的差异。</p>
                      ) : (
                        <ConfigDiffView
                          changes={previewState.preview.changes}
                          assets={assets}
                          loras={loras}
                          segmentLabels={previewState.labels}
                        />
                      )}
                      <p className="p2-hint">
                        只有点击应用才会替换快照；逐段 overrides 会保留。
                      </p>
                    </section>
                  ) : null}

                  <SegmentEditor
                    segments={draft.segments}
                    presets={presets}
                    assets={assets}
                    loras={loras}
                    selectedKeys={selectedKeys}
                    defaultPresetId={draft.default_preset_id}
                    defaultPresetLabel={defaultLabel}
                    busy={busy}
                    onToggle={toggleSelected}
                    onChange={changeSegment}
                    onMove={moveSegment}
                    onRemove={removeSegment}
                    onGenerate={(index) => void runGenerate('single', index)}
                    onSelectJob={(index, jobId) => void selectVersion(index, jobId)}
                  />
                </div>
              </>
            ) : null}
          </section>
        </div>
  )
}
