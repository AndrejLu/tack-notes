import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { DOMParser as PmDOMParser, Fragment, Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { NoteEditorPayload } from '@shared/ipc'
import { NOTE_COLORS, type NoteColor } from '@shared/note-model'
import { htmlToMarkdown, markdownToHtml } from '@shared/markdown'
import { COLOR_VALUES, applyTheme } from '../theme'
import { ConfirmDialog } from '../components/ConfirmDialog'
import '../components/confirm.css'
import { DEFAULT_NOTE_FONT_SIZE } from '@shared/note-model'

function getNoteId(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('id') ?? ''
}

function sanitizePasteHtml(html: string): string {
  let s = html
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '')
  s = s.replace(/<img[^>]*>/gi, '')
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
  s = s.replace(/\son\w+="[^"]*"/gi, '')
  s = s.replace(/\son\w+='[^']*'/gi, '')
  s = s.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1')
  return s
}

function normalizeMd(md: string): string {
  const text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (text.length === 0) return ''
  return text.endsWith('\n') ? text : `${text}\n`
}

/**
 * Paste plain text as one paragraph per line.
 * Empty lines use a hardBreak so ProseMirror does not drop them.
 */
function insertPlainTextLines(view: EditorView, plain: string): void {
  const text = plain.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const { schema } = view.state
  const paragraph = schema.nodes.paragraph
  if (!paragraph) return

  const nodes = lines.map((line) => {
    if (line === '') {
      // Empty paragraph (no hardBreak) = one blank line; a hardBreak renders as two
      return paragraph.create()
    }
    return paragraph.create(null, schema.text(line))
  })

  view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.from(nodes), 0, 0)).scrollIntoView())
}

function insertHtmlAsMarkdown(view: EditorView, html: string): void {
  const md = htmlToMarkdown(sanitizePasteHtml(html))
  const safeHtml = markdownToHtml(md)
  const el = document.createElement('div')
  el.innerHTML = safeHtml
  const slice = PmDOMParser.fromSchema(view.state.schema).parseSlice(el, {
    preserveWhitespace: true
  })
  view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView())
}

function handleNotePaste(view: EditorView, event: ClipboardEvent): boolean {
  const plain = event.clipboardData?.getData('text/plain') ?? ''
  const html = event.clipboardData?.getData('text/html') ?? ''
  const cleanHtml = html ? sanitizePasteHtml(html) : ''
  const htmlHasMarks = /<(strong|em|u|s|b|i|del|ul|ol|li)\b/i.test(cleanHtml)

  // Notepad / plain editors: Chromium may also supply HTML that dropped blank lines.
  // Always prefer text/plain when there is no real rich formatting.
  if (plain.length > 0 && !htmlHasMarks) {
    insertPlainTextLines(view, plain)
    return true
  }

  if (htmlHasMarks && cleanHtml) {
    if (plain.length > 0) {
      const plainMd = plain.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const mdFromHtml = htmlToMarkdown(cleanHtml)
      const plainBlanks = (plainMd.match(/\n\s*\n/g) || []).length
      const htmlBlanks = (mdFromHtml.match(/\n\s*\n/g) || []).length
      if (plainBlanks > htmlBlanks) {
        insertPlainTextLines(view, plain)
        return true
      }
    }
    insertHtmlAsMarkdown(view, cleanHtml)
    return true
  }

  if (plain.length > 0) {
    insertPlainTextLines(view, plain)
    return true
  }

  if (cleanHtml) {
    insertHtmlAsMarkdown(view, cleanHtml)
    return true
  }

  return false
}

export function NoteApp() {
  const noteId = useMemo(() => getNoteId(), [])
  const [payload, setPayload] = useState<NoteEditorPayload | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  const [noteFontSize, setNoteFontSize] = useState(DEFAULT_NOTE_FONT_SIZE)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [sourceMode, setSourceMode] = useState(false)
  const [sourceText, setSourceText] = useState('')
  const applyingRemote = useRef(false)
  const lastSent = useRef('')
  const loadedRef = useRef(false)

  const pushBody = useCallback(
    (md: string) => {
      const normalized = normalizeMd(md)
      if (normalized === lastSent.current) return
      lastSent.current = normalized
      void window.tack.updateNoteBody(noteId, normalized)
    },
    [noteId]
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false
      }),
      Underline,
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder: 'Take a note…' })
    ],
    content: '<p></p>',
    autofocus: false,
    editorProps: {
      attributes: {
        class: 'ProseMirror note-editor',
        'data-gramm': 'false',
        spellcheck: 'false'
      },
      handlePaste(view, event) {
        return handleNotePaste(view, event)
      }
    },
    onUpdate: ({ editor: ed }) => {
      if (applyingRemote.current) return
      const md = htmlToMarkdown(ed.getHTML())
      pushBody(md)
      setPayload((p) => (p ? { ...p, saveStatus: 'unsaved', bodyMarkdown: md } : p))
    }
  })

  // Load note once editor is ready — keep EditorContent mounted (no loading gate)
  useEffect(() => {
    if (!editor || loadedRef.current) return
    let cancelled = false
    void (async () => {
      await applyTheme().then(setTheme)
      const settings = await window.tack.getSettings()
      const size = settings.noteFontSize ?? DEFAULT_NOTE_FONT_SIZE
      setNoteFontSize(size)
      document.documentElement.style.setProperty('--note-font-size', `${size}px`)
      const p = await window.tack.getNote(noteId)
      if (cancelled || !p) return
      loadedRef.current = true
      lastSent.current = normalizeMd(p.bodyMarkdown)
      setPayload(p)
      if (p.unsupportedMarkup) {
        setSourceMode(true)
        setSourceText(p.bodyMarkdown)
      } else {
        applyingRemote.current = true
        editor.commands.setContent(markdownToHtml(p.bodyMarkdown), false)
        applyingRemote.current = false
      }
      // Focus after the view is painted — empty notes otherwise never receive keystrokes
      requestAnimationFrame(() => {
        if (!cancelled && !p.unsupportedMarkup) {
          editor.commands.focus('end')
        }
      })
    })()
    return () => {
      cancelled = true
    }
  }, [editor, noteId])

  useEffect(() => {
    document.documentElement.style.setProperty('--note-font-size', `${noteFontSize}px`)
  }, [noteFontSize])

  useEffect(() => {
    const offFont = window.tack.onNoteFontSizeChanged((size) => {
      setNoteFontSize(size)
    })
    return offFont
  }, [])

  useEffect(() => {
    const offNote = window.tack.onNoteUpdated((p) => {
      if (p.id !== noteId) return
      setPayload(p)
      if (p.unsupportedMarkup) {
        setSourceMode(true)
        setSourceText(p.bodyMarkdown)
        return
      }
      if (sourceMode) {
        setSourceText(p.bodyMarkdown)
        return
      }
      const incoming = normalizeMd(p.bodyMarkdown)
      if (editor && incoming !== lastSent.current) {
        applyingRemote.current = true
        const { from, to } = editor.state.selection
        editor.commands.setContent(markdownToHtml(p.bodyMarkdown), false)
        try {
          editor.commands.setTextSelection({
            from: Math.min(from, editor.state.doc.content.size),
            to: Math.min(to, editor.state.doc.content.size)
          })
        } catch {
          /* ignore */
        }
        applyingRemote.current = false
        lastSent.current = incoming
      }
    })
    const offTheme = window.tack.onThemeChanged((t) => {
      document.documentElement.dataset.theme = t
      setTheme(t)
    })
    const offSave = window.tack.onSaveStatus((s) => {
      if (s.noteId !== noteId) return
      setPayload((p) => (p ? { ...p, saveStatus: s.status } : p))
    })
    return () => {
      offNote()
      offTheme()
      offSave()
    }
  }, [noteId, editor, sourceMode])

  const color = payload?.color ?? 'yellow'
  const colors = COLOR_VALUES[color]
  const bg = theme === 'dark' ? '#2a2824' : colors.light
  const accent = theme === 'dark' ? colors.darkAccent : colors.header

  useEffect(() => {
    document.body.style.background = bg
  }, [bg])

  useEffect(() => {
    if (!menuOpen && !confirmDelete) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setConfirmDelete(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, confirmDelete])

  const focusEditor = useCallback(() => {
    editor?.chain().focus('end').run()
  }, [editor])

  const runFormat = (fn: () => void) => {
    fn()
    editor?.commands.focus()
  }

  return (
    <div className="note-shell" style={{ background: bg, ['--note-accent' as string]: accent }}>
      <header className="note-titlebar" style={{ background: accent }}>
        <div className="drag-region" />
        <div className="titlebar-actions">
          <button
            type="button"
            className="tb-btn"
            title="Minimize"
            onClick={() => void window.tack.minimizeNoteWindow(noteId)}
          >
            ─
          </button>
          <button
            type="button"
            className="tb-btn"
            title="Close"
            onClick={() => void window.tack.closeNoteWindow(noteId)}
          >
            ✕
          </button>
        </div>
      </header>

      <div className="toolbar">
        <button
          type="button"
          className={editor?.isActive('bold') ? 'active' : ''}
          title="Bold (Ctrl+B)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleBold().run())}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={editor?.isActive('italic') ? 'active' : ''}
          title="Italic (Ctrl+I)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleItalic().run())}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className={editor?.isActive('underline') ? 'active' : ''}
          title="Underline (Ctrl+U)"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleUnderline().run())}
        >
          <span style={{ textDecoration: 'underline' }}>U</span>
        </button>
        <button
          type="button"
          className={editor?.isActive('strike') ? 'active' : ''}
          title="Strikethrough"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleStrike().run())}
        >
          <span style={{ textDecoration: 'line-through' }}>S</span>
        </button>
        <span className="sep" />
        <button
          type="button"
          className={editor?.isActive('bulletList') ? 'active' : ''}
          title="Bullet list"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleBulletList().run())}
        >
          •≡
        </button>
        <button
          type="button"
          className={editor?.isActive('taskList') ? 'active' : ''}
          title="Checklist"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => runFormat(() => editor?.chain().focus().toggleTaskList().run())}
        >
          ☑
        </button>
        <span className="sep" />
        <div className="menu-wrap">
          <button
            type="button"
            title="More"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
        </div>
        <span className="spacer" />
        {payload ? (
          <SaveBadge status={payload.saveStatus} onRetry={() => void window.tack.retrySave(noteId)} />
        ) : (
          <span className="save-badge muted">Loading…</span>
        )}
      </div>

      {menuOpen && payload && (
        <div className="menu-panel" role="menu">
          <div className="color-row" aria-label="Note color">
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className={`color-dot ${c === color ? 'selected' : ''}`}
                style={{ background: COLOR_VALUES[c].light }}
                title={c}
                onClick={() => {
                  void window.tack.setNoteColor(noteId, c as NoteColor)
                  setMenuOpen(false)
                }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void window.tack.setAlwaysOnTop(noteId, !payload.alwaysOnTop)
              setPayload((p) => (p ? { ...p, alwaysOnTop: !p.alwaysOnTop } : p))
              setMenuOpen(false)
            }}
          >
            {payload.alwaysOnTop ? '✓ ' : ''}Always on top
          </button>
          {(payload.unsupportedMarkup || sourceMode) && (
            <button
              type="button"
              onClick={() => {
                if (sourceMode && !payload.unsupportedMarkup && editor) {
                  const md = sourceText
                  applyingRemote.current = true
                  editor.commands.setContent(markdownToHtml(md), false)
                  applyingRemote.current = false
                  pushBody(md)
                }
                setSourceMode((v) => !v)
                setMenuOpen(false)
              }}
            >
              {sourceMode ? 'Rich text view' : 'Source view'}
            </button>
          )}
          {payload.unsupportedMarkup && (
            <p className="menu-hint">{payload.unsupportedReason}</p>
          )}
          <button
            type="button"
            className="danger"
            onClick={() => {
              setMenuOpen(false)
              setConfirmDelete(true)
            }}
          >
            Delete note
          </button>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete note"
          message="Move this note to trash? You can restore it later from Settings."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false)
            void window.tack.deleteNote(noteId)
          }}
        />
      )}

      {payload?.conflict && (
        <div className="conflict-bar">
          <span>{payload.conflict.message}</span>
          <div className="conflict-actions">
            <button type="button" onClick={() => void window.tack.resolveConflict(noteId, 'keep_local')}>
              Keep mine
            </button>
            <button type="button" onClick={() => void window.tack.resolveConflict(noteId, 'keep_disk')}>
              Keep disk
            </button>
            <button type="button" onClick={() => void window.tack.resolveConflict(noteId, 'keep_both')}>
              Keep both
            </button>
          </div>
        </div>
      )}

      <div
        className="body"
        onMouseDown={(e) => {
          if (menuOpen) setMenuOpen(false)
          if (sourceMode) return
          const target = e.target as HTMLElement
          if (target === e.currentTarget || target.classList.contains('ProseMirror')) {
            focusEditor()
          }
        }}
      >
        {sourceMode ? (
          <textarea
            className="source-editor"
            value={sourceText}
            autoFocus
            onChange={(e) => {
              setSourceText(e.target.value)
              pushBody(e.target.value)
              setPayload((p) => (p ? { ...p, saveStatus: 'unsaved' } : p))
            }}
            spellCheck={false}
          />
        ) : (
          <EditorContent editor={editor} />
        )}
      </div>
    </div>
  )
}

function SaveBadge({
  status,
  onRetry
}: {
  status: NoteEditorPayload['saveStatus']
  onRetry: () => void
}) {
  if (status === 'saved' || status === 'idle') {
    return <span className="save-badge muted">Saved</span>
  }
  if (status === 'saving') return <span className="save-badge">Saving…</span>
  if (status === 'unsaved') return <span className="save-badge">Unsaved</span>
  if (status === 'conflict') return <span className="save-badge warn">Conflict</span>
  return (
    <button type="button" className="save-badge error" onClick={onRetry}>
      Unsaved — Retry
    </button>
  )
}
