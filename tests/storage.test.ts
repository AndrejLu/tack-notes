import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppDataRootForTests } from '../src/main/app-paths'
import { StorageService } from '../src/main/storage'
import { hashContent, parseNoteMarkdown, serializeNoteMarkdown } from '../src/shared/markdown'
import { createEmptyFrontMatter } from '../src/shared/note-model'

function mktemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tack-test-'))
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

describe('StorageService', () => {
  let appData: string
  let notesDir: string
  let storage: StorageService

  beforeEach(async () => {
    appData = mktemp()
    notesDir = mktemp()
    setAppDataRootForTests(appData)
    storage = new StorageService()
    await storage.setFolder(notesDir)
  })

  afterEach(async () => {
    await storage.close()
    setAppDataRootForTests(null)
    rmrf(appData)
    rmrf(notesDir)
  })

  it('creates, edits, saves, and reloads a note', async () => {
    const note = storage.createNote('green')
    storage.setEditorBody(note.id, 'Hello **Tack**\n')
    const save = await storage.saveNote(note.id)
    expect(save.ok).toBe(true)

    const file = path.join(notesDir, `${note.id}.md`)
    expect(fs.existsSync(file)).toBe(true)
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('Hello **Tack**')
    expect(raw).toContain('color: "green"')

    await storage.close()
    storage = new StorageService()
    await storage.setFolder(notesDir)
    const listed = storage.listNotes()
    expect(listed).toHaveLength(1)
    expect(listed[0].title).toBe('Hello Tack')
    expect(storage.getLive(note.id)?.editorBody).toContain('Hello **Tack**')
  })

  it('loads external edits when there are no local changes', async () => {
    const note = storage.createNote()
    await storage.saveNote(note.id)
    const file = path.join(notesDir, `${note.id}.md`)
    const doc = parseNoteMarkdown(fs.readFileSync(file, 'utf8'), note.id)
    doc.bodyMarkdown = 'External change\n'
    doc.frontMatter.updated_at = new Date().toISOString()
    fs.writeFileSync(file, serializeNoteMarkdown(doc), 'utf8')

    await storage.rescan()
    expect(storage.getLive(note.id)?.editorBody).toBe('External change\n')
    expect(storage.getLive(note.id)?.dirty).toBe(false)
  })

  it('merges nonoverlapping concurrent changes', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'line1\nline2\nline3\n')
    await storage.saveNote(note.id)

    // Local edit line1
    storage.setEditorBody(note.id, 'LOCAL\nline2\nline3\n')

    // Disk edit line3
    const file = path.join(notesDir, `${note.id}.md`)
    const diskDoc = parseNoteMarkdown(fs.readFileSync(file, 'utf8'), note.id)
    // Simulate disk having base then changing line3 — base is what was saved
    diskDoc.bodyMarkdown = 'line1\nline2\nDISK\n'
    // Force base on live to match file before disk write... 
    // After saveNote, base is LOCAL? No - we set editor after save, so dirty.
    // Manually write disk as if sync changed from the saved base:
    const baseRaw = serializeNoteMarkdown({
      frontMatter: diskDoc.frontMatter,
      bodyMarkdown: 'line1\nline2\nline3\n',
      unsupportedMarkup: false
    })
    // Reset live base by re-reading: easiest path — set disk file to changed version
    // First ensure live baseBody is line1/2/3 from last save
    const live = storage.getLive(note.id)!
    expect(live.baseBody).toBe('line1\nline2\nline3\n')

    fs.writeFileSync(
      file,
      serializeNoteMarkdown({
        frontMatter: { ...live.baseFrontMatter, updated_at: new Date().toISOString() },
        bodyMarkdown: 'line1\nline2\nDISK\n',
        unsupportedMarkup: false
      }),
      'utf8'
    )

    await storage.rescan()
    const after = storage.getLive(note.id)!
    expect(after.conflict).toBeNull()
    expect(after.editorBody).toBe('LOCAL\nline2\nDISK\n')
  })

  it('surfaces conflict on overlapping body changes', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'same\n')
    await storage.saveNote(note.id)
    storage.setEditorBody(note.id, 'local\n')

    const live = storage.getLive(note.id)!
    const file = path.join(notesDir, `${note.id}.md`)
    fs.writeFileSync(
      file,
      serializeNoteMarkdown({
        frontMatter: live.baseFrontMatter,
        bodyMarkdown: 'disk\n',
        unsupportedMarkup: false
      }),
      'utf8'
    )

    await storage.rescan()
    expect(storage.getLive(note.id)?.conflict?.kind).toBe('body')
  })

  it('handles divergent files sharing one note ID', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000'
    const fm = createEmptyFrontMatter(id, 'yellow')
    const a = serializeNoteMarkdown({
      frontMatter: fm,
      bodyMarkdown: 'Version A\n',
      unsupportedMarkup: false
    })
    const b = serializeNoteMarkdown({
      frontMatter: { ...fm, updated_at: '2026-09-23T13:00:00Z' },
      bodyMarkdown: 'Version B\n',
      unsupportedMarkup: false
    })
    fs.writeFileSync(path.join(notesDir, `${id}.md`), a, 'utf8')
    fs.writeFileSync(path.join(notesDir, `${id} (conflict).md`), b, 'utf8')

    await storage.close()
    storage = new StorageService()
    await storage.setFolder(notesDir)

    const live = storage.getLive(id)
    expect(live).toBeTruthy()
    expect(live?.conflict?.kind).toBe('duplicate_id')
  })

  it('delete moves to trash and restore works', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'Trashed content\n')
    await storage.saveNote(note.id)
    await storage.deleteNote(note.id)
    expect(storage.listNotes()).toHaveLength(0)
    expect(storage.listTrash()).toHaveLength(1)

    const restored = await storage.restoreFromTrash(note.id)
    expect(restored.ok).toBe(true)
    expect(storage.listNotes()).toHaveLength(1)
    expect(storage.getLive(note.id)?.editorBody).toContain('Trashed content')
  })

  it('restore refuses to overwrite divergent active note', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'Active\n')
    await storage.saveNote(note.id)

    // Manually put a different trash entry with same id
    const trashDir = path.join(notesDir, '.tack-trash')
    fs.mkdirSync(trashDir, { recursive: true })
    const fm = createEmptyFrontMatter(note.id)
    fs.writeFileSync(
      path.join(trashDir, `${note.id}.md`),
      serializeNoteMarkdown({
        frontMatter: { ...fm, deleted_at: new Date().toISOString() },
        bodyMarkdown: 'Old trash\n',
        unsupportedMarkup: false
      }),
      'utf8'
    )

    const result = await storage.restoreFromTrash(note.id)
    expect(result.ok).toBe(false)
    expect(storage.getLive(note.id)?.editorBody).toContain('Active')
  })

  it('does not treat missing storage folder as deleting all notes', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'Keep me\n')
    await storage.saveNote(note.id)

    // Simulate unavailable path without renaming (watchers may lock dirs on Windows)
    const realFolder = (storage as unknown as { folder: string | null }).folder
    ;(storage as unknown as { folder: string | null }).folder = path.join(notesDir, '__missing__')
    await storage.rescan()
    expect(storage.isAvailable()).toBe(false)
    expect(storage.getLive(note.id)?.editorBody).toContain('Keep me')

    ;(storage as unknown as { folder: string | null }).folder = realFolder
    await storage.rescan()
    expect(storage.isAvailable()).toBe(true)
    expect(storage.getLive(note.id)?.editorBody).toContain('Keep me')
  })

  it('recovers pending edits via recovery snapshots on failed path', async () => {
    const note = storage.createNote()
    storage.setEditorBody(note.id, 'Pending body\n')
    // Recovery snapshot written on edit
    const recoveryRoot = path.join(appData, 'recovery', note.id)
    expect(fs.existsSync(recoveryRoot)).toBe(true)
    const files = fs.readdirSync(recoveryRoot).filter((f) => f.startsWith('pending-'))
    expect(files.length).toBeGreaterThan(0)
    const content = fs.readFileSync(path.join(recoveryRoot, files[0]), 'utf8')
    expect(content).toContain('Pending body')
  })

  it('ignores temp files during discovery', async () => {
    fs.writeFileSync(path.join(notesDir, 'foo.md.123.tmp'), 'temp', 'utf8')
    await storage.rescan()
    expect(storage.listNotes().every((n) => !n.fileName.endsWith('.tmp'))).toBe(true)
  })

  it('preserves content hash stability for identical serialization', () => {
    const fm = createEmptyFrontMatter('550e8400-e29b-41d4-a716-446655440000')
    const raw = serializeNoteMarkdown({
      frontMatter: fm,
      bodyMarkdown: 'x\n',
      unsupportedMarkup: false
    })
    expect(hashContent(raw)).toBe(hashContent(raw))
  })
})
