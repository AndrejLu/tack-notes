import { useEffect, useState } from 'react'
import type { NoteSummary } from '@shared/note-model'
import { COLOR_VALUES, applyTheme } from '../theme'

export function CentralApp() {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [filtered, setFiltered] = useState<NoteSummary[]>([])
  const [query, setQuery] = useState('')
  const [theme, setTheme] = useState<'light' | 'dark'>('light')

  useEffect(() => {
    void applyTheme().then(setTheme)
    void window.tack.listNotes().then(setNotes)
    const offNotes = window.tack.onNotesChanged(setNotes)
    const offTheme = window.tack.onThemeChanged((t) => {
      document.documentElement.dataset.theme = t
      setTheme(t)
    })
    return () => {
      offNotes()
      offTheme()
    }
  }, [])

  // Full-body search via main process (title/preview alone only cover the start of a note)
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFiltered(notes)
      return
    }
    let cancelled = false
    void window.tack.searchNotes(q).then((results) => {
      if (!cancelled) setFiltered(results)
    })
    return () => {
      cancelled = true
    }
  }, [notes, query])

  return (
    <div className="central">
      <header className="central-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          <h1>Tack Notes</h1>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn"
            title="Settings"
            onClick={() => void window.tack.openSettings()}
          >
            ⚙
          </button>
          <button
            type="button"
            className="new-btn"
            onClick={() => void window.tack.createNote()}
          >
            + New note
          </button>
        </div>
      </header>

      <div className="search-wrap">
        <input
          className="search"
          type="search"
          placeholder="Search note contents"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search notes"
        />
      </div>

      <div className="note-list" role="list">
        {filtered.length === 0 ? (
          <div className="empty">
            {notes.length === 0 ? 'No notes yet. Create one to get started.' : 'No matches.'}
          </div>
        ) : (
          filtered.map((note) => {
            const colors = COLOR_VALUES[note.color]
            return (
              <button
                type="button"
                key={note.id}
                className="note-row"
                role="listitem"
                onDoubleClick={() => void window.tack.openNote(note.id)}
                onClick={() => void window.tack.openNote(note.id)}
              >
                <span
                  className="swatch"
                  style={{
                    background: theme === 'dark' ? colors.darkAccent : colors.light
                  }}
                />
                <span className="note-meta">
                  <span className="note-title">{note.title}</span>
                  <span className="note-preview">{note.preview || ' '}</span>
                  <span className="note-date">
                    {new Date(note.updatedAt).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                    {note.unsupportedMarkup ? ' · limited format' : ''}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
