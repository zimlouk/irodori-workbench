import type { Lora } from './types'

export function loraLabel(lora: Lora): string {
  const character = lora.name.replace(/(?:_\d+|（\d+）)$/,'')
  return [character, lora.model_version, lora.checkpoint].filter(Boolean).join(' · ')
}
