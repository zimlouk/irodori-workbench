import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'
import { countCharacters } from './model'
import './editor-details.css'

interface LineMarker {
  lineIndex: number
  sentence: number
  characters: number
  top: number
}

interface EditorMetrics {
  paddingTop: number
  borderTop: number
  borderRight: number
  borderBottom: number
  borderLeft: number
  lineHeight: number
}

interface ScriptEditorProps {
  value: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onChange: (value: string) => void
  onSentenceFocus?: (index: number | null) => void
  limit: number
  placeholder?: string
}

const INITIAL_METRICS: EditorMetrics = {
  paddingTop: 13,
  borderTop: 1,
  borderRight: 1,
  borderBottom: 1,
  borderLeft: 1,
  lineHeight: 23,
}

const GUTTER_EXTRA_WIDTH = 14

function sentenceIndexAtCursor(text: string, position: number): number | null {
  const clamped = Math.max(0, Math.min(position, text.length))
  const lines = text.split('\n')
  const lineIndex = text.slice(0, clamped).split('\n').length - 1
  if (!(lines[lineIndex] ?? '').trim()) return null

  let sentence = 0
  for (let index = 0; index < lineIndex; index += 1) {
    if ((lines[index] ?? '').trim()) sentence += 1
  }
  return sentence
}

function pixelValue(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function ScriptEditor({
  value,
  textareaRef,
  onChange,
  onSentenceFocus,
  limit,
  placeholder,
}: ScriptEditorProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const gutterMeasureRef = useRef<HTMLSpanElement | null>(null)
  const [markers, setMarkers] = useState<LineMarker[]>([])
  const [metrics, setMetrics] = useState<EditorMetrics>(INITIAL_METRICS)
  const [gutterWidth, setGutterWidth] = useState(66)

  const measure = useCallback(() => {
    const textarea = textareaRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return

    const style = window.getComputedStyle(textarea)
    const paddingLeft = pixelValue(style.paddingLeft)
    const paddingRight = pixelValue(style.paddingRight)
    const paddingTop = pixelValue(style.paddingTop)
    const borderLeft = pixelValue(style.borderLeftWidth)
    const borderRight = pixelValue(style.borderRightWidth)
    const borderTop = pixelValue(style.borderTopWidth)
    const borderBottom = pixelValue(style.borderBottomWidth)
    const rect = textarea.getBoundingClientRect()
    const scrollbarWidth = Math.max(
      0,
      textarea.offsetWidth - textarea.clientWidth - borderLeft - borderRight,
    )
    const contentWidth = Math.max(
      0,
      rect.width -
        borderLeft -
        borderRight -
        scrollbarWidth -
        paddingLeft -
        paddingRight,
    )

    mirror.textContent = value
    mirror.style.width = String(contentWidth) + 'px'
    mirror.style.margin = '0'
    mirror.style.padding = '0'
    mirror.style.border = '0'
    mirror.style.boxSizing = 'content-box'
    mirror.style.overflow = 'visible'
    mirror.style.whiteSpace = 'pre-wrap'
    mirror.style.overflowWrap = 'break-word'
    mirror.style.wordBreak = 'break-word'
    mirror.style.fontFamily = style.fontFamily
    mirror.style.fontSize = style.fontSize
    mirror.style.fontStyle = style.fontStyle
    mirror.style.fontWeight = style.fontWeight
    mirror.style.fontVariant = style.fontVariant
    mirror.style.letterSpacing = style.letterSpacing
    mirror.style.wordSpacing = style.wordSpacing
    mirror.style.lineHeight = style.lineHeight
    mirror.style.textTransform = style.textTransform
    mirror.style.textIndent = style.textIndent
    mirror.style.tabSize = style.tabSize
    mirror.style.direction = style.direction

    const mirrorTop = mirror.getBoundingClientRect().top
    const textNode = mirror.firstChild
    const lines = value.split('\n')
    const next: LineMarker[] = []
    let offset = 0
    let sentence = 0

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()
      if (!trimmed) {
        offset += line.length + 1
        continue
      }

      sentence += 1
      if (textNode && textNode.nodeType === Node.TEXT_NODE) {
        const range = document.createRange()
        range.setStart(textNode, offset)
        range.setEnd(textNode, offset + line.length)
        let lineTop = Number.POSITIVE_INFINITY
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width > 0 || rect.height > 0) {
            lineTop = Math.min(lineTop, rect.top)
          }
        }
        if (Number.isFinite(lineTop)) {
          next.push({
            lineIndex: index,
            sentence,
            characters: countCharacters(trimmed),
            top: lineTop - mirrorTop,
          })
        }
      }
      offset += line.length + 1
    }

    const parsedLineHeight = pixelValue(style.lineHeight)
    setMetrics({
      paddingTop,
      borderTop,
      borderRight,
      borderBottom,
      borderLeft,
      lineHeight: parsedLineHeight > 0 ? parsedLineHeight : INITIAL_METRICS.lineHeight,
    })
    setMarkers(next)

    const widestLabel = next.reduce((widest, marker) => {
      const label =
        String(marker.sentence) + ' · ' + String(marker.characters) + '字'
      return label.length > widest.length ? label : widest
    }, '')
    const measureElement = gutterMeasureRef.current
    if (measureElement) {
      measureElement.textContent = widestLabel
      const measured = measureElement.getBoundingClientRect().width
      const nextGutter = Math.max(
        56,
        Math.ceil(measured) + GUTTER_EXTRA_WIDTH,
      )
      setGutterWidth((current) => (current === nextGutter ? current : nextGutter))
    }
  }, [gutterWidth, textareaRef, value])

  const syncScroll = useCallback(() => {
    const textarea = textareaRef.current
    const track = trackRef.current
    if (!textarea || !track) return
    track.style.transform = 'translateY(' + String(-textarea.scrollTop) + 'px)'
  }, [textareaRef])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useLayoutEffect(() => {
    syncScroll()
  }, [markers, metrics.lineHeight, syncScroll])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    let frame = 0
    const schedule = (): void => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(textarea)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    void document.fonts.ready.then(schedule)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [measure, textareaRef])

  const reportCursor = useCallback(
    (textarea: HTMLTextAreaElement) => {
      onSentenceFocus?.(
        sentenceIndexAtCursor(textarea.value, textarea.selectionStart),
      )
    },
    [onSentenceFocus],
  )

  const locateLine = useCallback(
    (lineIndex: number) => {
      const textarea = textareaRef.current
      if (!textarea) return
      const lines = value.split('\n')
      const line = lines[lineIndex] ?? ''
      let lineStart = 0
      for (let index = 0; index < lineIndex; index += 1) {
        lineStart += lines[index].length + 1
      }
      const leading = line.length - line.trimStart().length
      const trailing = line.length - line.trimEnd().length
      const selectionStart = lineStart + leading
      const selectionEnd = Math.max(
        selectionStart,
        lineStart + line.length - trailing,
      )

      textarea.focus()
      textarea.setSelectionRange(selectionStart, selectionEnd)
      reportCursor(textarea)

      const marker = markers.find((item) => item.lineIndex === lineIndex)
      if (marker) {
        const top = metrics.borderTop + metrics.paddingTop + marker.top
        const bottom = top + metrics.lineHeight
        if (top < textarea.scrollTop) {
          textarea.scrollTop = Math.max(0, top - metrics.lineHeight)
        } else if (bottom > textarea.scrollTop + textarea.clientHeight) {
          textarea.scrollTop =
            bottom - textarea.clientHeight + metrics.lineHeight
        }
      }
      window.requestAnimationFrame(syncScroll)
    },
    [markers, metrics, reportCursor, syncScroll, textareaRef, value],
  )

  return (
    <div
      className="script-editor"
      style={
        {
          '--script-line-height': String(metrics.lineHeight) + 'px',
          '--script-gutter-width': String(gutterWidth) + 'px',
        } as CSSProperties
      }
    >
      <span
        className="script-editor-measure"
        ref={gutterMeasureRef}
        aria-hidden="true"
      />
      <div
        className="script-editor-rail"
        style={{
          top: String(metrics.borderTop) + 'px',
          right: 'auto',
          bottom: String(metrics.borderBottom) + 'px',
          left: String(metrics.borderLeft) + 'px',
        }}
      >
        <div className="script-editor-track" ref={trackRef}>
          {markers.map((marker) => {
            const overLimit = limit > 0 && marker.characters > limit
            const description =
              '第 ' +
              String(marker.sentence) +
              ' 句，' +
              String(marker.characters) +
              ' 字' +
              (overLimit ? '，超过上限 ' + String(limit) + ' 字' : '')
            return (
              <button
                key={marker.lineIndex}
                className={
                  'script-editor-marker' + (overLimit ? ' over-limit' : '')
                }
                type="button"
                style={{
                  top: String(metrics.paddingTop + marker.top) + 'px',
                }}
                title={description + '。点击定位并选择该行。'}
                aria-label={description + '。点击定位并选择该行。'}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => locateLine(marker.lineIndex)}
              >
                {marker.sentence} · {marker.characters}字
              </button>
            )
          })}
        </div>
      </div>
      <div className="script-editor-mirror" ref={mirrorRef} aria-hidden="true" />
      <textarea
        id="batch-script-text"
        ref={textareaRef}
        className="batch-main-textarea script-editor-textarea"
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value
          onChange(next)
          const cursor = event.currentTarget.selectionStart
          onSentenceFocus?.(sentenceIndexAtCursor(next, cursor))
        }}
        onSelect={(event) => reportCursor(event.currentTarget)}
        onClick={(event) => reportCursor(event.currentTarget)}
        onKeyUp={(event) => reportCursor(event.currentTarget)}
        onFocus={(event) => reportCursor(event.currentTarget)}
        onScroll={syncScroll}
        placeholder={placeholder}
        spellCheck={false}
      />
    </div>
  )
}
