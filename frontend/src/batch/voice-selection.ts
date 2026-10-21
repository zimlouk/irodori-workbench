import type { P2Config, P2Overrides, P2Preset } from '../p2-api'
import { ADVANCED_PARAMETERS } from '../voice-parameters'

// Compare values, not property insertion order or optional default/null spelling.
export function voiceSignature(config: P2Config): string {
  const parameters = { ...config.parameters }
  for (const spec of ADVANCED_PARAMETERS) {
    if (parameters[spec.key] == null) delete parameters[spec.key]
  }
  return JSON.stringify([config.lora_id, config.reference_asset_ids, config.caption,
    Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b))])
}

export function matchingVoice(config: P2Config, presets: P2Preset[]): P2Preset | undefined {
  const signature = voiceSignature(config)
  return presets.find((preset) => voiceSignature(preset.config) === signature)
}

export function voiceName(preset: P2Preset): string {
  return preset.voice_name + ' · ' + preset.name + ' · 预设第' + String(preset.version) + '版'
}

export function voiceOverrides(config: P2Config): P2Overrides {
  // A voice is a full snapshot: defaults absent from the preset must not inherit
  // unrelated advanced parameters from the batch.
  const parameters = { ...config.parameters }
  for (const spec of ADVANCED_PARAMETERS) {
    if (!(spec.key in parameters)) Object.assign(parameters, { [spec.key]: null })
  }
  return { lora_id: config.lora_id, reference_asset_ids: [...config.reference_asset_ids],
    caption: config.caption, parameters }
}
