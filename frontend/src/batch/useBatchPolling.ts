import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { errorMessage, isAbortError } from '../api'
import { fetchBatch } from '../batch-api'
import type { Batch } from '../batch-api'

export function useBatchPolling(
  batchIdRef: RefObject<string | null>,
  revisionRef: RefObject<number>,
  applyServerBatch: (batch: Batch) => void,
  setSyncError: (value: string | null) => void,
): void {
  const applyRef = useRef(applyServerBatch)
  applyRef.current = applyServerBatch

  useEffect(() => {
    let active = true
    let timer: number | undefined

    async function poll(): Promise<void> {
      const id = batchIdRef.current
      if (id) {
        try {
          const server = await fetchBatch(id)
          if (active && id === batchIdRef.current) {
            if (server.revision >= revisionRef.current) applyRef.current(server)
            setSyncError(null)
          }
        } catch (error) {
          if (active && !isAbortError(error)) setSyncError(errorMessage(error))
        }
      }
      if (active) timer = window.setTimeout(() => void poll(), 2500)
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [batchIdRef, revisionRef, setSyncError])
}
