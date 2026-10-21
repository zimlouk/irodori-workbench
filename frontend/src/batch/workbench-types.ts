import { parseConfig } from '../p2-api'
import type { P2Config, P2Overrides } from '../p2-api'
import { emptyConfig } from '../p2/model'
import type { Batch, Processing, QueueItem } from '../batch-api'
import {
  cloneConfig,
  cloneOverrides,
  cloneProcessing,
  DEFAULT_PROCESSING,
} from './model'
import type { CachedDraft } from './model'

export const DRAFT_CACHE_KEY = 'irodori-batch-workbench-drafts-v1'

export type NoticeKind = 'info' | 'success' | 'error' | 'warning'

export interface WorkbenchNotice {
  kind: NoticeKind
  text: string
}

export interface WorkbenchState {
  editorSession: number
  batch: Batch | null
  leftText: string
  rightText: string
  config: P2Config
  processing: Processing
  outputDir: string
  overrides: Record<string, P2Overrides>
  overridesDirty: Record<string, boolean>
  leftDirty: boolean
  rightDirty: boolean
  settingsDirty: boolean
  follow: boolean
}

export interface PreferencesDefaults {
  config: P2Config
  processing: Processing
  outputDir: string
}

export interface DraftVersions {
  left: number
  right: number
  settings: number
  overrides: Record<string, number>
}

export function snapshotVersions(
  left: number,
  right: number,
  settings: number,
  overrides: Record<string, number>,
): DraftVersions {
  return { left, right, settings, overrides: { ...overrides } }
}

export function versionsDiffer(
  snapshot: DraftVersions,
  left: number,
  right: number,
  settings: number,
  overrides: Record<string, number>,
): boolean {
  if (left !== snapshot.left || right !== snapshot.right || settings !== snapshot.settings) {
    return true
  }
  const keys = new Set([...Object.keys(snapshot.overrides), ...Object.keys(overrides)])
  for (const key of keys) {
    if ((snapshot.overrides[key] ?? 0) !== (overrides[key] ?? 0)) return true
  }
  return false
}

function initialConfig(): P2Config {
  return emptyConfig()
}

export function initialDraft(): WorkbenchState {
  return {
    editorSession: 0,
    batch: null,
    leftText: '',
    rightText: '',
    config: initialConfig(),
    processing: cloneProcessing(DEFAULT_PROCESSING),
    outputDir: '',
    overrides: {},
    overridesDirty: {},
    leftDirty: false,
    rightDirty: false,
    settingsDirty: false,
    follow: false,
  }
}

export function readDraftCache(): Record<string, CachedDraft> {
  try {
    const raw = window.localStorage.getItem(DRAFT_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    const result: Record<string, CachedDraft> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        continue
      }
      const item = value as Partial<CachedDraft>
      if (
        typeof item.leftText !== 'string' ||
        typeof item.rightText !== 'string' ||
        !parseConfig(item.config) ||
        typeof item.processing !== 'object' ||
        item.processing === null ||
        typeof item.outputDir !== 'string' ||
        typeof item.overrides !== 'object' ||
        item.overrides === null ||
        Array.isArray(item.overrides)
      ) {
        continue
      }
      const mode = item.processing.mode
      if (mode !== 'article' && mode !== 'lines' && mode !== 'passthrough') {
        continue
      }
      result[key] = item as CachedDraft
    }
    return result
  } catch {
    return {}
  }
}

export function writeDraftCache(cache: Record<string, CachedDraft>): void {
  try {
    if (Object.keys(cache).length === 0) {
      window.localStorage.removeItem(DRAFT_CACHE_KEY)
    } else {
      window.localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify(cache))
    }
  } catch {
    // Local draft safety net is best-effort when storage is unavailable.
  }
}

export function hasDirtyDraft(state: WorkbenchState): boolean {
  return (
    state.leftDirty ||
    state.rightDirty ||
    state.settingsDirty ||
    Object.values(state.overridesDirty).some(Boolean)
  )
}

export function cachedDraftFrom(state: WorkbenchState): CachedDraft | null {
  if (!hasDirtyDraft(state)) return null
  return {
    leftText: state.leftText,
    rightText: state.rightText,
    config: cloneConfig(state.config),
    processing: cloneProcessing(state.processing),
    outputDir: state.outputDir,
    overrides: Object.fromEntries(
      Object.entries(state.overrides).map(([key, value]) => [
        key,
        cloneOverrides(value),
      ]),
    ),
    leftDirty: state.leftDirty,
    rightDirty: state.rightDirty,
    settingsDirty: state.settingsDirty,
    overridesDirty: { ...state.overridesDirty },
    updatedAt: new Date().toISOString(),
  }
}

export function cacheKeyFor(state: WorkbenchState): string {
  return state.batch?.id ?? '__new__'
}

export interface BatchWorkbenchController {
  state: WorkbenchState
  loading: boolean
  loadError: string | null
  busy: number
  notice: WorkbenchNotice | null
  syncError: string | null
  revisionConflict: string | null
  savePaused: boolean
  queue: QueueItem[]
  queueError: string | null
  queueLoading: boolean
  updateLeft: (text: string) => void
  updateRight: (text: string) => void
  updateConfig: (config: P2Config) => void
  updateProcessing: (processing: Processing) => void
  updateOutputDir: (value: string) => void
  updateOverride: (segmentId: string, overrides: P2Overrides) => void
  applySentenceVoice: (index: number, config: P2Config | null) => Promise<void>
  flushDrafts: () => Promise<void>
  generate: (all: boolean) => Promise<void>
  rerollSegment: (segmentId: string, batchId?: string) => Promise<void>
  restoreDeleted: (batchId: string, segmentId: string) => Promise<void>
  selectVersion: (segmentId: string, jobId: string) => Promise<void>
  resolveConflict: (
    conflictId: string,
    choice: 'keep' | 'replace',
    segmentId?: string,
  ) => Promise<void>
  createNewBatch: (source: string) => Promise<boolean>
  switchToBatch: (id: string) => Promise<boolean>
  reloadCurrent: () => Promise<void>
  keepLocalAfterConflict: () => void
  setFollow: (follow: boolean) => Promise<void>
  openOutput: () => Promise<void>
  cancelTasks: (batchId?: string) => Promise<void>
  refreshQueue: () => Promise<void>
  clearNotice: () => void
  setNotice: (text: string, kind?: NoticeKind) => void
}
