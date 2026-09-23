/**
 * Filesystem storage service — sole owner of note persistence.
 * All reads/writes go through this module in the main process.
 */

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  generateNoteId,
  hashContent,
  mergeBodies,
  mergeFrontMatter,
  noteFileName,
  parseNoteMarkdown,
  serializeNoteMarkdown,
  trashFileName
} from '@shared/markdown'
import {
  createEmptyFrontMatter,
  derivePreview,
  deriveTitle,
  type NoteColor,
  type NoteConflict,
  type NoteFrontMatter,
  type NoteSnapshot,
  type NoteSummary,
  DEFAULT_NOTE_COLOR
} from '@shared/note-model'
import { clearPendingRecovery, writeRecoverySnapshot } from './app-paths'

const TEMP_SUFFIX_RE = /\.\d+\.tmp$/i
const TRASH_DIR = '.tack-trash'
const SCAN_INTERVAL_MS = 30_000
const WATCH_DEBOUNCE_MS = 400
const STABLE_READ_RETRIES = 5
const STABLE_READ_DELAY_MS = 80
const WRITE_RETRIES = 4

export type StorageEvent =
  | { type: 'notes-changed' }
  | { type: 'note-external'; noteId: string }
  | { type: 'conflict'; conflict: NoteConflict }
  | { type: 'storage-unavailable'; reason: string }
  | { type: 'storage-restored' }

interface LiveNote {
  id: string
  fileName: string
  filePath: string
  baseRaw: string
  baseHash: string
  baseFrontMatter: NoteFrontMatter
  baseBody: string
  editorBody: string
  editorFrontMatter: NoteFrontMatter
  editorHash: string
  diskRaw: string
  diskHash: string
  dirty: boolean
  unsupportedMarkup: boolean
  unsupportedReason?: string
  conflict: NoteConflict | null
  saveQueue: Promise<void>
  lastOwnWriteHash: string | null
  mtimeMs: number
  missingOnDisk: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function contentSha(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export class StorageService {
  private folder: string | null = null
  private notes = new Map<string, LiveNote>()
  /** filePath -> noteId for duplicate detection */
  private pathIndex = new Map<string, string>()
  private watcher: FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private listeners = new Set<(e: StorageEvent) => void>()
  private available = true

  onEvent(cb: (e: StorageEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: StorageEvent): void {
    for (const cb of this.listeners) cb(e)
  }

  getFolder(): string | null {
    return this.folder
  }

  isAvailable(): boolean {
    return this.available
  }

  trashDir(): string {
    if (!this.folder) throw new Error('No storage folder')
    return path.join(this.folder, TRASH_DIR)
  }

  async setFolder(folder: string): Promise<void> {
    await this.close()
    this.folder = folder
    fs.mkdirSync(folder, { recursive: true })
    fs.mkdirSync(this.trashDir(), { recursive: true })
    await this.rescan()
    this.startWatching()
    this.scanTimer = setInterval(() => {
      void this.rescan()
    }, SCAN_INTERVAL_MS)
  }

  async close(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer)
      this.scanTimer = null
    }
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.notes.clear()
    this.pathIndex.clear()
    this.folder = null
  }

  private startWatching(): void {
    if (!this.folder) return
    this.watcher = chokidar.watch(this.folder, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p) => {
        const base = path.basename(p)
        if (TEMP_SUFFIX_RE.test(base)) return true
        if (base.startsWith('.')) {
          // watch trash separately? ignore nested except we handle trash via API
          return !p.includes(TRASH_DIR)
        }
        return false
      },
      depth: 1
    })

    const onFs = (filePath: string) => {
      if (!filePath.endsWith('.md')) return
      if (TEMP_SUFFIX_RE.test(filePath)) return
      if (filePath.includes(TRASH_DIR)) return
      const existing = this.debounceTimers.get(filePath)
      if (existing) clearTimeout(existing)
      this.debounceTimers.set(
        filePath,
        setTimeout(() => {
          this.debounceTimers.delete(filePath)
          void this.handleFsEvent(filePath)
        }, WATCH_DEBOUNCE_MS)
      )
    }

    this.watcher.on('add', onFs)
    this.watcher.on('change', onFs)
    this.watcher.on('unlink', (filePath) => {
      if (!filePath.endsWith('.md') || filePath.includes(TRASH_DIR)) return
      void this.handleUnlink(filePath)
    })
  }

  private async stableRead(filePath: string): Promise<{ raw: string; mtimeMs: number } | null> {
    let lastHash = ''
    for (let i = 0; i < STABLE_READ_RETRIES; i++) {
      try {
        if (!fs.existsSync(filePath)) return null
        const raw = fs.readFileSync(filePath, 'utf8')
        const mtimeMs = fs.statSync(filePath).mtimeMs
        const h = contentSha(raw)
        if (h === lastHash) return { raw, mtimeMs }
        lastHash = h
        await sleep(STABLE_READ_DELAY_MS)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') return null
        if (code === 'EACCES' || code === 'EPERM') throw err
        await sleep(STABLE_READ_DELAY_MS)
      }
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      return { raw, mtimeMs: fs.statSync(filePath).mtimeMs }
    } catch {
      return null
    }
  }

  private snapshotFromRaw(filePath: string, raw: string, mtimeMs: number): NoteSnapshot {
    const baseName = path.basename(filePath, '.md')
    const fallbackId = /^[0-9a-f-]{36}$/i.test(baseName) ? baseName : generateNoteId()
    const doc = parseNoteMarkdown(raw, fallbackId)
    return {
      id: doc.frontMatter.id,
      fileName: path.basename(filePath),
      raw,
      contentHash: hashContent(raw),
      frontMatter: doc.frontMatter,
      bodyMarkdown: doc.bodyMarkdown,
      mtimeMs,
      unsupportedMarkup: doc.unsupportedMarkup,
      unsupportedReason: doc.unsupportedReason
    }
  }

  private liveFromSnapshot(snap: NoteSnapshot, filePath: string): LiveNote {
    return {
      id: snap.id,
      fileName: snap.fileName,
      filePath,
      baseRaw: snap.raw,
      baseHash: snap.contentHash,
      baseFrontMatter: { ...snap.frontMatter },
      baseBody: snap.bodyMarkdown,
      editorBody: snap.bodyMarkdown,
      editorFrontMatter: { ...snap.frontMatter },
      editorHash: snap.contentHash,
      diskRaw: snap.raw,
      diskHash: snap.contentHash,
      dirty: false,
      unsupportedMarkup: snap.unsupportedMarkup,
      unsupportedReason: snap.unsupportedReason,
      conflict: null,
      saveQueue: Promise.resolve(),
      lastOwnWriteHash: null,
      mtimeMs: snap.mtimeMs,
      missingOnDisk: false
    }
  }

  async rescan(): Promise<void> {
    if (!this.folder) return
    try {
      if (!fs.existsSync(this.folder)) {
        this.available = false
        this.emit({ type: 'storage-unavailable', reason: 'Storage folder is missing or unavailable.' })
        return
      }
      const wasUnavailable = !this.available
      this.available = true
      if (wasUnavailable) this.emit({ type: 'storage-restored' })

      const entries = fs.readdirSync(this.folder)
      const mdFiles = entries.filter(
        (f) => f.endsWith('.md') && !TEMP_SUFFIX_RE.test(f) && !f.startsWith('.')
      )

      const seenPaths = new Set<string>()
      const byId = new Map<string, Array<{ filePath: string; snap: NoteSnapshot }>>()

      for (const file of mdFiles) {
        const filePath = path.join(this.folder, file)
        const read = await this.stableRead(filePath)
        if (!read) continue
        seenPaths.add(filePath)
        const snap = this.snapshotFromRaw(filePath, read.raw, read.mtimeMs)
        const list = byId.get(snap.id) ?? []
        list.push({ filePath, snap })
        byId.set(snap.id, list)
      }

      for (const [id, copies] of byId) {
        if (copies.length === 1) {
          const { filePath, snap } = copies[0]
          const existing = this.notes.get(id)
          if (!existing) {
            const live = this.liveFromSnapshot(snap, filePath)
            this.notes.set(id, live)
            this.pathIndex.set(filePath, id)
          } else if (!existing.dirty && snap.contentHash !== existing.diskHash) {
            // External change while clean
            this.applyExternalClean(existing, snap, filePath)
          } else if (existing.dirty && snap.contentHash !== existing.diskHash) {
            existing.diskRaw = snap.raw
            existing.diskHash = snap.contentHash
            existing.mtimeMs = snap.mtimeMs
            await this.reconcile(existing)
          } else {
            existing.filePath = filePath
            existing.fileName = snap.fileName
            this.pathIndex.set(filePath, id)
          }
        } else {
          // Multiple files with same ID
          await this.handleDuplicateIds(id, copies)
        }
      }

      // Detect files that vanished (not trash)
      for (const [id, live] of this.notes) {
        if (!seenPaths.has(live.filePath) && !live.missingOnDisk) {
          // Might have been renamed — check if another path has this id
          let found = false
          for (const p of seenPaths) {
            if (this.pathIndex.get(p) === id) {
              found = true
              break
            }
          }
          if (!found) {
            live.missingOnDisk = true
            if (live.dirty) {
              writeRecoverySnapshot(id, 'pending', this.serializeLive(live))
              live.conflict = {
                noteId: id,
                kind: 'deleted_externally',
                message:
                  'This note file disappeared while you had unsaved edits. Your edits are preserved locally.',
                baseHash: live.baseHash,
                localHash: hashContent(this.serializeLive(live)),
                diskHash: live.diskHash,
                localBody: live.editorBody
              }
              this.emit({ type: 'conflict', conflict: live.conflict })
            } else {
              this.notes.delete(id)
              this.pathIndex.delete(live.filePath)
            }
          }
        }
      }

      this.emit({ type: 'notes-changed' })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES') {
        this.available = false
        this.emit({
          type: 'storage-unavailable',
          reason: code === 'ENOENT' ? 'Storage folder missing.' : 'Permission denied.'
        })
      }
    }
  }

  private applyExternalClean(live: LiveNote, snap: NoteSnapshot, filePath: string): void {
    if (live.lastOwnWriteHash && snap.contentHash === hashContent(snap.raw) && live.lastOwnWriteHash === snap.contentHash) {
      live.lastOwnWriteHash = null
      live.diskRaw = snap.raw
      live.diskHash = snap.contentHash
      return
    }
    live.filePath = filePath
    live.fileName = snap.fileName
    live.baseRaw = snap.raw
    live.baseHash = snap.contentHash
    live.baseBody = snap.bodyMarkdown
    live.baseFrontMatter = { ...snap.frontMatter }
    live.editorBody = snap.bodyMarkdown
    live.editorFrontMatter = { ...snap.frontMatter }
    live.editorHash = snap.contentHash
    live.diskRaw = snap.raw
    live.diskHash = snap.contentHash
    live.unsupportedMarkup = snap.unsupportedMarkup
    live.unsupportedReason = snap.unsupportedReason
    live.mtimeMs = snap.mtimeMs
    live.missingOnDisk = false
    live.conflict = null
    this.pathIndex.set(filePath, live.id)
    this.emit({ type: 'note-external', noteId: live.id })
  }

  private async handleDuplicateIds(
    id: string,
    copies: Array<{ filePath: string; snap: NoteSnapshot }>
  ): Promise<void> {
    // Identical content → keep canonical filename, ignore duplicates as separate notes
    const uniqueHashes = new Map<string, { filePath: string; snap: NoteSnapshot }>()
    for (const c of copies) {
      if (!uniqueHashes.has(c.snap.contentHash)) {
        uniqueHashes.set(c.snap.contentHash, c)
      }
    }

    const preferred =
      copies.find((c) => c.filePath === path.join(this.folder!, noteFileName(id))) ?? copies[0]

    if (uniqueHashes.size === 1) {
      // Identical duplicates — surface only one
      const existing = this.notes.get(id)
      if (!existing) {
        this.notes.set(id, this.liveFromSnapshot(preferred.snap, preferred.filePath))
      }
      this.pathIndex.set(preferred.filePath, id)
      return
    }

    // Divergent — keep all, conflict on primary
    const live = this.notes.get(id) ?? this.liveFromSnapshot(preferred.snap, preferred.filePath)
    this.notes.set(id, live)
    this.pathIndex.set(preferred.filePath, id)

    for (const c of copies) {
      if (c.filePath === preferred.filePath) continue
      if (c.snap.contentHash === preferred.snap.contentHash) continue
      live.conflict = {
        noteId: id,
        kind: 'duplicate_id',
        message:
          'Another file shares this note ID but has different content (likely a sync conflict copy).',
        baseHash: live.baseHash,
        localHash: live.editorHash,
        diskHash: c.snap.contentHash,
        diskBody: c.snap.bodyMarkdown,
        localBody: live.editorBody,
        duplicatePath: c.filePath
      }
      writeRecoverySnapshot(id, 'disk', c.snap.raw)
      this.emit({ type: 'conflict', conflict: live.conflict })
    }
  }

  private async handleFsEvent(filePath: string): Promise<void> {
    const read = await this.stableRead(filePath)
    if (!read) return
    const snap = this.snapshotFromRaw(filePath, read.raw, read.mtimeMs)

    // Ignore our own writes
    for (const live of this.notes.values()) {
      if (live.filePath === filePath && live.lastOwnWriteHash === snap.contentHash) {
        live.lastOwnWriteHash = null
        live.diskRaw = snap.raw
        live.diskHash = snap.contentHash
        live.mtimeMs = snap.mtimeMs
        return
      }
    }

    const byPath = this.pathIndex.get(filePath)
    const live = this.notes.get(snap.id) ?? (byPath ? this.notes.get(byPath) : undefined)

    if (!live) {
      // New note from outside
      // Check duplicate id
      if (this.notes.has(snap.id)) {
        await this.handleDuplicateIds(snap.id, [
          {
            filePath: this.notes.get(snap.id)!.filePath,
            snap: this.snapshotFromRaw(
              this.notes.get(snap.id)!.filePath,
              this.notes.get(snap.id)!.diskRaw,
              this.notes.get(snap.id)!.mtimeMs
            )
          },
          { filePath, snap }
        ])
      } else {
        this.notes.set(snap.id, this.liveFromSnapshot(snap, filePath))
        this.pathIndex.set(filePath, snap.id)
      }
      this.emit({ type: 'notes-changed' })
      return
    }

    if (snap.contentHash === live.diskHash) return

    live.diskRaw = snap.raw
    live.diskHash = snap.contentHash
    live.mtimeMs = snap.mtimeMs
    live.filePath = filePath
    live.missingOnDisk = false

    if (!live.dirty) {
      this.applyExternalClean(live, snap, filePath)
      this.emit({ type: 'notes-changed' })
      this.emit({ type: 'note-external', noteId: live.id })
    } else {
      await this.reconcile(live)
      this.emit({ type: 'notes-changed' })
    }
  }

  private async handleUnlink(filePath: string): Promise<void> {
    const id = this.pathIndex.get(filePath)
    if (!id) return
    const live = this.notes.get(id)
    if (!live || live.filePath !== filePath) return

    // Brief wait — sync clients often replace via unlink+add
    await sleep(500)
    if (fs.existsSync(filePath)) {
      await this.handleFsEvent(filePath)
      return
    }
    // Check if file reappeared under same id elsewhere
    await this.rescan()
  }

  private serializeLive(live: LiveNote): string {
    return serializeNoteMarkdown({
      frontMatter: live.editorFrontMatter,
      bodyMarkdown: live.editorBody,
      unsupportedMarkup: live.unsupportedMarkup,
      unsupportedReason: live.unsupportedReason
    })
  }

  private async reconcile(live: LiveNote): Promise<void> {
    const diskDoc = parseNoteMarkdown(live.diskRaw, live.id)
    writeRecoverySnapshot(live.id, 'base', live.baseRaw)
    writeRecoverySnapshot(live.id, 'local', this.serializeLive(live))
    writeRecoverySnapshot(live.id, 'disk', live.diskRaw)

    const bodyMerge = mergeBodies(live.baseBody, live.editorBody, diskDoc.bodyMarkdown)
    const metaMerge = mergeFrontMatter(
      live.baseFrontMatter,
      live.editorFrontMatter,
      diskDoc.frontMatter
    )

    const metaConflict = metaMerge.conflicts.includes('color')
    if (!bodyMerge.clean || metaConflict) {
      live.conflict = {
        noteId: live.id,
        kind: !bodyMerge.clean ? 'body' : 'color',
        message: !bodyMerge.clean
          ? 'This note changed on disk and locally in overlapping ways.'
          : 'Note color changed both locally and on disk.',
        baseHash: live.baseHash,
        localHash: hashContent(this.serializeLive(live)),
        diskHash: live.diskHash,
        localBody: live.editorBody,
        diskBody: diskDoc.bodyMarkdown,
        localColor: live.editorFrontMatter.color,
        diskColor: diskDoc.frontMatter.color
      }
      this.emit({ type: 'conflict', conflict: live.conflict })
      return
    }

    live.editorBody = bodyMerge.merged
    live.editorFrontMatter = metaMerge.merged
    live.dirty = true
    // Update base to disk so subsequent saves compare correctly after we write
    live.baseBody = diskDoc.bodyMarkdown
    live.baseFrontMatter = { ...diskDoc.frontMatter }
    live.baseRaw = live.diskRaw
    live.baseHash = live.diskHash
    this.emit({ type: 'note-external', noteId: live.id })
  }

  listNotes(): NoteSummary[] {
    const items: NoteSummary[] = []
    for (const live of this.notes.values()) {
      items.push({
        id: live.id,
        color: live.editorFrontMatter.color,
        title: deriveTitle(live.editorBody),
        preview: derivePreview(live.editorBody),
        createdAt: String(live.editorFrontMatter.created_at),
        updatedAt: String(live.editorFrontMatter.updated_at),
        fileName: live.fileName,
        trashed: false,
        unsupportedMarkup: live.unsupportedMarkup
      })
    }
    items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return items
  }

  searchNotes(query: string): NoteSummary[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.listNotes()
    return this.listNotes().filter(
      (n) =>
        n.title.toLowerCase().includes(q) ||
        n.preview.toLowerCase().includes(q) ||
        this.notes.get(n.id)?.editorBody.toLowerCase().includes(q)
    )
  }

  getLive(noteId: string): LiveNote | undefined {
    return this.notes.get(noteId)
  }

  createNote(color: NoteColor = DEFAULT_NOTE_COLOR): NoteSummary {
    if (!this.folder) throw new Error('No storage folder')
    if (!this.available) throw new Error('Storage unavailable')

    const id = generateNoteId()
    const fileName = noteFileName(id)
    const filePath = path.join(this.folder, fileName)
    const fm = createEmptyFrontMatter(id, color)
    const raw = serializeNoteMarkdown({
      frontMatter: fm,
      bodyMarkdown: '',
      unsupportedMarkup: false
    })
    this.writeAtomicSync(filePath, raw)
    const snap = this.snapshotFromRaw(filePath, raw, Date.now())
    const live = this.liveFromSnapshot(snap, filePath)
    live.lastOwnWriteHash = snap.contentHash
    this.notes.set(id, live)
    this.pathIndex.set(filePath, id)
    this.emit({ type: 'notes-changed' })
    return this.listNotes().find((n) => n.id === id)!
  }

  setEditorBody(noteId: string, bodyMarkdown: string): void {
    const live = this.notes.get(noteId)
    if (!live) return
    if (live.unsupportedMarkup) {
      // Source mode still allowed — treat as body replace
    }
    const normalized = bodyMarkdown.replace(/\r\n/g, '\n')
    if (normalized === live.editorBody) return
    live.editorBody = normalized.endsWith('\n') || normalized.length === 0 ? normalized : normalized + '\n'
    live.dirty = live.editorBody !== live.baseBody || JSON.stringify(live.editorFrontMatter) !== JSON.stringify(live.baseFrontMatter)
    if (live.dirty) {
      writeRecoverySnapshot(noteId, 'pending', this.serializeLive(live))
    }
  }

  setColor(noteId: string, color: NoteColor): void {
    const live = this.notes.get(noteId)
    if (!live) return
    if (live.editorFrontMatter.color === color) return
    live.editorFrontMatter = {
      ...live.editorFrontMatter,
      color,
      updated_at: new Date().toISOString()
    }
    live.dirty = true
    writeRecoverySnapshot(noteId, 'pending', this.serializeLive(live))
  }

  async saveNote(noteId: string): Promise<{ ok: boolean; conflict?: NoteConflict; error?: string }> {
    const live = this.notes.get(noteId)
    if (!live) return { ok: false, error: 'Note not found' }

    const run = async (): Promise<{ ok: boolean; conflict?: NoteConflict; error?: string }> => {
      if (!this.folder || !this.available) {
        return { ok: false, error: 'Storage folder unavailable' }
      }
      if (!live.dirty && !live.missingOnDisk) {
        return { ok: true }
      }

      // Reread disk before write
      if (!live.missingOnDisk && fs.existsSync(live.filePath)) {
        const read = await this.stableRead(live.filePath)
        if (read) {
          const diskHash = hashContent(read.raw)
          if (diskHash !== live.baseHash && diskHash !== live.lastOwnWriteHash) {
            live.diskRaw = read.raw
            live.diskHash = diskHash
            live.mtimeMs = read.mtimeMs
            await this.reconcile(live)
            if (live.conflict) {
              return { ok: false, conflict: live.conflict }
            }
          }
        }
      }

      const meaningful =
        live.editorBody !== live.baseBody ||
        live.editorFrontMatter.color !== live.baseFrontMatter.color ||
        Object.keys(live.editorFrontMatter).some(
          (k) =>
            !['updated_at', 'created_at', 'schema_version', 'id'].includes(k) &&
            live.editorFrontMatter[k] !== live.baseFrontMatter[k]
        )

      if (meaningful) {
        live.editorFrontMatter = {
          ...live.editorFrontMatter,
          updated_at: new Date().toISOString()
        }
      }

      const raw = this.serializeLive(live)

      try {
        if (live.missingOnDisk) {
          live.filePath = path.join(this.folder!, noteFileName(live.id))
          live.fileName = noteFileName(live.id)
        }
        await this.writeAtomic(live.filePath, raw)
        const hash = hashContent(raw)
        live.lastOwnWriteHash = hash
        live.baseRaw = raw
        live.baseHash = hash
        live.baseBody = live.editorBody
        live.baseFrontMatter = { ...live.editorFrontMatter }
        live.diskRaw = raw
        live.diskHash = hash
        live.editorHash = hash
        live.dirty = false
        live.missingOnDisk = false
        live.conflict = null
        this.pathIndex.set(live.filePath, live.id)
        writeRecoverySnapshot(noteId, 'base', raw)
        clearPendingRecovery(noteId)
        this.emit({ type: 'notes-changed' })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        writeRecoverySnapshot(noteId, 'pending', raw)
        return { ok: false, error: msg }
      }
    }

    const resultPromise = live.saveQueue.then(run, run)
    live.saveQueue = resultPromise.then(
      () => undefined,
      () => undefined
    )
    return resultPromise
  }

  private writeAtomicSync(filePath: string, content: string): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.tmp`)
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'w' })
    fs.renameSync(tmp, filePath)
  }

  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    let lastErr: unknown
    for (let i = 0; i < WRITE_RETRIES; i++) {
      const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.${i}.tmp`)
      try {
        fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'w' })
        try {
          fs.renameSync(tmp, filePath)
        } catch {
          // On Windows, replace may need unlink if replaceFile not available
          // Never delete original as unsafe fallback without having tmp ready —
          // copy over then remove tmp
          fs.copyFileSync(tmp, filePath)
          try {
            fs.unlinkSync(tmp)
          } catch {
            /* ignore */
          }
        }
        return
      } catch (err) {
        lastErr = err
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch {
          /* ignore */
        }
        await sleep(50 * (i + 1))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  async deleteNote(noteId: string): Promise<void> {
    const live = this.notes.get(noteId)
    if (!live || !this.folder) return
    if (live.dirty) {
      await this.saveNote(noteId)
    }
    const trashPath = path.join(this.trashDir(), trashFileName(noteId))
    fs.mkdirSync(this.trashDir(), { recursive: true })
    const raw = live.missingOnDisk
      ? this.serializeLive(live)
      : fs.existsSync(live.filePath)
        ? fs.readFileSync(live.filePath, 'utf8')
        : this.serializeLive(live)

    // Add deleted_at into front matter for trash
    const doc = parseNoteMarkdown(raw, noteId)
    doc.frontMatter = {
      ...doc.frontMatter,
      deleted_at: new Date().toISOString()
    }
    await this.writeAtomic(trashPath, serializeNoteMarkdown(doc))

    if (!live.missingOnDisk && fs.existsSync(live.filePath)) {
      try {
        fs.unlinkSync(live.filePath)
      } catch {
        /* keep trash copy even if active delete fails */
      }
    }
    this.pathIndex.delete(live.filePath)
    this.notes.delete(noteId)
    this.emit({ type: 'notes-changed' })
  }

  listTrash(): Array<NoteSummary & { deletedAt: string }> {
    if (!this.folder || !fs.existsSync(this.trashDir())) return []
    const out: Array<NoteSummary & { deletedAt: string }> = []
    for (const f of fs.readdirSync(this.trashDir())) {
      if (!f.endsWith('.md') || TEMP_SUFFIX_RE.test(f)) continue
      try {
        const raw = fs.readFileSync(path.join(this.trashDir(), f), 'utf8')
        const doc = parseNoteMarkdown(raw)
        out.push({
          id: doc.frontMatter.id,
          color: doc.frontMatter.color,
          title: deriveTitle(doc.bodyMarkdown),
          preview: derivePreview(doc.bodyMarkdown),
          createdAt: String(doc.frontMatter.created_at),
          updatedAt: String(doc.frontMatter.updated_at),
          fileName: f,
          trashed: true,
          unsupportedMarkup: doc.unsupportedMarkup,
          deletedAt: String(doc.frontMatter.deleted_at ?? doc.frontMatter.updated_at)
        })
      } catch {
        /* skip invalid */
      }
    }
    out.sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt))
    return out
  }

  async restoreFromTrash(noteId: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.folder) return { ok: false, error: 'No storage folder' }
    const trashPath = path.join(this.trashDir(), trashFileName(noteId))
    if (!fs.existsSync(trashPath)) return { ok: false, error: 'Not in trash' }

    const raw = fs.readFileSync(trashPath, 'utf8')
    const doc = parseNoteMarkdown(raw, noteId)
    delete doc.frontMatter.deleted_at

    const existing = this.notes.get(noteId)
    if (existing) {
      const existingRaw = this.serializeLive(existing)
      if (hashContent(existingRaw) !== hashContent(serializeNoteMarkdown(doc))) {
        return {
          ok: false,
          error:
            'An active note with the same ID already exists and differs. Use Keep both from conflicts, or permanently delete one first.'
        }
      }
    }

    const dest = path.join(this.folder, noteFileName(noteId))
    if (fs.existsSync(dest) && !existing) {
      const diskRaw = fs.readFileSync(dest, 'utf8')
      if (hashContent(diskRaw) !== hashContent(serializeNoteMarkdown(doc))) {
        return {
          ok: false,
          error: 'A divergent active file with this ID exists. Restore canceled to avoid overwrite.'
        }
      }
    }

    await this.writeAtomic(dest, serializeNoteMarkdown(doc))
    fs.unlinkSync(trashPath)
    await this.rescan()
    return { ok: true }
  }

  async permanentlyDelete(noteId: string): Promise<void> {
    if (!this.folder) return
    const trashPath = path.join(this.trashDir(), trashFileName(noteId))
    if (fs.existsSync(trashPath)) fs.unlinkSync(trashPath)
  }

  async emptyTrash(): Promise<void> {
    if (!this.folder || !fs.existsSync(this.trashDir())) return
    for (const f of fs.readdirSync(this.trashDir())) {
      if (f.endsWith('.md')) {
        try {
          fs.unlinkSync(path.join(this.trashDir(), f))
        } catch {
          /* ignore */
        }
      }
    }
  }

  async resolveConflict(
    noteId: string,
    resolution: 'keep_local' | 'keep_disk' | 'keep_both'
  ): Promise<void> {
    const live = this.notes.get(noteId)
    if (!live || !live.conflict) return
    const conflict = live.conflict

    if (conflict.kind === 'duplicate_id' && conflict.duplicatePath) {
      if (resolution === 'keep_local') {
        // Leave primary; rename duplicate to new id
        await this.reassignDuplicate(conflict.duplicatePath)
      } else if (resolution === 'keep_disk') {
        // Load duplicate into primary, reassign old primary file
        const read = await this.stableRead(conflict.duplicatePath)
        if (read) {
          const snap = this.snapshotFromRaw(conflict.duplicatePath, read.raw, read.mtimeMs)
          // Save current as new note
          await this.spillAsNewNote(live)
          this.applyExternalClean(live, snap, conflict.duplicatePath)
        }
      } else {
        await this.reassignDuplicate(conflict.duplicatePath)
      }
      live.conflict = null
      this.emit({ type: 'notes-changed' })
      return
    }

    if (resolution === 'keep_local') {
      live.dirty = true
      live.baseHash = live.diskHash
      live.baseRaw = live.diskRaw
      live.baseBody = parseNoteMarkdown(live.diskRaw, live.id).bodyMarkdown
      live.baseFrontMatter = { ...parseNoteMarkdown(live.diskRaw, live.id).frontMatter }
      live.conflict = null
      await this.saveNote(noteId)
    } else if (resolution === 'keep_disk') {
      const diskDoc = parseNoteMarkdown(live.diskRaw, live.id)
      live.editorBody = diskDoc.bodyMarkdown
      live.editorFrontMatter = { ...diskDoc.frontMatter }
      live.baseRaw = live.diskRaw
      live.baseHash = live.diskHash
      live.baseBody = diskDoc.bodyMarkdown
      live.baseFrontMatter = { ...diskDoc.frontMatter }
      live.dirty = false
      live.conflict = null
      this.emit({ type: 'note-external', noteId })
    } else {
      // keep both: spill local as new note, take disk as current
      await this.spillAsNewNote(live)
      const diskDoc = parseNoteMarkdown(live.diskRaw, live.id)
      live.editorBody = diskDoc.bodyMarkdown
      live.editorFrontMatter = { ...diskDoc.frontMatter }
      live.baseRaw = live.diskRaw
      live.baseHash = live.diskHash
      live.baseBody = diskDoc.bodyMarkdown
      live.baseFrontMatter = { ...diskDoc.frontMatter }
      live.dirty = false
      live.conflict = null
      this.emit({ type: 'note-external', noteId })
    }
    this.emit({ type: 'notes-changed' })
  }

  private async spillAsNewNote(live: LiveNote): Promise<void> {
    if (!this.folder) return
    const newId = generateNoteId()
    const fm = {
      ...live.editorFrontMatter,
      id: newId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
    const raw = serializeNoteMarkdown({
      frontMatter: fm,
      bodyMarkdown: live.editorBody,
      unsupportedMarkup: live.unsupportedMarkup,
      unsupportedReason: live.unsupportedReason
    })
    const filePath = path.join(this.folder, noteFileName(newId))
    await this.writeAtomic(filePath, raw)
    const snap = this.snapshotFromRaw(filePath, raw, Date.now())
    const neu = this.liveFromSnapshot(snap, filePath)
    neu.lastOwnWriteHash = snap.contentHash
    this.notes.set(newId, neu)
    this.pathIndex.set(filePath, newId)
  }

  private async reassignDuplicate(filePath: string): Promise<void> {
    const read = await this.stableRead(filePath)
    if (!read || !this.folder) return
    const doc = parseNoteMarkdown(read.raw)
    const newId = generateNoteId()
    doc.frontMatter = {
      ...doc.frontMatter,
      id: newId,
      updated_at: new Date().toISOString()
    }
    const newPath = path.join(this.folder, noteFileName(newId))
    const raw = serializeNoteMarkdown(doc)
    await this.writeAtomic(newPath, raw)
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* leave old conflict copy if locked */
    }
    const snap = this.snapshotFromRaw(newPath, raw, Date.now())
    const live = this.liveFromSnapshot(snap, newPath)
    live.lastOwnWriteHash = snap.contentHash
    this.notes.set(newId, live)
    this.pathIndex.set(newPath, newId)
  }

  async flushAll(): Promise<void> {
    for (const id of this.notes.keys()) {
      const live = this.notes.get(id)
      if (live?.dirty) {
        await this.saveNote(id)
      }
    }
  }

  /** Open an existing collection folder without merging into the previous one. */
  async openCollection(folder: string): Promise<void> {
    await this.setFolder(folder)
  }

  /** Copy notes from current folder into a new folder (explicit migrate). */
  async migrateCollection(destFolder: string): Promise<void> {
    if (!this.folder) throw new Error('No current folder')
    await this.flushAll()
    fs.mkdirSync(destFolder, { recursive: true })
    fs.mkdirSync(path.join(destFolder, TRASH_DIR), { recursive: true })

    for (const f of fs.readdirSync(this.folder)) {
      if (!f.endsWith('.md')) continue
      const src = path.join(this.folder, f)
      const dest = path.join(destFolder, f)
      if (fs.existsSync(dest)) {
        throw new Error(`Destination already contains ${f}. Migrate canceled to avoid overwrite.`)
      }
      fs.copyFileSync(src, dest)
    }
    const trashSrc = this.trashDir()
    if (fs.existsSync(trashSrc)) {
      for (const f of fs.readdirSync(trashSrc)) {
        if (!f.endsWith('.md')) continue
        const dest = path.join(destFolder, TRASH_DIR, f)
        if (fs.existsSync(dest)) {
          throw new Error(`Destination trash already contains ${f}. Migrate canceled.`)
        }
        fs.copyFileSync(path.join(trashSrc, f), dest)
      }
    }
    await this.setFolder(destFolder)
  }
}

export const storage = new StorageService()
