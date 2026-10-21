import { useEffect, useState } from 'react'
import { errorMessage, isAbortError } from '../api'
import { fetchPresetCatalog, reorderPresets } from '../p2-api'
import type { P2Preset } from '../p2-api'

export function PresetOrderPanel({presets,onSaved}: {
  presets:P2Preset[]; onSaved:(items:P2Preset[])=>void
}) {
  const [draft,setDraft] = useState<P2Preset[]>([])
  const [revision,setRevision] = useState('')
  const [busy,setBusy] = useState(false)
  const [dirty,setDirty] = useState(false)
  const [error,setError] = useState<string|null>(null)
  const [notice,setNotice] = useState('')
  const [refresh,setRefresh] = useState(0)
  // Config saves do not discard a draft; adding/removing/ordering presets does.
  const signature = presets.map(p=>p.id).join('|')
  useEffect(()=>{
    const controller = new AbortController()
    setRevision('')
    void fetchPresetCatalog(controller.signal).then(c=>{
      setDraft(c.items); setRevision(c.revision); setDirty(false); setError(null)
    }).catch(e=>{if(!isAbortError(e))setError(errorMessage(e))})
    return ()=>controller.abort()
  },[signature,refresh])

  function move(index:number,direction:number) {
    const next = [...draft]
    const target = index+direction
    if(target<0 || target>=next.length)return
    ;[next[index],next[target]]=[next[target],next[index]]
    setDraft(next);setDirty(true);setNotice('')
  }
  async function save(reset:boolean) {
    if(busy || !revision)return
    setBusy(true);setError(null);setNotice('')
    try {
      const result = await reorderPresets(revision,reset?null:draft.map(p=>p.id))
      setDraft(result.items);setRevision(result.revision);setDirty(false)
      onSaved(result.items)
      setNotice(reset?'已恢复按作品排序。':'顺序已保存，整批与本句音色列表同步更新。')
    } catch(e) {setError(errorMessage(e))}
    finally {setBusy(false)}
  }
  return <details className="batch-settings-details">
    <summary>调整预设顺序{dirty?' · 尚未保存':''}</summary>
    <p className="batch-hint">上下移动后保存；默认按角色所属作品排列。顺序会保留在工作台中。</p>
    <ol className="preset-order-list" aria-label="预设排序列表">
      {draft.map((p,index)=><li className="preset-order-row" key={p.id}>
        <div className="preset-order-copy"><strong>{p.voice_name} · {p.name}</strong><small>{p.work??'其他'}</small></div>
        <div className="preset-order-actions">
          <button type="button" className="quiet-button" disabled={busy||!revision||index===0}
            aria-label={'上移 '+p.voice_name+' · '+p.name} onClick={()=>move(index,-1)}>↑</button>
          <button type="button" className="quiet-button" disabled={busy||!revision||index===draft.length-1}
            aria-label={'下移 '+p.voice_name+' · '+p.name} onClick={()=>move(index,1)}>↓</button>
        </div>
      </li>)}
    </ol>
    <div className="preset-order-tools">
      <button className="quiet-button accent" type="button" disabled={busy||!revision||!dirty} onClick={()=>void save(false)}>保存顺序</button>
      <button className="quiet-button" type="button" disabled={busy||!revision} onClick={()=>void save(true)}>恢复按作品排序</button>
      <button className="quiet-button" type="button" disabled={busy} onClick={()=>{setRefresh(v=>v+1);setNotice('')}}>重新读取顺序</button>
    </div>
    {error?<p className="batch-inline-error" role="alert">{error}</p>:null}
    {notice?<p className="batch-hint" role="status">{notice}</p>:null}
  </details>
}
