import { useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { Processing, ProcessingMode } from '../batch-api'
import {
  countCharacters,
  countNonemptyLines,
  processingLabel,
} from './model'
import { ScriptEditor } from './ScriptEditor'
import { ReplacementRulesEditor } from './ReplacementRulesEditor'
import { EMOTIONS, emotionAriaLabel, emotionLabelText } from './emoji-data'
import {
  PROCESSING_MODES,
  PROCESSING_MODE_COPY,
  processingModeTitle,
  ruleText,
} from './processing-help'
import './text-usability.css'

const EMOTION_EXPANDED_KEY = 'irodori.batch.emotion-expanded'

function readEmotionExpanded(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(EMOTION_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

interface TextWorkspaceProps {
  rulesScopeKey:string
  savedPersistentRules:string|null
  onSavePersistentRules:(value:string)=>Promise<boolean>
  leftText: string
  rightText: string
  leftDirty: boolean
  rightDirty: boolean
  processing: Processing
  generationCount: number
  activeSegments: number
  conflictCount: number
  follow: boolean
  origin: string
  busy: boolean
  savePaused: boolean
  canGenerate: boolean
  rightRef: RefObject<HTMLTextAreaElement | null>
  voiceControls?: ReactNode
  onSentenceFocus?: (index: number | null) => void
  onLeftChange: (value: string) => void
  onRightChange: (value: string) => void
  onProcessingChange: (value: Processing) => void
  onPasteNewBatch: () => void
  onClearNewBatch: () => void
  onGenerate: () => void
  onGenerateAll: () => void
}

function ProcessingRulesDetails({
  processing,
  mode,
}: {
  processing: Processing
  mode: ProcessingMode
}) {
  const copy = PROCESSING_MODE_COPY[mode]
  return (
    <details className="batch-mode-rule-details">
      <summary>{'查看当前处理规则 · ' + copy.label}</summary>
      <div className="batch-mode-rule-body">
        <p>{copy.summary}</p>
        <ul>
          {copy.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <div className="batch-rule-block">
          <h4>当前实际设置</h4>
          <dl className="batch-rule-values">
            <div>
              <dt>长句拆分阈值</dt>
              <dd>{processing.limit} 字</dd>
            </div>
            <div>
              <dt>短句阈值</dt>
              <dd>{processing.short} 字</dd>
            </div>
            <div>
              <dt>合并连续短句</dt>
              <dd>{processing.merge_short ? '已开启' : '已关闭'}</dd>
            </div>
            <div>
              <dt>同时提取『…』内容</dt>
              <dd>
                {processing.include_double ? '已开启' : '已关闭'}
                （仅文章提取生效）
              </dd>
            </div>
          </dl>
        </div>
        <div className="batch-rule-block">
          <h4>处理顺序与分组、拆分</h4>
          <ol>
            <li>
              关键词替换只作用于文章提取和一行一个音频：先逐条应用长期规则，再逐条应用本次规则；每行按“旧词 -&gt; 新词”做字面替换。
            </li>
            <li>
              短句合并只作用于文章提取和一行一个音频：仅相邻、中间没有其他文字且不跨空行的句子会尝试；任一句短于{' '}
              {processing.short} 字，且合并后不超过 {processing.limit} 字，才合并。
              {mode === 'lines' ? ' 原文空行会阻止短句合并。' : ''}
            </li>
            <li>
              长句拆分只作用于文章提取和一行一个音频：超过 {processing.limit} 字时，在达到{' '}
              {processing.limit} 的三分之一之后选择最后一个句末标点切分；没有合适句末标点时改用逗号或空格；仍切不开时硬切。
            </li>
            <li>原样直通：保留原文换行，不执行上面的替换、合并和拆分。</li>
          </ol>
        </div>
        <div className="batch-rule-block">
          <h4>长期关键词替换</h4>
          <pre>{ruleText(processing.persistent_rules)}</pre>
        </div>
        <div className="batch-rule-block">
          <h4>本次关键词替换</h4>
          <pre>{ruleText(processing.temporary_rules)}</pre>
        </div>
        <p className="batch-rule-note">
          右侧配音正文的手工修改只保存，不会自动应用以上规则。
        </p>
      </div>
    </details>
  )
}

export function TextWorkspace({
  rulesScopeKey,
  savedPersistentRules,
  onSavePersistentRules,
  leftText,
  rightText,
  leftDirty,
  rightDirty,
  processing,
  generationCount,
  activeSegments,
  conflictCount,
  follow,
  origin,
  busy,
  savePaused,
  canGenerate,
  rightRef,
  voiceControls,
  onSentenceFocus,
  onLeftChange,
  onRightChange,
  onProcessingChange,
  onPasteNewBatch,
  onClearNewBatch,
  onGenerate,
  onGenerateAll,
}: TextWorkspaceProps) {
  const [emotionExpanded, setEmotionExpanded] = useState(readEmotionExpanded)
  const lineCount = countNonemptyLines(rightText)
  const external = origin && origin !== 'workbench'
  const characterLimit =
    Number.isFinite(processing.limit) && processing.limit > 0
      ? processing.limit
      : 0

  function patchProcessing(next: Partial<Processing>): void {
    onProcessingChange({ ...processing, ...next })
  }

  function insertEmotion(text: string): void {
    const textarea = rightRef.current
    if (!textarea) {
      onRightChange(rightText + text)
      return
    }
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const next = rightText.slice(0, start) + text + rightText.slice(end)
    onRightChange(next)
    const cursor = start + text.length
    window.requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  function toggleEmotions(): void {
    const next = !emotionExpanded
    setEmotionExpanded(next)
    try {
      window.localStorage.setItem(EMOTION_EXPANDED_KEY, next ? '1' : '0')
    } catch {
      // 隐私模式等情况下无法写入时，仅保留本次展开状态。
    }
  }

  return (
    <section className="batch-text-section" aria-labelledby="batch-text-title">
      <div className="batch-text-heading">
        <div>
          <p className="batch-kicker">文本与校对</p>
          <h2 id="batch-text-title">原文与配音正文</h2>
        </div>
        <div className="batch-text-badges">
          {follow ? <span className="batch-chip follow">跟随外部请求</span> : null}
          {external ? <span className="batch-chip">来源：{origin}</span> : null}
          {conflictCount > 0 ? (
            <span className="batch-chip warn">{conflictCount} 处待确认</span>
          ) : null}
        </div>
      </div>

      <div className="batch-text-grid">
        <section className="batch-text-pane" aria-labelledby="batch-source-label">
          <div className="batch-pane-head">
            <div>
              <label id="batch-source-label" htmlFor="batch-source-text">
                原文
              </label>
              <p>左侧改动停止约 500 毫秒后自动处理并保存。</p>
            </div>
            <span className={"batch-save-state" + (leftDirty ? " dirty" : "")}>
              {savePaused ? '保存暂停' : leftDirty ? '等待自动保存' : '已自动保存'}
            </span>
          </div>

          <div className="batch-text-actions">
            <button
              className="quiet-button accent"
              type="button"
              onClick={onPasteNewBatch}
              disabled={busy || savePaused}
            >
              粘贴为新一批
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={onClearNewBatch}
              disabled={busy || savePaused}
            >
              清空并开始新一批
            </button>
            <span className="batch-small-note">普通 Ctrl+V 只修改当前批次</span>
          </div>

          <textarea
            id="batch-source-text"
            className="batch-main-textarea"
            value={leftText}
            onChange={(event) => onLeftChange(event.target.value)}
            placeholder="粘贴文章或台词。左侧会自动按当前规则提取和替换。"
            spellCheck={false}
          />
          <div className="batch-text-meta">
            <span>{countCharacters(leftText)} 字符</span>
            <span>{processingLabel(processing.mode)}</span>
            <span>
              {processing.mode === 'passthrough' ? '不拆分原文' : '自动更新右侧'}
            </span>
          </div>

          <div className="batch-processing">
            <fieldset className="batch-mode-group">
              <legend>文本处理方式</legend>
              {PROCESSING_MODES.map((mode) => {
                const copy = PROCESSING_MODE_COPY[mode]
                return (
                  <label
                    key={mode}
                    className="batch-radio"
                    title={processingModeTitle(mode)}
                  >
                    <input
                      type="radio"
                      name="batch-processing-mode"
                      value={mode}
                      checked={processing.mode === mode}
                      onChange={() => patchProcessing({ mode })}
                      disabled={busy}
                      title={processingModeTitle(mode)}
                    />
                    <span>{copy.label}</span>
                  </label>
                )
              })}
            </fieldset>

            <div className="batch-mode-rules">
              <ProcessingRulesDetails processing={processing} mode={processing.mode} />
            </div>

            <details className="batch-processing-details">
              <summary>查看／调整处理规则与关键词替换</summary>
              <p className="batch-rule-overview">
                这里调整左侧原文的处理方式。当前：
                {PROCESSING_MODE_COPY[processing.mode].label}，长句阈值{' '}
                {processing.limit} 字，短句阈值 {processing.short} 字，合并短句
                {processing.merge_short ? '已开启' : '已关闭'}。右侧配音正文的手工修改只保存，不会自动应用这些规则。
              </p>
              <div className="batch-processing-grid">
                <label className="batch-field">
                  <span>长句拆分阈值（字）</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={processing.limit}
                    onChange={(event) =>
                      patchProcessing({ limit: Number(event.target.value) })
                    }
                    disabled={busy}
                  />
                </label>
                <label className="batch-field">
                  <span>短句阈值（字）</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={processing.short}
                    onChange={(event) =>
                      patchProcessing({ short: Number(event.target.value) })
                    }
                    disabled={busy}
                  />
                </label>
              </div>
              <div className="batch-check-row">
                <label className="batch-check">
                  <input
                    type="checkbox"
                    checked={processing.merge_short}
                    onChange={(event) =>
                      patchProcessing({ merge_short: event.target.checked })
                    }
                    disabled={busy}
                  />
                  <span>合并连续短句（保留停顿边界）</span>
                </label>
                <label
                  className="batch-check batch-include-double"
                  title="include_double：同时提取『…』内容。这里的『』是非 ASCII 双引号，不是英文半角双引号。仅文章提取模式生效。"
                >
                  <input
                    type="checkbox"
                    checked={processing.include_double}
                    onChange={(event) =>
                      patchProcessing({ include_double: event.target.checked })
                    }
                    disabled={busy}
                  />
                  <span>同时提取『…』内容</span>
                </label>
              </div>
              <ReplacementRulesEditor key={rulesScopeKey}
                persistentRules={processing.persistent_rules}
                temporaryRules={processing.temporary_rules}
                savedPersistentRules={savedPersistentRules}
                disabled={savePaused}
                onApply={(field,value)=>patchProcessing({[field]:value})}
                onSavePersistent={onSavePersistentRules}
              />
              <p className="batch-rule-note">
                处理时先逐条应用长期关键词替换，再逐条应用本次关键词替换，都是字面替换；文章提取和一行一个音频才会执行合并与拆分，原样直通不替换、不合并、不拆分。
              </p>
            </details>
          </div>
        </section>

        <section className="batch-text-pane" aria-labelledby="batch-script-label">
          <div className="batch-pane-head">
            <div>
              <label id="batch-script-label" htmlFor="batch-script-text">
                配音正文
              </label>
              <p>手工修改只保存，不会再次拆分、替换或合并。</p>
            </div>
            <span className={"batch-save-state" + (rightDirty ? " dirty" : "")}>
              {savePaused ? '保存暂停' : rightDirty ? '等待自动保存' : '已自动保存'}
            </span>
          </div>

          {voiceControls ? (
            <div className="batch-voice-controls">{voiceControls}</div>
          ) : null}

          <div className="batch-generate-row">
            <button
              className="primary-button"
              type="button"
              onClick={onGenerate}
              disabled={busy || savePaused || !canGenerate}
            >
              生成未完成／已修改 {generationCount} 句
            </button>
            <button
              className="quiet-button"
              type="button"
              onClick={onGenerateAll}
              disabled={busy || savePaused || !canGenerate}
            >
              全部重新生成
            </button>
          </div>
          <p className="batch-generate-note">
            {activeSegments > 0
              ? '有 ' + String(activeSegments) + ' 句正在生成；提交不会中断当前推理。'
              : '只提交缺失、已修改或失败的句子。点击前会先保存右侧当前正文。'}
          </p>

          <ScriptEditor
            value={rightText}
            textareaRef={rightRef}
            onChange={onRightChange}
            onSentenceFocus={onSentenceFocus}
            limit={characterLimit}
            placeholder="一行一个音频。左侧处理后自动填充，也可以直接手工校对。"
          />
          <p className="script-editor-legend">
            <span>每行左侧显示句序号和字符数，空行不编号；点击可定位。</span>
            <span>不计首尾空白，包含标点；字数不代表音频时长。</span>
            {characterLimit > 0 ? (
              <span className="warn">
                超过 {characterLimit} 字的行会标色提醒，不会自动修改正文。
              </span>
            ) : null}
          </p>
          <div className="batch-text-meta">
            <span>{lineCount} 句</span>
            <span>{countCharacters(rightText)} 字符</span>
            {conflictCount > 0 ? (
              <span className="batch-warn-text">
                冲突未解决时仍按当前校对正文生成
              </span>
            ) : null}
          </div>

          <div className="batch-emotion-panel">
            <button
              className="batch-emotion-toggle"
              type="button"
              aria-expanded={emotionExpanded}
              title={emotionExpanded ? '收起颜文字' : '展开颜文字，按光标位置插入'}
              onClick={toggleEmotions}
            >
              <span>颜文字 · {EMOTIONS.length} 个</span>
              <span className="batch-emotion-toggle-state">
                {emotionExpanded ? '收起' : '展开'}
              </span>
            </button>
            {emotionExpanded ? (
              <div
                id="batch-emotion-list"
                className="batch-emotion-bar"
                aria-label="插入颜文字"
              >
                {EMOTIONS.map((emotion) => (
                  <button
                    key={emotion.emoji}
                    className="quiet-button batch-emotion"
                    type="button"
                    title={emotionLabelText(emotion)}
                    aria-label={emotionAriaLabel(emotion)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertEmotion(emotion.emoji)}
                    disabled={busy}
                  >
                    {emotion.emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      </div>

      {follow ? (
        <p className="batch-follow-note" role="status">
          正在跟随最新外部请求。两个文本框只用于显示，任务仍由调用方自动执行；开始编辑正文会退出跟随。
        </p>
      ) : null}
    </section>
  )
}
