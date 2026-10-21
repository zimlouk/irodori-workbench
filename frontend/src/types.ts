export type JobStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'cancelled'

export type JobMode = 'fake' | 'irodori'

export interface JobReferenceSummary {
  selected_count: number
  encoded_count: number | null
  max_ref_seconds: number | null
}

export interface JobResultMetadata {
  used_seed?: string | number
  sample_rate?: number
  audio_seconds?: number
  messages?: string[]
  reference_summary?: JobReferenceSummary
  effective_config?: Record<string, unknown>
}

export interface Job {
  id: string
  text: string
  status: JobStatus
  mode: JobMode
  created_at: string
  error: string | null
  audio_url: string | null
  request_config: Record<string, unknown> | null
  result_metadata: JobResultMetadata | null
}

export interface JobsResponse {
  items: Job[]
}

export interface InferenceCapabilities {
  protocol_version: 1
  multi_reference: true
  managed_synthesis: true
  model: string
  defaults: {
    max_ref_seconds: number | null
  }
  runtime: {
    loaded: boolean
    loading: boolean
    busy: boolean
  }
}

export interface ServiceStatus {
  service: string
  mode: JobMode
  database: string
  inference: {
    available: boolean
    kind: string
    error?: string
    capabilities?: InferenceCapabilities
  }
  version: string
}

export interface Lora {
  id: string
  name: string
  available: boolean
  family?: string
  model_version?: string
  checkpoint?: string
  relative_path?: string
}

export interface Asset {
  id: string
  name: string
  duration_seconds: number
  sample_rate: number
  channels: number
  audio_url: string
}

export interface JobParameters {
  num_steps: number
  seed: string | null
  max_ref_seconds: number | null
}

export interface CreateJobInput {
  text: string
  lora_id: string | null
  reference_asset_ids: string[]
  caption: string
  parameters: JobParameters
}
