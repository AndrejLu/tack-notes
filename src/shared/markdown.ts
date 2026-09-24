/**
 * Stable Markdown serialization for Tack Notes.
 * Front matter uses YAML; body uses a constrained Markdown subset.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  SCHEMA_VERSION,
  type NoteColor,
  type NoteDocument,
  type NoteFrontMatter,
  createEmptyFrontMatter,
  isNoteColor,
  DEFAULT_NOTE_COLOR
} from './note-model'

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Patterns that cannot safely round-trip through the rich editor. */
const UNSUPPORTED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /<script[\s>]/i, reason: 'Embedded scripts are not supported.' },
  { re: /<iframe[\s>]/i, reason: 'Embedded iframes are not supported.' },
  { re: /<!DOCTYPE/i, reason: 'Full HTML documents are not supported.' },
  { re: /<img[\s>]/i, reason: 'Images are not supported in this version.' },
  { re: /!\[[^\]]*\]\([^)]+\)/, reason: 'Image markdown is not supported in this version.' },
  { re: /\[([^\]]+)\]\(([^)]+)\)/, reason: 'Links are preserved as plain text only; use source mode for full link markup.' },
  { re: /```/, reason: 'Fenced code blocks are not supported in the rich editor.' },
  { re: /^[ \t]{0,3}\|/m, reason: 'Tables are not supported in the rich editor.' },
  {
    re: /<(?!\/?(?:u|br|strong|em|del|s|b|i)\b)[a-zA-Z]/,
    reason: 'Unsupported HTML elements found; open in source mode to edit safely.'
  }
]

export function generateNoteId(): string {
  // UUID v4 without depending on crypto in all test environments
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function noteFileName(id: string): string {
  return `${id}.md`
}

export function trashFileName(id: string): string {
  return `${id}.md`
}

function normalizeBody(body: string): string {
  // Stable line endings (LF) and single trailing newline
  let text = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  text = text.replace(/[ \t]+$/gm, '')
  if (text.length === 0) return ''
  if (!text.endsWith('\n')) text += '\n'
  return text
}

function detectUnsupported(body: string): { unsupported: boolean; reason?: string } {
  for (const { re, reason } of UNSUPPORTED_PATTERNS) {
    // Links: we allow them to pass into "unsupported" only if we want source mode.
    // Spec says: if cannot round-trip safely, preserve original and offer source/read-only.
    // Links don't round-trip cleanly through our subset editor, so flag them.
    if (re.test(body)) {
      return { unsupported: true, reason }
    }
  }
  return { unsupported: false }
}

function coerceFrontMatter(raw: Record<string, unknown>, fallbackId: string): NoteFrontMatter {
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : fallbackId
  const color: NoteColor = isNoteColor(raw.color) ? raw.color : DEFAULT_NOTE_COLOR
  const created =
    typeof raw.created_at === 'string' && raw.created_at.length > 0
      ? raw.created_at
      : new Date().toISOString()
  const updated =
    typeof raw.updated_at === 'string' && raw.updated_at.length > 0 ? raw.updated_at : created

  const schema =
    typeof raw.schema_version === 'number' ? raw.schema_version : SCHEMA_VERSION

  const fm: NoteFrontMatter = {
    ...raw,
    schema_version: schema,
    id,
    color,
    created_at: created,
    updated_at: updated
  }
  return fm
}

/** Ordered keys for stable YAML output to reduce sync churn. */
const KNOWN_KEY_ORDER = ['schema_version', 'id', 'color', 'created_at', 'updated_at'] as const

function frontMatterToYaml(fm: NoteFrontMatter): string {
  const ordered: Record<string, unknown> = {}
  for (const key of KNOWN_KEY_ORDER) {
    if (key in fm) ordered[key] = fm[key]
  }
  const extraKeys = Object.keys(fm)
    .filter((k) => !(KNOWN_KEY_ORDER as readonly string[]).includes(k))
    .sort()
  for (const key of extraKeys) {
    ordered[key] = fm[key]
  }
  return stringifyYaml(ordered, {
    lineWidth: 0,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN'
  }).trimEnd()
}

export function parseNoteMarkdown(raw: string, fallbackId?: string): NoteDocument {
  const id = fallbackId ?? generateNoteId()
  const match = FRONT_MATTER_RE.exec(raw)

  if (!match) {
    const bodyMarkdown = normalizeBody(raw)
    const { unsupported, reason } = detectUnsupported(bodyMarkdown)
    return {
      frontMatter: createEmptyFrontMatter(id),
      bodyMarkdown,
      unsupportedMarkup: unsupported,
      unsupportedReason: reason
    }
  }

  let parsed: Record<string, unknown> = {}
  try {
    const yamlResult = parseYaml(match[1])
    if (yamlResult && typeof yamlResult === 'object' && !Array.isArray(yamlResult)) {
      parsed = yamlResult as Record<string, unknown>
    }
  } catch {
    // Invalid YAML — treat entire file as body with fresh metadata
    const bodyMarkdown = normalizeBody(raw)
    return {
      frontMatter: createEmptyFrontMatter(id),
      bodyMarkdown,
      unsupportedMarkup: true,
      unsupportedReason: 'Invalid YAML front matter; metadata was reset. Body preserved as source.'
    }
  }

  const bodyMarkdown = normalizeBody(match[2] ?? '')
  const { unsupported, reason } = detectUnsupported(bodyMarkdown)

  return {
    frontMatter: coerceFrontMatter(parsed, id),
    bodyMarkdown,
    unsupportedMarkup: unsupported,
    unsupportedReason: reason
  }
}

export function serializeNoteMarkdown(doc: NoteDocument): string {
  const yaml = frontMatterToYaml(doc.frontMatter)
  const body = normalizeBody(doc.bodyMarkdown)
  if (body.length === 0) {
    return `---\n${yaml}\n---\n`
  }
  return `---\n${yaml}\n---\n${body}`
}

export function hashContent(content: string): string {
  // FNV-1a 32-bit — fast, stable, no crypto dependency needed for change detection
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Convert a constrained HTML fragment (from TipTap) into Markdown.
 * Only the supported subset is emitted.
 */
export function htmlToMarkdown(html: string): string {
  if (!html || html === '<p></p>' || html === '<p><br></p>' || /^<p><br\b[^>]*><\/p>$/i.test(html)) {
    return ''
  }

  const blocks: string[] = []
  // Split top-level blocks loosely
  const wrapped = `<div>${html}</div>`

  // Use regex-based conversion to avoid DOM dependency in Node/tests
  let remaining = wrapped
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  // Keep existing whitespace between block tags (blank lines in CF_HTML)
  remaining = remaining.replace(
    /<\/(p|div|h[1-6]|tr|li)>(\s*)<(p|div|h[1-6]|tr|li)(\s[^>]*)?>/gi,
    (_m, close: string, ws: string, open: string, attrs: string) =>
      `</${close}>${ws.length > 0 ? ws : '\n'}<${open}${attrs ?? ''}>`
  )
  remaining = remaining.replace(/<\/?div\b[^>]*>/gi, '\n').replace(/<\/?span\b[^>]*>/gi, '')

  // Normalize void tags (including <br class="ProseMirror-trailingBreak">)
  remaining = remaining.replace(/<br\b[^>]*>/gi, '\n')

  const blockRe =
    /<(p|h[1-6]|ul|ol|pre|blockquote)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi
  let match: RegExpExecArray | null
  let lastIndex = 0
  const parts: Array<{ type: string; inner: string }> = []

  while ((match = blockRe.exec(remaining)) !== null) {
    if (match.index > lastIndex) {
      pushGapParts(parts, remaining.slice(lastIndex, match.index))
    }
    parts.push({ type: match[1].toLowerCase(), inner: match[3] })
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < remaining.length) {
    pushGapParts(parts, remaining.slice(lastIndex))
  }

  if (parts.length === 0 && remaining.replace(/\s/g, '').length > 0) {
    parts.push({ type: 'p', inner: remaining })
  }

  for (const part of parts) {
    if (part.type === 'ul') {
      blocks.push(listHtmlToMarkdown(part.inner))
    } else if (part.type === 'ol') {
      blocks.push(orderedListHtmlToMarkdown(part.inner))
    } else {
      const line = inlineHtmlToMarkdown(part.inner)
      // Empty editor paragraph (<p></p> or <p><br></p>) → one blank line
      if (line.trim() === '') {
        blocks.push('')
        continue
      }
      for (const segment of line.split('\n')) {
        blocks.push(segment.trim() === '' ? '' : segment.trimEnd())
      }
    }
  }

  // Drop leading/trailing empties from wrapper noise; keep internal blanks
  while (blocks.length > 0 && blocks[0] === '') blocks.shift()
  while (blocks.length > 0 && blocks[blocks.length - 1] === '') blocks.pop()

  return normalizeBody(blocks.join('\n'))
}

/** Preserve blank lines found between HTML blocks (e.g. </p>\\n\\n<p>). */
function pushGapParts(parts: Array<{ type: string; inner: string }>, gap: string): void {
  if (!gap) return
  const withoutTags = gap.replace(/<[^>]+>/g, '')
  if (withoutTags.trim()) {
    for (const segment of withoutTags.split('\n')) {
      parts.push({ type: 'p', inner: segment })
    }
    return
  }
  // Whitespace-only gap: one newline is structural; each extra is a blank line
  const newlineCount = (withoutTags.match(/\n/g) || []).length
  const blanks = Math.max(0, newlineCount - 1)
  for (let i = 0; i < blanks; i++) {
    parts.push({ type: 'p', inner: '' })
  }
}

function listHtmlToMarkdown(inner: string): string {
  const items: string[] = []
  const liRe = /<li(\s[^>]*)?>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = liRe.exec(inner)) !== null) {
    const attrs = m[1] ?? ''
    const content = m[2]
    const dataChecked = /data-checked=["']true["']/i.test(attrs)
    const hasCheckbox = /data-type=["']taskItem["']/i.test(attrs) || /task-item/i.test(attrs)
    // TipTap task items wrap in <label><input> or use data-checked
    const inputChecked = /<input[^>]*checked[^>]*>/i.test(content)
    const isTask =
      hasCheckbox ||
      dataChecked ||
      inputChecked ||
      /data-checked=/i.test(attrs) ||
      /class=["'][^"']*task-item/i.test(attrs)

    let text = content
      .replace(/<label[\s\S]*?<\/label>/gi, '')
      .replace(/<input[^>]*>/gi, '')
      .replace(/<p>([\s\S]*?)<\/p>/gi, '$1')
      .replace(/<ul[\s\S]*?<\/ul>/gi, '') // nested handled simply by stripping for v1
    text = inlineHtmlToMarkdown(text).trim()

    if (isTask || /data-checked/i.test(attrs)) {
      const checked = dataChecked || inputChecked || /data-checked=["']true["']/i.test(attrs)
      items.push(`- [${checked ? 'x' : ' '}] ${text}`)
    } else {
      items.push(`- ${text}`)
    }
  }
  return items.join('\n')
}

function orderedListHtmlToMarkdown(inner: string): string {
  const items: string[] = []
  const liRe = /<li(\s[^>]*)?>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  let i = 1
  while ((m = liRe.exec(inner)) !== null) {
    let text = m[2].replace(/<p>([\s\S]*?)<\/p>/gi, '$1')
    text = inlineHtmlToMarkdown(text).trim()
    items.push(`${i}. ${text}`)
    i++
  }
  return items.join('\n')
}

function inlineHtmlToMarkdown(html: string): string {
  let s = html
  // TipTap task list uses <ul data-type="taskList"> — handled at list level

  // Order matters: handle nested marks
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `**${inlineHtmlToMarkdown(inner)}**`)
  s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `*${inlineHtmlToMarkdown(inner)}*`)
  s = s.replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, (_, _t, inner) => `~~${inlineHtmlToMarkdown(inner)}~~`)
  // Placeholder so a later tag-strip pass does not remove underline markers
  s = s.replace(/<u>([\s\S]*?)<\/u>/gi, (_, inner) => `{{U}}${inlineHtmlToMarkdown(inner)}{{/U}}`)
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, (_, inner) => `\`${inner}\``)
  s = s.replace(/<br\b[^>]*>/gi, '\n')
  s = s.replace(/<\/?p>/gi, '')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/\{\{U\}\}/g, '<u>').replace(/\{\{\/U\}\}/g, '</u>')
  return decodeEntities(s)
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * Convert supported Markdown body to HTML suitable for TipTap setContent.
 */
export function markdownToHtml(md: string): string {
  const text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!text.trim()) return '<p><br></p>'

  const lines = text.replace(/\n$/, '').split('\n')
  const htmlParts: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Task / bullet list
    if (/^\s*[-*+]\s+\[([ xX])\]\s+/.test(line) || /^\s*[-*+]\s+/.test(line)) {
      const isTaskList = /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i]
        const taskMatch = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(l)
        const bulletMatch = /^\s*[-*+]\s+(.*)$/.exec(l)
        if (isTaskList && taskMatch) {
          const checked = taskMatch[1].toLowerCase() === 'x'
          items.push(
            `<li data-type="taskItem" data-checked="${checked}"><p>${inlineMarkdownToHtml(taskMatch[2])}</p></li>`
          )
          i++
        } else if (!isTaskList && bulletMatch && !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(l)) {
          items.push(`<li><p>${inlineMarkdownToHtml(bulletMatch[1])}</p></li>`)
          i++
        } else if (!isTaskList && taskMatch) {
          // switched to task mid-stream — break
          break
        } else if (isTaskList && bulletMatch && !taskMatch) {
          break
        } else {
          break
        }
      }
      if (isTaskList) {
        htmlParts.push(`<ul data-type="taskList">${items.join('')}</ul>`)
      } else {
        htmlParts.push(`<ul>${items.join('')}</ul>`)
      }
      continue
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = /^\s*\d+\.\s+(.*)$/.exec(lines[i])
        if (!m) break
        items.push(`<li><p>${inlineMarkdownToHtml(m[1])}</p></li>`)
        i++
      }
      htmlParts.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Blank line → TipTap-compatible empty paragraph (<p></p> is stripped on paste/setContent)
    if (line.trim() === '') {
      htmlParts.push('<p><br></p>')
      i++
      continue
    }

    // One Markdown line → one editor paragraph
    htmlParts.push(`<p>${inlineMarkdownToHtml(line)}</p>`)
    i++
  }

  return htmlParts.join('') || '<p><br></p>'
}

function inlineMarkdownToHtml(text: string): string {
  let s = escapeHtml(text)
  // Underline tags already in source — allow through after escape, so restore
  s = s.replace(/&lt;u&gt;/gi, '<u>').replace(/&lt;\/u&gt;/gi, '</u>')

  // Bold ** ** or __ __
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  // Italic * * or _ _
  s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_])_([^_]+)_(?!_)/g, '$1<em>$2</em>')
  // Strikethrough
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  // Newlines in paragraph
  s = s.replace(/\n/g, '<br>')
  return s
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function mergeFrontMatter(
  base: NoteFrontMatter,
  local: NoteFrontMatter,
  disk: NoteFrontMatter
): { merged: NoteFrontMatter; conflicts: string[] } {
  const conflicts: string[] = []
  const merged: NoteFrontMatter = { ...base }

  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(disk)])
  for (const key of keys) {
    if (key === 'id' || key === 'schema_version' || key === 'created_at') {
      merged[key] = base[key] ?? local[key] ?? disk[key]
      continue
    }
    if (key === 'updated_at') {
      // Take the chronologically later timestamp after merge decisions
      continue
    }

    const b = base[key]
    const l = local[key]
    const d = disk[key]
    const localChanged = !deepEqual(l, b)
    const diskChanged = !deepEqual(d, b)

    if (localChanged && diskChanged && !deepEqual(l, d)) {
      conflicts.push(key)
      // Prefer local for ambiguous; caller may surface conflict
      merged[key] = l
    } else if (diskChanged) {
      merged[key] = d
    } else if (localChanged) {
      merged[key] = l
    } else {
      merged[key] = b
    }
  }

  const localTime = Date.parse(String(local.updated_at ?? '')) || 0
  const diskTime = Date.parse(String(disk.updated_at ?? '')) || 0
  merged.updated_at = new Date(Math.max(localTime, diskTime, Date.now())).toISOString()

  return { merged, conflicts }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Line-based three-way merge for Markdown bodies.
 * Returns null when overlapping changes cannot be auto-merged.
 */
export function mergeBodies(
  base: string,
  local: string,
  disk: string
): { merged: string; clean: boolean } {
  const b = normalizeBody(base)
  const l = normalizeBody(local)
  const d = normalizeBody(disk)

  if (l === d) return { merged: l, clean: true }
  if (l === b) return { merged: d, clean: true }
  if (d === b) return { merged: l, clean: true }

  const baseLines = b.split('\n')
  const localLines = l.split('\n')
  const diskLines = d.split('\n')

  // Simple LCS-free approach: if line counts match and changes don't overlap, merge
  if (baseLines.length === localLines.length && baseLines.length === diskLines.length) {
    const out: string[] = []
    for (let i = 0; i < baseLines.length; i++) {
      const bv = baseLines[i]
      const lv = localLines[i]
      const dv = diskLines[i]
      if (lv === dv) {
        out.push(lv)
      } else if (lv === bv) {
        out.push(dv)
      } else if (dv === bv) {
        out.push(lv)
      } else {
        return { merged: l, clean: false }
      }
    }
    return { merged: normalizeBody(out.join('\n')), clean: true }
  }

  // Nonoverlapping prefix/suffix heuristic
  let prefixLen = 0
  while (
    prefixLen < baseLines.length &&
    prefixLen < localLines.length &&
    prefixLen < diskLines.length &&
    baseLines[prefixLen] === localLines[prefixLen] &&
    baseLines[prefixLen] === diskLines[prefixLen]
  ) {
    prefixLen++
  }

  let baseSuffix = baseLines.length
  let localSuffix = localLines.length
  let diskSuffix = diskLines.length
  while (
    baseSuffix > prefixLen &&
    localSuffix > prefixLen &&
    diskSuffix > prefixLen &&
    baseLines[baseSuffix - 1] === localLines[localSuffix - 1] &&
    baseLines[baseSuffix - 1] === diskLines[diskSuffix - 1]
  ) {
    baseSuffix--
    localSuffix--
    diskSuffix--
  }

  const baseMid = baseLines.slice(prefixLen, baseSuffix).join('\n')
  const localMid = localLines.slice(prefixLen, localSuffix).join('\n')
  const diskMid = diskLines.slice(prefixLen, diskSuffix).join('\n')

  if (localMid === baseMid) {
    const merged = [
      ...localLines.slice(0, prefixLen),
      ...diskLines.slice(prefixLen, diskSuffix),
      ...localLines.slice(localSuffix)
    ].join('\n')
    return { merged: normalizeBody(merged), clean: true }
  }
  if (diskMid === baseMid) {
    const merged = [
      ...diskLines.slice(0, prefixLen),
      ...localLines.slice(prefixLen, localSuffix),
      ...diskLines.slice(diskSuffix)
    ].join('\n')
    return { merged: normalizeBody(merged), clean: true }
  }

  return { merged: l, clean: false }
}
