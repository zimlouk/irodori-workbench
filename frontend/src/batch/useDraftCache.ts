import { useEffect, useRef } from 'react'
import {
  cacheKeyFor,
  hasDirtyDraft,
  readDraftCache,
  writeDraftCache,
} from './workbench-types'
import type { WorkbenchState } from './workbench-types'

export function useDraftCachePersistence(
  state: WorkbenchState,
  loading: boolean,
  persistCache: () => void,
): void {
  const persistRef = useRef(persistCache)
  persistRef.current = persistCache

  useEffect(() => {
    if (loading) return
    if (!hasDirtyDraft(state)) {
      const key = cacheKeyFor(state)
      const cache = readDraftCache()
      if (Object.prototype.hasOwnProperty.call(cache, key)) {
        delete cache[key]
        writeDraftCache(cache)
      }
      return
    }
    const timer = window.setTimeout(() => persistRef.current(), 400)
    return () => window.clearTimeout(timer)
  }, [state, loading])
}
