import type { ProcessingMode } from '../batch-api'

interface ProcessingModeCopy {
  label: string
  summary: string
  title: string
  points: string[]
}

export const PROCESSING_MODE_COPY: Record<ProcessingMode, ProcessingModeCopy> = {
  article: {
    label: '文章提取',
    summary:
      '从原文中提取最外层「」里的台词，再把提取结果交给下面的替换、合并和拆分规则。',
    title:
      '文章提取：提取最外层「…」台词，可选同时提取独立的『…』台词；随后执行关键词替换、短句合并和长句拆分。',
    points: [
      '只提取最外层「」中的台词，引号外的叙述不会进入配音正文。',
      '开启“同时提取『…』内容”后，也会提取独立的『』台词；不包含英文半角双引号里的内容。',
      '提取出的台词继续按关键词替换、短句合并和长句拆分规则处理。',
    ],
  },
  lines: {
    label: '一行一个音频',
    summary:
      '读取原文中的全部非空行，先替换，再按阈值合并短句、拆分长句；空行会被跳过并阻断短句合并。',
    title:
      '一行一个音频：读取全部非空行，先按长期和本次规则逐条替换，再按短句阈值合并、按长句阈值拆分。空行会被跳过，并阻止相邻短句跨空行合并。',
    points: [
      '读取全部非空行；空行不生成句子，但会阻断它两侧的短句合并。',
      '每个非空行先经过关键词替换，再参与短句合并和长句拆分。',
    ],
  },
  passthrough: {
    label: '原样直通',
    summary: '保留原文的换行和内容，不替换、不合并、不拆分。',
    title:
      '原样直通：保留原文换行和全部内容，不做关键词替换、短句合并或长句拆分。',
    points: [
      '右侧按原文保留换行，不执行关键词替换。',
      '不合并短句，也不拆分长句。',
    ],
  },
}

export const PROCESSING_MODES: ProcessingMode[] = [
  'article',
  'lines',
  'passthrough',
]

export function processingModeTitle(mode: ProcessingMode): string {
  return PROCESSING_MODE_COPY[mode].title
}

export function ruleText(value: string): string {
  return value.trim() ? value : '未设置（不做替换）'
}
