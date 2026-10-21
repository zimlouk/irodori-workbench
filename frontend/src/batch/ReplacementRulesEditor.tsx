import { useEffect, useRef, useState } from 'react'

import './replacement-rules.css'

export type ReplacementField = 'persistent_rules' | 'temporary_rules'

type Drafts = Record<ReplacementField, string>

type SaveNotice = {
  kind: 'success' | 'error'
  message: string
}

const FIELDS: readonly ReplacementField[] = [
  'persistent_rules',
  'temporary_rules',
]

export function ReplacementRulesEditor(props: {
  persistentRules: string
  temporaryRules: string
  savedPersistentRules: string | null
  disabled: boolean
  onApply: (field: ReplacementField, value: string) => void
  onSavePersistent: (value: string) => Promise<boolean>
}) {
  const {
    persistentRules,
    temporaryRules,
    savedPersistentRules,
    disabled,
    onApply,
    onSavePersistent,
  } = props

  const [drafts, setDrafts] = useState<Drafts>({
    persistent_rules: persistentRules,
    temporary_rules: temporaryRules,
  })
  const draftsRef = useRef(drafts)
  const [focusedField, setFocusedField] = useState<ReplacementField | null>(null)
  const dirtyRef = useRef<Record<ReplacementField, boolean>>({
    persistent_rules: false,
    temporary_rules: false,
  })
  const submittedRef = useRef<Partial<Record<ReplacementField, string>>>({})
  const loadButtonRef = useRef<HTMLButtonElement | null>(null)
  const previousPropsRef = useRef<Drafts>({
    persistent_rules: persistentRules,
    temporary_rules: temporaryRules,
  })

  const [saving, setSaving] = useState(false)
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null)

  function appliedValue(field: ReplacementField): string {
    return field === 'persistent_rules' ? persistentRules : temporaryRules
  }

  function commitField(field: ReplacementField, value: string): boolean {
    if (disabled) return false
    if (value === appliedValue(field)) return false
    if (submittedRef.current[field] === value) return false

    submittedRef.current[field] = value
    onApply(field, value)
    return true
  }

  useEffect(() => {
    const nextProps: Drafts = {
      persistent_rules: persistentRules,
      temporary_rules: temporaryRules,
    }
    const previousProps = previousPropsRef.current
    previousPropsRef.current = nextProps

    const current = draftsRef.current
    let next: Drafts | null = null

    for (const field of FIELDS) {
      if (dirtyRef.current[field]) continue

      const incoming = nextProps[field]
      const submitted = submittedRef.current[field]
      let shouldSync = submitted === undefined

      if (submitted !== undefined) {
        const confirmed = incoming === submitted
        const changedElsewhere = incoming !== previousProps[field]
        if (confirmed || changedElsewhere) {
          delete submittedRef.current[field]
          shouldSync = true
        }
      }

      if (shouldSync && current[field] !== incoming) {
        next ??= { ...current }
        next[field] = incoming
      }
    }

    if (next) {
      draftsRef.current = next
      setDrafts(next)
    }
  }, [persistentRules, temporaryRules, focusedField])

  function handleFocus(field: ReplacementField): void {
    setFocusedField(field)
  }

  function handleChange(field: ReplacementField, value: string): void {
    dirtyRef.current[field] = true
    const next: Drafts = { ...draftsRef.current, [field]: value }
    draftsRef.current = next
    setDrafts(next)

    if (field === 'persistent_rules') {
      setSaveNotice((current) =>
        current?.kind === 'success' ? null : current,
      )
    }
  }

  function handleBlur(
    field: ReplacementField,
    relatedTarget: EventTarget | null,
  ): void {
    setFocusedField((current) => (current === field ? null : current))

    if (disabled || !dirtyRef.current[field]) return

    // 载入按钮会直接用已保存规则覆盖草稿，本次失焦不需要先提交旧草稿。
    if (
      field === 'persistent_rules' &&
      relatedTarget === loadButtonRef.current
    ) {
      return
    }

    const value = draftsRef.current[field]
    dirtyRef.current[field] = false
    commitField(field, value)
  }

  async function handleSavePersistent(): Promise<void> {
    if (disabled || saving) return

    const value = draftsRef.current.persistent_rules
    setSaving(true)
    setSaveNotice(null)

    try {
      commitField('persistent_rules', value)
      const saved = await onSavePersistent(value)
      if (saved) {
        setSaveNotice({ kind: 'success', message: '长期规则已保存。' })
      } else {
        setSaveNotice({
          kind: 'error',
          message: '保存长期规则失败，草稿已保留，请稍后重试。',
        })
      }
    } catch (error) {
      const detail =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : ''
      setSaveNotice({
        kind: 'error',
        message: detail
          ? '保存长期规则失败：' + detail
          : '保存长期规则失败，草稿已保留，请稍后重试。',
      })
    } finally {
      setSaving(false)
    }
  }

  function handleLoadSaved(): void {
    if (disabled || saving || savedPersistentRules === null) return

    const value = savedPersistentRules
    const next: Drafts = {
      ...draftsRef.current,
      persistent_rules: value,
    }
    draftsRef.current = next
    setDrafts(next)
    dirtyRef.current.persistent_rules = false

    if (value === appliedValue('persistent_rules')) {
      delete submittedRef.current.persistent_rules
    } else if (submittedRef.current.persistent_rules !== value) {
      submittedRef.current.persistent_rules = value
      onApply('persistent_rules', value)
    }

    setSaveNotice(null)
  }

  const savedMatch =
    savedPersistentRules !== null &&
    drafts.persistent_rules === savedPersistentRules

  return (
    <section className="replacement-rules-editor" aria-label="关键词替换规则">
      <div className="replacement-rules-fields">
        <label className="batch-field">
          <span>长期关键词替换</span>
          <textarea
            rows={4}
            value={drafts.persistent_rules}
            onChange={(event) =>
              handleChange('persistent_rules', event.target.value)
            }
            onFocus={() => handleFocus('persistent_rules')}
            onBlur={(event) =>
              handleBlur('persistent_rules', event.relatedTarget)
            }
            placeholder="每行一条：旧词 -> 新词"
            spellCheck={false}
            disabled={disabled}
            aria-describedby="replacement-rules-hint"
          />
        </label>

        <label className="batch-field">
          <span>本次关键词替换</span>
          <textarea
            rows={4}
            value={drafts.temporary_rules}
            onChange={(event) =>
              handleChange('temporary_rules', event.target.value)
            }
            onFocus={() => handleFocus('temporary_rules')}
            onBlur={(event) =>
              handleBlur('temporary_rules', event.relatedTarget)
            }
            placeholder="每行一条：旧词 -> 新词"
            spellCheck={false}
            disabled={disabled}
            aria-describedby="replacement-rules-hint"
          />
        </label>
      </div>

      <div className="replacement-rules-actions">
        <button
          className="quiet-button accent"
          type="button"
          onClick={() => void handleSavePersistent()}
          disabled={disabled || saving}
        >
          保存长期规则
        </button>
        <button
          ref={loadButtonRef}
          className="quiet-button"
          type="button"
          onClick={handleLoadSaved}
          disabled={disabled || saving || savedPersistentRules === null}
        >
          载入已保存规则
        </button>
        <span
          className={
            'replacement-rules-state' + (savedMatch ? ' saved' : '')
          }
          role="status"
        >
          {savedMatch ? '与已保存规则一致' : '尚未保存到长期规则'}
        </span>
      </div>

      <p id="replacement-rules-hint" className="batch-hint">
        输入期间不重处理正文；离开输入框后应用到当前批次。
      </p>
      <p className="batch-hint">
        保存的长期规则可跨批次载入；新一批仍沿用当前已应用设置。
      </p>
      <p className="batch-hint">
        保存只包含长期关键词替换，本次关键词替换不会写入长期规则。
      </p>

      {saving ? (
        <p className="replacement-rules-notice saving" role="status">
          正在保存长期规则…
        </p>
      ) : saveNotice ? (
        <p
          className={'replacement-rules-notice ' + saveNotice.kind}
          role={saveNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {saveNotice.message}
        </p>
      ) : null}
    </section>
  )
}
