import { useEffect, useState } from 'react'
import { errorMessage, isAbortError } from '../api'
import { fetchQueue } from '../batch-api'
import type { QueueItem } from '../batch-api'

export interface QueuePollingState {
  queue: QueueItem[]
  queueError: string | null
  queueLoading: boolean
  refreshQueue: () => Promise<void>
  setQueue: (items: QueueItem[]) => void
}

export function useQueuePolling(): QueuePollingState {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueError, setQueueError] = useState<string | null>(null)
  const [queueLoading, setQueueLoading] = useState(true)

  useEffect(() => {
    let active = true
    let timer: number | undefined

    async function poll(): Promise<void> {
      try {
        const items = await fetchQueue()
        if (!active) return
        setQueue(items)
        setQueueError(null)
        setQueueLoading(false)
      } catch (error) {
        if (!active || isAbortError(error)) return
        setQueueError(errorMessage(error))
        setQueueLoading(false)
      }
      if (active) timer = window.setTimeout(() => void poll(), 2000)
    }

    void poll()
    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  async function refreshQueue(): Promise<void> {
    try {
      const items = await fetchQueue()
      setQueue(items)
      setQueueError(null)
      setQueueLoading(false)
    } catch (error) {
      if (!isAbortError(error)) setQueueError(errorMessage(error))
    }
  }

  return { queue, queueError, queueLoading, refreshQueue, setQueue }
}
