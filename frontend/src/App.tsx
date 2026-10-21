import { useEffect, useRef, useState } from 'react'
import { loraLabel } from './lora-label'
import type { FormEvent } from 'react'
import {
  MAX_ASSET_BYTES,
  MAX_TEXT_LENGTH,
  createJob,
  errorMessage,
  fetchAssets,
  fetchJobs,
  fetchLoras,
  fetchStatus,
  isAbortError,
  uploadAsset,
} from './api'
import type {
  Asset,
  CreateJobInput,
  InferenceCapabilities,
  Job,
  JobMode,
  JobResultMetadata,
  JobStatus,
  Lora,
  ServiceStatus,
} from './types'

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: '等待中',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
  cancelled: '已取消',
}

const MODE_LABELS: Record<JobMode, string> = {
  irodori: '真实语音',
  fake: '测试音',
}

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const numberFormatter = new Intl.NumberFormat('zh-CN')

function formatLocalTime(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }
  return dateTimeFormatter.format(date)
}

function shortId(id: string): string {
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id
}

function databaseLabel(value: string): string {
  return value === 'ok' ? '正常' : value
}

function kindLabel(kind: string): string {
  if (kind === 'irodori') {
    return 'Irodori'
  }
  if (kind === 'fake') {
    return '测试音'
  }
  return kind || '未知'
}

function inferenceLabel(status: ServiceStatus): string {
  return (
    kindLabel(status.inference.kind) +
    (status.inference.available ? ' · 可用' : ' · 不可用')
  )
}

function runtimeSummary(capabilities: InferenceCapabilities): string {
  if (capabilities.runtime.loading) return '模型加载中'
  const parts = [capabilities.runtime.loaded ? '已加载' : '未加载']
  if (capabilities.runtime.busy) {
    parts.push('生成中')
  }
  return parts.join(' · ')
}

function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return '未报告'
  }
  if (seconds < 60) {
    return seconds.toFixed(2) + ' 秒'
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return String(minutes) + ' 分 ' + rest.toFixed(1) + ' 秒'
}

function formatLimit(seconds: number | null | undefined): string {
  if (seconds === undefined) {
    return '未报告'
  }
  if (seconds === null) {
    return '模型推荐'
  }
  return formatDuration(seconds)
}

function channelLabel(channels: number): string {
  if (channels === 1) {
    return '单声道'
  }
  if (channels === 2) {
    return '立体声'
  }
  return String(channels) + ' 声道'
}

function jsonText(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2) ?? '{}'
}

function JsonDetails({
  summary,
  value,
}: {
  summary: string
  value: Record<string, unknown>
}) {
  return (
    <details className="config-details">
      <summary>{summary}</summary>
      <pre>{jsonText(value)}</pre>
    </details>
  )
}

function ResultMetadataBlock({ metadata }: { metadata: JobResultMetadata }) {
  const summary = metadata.reference_summary
  const warnings = (metadata.messages ?? []).filter(message => /^warning:|^error:/i.test(message))
  const hasResult =
    metadata.used_seed !== undefined ||
    metadata.sample_rate !== undefined ||
    metadata.audio_seconds !== undefined ||
    summary !== undefined ||
    warnings.length > 0 ||
    metadata.effective_config !== undefined

  if (!hasResult) {
    return null
  }

  return (
    <div className="result-metadata">
      <div className="result-metrics">
        <div>
          <span>实际 seed</span>
          <strong>{metadata.used_seed ?? '未报告'}</strong>
        </div>
        <div>
          <span>音频时长</span>
          <strong>{formatDuration(metadata.audio_seconds)}</strong>
        </div>
        <div>
          <span>参考</span>
          <strong>
            {summary
              ? summary.selected_count +
                ' 选中 / ' +
                (summary.encoded_count === null
                  ? '编码未报告'
                  : summary.encoded_count + ' 编码')
              : '未报告'}
          </strong>
        </div>
        <div>
          <span>累计上限</span>
          <strong>{formatLimit(summary?.max_ref_seconds)}</strong>
        </div>
        <div>
          <span>采样率</span>
          <strong>
            {metadata.sample_rate === undefined
              ? '未报告'
              : numberFormatter.format(metadata.sample_rate) + ' Hz'}
          </strong>
        </div>
      </div>

      {warnings.length > 0 ? (
        <ul className="result-warnings" aria-label="生成警告">
          {warnings.map((message, index) => (
            <li key={String(index) + ':' + message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {metadata.effective_config ? (
        <JsonDetails summary="最终配置" value={metadata.effective_config} />
      ) : null}
      {metadata.messages?.length ? (
        <JsonDetails summary="运行详情" value={{ messages: metadata.messages }} />
      ) : null}
    </div>
  )
}

function JobCard({ job }: { job: Job }) {
  const isTestAudio = job.mode === 'fake'

  return (
    <article
      className={'job-card job-' + job.status}
      aria-label={'任务 ' + job.id}
    >
      <div className="job-topline">
        <div className="job-identifiers">
          <span className={'status-badge status-' + job.status}>
            <span aria-hidden="true" />
            {STATUS_LABELS[job.status]}
          </span>
          <span className="job-id" title={job.id}>
            #{shortId(job.id)}
          </span>
          <span
            className={
              'mode-chip ' + (isTestAudio ? 'mode-test' : 'mode-real')
            }
          >
            {MODE_LABELS[job.mode]}
          </span>
        </div>
        <time dateTime={job.created_at} title={job.created_at}>
          {formatLocalTime(job.created_at)}
        </time>
      </div>

      <p className="job-text">{job.text}</p>

      {job.status === 'running' ? (
        <div className="running-track" aria-hidden="true">
          <span />
        </div>
      ) : null}

      {job.error ? (
        <div className="job-error">
          <strong>任务错误</strong>
          <p>{job.error}</p>
        </div>
      ) : null}

      {job.result_metadata ? (
        <ResultMetadataBlock metadata={job.result_metadata} />
      ) : null}

      {job.request_config ? (
        <JsonDetails summary="请求配置（只读）" value={job.request_config} />
      ) : null}

      {job.audio_url ? (
        <div className="audio-block">
          <div className="audio-label">
            <span className="audio-bars" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            {isTestAudio ? '测试音试听' : '结果试听'}
          </div>
          <audio
            controls
            preload="none"
            src={job.audio_url}
            aria-label={'任务 ' + job.id + ' 的音频'}
          >
            当前浏览器不支持音频播放。
          </audio>
        </div>
      ) : job.status === 'succeeded' ? (
        <p className="audio-unavailable">任务已完成，暂未提供音频链接。</p>
      ) : null}
    </article>
  )
}

interface UploadIssue {
  fileName: string
  message: string
}

function App() {
  const [text, setText] = useState('')
  const [caption, setCaption] = useState('')
  const [numSteps, setNumSteps] = useState('40')
  const [seed, setSeed] = useState('')
  const [maxRefSeconds, setMaxRefSeconds] = useState('')
  const [selectedLoraId, setSelectedLoraId] = useState('')
  const [references, setReferences] = useState<Asset[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [serviceStatus, setServiceStatus] = useState<ServiceStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)

  const [loras, setLoras] = useState<Lora[]>([])
  const [lorasLoading, setLorasLoading] = useState(true)
  const [lorasError, setLorasError] = useState<string | null>(null)
  const [lorasVersion, setLorasVersion] = useState(0)

  const [assets, setAssets] = useState<Asset[]>([])
  const [assetsLoading, setAssetsLoading] = useState(true)
  const [assetsError, setAssetsError] = useState<string | null>(null)
  const [assetsVersion, setAssetsVersion] = useState(0)
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<{
    current: number
    total: number
    name: string
  } | null>(null)
  const [uploadErrors, setUploadErrors] = useState<UploadIssue[]>([])

  const [jobs, setJobs] = useState<Job[]>([])
  const [jobsLoading, setJobsLoading] = useState(true)
  const [jobsError, setJobsError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [jobsVersion, setJobsVersion] = useState(0)

  const submitLock = useRef(false)
  const submitController = useRef<AbortController | null>(null)
  const uploadLock = useRef(false)
  const uploadController = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      submitController.current?.abort()
      uploadController.current?.abort()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let timer: number | undefined
    setStatusLoading(true)
    setStatusError(null)

    const poll = () => fetchStatus(controller.signal)
      .then((status) => {
        if (active) {
          setServiceStatus(status)
          setStatusError(null)
        }
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) {
          return
        }
        setServiceStatus(null)
        setStatusError(errorMessage(error))
      })
      .finally(() => {
        if (active) {
          setStatusLoading(false)
          timer = window.setTimeout(() => { void poll() }, 5000)
        }
      })
    void poll()

    return () => {
      active = false
      if (timer !== undefined) window.clearTimeout(timer)
      controller.abort()
    }
  }, [statusVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLorasLoading(true)
    setLorasError(null)

    void fetchLoras(controller.signal)
      .then((items) => {
        if (!active) {
          return
        }
        setLoras(items)
        setSelectedLoraId((current) => {
          if (!current) {
            return current
          }
          const selected = items.find((item) => item.id === current)
          return selected?.available ? current : ''
        })
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) {
          return
        }
        setLorasError(errorMessage(error))
      })
      .finally(() => {
        if (active) {
          setLorasLoading(false)
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [lorasVersion])

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setAssetsLoading(true)
    setAssetsError(null)

    void fetchAssets(controller.signal)
      .then((items) => {
        if (!active) {
          return
        }
        setAssets(items)
        setReferences((current) =>
          current.map(
            (reference) =>
              items.find((asset) => asset.id === reference.id) ?? reference,
          ),
        )
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) {
          return
        }
        setAssetsError(errorMessage(error))
      })
      .finally(() => {
        if (active) {
          setAssetsLoading(false)
        }
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [assetsVersion])

  useEffect(() => {
    let active = true
    let timeoutId: number | undefined
    let controller: AbortController | undefined

    const poll = async () => {
      controller = new AbortController()

      try {
        const items = await fetchJobs(controller.signal)
        if (!active) {
          return
        }
        setJobs(items)
        setJobsError(null)
        setLastUpdated(new Date())
      } catch (error) {
        if (!active || isAbortError(error)) {
          return
        }
        setJobsError(errorMessage(error))
      } finally {
        if (active) {
          setJobsLoading(false)
          timeoutId = window.setTimeout(() => {
            void poll()
          }, 1500)
        }
      }
    }

    void poll()

    return () => {
      active = false
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
      controller?.abort()
    }
  }, [jobsVersion])

  const inferenceAvailable =
    !statusLoading &&
    !statusError &&
    serviceStatus !== null &&
    serviceStatus.inference.available

  const blockedReason = statusLoading
    ? '正在读取服务状态，暂不能提交。'
    : statusError
      ? '无法确认推理服务状态，暂不能提交。'
      : !serviceStatus
        ? '服务状态未知，暂不能提交。'
        : !serviceStatus.inference.available
          ? serviceStatus.inference.error
            ? '推理服务不可用：' + serviceStatus.inference.error
            : '推理服务当前不可用，暂不能提交。'
          : null

  const isRealMode = serviceStatus?.mode === 'irodori'
  const modeSummary = serviceStatus
    ? serviceStatus.mode === 'irodori'
      ? '本机模型'
      : '测试音'
    : '模式未知'

  let bannerClass = 'mode-banner loading'
  let bannerCode = 'SYNC'
  let bannerTitle = '正在读取服务状态'
  let bannerBody = '确认推理服务与运行模式后即可提交任务。'
  let bannerReason: string | null = null

  if (statusLoading) {
    bannerClass = 'mode-banner loading'
    bannerCode = 'SYNC'
    bannerTitle = '正在读取服务状态'
    bannerBody = '确认推理服务与运行模式后即可提交任务。'
  } else if (statusError) {
    bannerClass = 'mode-banner offline'
    bannerCode = 'OFFLINE'
    bannerTitle = '无法读取服务状态'
    bannerBody = '暂时无法确认推理服务是否可用，任务提交已禁用。'
    bannerReason = statusError
  } else if (serviceStatus) {
    if (!serviceStatus.inference.available) {
      bannerClass = 'mode-banner offline'
      bannerCode = 'OFFLINE'
      bannerTitle = '推理服务不可用'
      bannerBody = '当前不能生成语音，请检查本机推理服务后重试。'
      bannerReason =
        serviceStatus.inference.error ?? '后端未提供具体原因。'
    } else if (serviceStatus.mode === 'irodori') {
      bannerClass = 'mode-banner real'
      bannerCode = 'REAL'
      bannerTitle = '真实语音模式'
      const runtime = serviceStatus.inference.capabilities?.runtime
      bannerBody = runtime?.loading
        ? '使用本机模型；模型正在加载，任务可能稍后开始。'
        : runtime?.busy
          ? '使用本机模型；当前模型忙碌，新任务会排队。'
          : '使用本机模型生成语音，任务会加入队列。'
    } else {
      bannerClass = 'mode-banner fake'
      bannerCode = 'FAKE'
      bannerTitle = '测试音模式'
      bannerBody =
        '当前后端返回测试音，不会调用真实模型；仅用于验证提交、轮询与播放流程。'
    }
  }

  function clearFeedback() {
    if (formError) {
      setFormError(null)
    }
    if (notice) {
      setNotice(null)
    }
  }

  function addReference(asset: Asset) {
    setReferences((current) =>
      current.some((reference) => reference.id === asset.id)
        ? current
        : [...current, asset],
    )
  }

  function moveReference(index: number, direction: -1 | 1) {
    setReferences((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) {
        return current
      }
      const next = [...current]
      const item = next[index]
      next[index] = next[target]
      next[target] = item
      return next
    })
  }

  function removeReference(id: string) {
    setReferences((current) => current.filter((item) => item.id !== id))
  }

  async function handleFilesSelected(fileList: FileList | null) {
    if (uploadLock.current) {
      return
    }

    const files = fileList ? Array.from(fileList) : []
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    if (files.length === 0) {
      return
    }

    uploadLock.current = true
    setIsUploading(true)
    setUploadErrors([])

    const controller = new AbortController()
    uploadController.current = controller
    const issues: UploadIssue[] = []
    let uploadedCount = 0

    for (let index = 0; index < files.length; index += 1) {
      if (controller.signal.aborted) {
        break
      }

      const file = files[index]
      setUploadProgress({
        current: index + 1,
        total: files.length,
        name: file.name,
      })

      const lowerName = file.name.toLowerCase()
      const isWav =
        lowerName.endsWith('.wav') ||
        file.type === 'audio/wav' ||
        file.type === 'audio/x-wav' ||
        file.type === 'audio/wave'

      if (!isWav) {
        issues.push({ fileName: file.name, message: '仅支持 WAV 文件。' })
        setUploadErrors([...issues])
        continue
      }
      if (file.size === 0) {
        issues.push({ fileName: file.name, message: '文件为空。' })
        setUploadErrors([...issues])
        continue
      }
      if (file.size > MAX_ASSET_BYTES) {
        issues.push({
          fileName: file.name,
          message: '文件超过 30 MiB 上限。',
        })
        setUploadErrors([...issues])
        continue
      }

      try {
        const asset = await uploadAsset(file, controller.signal)
        if (controller.signal.aborted) {
          break
        }
        uploadedCount += 1
        setAssetsError(null)
        setAssets((current) => [
          asset,
          ...current.filter((item) => item.id !== asset.id),
        ])
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          break
        }
        issues.push({ fileName: file.name, message: errorMessage(error) })
        setUploadErrors([...issues])
      }
    }

    if (mountedRef.current) {
      setUploadProgress(null)
      setIsUploading(false)
      if (uploadedCount > 0) {
        setNotice('已上传 ' + String(uploadedCount) + ' 个素材。')
      }
    }

    if (uploadController.current === controller) {
      uploadController.current = null
    }
    uploadLock.current = false
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (submitLock.current) {
      return
    }
    if (blockedReason) {
      setFormError(blockedReason)
      setNotice(null)
      return
    }
    if (!text.trim()) {
      setFormError('请输入要生成的文本。')
      setNotice(null)
      return
    }
    if (text.length > MAX_TEXT_LENGTH) {
      setFormError('文本不能超过 ' + String(MAX_TEXT_LENGTH) + ' 字符。')
      setNotice(null)
      return
    }

    const steps = Number(numSteps.trim())
    if (!numSteps.trim() || !Number.isInteger(steps) || steps <= 0 || steps > 100) {
      setFormError('步数必须是 1–100 的整数。')
      setNotice(null)
      return
    }

    let seedValue: string | null = null
    if (seed.trim()) {
      seedValue = seed.trim()
      if (!/^\d{1,19}$/.test(seedValue) || BigInt(seedValue) > 9223372036854775807n) {
        setFormError('seed 必须是 0–9223372036854775807 的整数，或留空使用随机 seed。')
        setNotice(null)
        return
      }
    }

    let maxRefValue: number | null = null
    if (maxRefSeconds.trim()) {
      maxRefValue = Number(maxRefSeconds.trim())
      if (!Number.isFinite(maxRefValue) || maxRefValue <= 0 || maxRefValue > 180) {
        setFormError('参考时长上限必须在 0–180 秒之间（不含 0），或留空使用模型推荐值。')
        setNotice(null)
        return
      }
    }

    if (selectedLoraId) {
      const selected = loras.find((item) => item.id === selectedLoraId)
      if (!selected || !selected.available) {
        setFormError('所选模型当前不可用，请重新选择。')
        setNotice(null)
        return
      }
    }

    submitLock.current = true
    setIsSubmitting(true)
    setFormError(null)
    setNotice(null)

    const controller = new AbortController()
    submitController.current = controller
    const input: CreateJobInput = {
      text,
      lora_id: selectedLoraId || null,
      reference_asset_ids: references.map((reference) => reference.id),
      caption,
      parameters: {
        num_steps: steps,
        seed: seedValue,
        max_ref_seconds: maxRefValue,
      },
    }

    try {
      const job = await createJob(input, controller.signal)
      if (controller.signal.aborted) {
        return
      }
      setNotice(
        MODE_LABELS[job.mode] +
          '任务 ' +
          shortId(job.id) +
          ' 已提交，任务列表正在刷新。',
      )
      setJobsVersion((version) => version + 1)
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        return
      }
      setFormError(errorMessage(error))
    } finally {
      if (submitController.current === controller) {
        submitController.current = null
      }
      submitLock.current = false
      if (!controller.signal.aborted && mountedRef.current) {
        setIsSubmitting(false)
      }
    }
  }

  const submitLabel = isSubmitting
    ? '提交中……'
    : blockedReason
      ? '暂不可提交'
      : isRealMode
        ? '生成语音'
        : '生成测试音'

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />

      <header className="site-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div>
            <p className="eyebrow">IRODORI · P1</p>
            <h1>Irodori 工作台</h1>
          </div>
        </div>
        <div className={'header-note' + (inferenceAvailable ? '' : ' muted')}>
          <span className="header-dot" aria-hidden="true" />
          {statusLoading
            ? '正在读取服务状态'
            : statusError
              ? '服务状态异常'
              : inferenceAvailable
                ? isRealMode
                  ? '本机模型可用'
                  : '测试音模式可用'
                : '推理服务不可用'}
        </div>
      </header>

      <section className={bannerClass} aria-label="运行模式提示">
        <div className="mode-signal" aria-hidden="true">
          <span />
        </div>
        <div className="mode-copy">
          <strong>{bannerTitle}</strong>
          <p>{bannerBody}</p>
          {bannerReason ? <p className="mode-reason">{bannerReason}</p> : null}
        </div>
        <span className="mode-code">{bannerCode}</span>
      </section>

      <main>
        <div className="workspace-grid">
          <form className="panel composer" onSubmit={handleSubmit} noValidate>
            <div className="panel-heading">
              <div>
                <p className="kicker">NEW JOB</p>
                <h2>创建语音任务</h2>
              </div>
              <span className="endpoint-chip">{modeSummary}</span>
            </div>

            <div className="field">
              <div className="field-label-row">
                <label htmlFor="job-text">生成文本</label>
                <span>
                  {text.length} / {MAX_TEXT_LENGTH}
                </span>
              </div>
              <textarea
                id="job-text"
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  clearFeedback()
                }}
                placeholder="输入要交给 Irodori 生成的文本……"
                rows={6}
                maxLength={MAX_TEXT_LENGTH}
                aria-describedby="composer-help"
              />
              <p id="composer-help" className="field-help">
                提交后输入内容会保留。任务状态每 1.5 秒自动刷新。
              </p>
            </div>

            <div className="form-grid">
              <div className="field-block">
                <div className="field-label-row">
                  <label htmlFor="job-lora">模型 / LoRA</label>
                  <span>可选</span>
                </div>
                <select
                  id="job-lora"
                  value={selectedLoraId}
                  onChange={(event) => {
                    setSelectedLoraId(event.target.value)
                    clearFeedback()
                  }}
                >
                  <option value="">基础模型</option>
                  {loras.map((lora) => (
                    <option
                      key={lora.id}
                      value={lora.id}
                      disabled={!lora.available}
                    >
                      {loraLabel(lora)}
                      {lora.available ? '' : '（不可用）'}
                    </option>
                  ))}
                </select>
                {lorasLoading ? (
                  <p className="field-note">正在读取模型列表……</p>
                ) : lorasError ? (
                  <div className="field-error" role="alert">
                    <span>{lorasError}</span>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => setLorasVersion((version) => version + 1)}
                    >
                      重新读取
                    </button>
                  </div>
                ) : (
                  <p className="field-note">
                    仅可选择服务端提供的模型；默认使用基础模型。
                  </p>
                )}
              </div>

              <div className="field-block">
                <div className="field-label-row">
                  <label htmlFor="job-caption">Caption</label>
                  <span>可为空</span>
                </div>
                <textarea
                  id="job-caption"
                  className="caption-input"
                  value={caption}
                  onChange={(event) => {
                    setCaption(event.target.value)
                    clearFeedback()
                  }}
                  placeholder="可选：补充语气、情绪或风格……"
                  rows={2}
                />
              </div>
            </div>

            <div className="parameters-block">
              <div className="section-label-row">
                <h3>生成参数</h3>
                <span>参数会随任务一起保存</span>
              </div>
              <div className="parameter-grid">
                <div className="field-block">
                  <label htmlFor="job-steps">步数</label>
                  <input
                    id="job-steps"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={numSteps}
                    onChange={(event) => {
                      setNumSteps(event.target.value)
                      clearFeedback()
                    }}
                  />
                  <p className="field-note">默认 40，必须为大于 0 的整数。</p>
                </div>
                <div className="field-block">
                  <label htmlFor="job-seed">Seed</label>
                  <input
                    id="job-seed"
                    type="text"
                    inputMode="numeric"
                    maxLength={19}
                    value={seed}
                    onChange={(event) => {
                      setSeed(event.target.value)
                      clearFeedback()
                    }}
                    placeholder="留空随机"
                  />
                  <p className="field-note">留空随机；可粘贴结果中的完整 seed 复现。</p>
                </div>
                <div className="field-block">
                  <label htmlFor="job-max-ref">参考时长上限</label>
                  <input
                    id="job-max-ref"
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    step="any"
                    value={maxRefSeconds}
                    onChange={(event) => {
                      setMaxRefSeconds(event.target.value)
                      clearFeedback()
                    }}
                    placeholder="留空使用模型推荐值"
                  />
                  <p className="field-note">
                    单位秒；可填正数，当前不支持禁用上限。
                  </p>
                </div>
              </div>
            </div>

            <section className="reference-section" aria-labelledby="references-title">
              <div className="section-label-row reference-heading">
                <div>
                  <h3 id="references-title">参考素材</h3>
                  <span>上传 WAV 后可试听并按顺序加入参考</span>
                </div>
                <div className="asset-actions">
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => setAssetsVersion((version) => version + 1)}
                    disabled={assetsLoading}
                  >
                    刷新
                  </button>
                  <label
                    className={
                      'upload-button' + (isUploading ? ' is-disabled' : '')
                    }
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".wav,audio/wav,audio/x-wav,audio/wave"
                      multiple
                      disabled={isUploading}
                      onChange={(event) => {
                        void handleFilesSelected(event.target.files)
                      }}
                    />
                    {isUploading ? '上传中……' : '上传 WAV'}
                  </label>
                </div>
              </div>

              <p className="reference-hint">
                单个 WAV，最大 30 MiB；多选文件会串行上传。
              </p>

              {uploadProgress ? (
                <div className="upload-progress" role="status">
                  <span className="spinner dark" aria-hidden="true" />
                  正在上传 {uploadProgress.current} / {uploadProgress.total}：
                  {uploadProgress.name}
                </div>
              ) : null}

              {uploadErrors.length > 0 ? (
                <div className="upload-errors" role="alert">
                  <strong>素材上传失败</strong>
                  <ul>
                    {uploadErrors.map((issue, index) => (
                      <li key={String(index) + ':' + issue.fileName}>
                        {issue.fileName}：{issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="asset-list-wrap">
                {assetsError ? (
                  <div className="asset-empty asset-error" role="alert">
                    <span>{assetsError}</span>
                    <button
                      className="quiet-button"
                      type="button"
                      onClick={() => setAssetsVersion((version) => version + 1)}
                    >
                      重试
                    </button>
                  </div>
                ) : null}
                {assetsLoading && assets.length === 0 ? (
                  <div className="asset-empty">正在读取素材列表……</div>
                ) : assets.length === 0 ? (
                  assetsError ? null : (
                    <div className="asset-empty">
                      还没有素材，上传 WAV 后可在这里试听和加入参考。
                    </div>
                  )
                ) : (
                  <ul className="asset-list">
                    {assets.map((asset) => {
                      const isReferenced = references.some(
                        (reference) => reference.id === asset.id,
                      )
                      return (
                        <li className="asset-item" key={asset.id}>
                          <div className="asset-main">
                            <strong title={asset.name}>{asset.name}</strong>
                            <span>
                              {formatDuration(asset.duration_seconds)} ·{' '}
                              {numberFormatter.format(asset.sample_rate)} Hz ·{' '}
                              {channelLabel(asset.channels)}
                            </span>
                          </div>
                          <div className="asset-buttons">
                            <button
                              className="quiet-button"
                              type="button"
                              onClick={() => setPreviewAsset(asset)}
                            >
                              试听
                            </button>
                            <button
                              className="quiet-button accent"
                              type="button"
                              onClick={() => addReference(asset)}
                              disabled={isReferenced}
                            >
                              {isReferenced ? '已加入' : '加入参考'}
                            </button>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {previewAsset ? (
                <div className="asset-preview">
                  <div className="audio-label">
                    <span className="audio-bars" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                    试听：{previewAsset.name}
                  </div>
                  <audio
                    key={previewAsset.id}
                    controls
                    autoPlay
                    preload="metadata"
                    src={previewAsset.audio_url}
                  >
                    当前浏览器不支持音频播放。
                  </audio>
                  <button
                    className="quiet-button"
                    type="button"
                    onClick={() => setPreviewAsset(null)}
                  >
                    关闭
                  </button>
                </div>
              ) : null}

              <div className="reference-panel">
                <div className="section-label-row">
                  <h4>当前参考顺序</h4>
                  <span>{references.length} 个</span>
                </div>
                {references.length === 0 ? (
                  <p className="reference-empty">
                    未选择参考。参考为可选项，可直接生成。
                  </p>
                ) : (
                  <ol className="reference-list">
                    {references.map((reference, index) => (
                      <li key={reference.id}>
                        <span className="reference-order">{index + 1}</span>
                        <div className="reference-main">
                          <strong title={reference.name}>{reference.name}</strong>
                          <span>
                            {formatDuration(reference.duration_seconds)} ·{' '}
                            {numberFormatter.format(reference.sample_rate)} Hz
                          </span>
                        </div>
                        <div className="reference-buttons">
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => moveReference(index, -1)}
                            disabled={index === 0}
                            aria-label={'上移参考 ' + reference.name}
                          >
                            上移
                          </button>
                          <button
                            className="quiet-button"
                            type="button"
                            onClick={() => moveReference(index, 1)}
                            disabled={index === references.length - 1}
                            aria-label={'下移参考 ' + reference.name}
                          >
                            下移
                          </button>
                          <button
                            className="quiet-button danger"
                            type="button"
                            onClick={() => removeReference(reference.id)}
                            aria-label={'移除参考 ' + reference.name}
                          >
                            移除
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                <p className="reference-limit-hint">
                  选中参考按顺序传入；达到累计时长上限后，后续参考可能不参与生成。
                </p>
              </div>
            </section>

            <div className="message-stack" aria-live="polite">
              {formError ? (
                <div className="inline-message error" role="alert">
                  <span className="message-icon" aria-hidden="true">
                    !
                  </span>
                  <p>{formError}</p>
                </div>
              ) : null}
              {notice ? (
                <div className="inline-message success" role="status">
                  <span className="message-icon" aria-hidden="true">
                    ✓
                  </span>
                  <p>{notice}</p>
                </div>
              ) : null}
            </div>

            <div className="composer-actions">
              <p className="submit-note">
                {blockedReason ??
                  (isRealMode
                    ? '任务会使用本机模型生成，音频保存在本机。'
                    : '当前为测试音模式，音频保存在本机。')}
              </p>
              <button
                className="primary-button"
                type="submit"
                disabled={isSubmitting || blockedReason !== null}
                aria-busy={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner" aria-hidden="true" />
                    {submitLabel}
                  </>
                ) : (
                  <>
                    {submitLabel}
                    <span className="button-arrow" aria-hidden="true">
                      →
                    </span>
                  </>
                )}
              </button>
            </div>
          </form>

          <aside className="panel status-panel" aria-labelledby="status-title">
            <div className="panel-heading compact">
              <div>
                <p className="kicker">SERVICE</p>
                <h2 id="status-title">服务状态</h2>
              </div>
              <button
                className="quiet-button"
                type="button"
                onClick={() => setStatusVersion((version) => version + 1)}
                disabled={statusLoading}
              >
                刷新
              </button>
            </div>

            {statusLoading ? (
              <div className="status-loading" role="status" aria-live="polite">
                <div className="skeleton skeleton-wide" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
                <div className="skeleton skeleton-line" />
                <span className="visually-hidden">正在读取服务状态……</span>
              </div>
            ) : statusError ? (
              <div className="status-error" role="alert">
                <span className="status-error-icon" aria-hidden="true">
                  !
                </span>
                <h3>无法读取服务状态</h3>
                <p>{statusError}</p>
                <button
                  className="quiet-button"
                  type="button"
                  onClick={() => setStatusVersion((version) => version + 1)}
                >
                  重新读取
                </button>
              </div>
            ) : serviceStatus ? (
              <>
                <div className="service-summary">
                  <div className="service-symbol" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="service-name">
                    <span>当前服务</span>
                    <strong>{serviceStatus.service}</strong>
                  </div>
                  <span
                    className={
                      'online-badge' +
                      (serviceStatus.inference.available ? '' : ' offline')
                    }
                  >
                    <span aria-hidden="true" />
                    {serviceStatus.inference.available ? '可用' : '不可用'}
                  </span>
                </div>

                <dl className="status-list">
                  <div>
                    <dt>接口模式</dt>
                    <dd>
                      <span className="mini-badge">
                        {MODE_LABELS[serviceStatus.mode]}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>数据库</dt>
                    <dd>{databaseLabel(serviceStatus.database)}</dd>
                  </div>
                  <div>
                    <dt>推理服务</dt>
                    <dd>{inferenceLabel(serviceStatus)}</dd>
                  </div>
                  {serviceStatus.inference.capabilities ? (
                    <>
                      <div>
                        <dt>模型</dt>
                        <dd
                          className="model-value"
                          title={serviceStatus.inference.capabilities.model}
                        >
                          {serviceStatus.inference.capabilities.model}
                        </dd>
                      </div>
                      <div>
                        <dt>运行状态</dt>
                        <dd>
                          {runtimeSummary(serviceStatus.inference.capabilities)}
                        </dd>
                      </div>
                      <div>
                        <dt>默认参考上限</dt>
                        <dd>
                          {formatLimit(
                            serviceStatus.inference.capabilities.defaults
                              .max_ref_seconds,
                          )}
                        </dd>
                      </div>
                    </>
                  ) : null}
                  <div>
                    <dt>版本</dt>
                    <dd className="mono-value">{serviceStatus.version}</dd>
                  </div>
                </dl>

                {serviceStatus.inference.error ? (
                  <div className="status-reason" role="alert">
                    <strong>推理服务原因</strong>
                    <p>{serviceStatus.inference.error}</p>
                  </div>
                ) : null}

                <p className="status-footnote">
                  {serviceStatus.inference.available
                    ? '可手动刷新以检查当前服务是否可用。'
                    : '推理服务不可用期间不会提交新任务。'}
                </p>
              </>
            ) : null}
          </aside>
        </div>

        <section className="panel jobs-panel" aria-labelledby="jobs-title">
          <div className="jobs-heading">
            <div>
              <p className="kicker">QUEUE</p>
              <div className="jobs-title-row">
                <h2 id="jobs-title">任务列表</h2>
                <span className="job-count">{jobs.length}</span>
              </div>
              <p className="jobs-subtitle">
                每 1.5 秒自动刷新，有音频的任务可直接试听。
              </p>
            </div>
            <div className="refresh-meta">
              <span>
                {lastUpdated
                  ? '更新于 ' + formatLocalTime(lastUpdated)
                  : '等待首次刷新'}
              </span>
              <button
                className="quiet-button"
                type="button"
                onClick={() => setJobsVersion((version) => version + 1)}
              >
                立即刷新
              </button>
            </div>
          </div>

          {jobsError ? (
            <div className="inline-message error jobs-error" role="alert">
              <span className="message-icon" aria-hidden="true">
                !
              </span>
              <div>
                <strong>任务列表获取失败</strong>
                <p>{jobsError} 系统会自动继续尝试。</p>
              </div>
              <button
                className="message-action"
                type="button"
                onClick={() => setJobsVersion((version) => version + 1)}
              >
                重试
              </button>
            </div>
          ) : null}

          {jobsLoading ? (
            <div className="skeleton-list" aria-hidden="true">
              <div className="job-skeleton">
                <div className="skeleton skeleton-tag" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
              </div>
              <div className="job-skeleton">
                <div className="skeleton skeleton-tag" />
                <div className="skeleton skeleton-line" />
                <div className="skeleton skeleton-line short" />
              </div>
            </div>
          ) : jobs.length === 0 && !jobsError ? (
            <div className="empty-state">
              <div className="empty-wave" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
              <h3>暂无任务</h3>
              <p>在上方填写文本并提交，结果会显示在这里。</p>
            </div>
          ) : (
            <div className="job-list">
              {jobs.map((job) => (
                <JobCard job={job} key={job.id} />
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="site-footer">
        <span>Irodori 工作台 · P1</span>
        <span>
          {serviceStatus
            ? isRealMode
              ? '本机模型推理'
              : '测试音环境'
            : '运行模式未知'}
        </span>
      </footer>
    </div>
  )
}

export default App
