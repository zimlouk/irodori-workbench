import { useEffect, useRef, useState } from 'react'
import { fetchBatch } from '../batch-api'
import type { Batch, BatchJob, BatchSegment } from '../batch-api'
import { errorMessage, isAbortError } from '../api'
import { LivePreview, previewPlaylist } from './live-preview'
import { SequencePlayer, emptyPreview } from './sequence-player'

export { previewPlaylist } from './live-preview'

const SETTINGS_KEY = 'irodori-preview-settings-v1'
function settings(): { auto: boolean; gap: number } {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    if (typeof parsed === 'object' && parsed !== null && 'auto' in parsed && 'gap' in parsed) {
      return { auto: typeof parsed.auto === 'boolean' ? parsed.auto : true,
        gap: typeof parsed.gap === 'number' && Number.isFinite(parsed.gap) && parsed.gap >= 0 && parsed.gap <= 30 ? parsed.gap : .5 }
    }
  } catch { /* Local storage may be unavailable. */ }
  return { auto: true, gap: .5 }
}

export function useBatchPreview(batch: Batch | null, suspended = false) {
  const [options,setOptions] = useState(settings)
  const [state,setState] = useState(emptyPreview)
  const [sourceBatchId,setSourceBatchId] = useState<string|null>(null)
  const [syncError,setSyncError] = useState<string|null>(null)
  const engine = useRef<SequencePlayer|null>(null)
  const session = useRef<LivePreview|null>(null)
  const automatic = useRef(options.auto&&!suspended)
  automatic.current = options.auto&&!suspended
  const currentBatch = useRef(batch)
  currentBatch.current = batch

  useEffect(()=>{
    const audio = new Audio()
    audio.preload = 'metadata'
    let live:LivePreview|null=null
    const player = new SequencePlayer(audio,next=>{setState(next);live?.playerChanged()})
    live = new LivePreview(player,setSourceBatchId)
    engine.current=player;session.current=live
    let alive=true
    let timer:number|undefined
    const controller=new AbortController()
    async function poll():Promise<void> {
      const results=await Promise.allSettled((live?.pendingBatchIds()??[]).map(async id=>{
        const source=await fetchBatch(id,controller.signal)
        if(alive)live?.observe(source,automatic.current)
      }))
      if(!alive)return
      const failed=results.find(result=>result.status==='rejected'&&!isAbortError(result.reason))
      setSyncError(failed?.status==='rejected'?'读取后续试听结果暂时失败，将继续重试：'+errorMessage(failed.reason):null)
      timer=window.setTimeout(()=>void poll(),failed?3000:1000)
    }
    void poll()
    return ()=>{
      alive=false;controller.abort()
      if(timer!==undefined)window.clearTimeout(timer)
      player.dispose();engine.current=null;session.current=null
    }
  },[])

  useEffect(()=>{
    engine.current?.setGap(options.gap)
    try {localStorage.setItem(SETTINGS_KEY,JSON.stringify(options))} catch { /* Best effort. */ }
  },[options])

  useEffect(()=>{
    session.current?.setAutomatic(automatic.current)
    session.current?.observe(batch,automatic.current)
  },[batch,options.auto,suspended])

  function playVersion(segment:BatchSegment,job:BatchJob):void {
    if(!job.audio_url||job.purged||job.status!=='succeeded'||!currentBatch.current)return
    const ordinal=currentBatch.current.segments.findIndex(item=>item.id===segment.id)+1
    session.current?.playVersion(currentBatch.current.id,{segmentId:segment.id,jobId:job.id,
      url:job.audio_url,text:job.text,ordinal},job.stale?'正在试听历史版本。':'')
  }

  return {state,sourceBatchId,syncError,detached:!!sourceBatchId&&sourceBatchId!==batch?.id,
    auto:options.auto,gap:options.gap,available:previewPlaylist(batch).tracks.length,
    setAuto:(auto:boolean)=>setOptions(value=>({...value,auto})),
    setGap:(gap:number)=>{if(Number.isFinite(gap)&&gap>=0&&gap<=30)setOptions(value=>({...value,gap}))},
    playBatch:()=>{if(currentBatch.current)session.current?.playBatch(currentBatch.current)},playVersion,
    pause:()=>engine.current?.pause(),resume:()=>session.current?.resume(),
    stop:()=>{session.current?.stop();setSyncError(null)},
    previous:()=>session.current?.move(-1),next:()=>session.current?.move(1),
    seek:(seconds:number)=>engine.current?.seek(seconds),
  }
}
export type BatchPreviewController = ReturnType<typeof useBatchPreview>
