import type { Batch, BatchJob, BatchSegment } from '../batch-api'
import { SequencePlayer } from './sequence-player'
import type { PreviewTrack } from './sequence-player'

const active = (job:BatchJob) => job.status === 'pending' || job.status === 'running'
function valid(segment:BatchSegment, job:BatchJob|undefined):job is BatchJob {
  return !!job && job.status === 'succeeded' && !!job.audio_url && !job.purged && !job.stale &&
    !segment.selected_stale && job.input_revision === segment.input_revision && segment.selected_job_id === job.id
}
function track(segment:BatchSegment, job:BatchJob, ordinal:number):PreviewTrack {
  return {segmentId:segment.id,jobId:job.id,url:job.audio_url!,text:job.text??segment.text,ordinal}
}
export function previewPlaylist(batch:Batch|null):{tracks:PreviewTrack[];skipped:number} {
  const tracks:PreviewTrack[]=[]
  for(const [index,segment] of (batch?.segments??[]).entries()) {
    const job=segment.attempts.find(job=>job.id===segment.selected_job_id)
    if(valid(segment,job))tracks.push(track(segment,job,index+1))
  }
  return {tracks,skipped:(batch?.segments.length??0)-tracks.length}
}

interface Round {
  key:string
  batchId:string
  slots:{segmentId:string;jobId:string|null;ordinal:number}[]
  watched:Set<string>
  manual:boolean
}

/** Playback owns its source independently of the batch currently being edited. */
export class LivePreview {
  private batches=new Map<string,Batch>()
  private seen=new Map<string,Set<string>>()
  private done=new Set<string>()
  private queue:Round[]=[]
  private current:Round|null=null
  private directManual=false
  private advancing=false
  private counter=0
  private owner:string|null=null

  constructor(private player:SequencePlayer,private ownerChanged:(id:string|null)=>void=()=>{}) {}

  private setOwner(id:string|null):void {
    if(this.owner!==id) {this.owner=id;this.ownerChanged(id)}
  }

  observe(batch:Batch|null,automatic:boolean):void {
    if(!batch)return
    this.batches.set(batch.id,batch)
    const jobs=[...batch.segments,...batch.deleted_segments].flatMap(segment=>segment.attempts)
    const known=this.seen.get(batch.id)
    const newJobs=jobs.filter(job=>known?!known.has(job.id):active(job))
    this.seen.set(batch.id,new Set(jobs.map(job=>job.id)))
    if(automatic) {
      for(const job of newJobs) {
        const key=batch.id+':'+(job.batch_id??job.id)
        if(this.done.has(key)||this.current?.key===key||this.queue.some(round=>round.key===key))continue
        const roundJobs=jobs.filter(item=>(item.batch_id??item.id)===(job.batch_id??job.id))
        this.queue.push(this.round(batch,key,roundJobs,false))
      }
    }
    this.advance()
  }

  private round(batch:Batch,key:string,jobs:BatchJob[],manual:boolean):Round {
    const watched=new Set(jobs.map(job=>job.id))
    return {key,batchId:batch.id,watched,manual,slots:batch.segments.map((segment,index)=>({
      segmentId:segment.id,ordinal:index+1,
      jobId:segment.attempts.find(job=>watched.has(job.id))?.id??segment.selected_job_id,
    }))}
  }

  private plan(round:Round) {
    const batch=this.batches.get(round.batchId)!
    const jobs=[...batch.segments,...batch.deleted_segments].flatMap(segment=>segment.attempts)
    const watched=jobs.filter(job=>round.watched.has(job.id))
    const open=watched.some(active)
    const triggered=round.manual||batch.segments.some(segment=>
      segment.attempts.some(job=>round.watched.has(job.id)&&valid(segment,job)))
    const tracks:PreviewTrack[]=[]
    let failed=0
    for(const slot of round.slots) {
      const segment=batch.segments.find(segment=>segment.id===slot.segmentId)
      if(!segment)continue
      const job=segment.attempts.find(job=>job.id===slot.jobId)
      if(job&&active(job)&&job.input_revision===segment.input_revision)break
      if(valid(segment,job))tracks.push(track(segment,job,slot.ordinal))
      else if(job&&!active(job))failed++
    }
    return {tracks:triggered?tracks:[],open,failed}
  }

  /** Called by the audio element; progress and queue updates cannot restart a track. */
  playerChanged():void {
    if(this.player.snapshot().phase==='ended')this.advance()
  }

  private advance():void {
    if(this.advancing)return
    this.advancing=true
    try {
      if(this.directManual) {
        if(this.player.snapshot().phase!=='ended')return
        this.directManual=false
      }
      for(;;) {
        if(this.current) {
          const plan=this.plan(this.current)
          this.player.updateStream(plan.tracks,plan.open)
          if(this.player.snapshot().phase!=='ended')return
          this.done.add(this.current.key)
          this.current=null
        }
        const next=this.queue.shift()
        if(!next)return
        this.current=next
        const plan=this.plan(next)
        this.setOwner(next.batchId)
        this.player.start(plan.tracks,0,plan.failed?'本轮已有句子失败或被修改，已跳过对应音频。':'',plan.open)
        if(this.player.snapshot().phase!=='ended')return
      }
    } finally {this.advancing=false}
  }

  setAutomatic(enabled:boolean):void {
    if(enabled)return
    for(const round of this.queue)this.done.add(round.key)
    this.queue=[]
    if(this.current&&!this.current.manual&&this.player.snapshot().tracks.length===0) {
      this.done.add(this.current.key)
      this.current=null
      this.player.stop()
      this.setOwner(null)
    }
  }

  pendingBatchIds():string[] {
    return [...new Set([...(this.current?[this.current]:[]),...this.queue]
      .filter(round=>this.plan(round).open).map(round=>round.batchId))]
  }

  stop():void {
    if(this.current)this.done.add(this.current.key)
    for(const round of this.queue)this.done.add(round.key)
    this.current=null;this.queue=[];this.directManual=false
    this.player.stop();this.setOwner(null)
  }

  resume():void {
    if(!this.current&&this.player.snapshot().tracks.length)this.directManual=true
    this.player.resume()
  }

  move(direction:-1|1):void {
    const state=this.player.snapshot(),next=state.index+direction
    if(next<0||next>=state.tracks.length)return
    if(!this.current)this.directManual=true
    this.player.move(direction)
  }

  playBatch(batch:Batch):void {
    this.stop()
    this.batches.set(batch.id,batch)
    const jobs=batch.segments.flatMap(segment=>segment.attempts.filter(active))
    this.queue.push(this.round(batch,'manual:'+String(++this.counter),jobs,true))
    this.advance()
  }

  playVersion(batchId:string,preview:PreviewTrack,message=''):void {
    this.stop();this.directManual=true;this.setOwner(batchId)
    this.player.start([preview],0,message)
  }
}
