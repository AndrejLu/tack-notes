import {
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions
} from 'electron'
import path from 'path'
import { loadSession, saveSession, loadSettings } from './app-paths'
import { storage } from './storage'
import { getIconPath } from './app-icon'
import type { NoteWindowState, SessionState, WindowBounds } from '@shared/note-model'

function preloadPath(): string {
  return path.join(__dirname, '../preload/index.js')
}

function pageUrl(name: 'central' | 'note' | 'settings' | 'setup', query?: Record<string, string>): string {
  const q = query ? `?${new URLSearchParams(query).toString()}` : ''
  if (process.env.ELECTRON_RENDERER_URL) {
    return `${process.env.ELECTRON_RENDERER_URL}/${name}.html${q}`
  }
  return `file://${path.join(__dirname, `../renderer/${name}.html`)}${q}`
}

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

function applySecurity(win: BrowserWindow): void {
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP]
      }
    })
  })
}

function clampToVisible(bounds: WindowBounds): WindowBounds {
  const displays = screen.getAllDisplays()
  const overlaps = displays.some((d) => {
    const b = d.workArea
    return (
      bounds.x + bounds.width > b.x + 40 &&
      bounds.x < b.x + b.width - 40 &&
      bounds.y + bounds.height > b.y + 40 &&
      bounds.y < b.y + b.height - 40
    )
  })
  if (overlaps) return bounds
  const primary = screen.getPrimaryDisplay().workArea
  return {
    x: primary.x + 80,
    y: primary.y + 80,
    width: Math.min(bounds.width, primary.width - 100),
    height: Math.min(bounds.height, primary.height - 100)
  }
}

function baseOptions(extra?: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
  const hideTaskbar = loadSettings().hideTaskbarIcon === true
  return {
    show: false,
    autoHideMenuBar: true,
    icon: getIconPath(),
    skipTaskbar: hideTaskbar,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    ...extra
  }
}

function boundsFromWindow(win: BrowserWindow): WindowBounds {
  const b = win.getBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

export class WindowManager {
  central: BrowserWindow | null = null
  settings: BrowserWindow | null = null
  setup: BrowserWindow | null = null
  notes = new Map<string, BrowserWindow>()
  /** Last known layout per note — survives close/reopen. */
  private noteLayouts = new Map<string, NoteWindowState>()
  private quitting = false
  private cascadeIndex = 0

  constructor() {
    this.hydrateLayoutsFromDisk()
  }

  private hydrateLayoutsFromDisk(): void {
    const session = loadSession()
    for (const layout of session.noteLayouts ?? []) {
      this.noteLayouts.set(layout.noteId, layout)
    }
    // Migrate older sessions that only stored openNotes
    for (const layout of session.openNotes ?? []) {
      if (!this.noteLayouts.has(layout.noteId)) {
        this.noteLayouts.set(layout.noteId, layout)
      }
    }
  }

  setQuitting(v: boolean): void {
    this.quitting = v
  }

  private remembersLayout(): boolean {
    return loadSettings().rememberWindowLayout !== false
  }

  private rememberLayout(state: NoteWindowState): void {
    this.noteLayouts.set(state.noteId, {
      noteId: state.noteId,
      bounds: { ...state.bounds },
      alwaysOnTop: state.alwaysOnTop,
      isMinimized: state.isMinimized
    })
  }

  /** Forget saved window positions/sizes. Keeps always-on-top flags. */
  clearStoredBounds(): void {
    for (const [id, layout] of this.noteLayouts) {
      this.noteLayouts.set(id, {
        noteId: id,
        alwaysOnTop: layout.alwaysOnTop,
        bounds: { x: 0, y: 0, width: 300, height: 320 },
        isMinimized: false
      })
    }
    const session = loadSession()
    const openNotes: NoteWindowState[] = []
    for (const [noteId, win] of this.notes) {
      if (win.isDestroyed()) continue
      const layout = this.noteLayouts.get(noteId)
      openNotes.push({
        noteId,
        bounds: boundsFromWindow(win),
        alwaysOnTop: layout?.alwaysOnTop ?? win.isAlwaysOnTop(),
        isMinimized: win.isMinimized()
      })
    }
    saveSession({
      central: null,
      openNotes: this.remembersLayout() ? openNotes : openNotes.map((n) => ({
        ...n,
        // Still track which notes are open for launch restore, but don't reuse sizes later
        bounds: n.bounds
      })),
      noteLayouts: [...this.noteLayouts.values()].map((l) => ({
        noteId: l.noteId,
        alwaysOnTop: l.alwaysOnTop,
        bounds: { x: 0, y: 0, width: 300, height: 320 },
        isMinimized: false
      }))
    })
  }

  private captureNoteLayout(noteId: string, win: BrowserWindow): NoteWindowState {
    const prev = this.noteLayouts.get(noteId)
    const state: NoteWindowState = {
      noteId,
      bounds: boundsFromWindow(win),
      alwaysOnTop: prev?.alwaysOnTop ?? win.isAlwaysOnTop(),
      isMinimized: win.isMinimized()
    }
    this.rememberLayout(state)
    return state
  }

  private buildSessionSnapshot(): SessionState {
    const prev = loadSession()
    const remember = this.remembersLayout()
    const openNotes: NoteWindowState[] = []
    for (const [noteId, win] of this.notes) {
      if (win.isDestroyed()) continue
      openNotes.push(this.captureNoteLayout(noteId, win))
    }

    const centralBounds = this.central && !this.central.isDestroyed() ? this.central.getBounds() : null

    return {
      central:
        remember && centralBounds
          ? {
              bounds: {
                x: centralBounds.x,
                y: centralBounds.y,
                width: centralBounds.width,
                height: centralBounds.height
              },
              wasVisible: this.central!.isVisible()
            }
          : remember
            ? prev.central
            : null,
      openNotes,
      noteLayouts: remember
        ? [...this.noteLayouts.values()]
        : [...this.noteLayouts.values()].map((l) => ({
            noteId: l.noteId,
            alwaysOnTop: l.alwaysOnTop,
            bounds: { x: 0, y: 0, width: 300, height: 320 },
            isMinimized: false
          }))
    }
  }

  persistSession(): void {
    saveSession(this.buildSessionSnapshot())
  }

  private defaultBounds(): WindowBounds {
    const primary = screen.getPrimaryDisplay().workArea
    const offset = (this.cascadeIndex % 8) * 28
    this.cascadeIndex += 1
    return {
      x: primary.x + 100 + offset,
      y: primary.y + 100 + offset,
      width: 300,
      height: 320
    }
  }

  createCentral(): BrowserWindow {
    if (this.central && !this.central.isDestroyed()) {
      this.central.show()
      this.central.focus()
      return this.central
    }
    const session = loadSession()
    const bounds =
      this.remembersLayout() && session.central?.bounds
        ? clampToVisible(session.central.bounds)
        : { x: undefined, y: undefined, width: 360, height: 560 }

    const win = new BrowserWindow(
      baseOptions({
        width: bounds.width ?? 360,
        height: bounds.height ?? 560,
        x: bounds.x,
        y: bounds.y,
        minWidth: 280,
        minHeight: 360,
        title: 'Tack Notes',
        backgroundColor: '#f5f0e6'
      })
    )
    applySecurity(win)
    void win.loadURL(pageUrl('central'))
    win.once('ready-to-show', () => win.show())
    win.on('close', (e) => {
      if (this.quitting) return
      e.preventDefault()
      win.hide()
      this.persistSession()
    })
    win.on('moved', () => this.persistSession())
    win.on('resized', () => this.persistSession())
    this.central = win
    return win
  }

  showCentral(): void {
    const win = this.createCentral()
    win.show()
    win.focus()
  }

  hideCentral(): void {
    this.central?.hide()
  }

  createSetup(): BrowserWindow {
    if (this.setup && !this.setup.isDestroyed()) {
      this.setup.focus()
      return this.setup
    }
    const win = new BrowserWindow(
      baseOptions({
        width: 520,
        height: 420,
        resizable: false,
        title: 'Welcome to Tack Notes',
        backgroundColor: '#f5f0e6'
      })
    )
    applySecurity(win)
    void win.loadURL(pageUrl('setup'))
    win.once('ready-to-show', () => win.show())
    this.setup = win
    return win
  }

  closeSetup(): void {
    if (this.setup && !this.setup.isDestroyed()) {
      this.setup.destroy()
    }
    this.setup = null
  }

  openSettings(): BrowserWindow {
    if (this.settings && !this.settings.isDestroyed()) {
      this.settings.show()
      this.settings.focus()
      return this.settings
    }
    const win = new BrowserWindow(
      baseOptions({
        width: 520,
        height: 480,
        minWidth: 440,
        minHeight: 360,
        resizable: true,
        title: 'Tack Notes Settings',
        backgroundColor: '#f5f0e6'
      })
    )
    applySecurity(win)
    void win.loadURL(pageUrl('settings'))
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      this.settings = null
    })
    this.settings = win
    return win
  }

  /** Grow/shrink settings window to fit content, capped to the work area. */
  resizeSettingsToContent(contentHeight: number): void {
    const win = this.settings
    if (!win || win.isDestroyed()) return

    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const frame = win.getSize()
    const content = win.getContentSize()
    const chromeY = Math.max(0, frame[1] - content[1])
    const chromeX = Math.max(0, frame[0] - content[0])

    const width = Math.max(520, content[0])
    const maxContentHeight = Math.max(320, display.workArea.height - chromeY - 48)
    const target = Math.ceil(contentHeight + 2)
    const nextContentHeight = Math.min(Math.max(target, 360), maxContentHeight)

    win.setContentSize(width, nextContentHeight)

    // Keep on-screen after resize
    const after = win.getBounds()
    const work = display.workArea
    let { x, y } = after
    if (y + after.height > work.y + work.height) {
      y = Math.max(work.y, work.y + work.height - after.height)
    }
    if (x + after.width > work.x + work.width) {
      x = Math.max(work.x, work.x + work.width - after.width)
    }
    if (x !== after.x || y !== after.y) {
      win.setPosition(Math.round(x), Math.round(y))
    }
    void chromeX
  }

  getNoteWindow(noteId: string): BrowserWindow | undefined {
    const win = this.notes.get(noteId)
    if (win && !win.isDestroyed()) return win
    this.notes.delete(noteId)
    return undefined
  }

  openNote(
    noteId: string,
    opts?: { bounds?: WindowBounds; alwaysOnTop?: boolean; color?: string }
  ): BrowserWindow {
    const existing = this.getNoteWindow(noteId)
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }

    const saved = this.noteLayouts.get(noteId)
    const rawBounds =
      opts?.bounds ??
      (this.remembersLayout() ? saved?.bounds : undefined) ??
      this.defaultBounds()
    const bounds = clampToVisible(rawBounds)
    const alwaysOnTop = opts?.alwaysOnTop ?? saved?.alwaysOnTop ?? false

    const win = new BrowserWindow(
      baseOptions({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        minWidth: 240,
        minHeight: 180,
        title: 'Note',
        frame: false,
        transparent: false,
        backgroundColor: '#fff6a5',
        alwaysOnTop
      })
    )
    applySecurity(win)
    void win.loadURL(pageUrl('note', { id: noteId }))
    win.once('ready-to-show', () => {
      win.show()
      if (saved?.isMinimized) win.minimize()
    })
    let closing = false
    win.on('close', (e) => {
      if (this.quitting || closing) return
      e.preventDefault()
      closing = true
      if (!win.isDestroyed()) {
        this.captureNoteLayout(noteId, win)
        this.persistSession()
      }
      void (async () => {
        try {
          await storage.saveNote(noteId)
        } catch {
          /* best effort */
        }
        if (!win.isDestroyed()) win.destroy()
      })()
    })
    win.on('closed', () => {
      this.notes.delete(noteId)
      // Keep layout; only drop from currently-open list
      const snapshot = this.buildSessionSnapshot()
      snapshot.openNotes = snapshot.openNotes.filter((n) => n.noteId !== noteId)
      saveSession(snapshot)
    })
    win.on('moved', () => this.persistSession())
    win.on('resized', () => this.persistSession())

    this.notes.set(noteId, win)
    this.rememberLayout({ noteId, bounds, alwaysOnTop })
    this.persistSession()
    return win
  }

  setAlwaysOnTop(noteId: string, value: boolean): void {
    const win = this.getNoteWindow(noteId)
    win?.setAlwaysOnTop(value)
    const prev = this.noteLayouts.get(noteId)
    this.rememberLayout({
      noteId,
      bounds: win ? boundsFromWindow(win) : prev?.bounds ?? this.defaultBounds(),
      alwaysOnTop: value,
      isMinimized: win?.isMinimized()
    })
    this.persistSession()
  }

  isAlwaysOnTop(noteId: string): boolean {
    return this.noteLayouts.get(noteId)?.alwaysOnTop ?? this.getNoteWindow(noteId)?.isAlwaysOnTop() ?? false
  }

  closeNoteWindow(noteId: string): void {
    const win = this.getNoteWindow(noteId)
    if (win && !win.isDestroyed()) {
      this.captureNoteLayout(noteId, win)
      win.destroy()
    }
    const snapshot = this.buildSessionSnapshot()
    snapshot.openNotes = snapshot.openNotes.filter((n) => n.noteId !== noteId)
    saveSession(snapshot)
  }

  minimizeNoteWindow(noteId: string): void {
    this.getNoteWindow(noteId)?.minimize()
  }

  applyTaskbarVisibility(): void {
    const skip = loadSettings().hideTaskbarIcon === true
    for (const win of this.allWindows()) {
      win.setSkipTaskbar(skip)
    }
  }

  hideAllNotes(): void {
    for (const [noteId, win] of this.notes) {
      if (win.isDestroyed()) continue
      this.captureNoteLayout(noteId, win)
      win.hide()
    }
    this.persistSession()
  }

  showAllNotes(): void {
    let visibleCount = 0
    for (const win of this.notes.values()) {
      if (win.isDestroyed()) continue
      if (win.isMinimized()) win.restore()
      win.show()
      visibleCount++
    }
    if (visibleCount === 0) {
      const session = loadSession()
      const remember = this.remembersLayout()
      for (const n of session.openNotes) {
        this.openNote(n.noteId, {
          bounds: remember ? n.bounds : undefined,
          alwaysOnTop: n.alwaysOnTop
        })
      }
    }
  }

  private allWindows(): BrowserWindow[] {
    const list: BrowserWindow[] = []
    for (const win of [this.central, this.settings, this.setup, ...this.notes.values()]) {
      if (win && !win.isDestroyed()) list.push(win)
    }
    return list
  }

  restoreOpenNotes(openIds: string[]): void {
    const session = loadSession()
    const ids =
      openIds.length > 0
        ? session.openNotes.filter((n) => openIds.includes(n.noteId))
        : session.openNotes
    for (const n of ids) {
      this.openNote(n.noteId, { bounds: n.bounds, alwaysOnTop: n.alwaysOnTop })
    }
  }

  broadcast(channel: string, payload: unknown): void {
    const windows = [this.central, this.settings, ...this.notes.values()]
    for (const win of windows) {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload)
      }
    }
  }

  sendToNote(noteId: string, channel: string, payload: unknown): void {
    const win = this.getNoteWindow(noteId)
    win?.webContents.send(channel, payload)
  }
}

export const windows = new WindowManager()
