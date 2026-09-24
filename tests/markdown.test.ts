import { describe, expect, it } from 'vitest'
import {
  generateNoteId,
  hashContent,
  htmlToMarkdown,
  markdownToHtml,
  mergeBodies,
  mergeFrontMatter,
  parseNoteMarkdown,
  serializeNoteMarkdown
} from '../src/shared/markdown'
import { createEmptyFrontMatter, deriveTitle, DEFAULT_NOTE_COLOR } from '../src/shared/note-model'

describe('Markdown round-trip', () => {
  it('serializes and parses front matter with body', () => {
    const id = generateNoteId()
    const doc = {
      frontMatter: createEmptyFrontMatter(id, 'green'),
      bodyMarkdown: 'Hello **world**\n',
      unsupportedMarkup: false
    }
    const raw = serializeNoteMarkdown(doc)
    const parsed = parseNoteMarkdown(raw, id)
    expect(parsed.frontMatter.id).toBe(id)
    expect(parsed.frontMatter.color).toBe('green')
    expect(parsed.bodyMarkdown).toBe('Hello **world**\n')
    expect(parsed.unsupportedMarkup).toBe(false)
  })

  it('round-trips bold, italic, underline, strikethrough', () => {
    const md = '**bold** *italic* <u>under</u> ~~strike~~\n'
    const html = markdownToHtml(md)
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<u>under</u>')
    expect(html).toContain('<s>strike</s>')
    const back = htmlToMarkdown(html)
    expect(back).toContain('**bold**')
    expect(back).toContain('*italic*')
    expect(back).toContain('<u>under</u>')
    expect(back).toContain('~~strike~~')
  })

  it('round-trips bullet lists', () => {
    const md = '- one\n- two\n- three\n'
    const html = markdownToHtml(md)
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>')
    const back = htmlToMarkdown(html)
    expect(back.trim()).toBe(md.trim())
  })

  it('round-trips checklists', () => {
    const md = '- [ ] todo\n- [x] done\n'
    const html = markdownToHtml(md)
    expect(html).toContain('data-type="taskList"')
    expect(html).toContain('data-checked="false"')
    expect(html).toContain('data-checked="true"')
    const back = htmlToMarkdown(html)
    expect(back).toContain('- [ ] todo')
    expect(back).toContain('- [x] done')
  })

  it('round-trips empty newlines between paragraphs', () => {
    const md = 'line one\n\nline two\n\n\nline three\n'
    const html = markdownToHtml(md)
    expect(html).toBe('<p>line one</p><p></p><p>line two</p><p></p><p></p><p>line three</p>')
    const back = htmlToMarkdown(html)
    expect(back).toBe(md)
  })

  it('round-trips empty paragraphs from TipTap HTML', () => {
    const html = '<p>hello</p><p><br class="ProseMirror-trailingBreak"></p><p>world</p>'
    const md = htmlToMarkdown(html)
    expect(md).toBe('hello\n\nworld\n')
    expect(markdownToHtml(md)).toBe('<p>hello</p><p></p><p>world</p>')
  })

  it('preserves blank lines from br-separated clipboard HTML', () => {
    const html =
      'PRO one<br>PRO two<br><br>NXD one<br><br><br>ANO one'
    const md = htmlToMarkdown(html)
    expect(md).toBe('PRO one\nPRO two\n\nNXD one\n\n\nANO one\n')
  })

  it('preserves blank lines between paragraphs when CF_HTML omits empty p tags', () => {
    const html = '<p>PRO one</p>\n\n<p>NXD one</p>'
    const md = htmlToMarkdown(html)
    expect(md).toBe('PRO one\n\nNXD one\n')
  })

  it('round-trips plain multiline paste with blank lines', () => {
    const plain =
      'PRO 21.07.2026 0,5h wp urgent update\n' +
      'PRO 24.08.2026 0,5h storage\n' +
      '\n' +
      'NXD 21.07.2026 0,5h posodobitev urgent\n' +
      '\n' +
      'ANO 0,5h napajalnik za displej\n'
    const html = markdownToHtml(plain)
    expect(html).toContain('<p></p>')
    expect(htmlToMarkdown(html)).toBe(plain)
  })

  it('preserves Unicode', () => {
    const md = '日本語 🎉 café ñ\n'
    const doc = {
      frontMatter: createEmptyFrontMatter(generateNoteId()),
      bodyMarkdown: md,
      unsupportedMarkup: false
    }
    const raw = serializeNoteMarkdown(doc)
    const parsed = parseNoteMarkdown(raw)
    expect(parsed.bodyMarkdown).toBe(md)
  })

  it('preserves unknown front-matter fields', () => {
    const raw = `---
schema_version: 1
id: "550e8400-e29b-41d4-a716-446655440000"
color: "blue"
created_at: "2026-09-23T12:00:00Z"
updated_at: "2026-09-23T12:05:00Z"
custom_tag: "work"
pinned: true
---
Body text
`
    const parsed = parseNoteMarkdown(raw)
    expect(parsed.frontMatter.custom_tag).toBe('work')
    expect(parsed.frontMatter.pinned).toBe(true)
    const again = serializeNoteMarkdown(parsed)
    expect(again).toContain('custom_tag')
    expect(again).toContain('pinned')
  })

  it('detects unsupported markup', () => {
    const parsed = parseNoteMarkdown('![img](http://x.com/a.png)\n')
    expect(parsed.unsupportedMarkup).toBe(true)
    expect(parsed.unsupportedReason).toBeTruthy()
  })

  it('stable serialization avoids churn', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const doc = {
      frontMatter: {
        schema_version: 1,
        id,
        color: DEFAULT_NOTE_COLOR,
        created_at: '2026-09-23T12:00:00Z',
        updated_at: '2026-09-23T12:05:00Z'
      },
      bodyMarkdown: 'Stable\n',
      unsupportedMarkup: false
    }
    const a = serializeNoteMarkdown(doc)
    const b = serializeNoteMarkdown(parseNoteMarkdown(a, id))
    expect(a).toBe(b)
    expect(hashContent(a)).toBe(hashContent(b))
  })
})

describe('deriveTitle', () => {
  it('uses first nonempty line', () => {
    expect(deriveTitle('\n\nShopping list\nmilk')).toBe('Shopping list')
  })
  it('falls back to Untitled note', () => {
    expect(deriveTitle('')).toBe('Untitled note')
    expect(deriveTitle('\n\n')).toBe('Untitled note')
  })
})

describe('mergeBodies', () => {
  it('takes disk when local unchanged', () => {
    const r = mergeBodies('base\n', 'base\n', 'disk\n')
    expect(r.merged).toBe('disk\n')
    expect(r.clean).toBe(true)
  })

  it('takes local when disk unchanged', () => {
    const r = mergeBodies('base\n', 'local\n', 'base\n')
    expect(r.merged).toBe('local\n')
    expect(r.clean).toBe(true)
  })

  it('merges nonoverlapping line changes', () => {
    const base = 'a\nb\nc\n'
    const local = 'A\nb\nc\n'
    const disk = 'a\nb\nC\n'
    const r = mergeBodies(base, local, disk)
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('A\nb\nC\n')
  })

  it('fails clean merge on overlapping changes', () => {
    const r = mergeBodies('same\n', 'local\n', 'disk\n')
    expect(r.clean).toBe(false)
  })
})

describe('mergeFrontMatter', () => {
  it('merges nonoverlapping metadata', () => {
    const base = createEmptyFrontMatter('id1', 'yellow')
    const local = { ...base, color: 'green' as const, updated_at: '2026-09-23T13:00:00Z' }
    const disk = { ...base, custom: 'x', updated_at: '2026-09-23T12:30:00Z' }
    const { merged, conflicts } = mergeFrontMatter(base, local, disk)
    expect(merged.color).toBe('green')
    expect(merged.custom).toBe('x')
    expect(conflicts).toEqual([])
  })

  it('reports color conflicts', () => {
    const base = createEmptyFrontMatter('id1', 'yellow')
    const local = { ...base, color: 'green' as const }
    const disk = { ...base, color: 'blue' as const }
    const { conflicts } = mergeFrontMatter(base, local, disk)
    expect(conflicts).toContain('color')
  })
})
