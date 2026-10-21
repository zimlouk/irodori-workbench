import type { P2Preset } from '../p2-api'
import { voiceName } from './voice-selection'

export function PresetOptions({presets}: {presets:P2Preset[]}) {
  const groups: {work:string;items:P2Preset[]}[] = []
  for (const preset of presets) {
    const work = preset.work ?? '其他'
    const last = groups.at(-1)
    if (last?.work === work) last.items.push(preset)
    else groups.push({work,items:[preset]})
  }
  return <>{groups.map((group,index)=><optgroup key={index} label={group.work}>
    {group.items.map(preset=><option key={preset.id} value={preset.id}>{voiceName(preset)}</option>)}
  </optgroup>)}</>
}
