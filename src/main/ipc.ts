import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import {
  getDefaultStorageFolder,
  loadSettings,
  patchSettings,
  resolveTheme
} from './app-paths'
import { storage } from './storage'
import { windows } from './windows'
import { applyTrayVisibility } from './tray'
import { quitApp } from './lifecycle'
import { IPC_CHANNELS, type SaveStatus } from '@shared/ipc'
import {
  deriveTitle,
  isNoteColor,
  type NoteColor,
  type ThemePreference
} from '@shared/note-model'
import type { NoteEditorPayload } from '@shared/ipc'

const autosaveTimers = new Map<string, NodeJS.Timeout>()
const AUTOSAVE_MS = 650

function editorPayload(noteId: string): NoteEditorPayload | null {
  const live = storage.getLive(noteId)
  if (!live) return null
  let status: SaveStatus = 'saved'
  if (live.conflict) status = 'conflict'
  else if (live.dirty) status = 'unsaved'
  return {
    id: live.id,
    color: live.editorFrontMatter.color,
    bodyMarkdown: live.editorBody,
    title: deriveTitle(live.editorBody),
    updatedAt: String(live.editorFrontMatter.updated_at),
    unsupportedMarkup: live.unsupportedMarkup,
    unsupportedReason: live.unsupportedReason,
    alwaysOnTop: windows.isAlwaysOnTop(noteId),
    saveStatus: status,
    conflict: live.conflict
  }
}

function broadcastNotes(): void {
  windows.broadcast(IPC_CHANNELS.events.notesChanged, storage.listNotes())
}

function emitSaveStatus(noteId: string, status: SaveStatus, error?: string): void {
  windows.broadcast(IPC_CHANNELS.events.saveStatus, { noteId, status, error })
  const payload = editorPayload(noteId)
  if (payload) {
    windows.sendToNote(noteId, IPC_CHANNELS.events.noteUpdated, payload)
  }
}

function scheduleAutosave(noteId: string): void {
  const prev = autosaveTimers.get(noteId)
  if (prev) clearTimeout(prev)
  autosaveTimers.set(
    noteId,
    setTimeout(() => {
      autosaveTimers.delete(noteId)
      void (async () => {
        emitSaveStatus(noteId, 'saving')
        const result = await storage.saveNote(noteId)
        if (result.conflict) {
          emitSaveStatus(noteId, 'conflict')
        } else if (!result.ok) {
          emitSaveStatus(noteId, 'error', result.error)
        } else {
          emitSaveStatus(noteId, 'saved')
          broadcastNotes()
        }
      })()
    }, AUTOSAVE_MS)
  )
}

export function registerIpc(): void {
  const ch = IPC_CHANNELS.invoke

  ipcMain.handle(ch.getSettings, () => loadSettings())
  ipcMain.handle(ch.updateSettings, (_e, patch: Partial<ReturnType<typeof loadSettings>>) => {
    const prev = loadSettings()
    const next = patchSettings(patch)
    if (
      typeof patch?.rememberWindowLayout === 'boolean' &&
      patch.rememberWindowLayout === false &&
      prev.rememberWindowLayout !== false
    ) {
      windows.clearStoredBounds()
    }
    if (typeof patch?.hideTaskbarIcon === 'boolean') {
      windows.applyTaskbarVisibility()
    }
    if (typeof patch?.hideTrayIcon === 'boolean') {
      applyTrayVisibility()
    }
    return next
  })
  ipcMain.handle(ch.getDefaultStorageFolder, () => getDefaultStorageFolder())
  ipcMain.handle(ch.pickStorageFolder, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Choose notes folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(ch.completeSetup, async (_e, storageFolder: string) => {
    if (typeof storageFolder !== 'string' || !storageFolder.trim()) {
      throw new Error('Invalid folder')
    }
    await storage.setFolder(storageFolder)
    patchSettings({ storageFolder, setupComplete: true })
    windows.closeSetup()
    windows.showCentral()
    broadcastNotes()
  })

  ipcMain.handle(ch.changeStorageFolder, async (_e, folder: string, mode: 'open' | 'migrate') => {
    if (typeof folder !== 'string' || (mode !== 'open' && mode !== 'migrate')) {
      return { ok: false, error: 'Invalid arguments' }
    }
    try {
      await storage.flushAll()
      if (mode === 'migrate') {
        await storage.migrateCollection(folder)
      } else {
        await storage.openCollection(folder)
      }
      patchSettings({ storageFolder: folder })
      // Close all note windows — different collection
      for (const id of [...windows.notes.keys()]) {
        windows.closeNoteWindow(id)
      }
      broadcastNotes()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(ch.setTheme, (_e, theme: ThemePreference) => {
    if (theme !== 'system' && theme !== 'light' && theme !== 'dark') return
    patchSettings({ theme })
    nativeTheme.themeSource = theme === 'system' ? 'system' : theme
    windows.broadcast(IPC_CHANNELS.events.themeChanged, resolveTheme(theme))
  })

  ipcMain.handle(ch.getThemeResolved, () => resolveTheme(loadSettings().theme))

  ipcMain.handle(ch.setLaunchAtLogin, (_e, enabled: boolean) => {
    if (typeof enabled !== 'boolean') return
    patchSettings({ launchAtLogin: enabled })
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
  })

  ipcMain.handle(ch.listNotes, () => storage.listNotes())
  ipcMain.handle(ch.searchNotes, (_e, query: string) =>
    storage.searchNotes(typeof query === 'string' ? query : '')
  )

  ipcMain.handle(ch.createNote, async (_e, color?: NoteColor) => {
    const c = isNoteColor(color) ? color : undefined
    const note = storage.createNote(c)
    broadcastNotes()
    windows.openNote(note.id)
    return note
  })

  ipcMain.handle(ch.openNote, (_e, noteId: string) => {
    if (typeof noteId !== 'string') return
    if (!storage.getLive(noteId)) return
    windows.openNote(noteId)
  })

  ipcMain.handle(ch.deleteNote, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return
    windows.closeNoteWindow(noteId)
    await storage.deleteNote(noteId)
    broadcastNotes()
  })

  ipcMain.handle(ch.getNote, (_e, noteId: string) => {
    if (typeof noteId !== 'string') return null
    return editorPayload(noteId)
  })

  ipcMain.handle(ch.updateNoteBody, (_e, noteId: string, bodyMarkdown: string) => {
    if (typeof noteId !== 'string' || typeof bodyMarkdown !== 'string') {
      return { status: 'error' as const }
    }
    storage.setEditorBody(noteId, bodyMarkdown)
    scheduleAutosave(noteId)
    const live = storage.getLive(noteId)
    return {
      status: (live?.conflict ? 'conflict' : 'unsaved') as SaveStatus,
      conflict: live?.conflict ?? undefined
    }
  })

  ipcMain.handle(ch.setNoteColor, async (_e, noteId: string, color: NoteColor) => {
    if (typeof noteId !== 'string' || !isNoteColor(color)) return
    storage.setColor(noteId, color)
    scheduleAutosave(noteId)
    const payload = editorPayload(noteId)
    if (payload) windows.sendToNote(noteId, IPC_CHANNELS.events.noteUpdated, payload)
    broadcastNotes()
  })

  ipcMain.handle(ch.setAlwaysOnTop, (_e, noteId: string, value: boolean) => {
    if (typeof noteId !== 'string' || typeof value !== 'boolean') return
    windows.setAlwaysOnTop(noteId, value)
  })

  ipcMain.handle(ch.closeNoteWindow, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return
    const t = autosaveTimers.get(noteId)
    if (t) {
      clearTimeout(t)
      autosaveTimers.delete(noteId)
    }
    await storage.saveNote(noteId)
    windows.closeNoteWindow(noteId)
  })

  ipcMain.handle(ch.minimizeNoteWindow, (_e, noteId: string) => {
    if (typeof noteId !== 'string') return
    windows.minimizeNoteWindow(noteId)
  })

  ipcMain.handle(ch.flushNote, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return { status: 'error' as const, error: 'Invalid id' }
    emitSaveStatus(noteId, 'saving')
    const result = await storage.saveNote(noteId)
    if (result.conflict) {
      emitSaveStatus(noteId, 'conflict')
      return { status: 'conflict' as const }
    }
    if (!result.ok) {
      emitSaveStatus(noteId, 'error', result.error)
      return { status: 'error' as const, error: result.error }
    }
    emitSaveStatus(noteId, 'saved')
    return { status: 'saved' as const }
  })

  ipcMain.handle(ch.retrySave, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return { status: 'error' as const, error: 'Invalid id' }
    const result = await storage.saveNote(noteId)
    if (result.conflict) return { status: 'conflict' as const }
    if (!result.ok) return { status: 'error' as const, error: result.error }
    emitSaveStatus(noteId, 'saved')
    broadcastNotes()
    return { status: 'saved' as const }
  })

  ipcMain.handle(ch.resolveConflict, async (_e, noteId: string, resolution: 'keep_local' | 'keep_disk' | 'keep_both') => {
    if (typeof noteId !== 'string') return
    if (!['keep_local', 'keep_disk', 'keep_both'].includes(resolution)) return
    await storage.resolveConflict(noteId, resolution)
    const payload = editorPayload(noteId)
    if (payload) windows.sendToNote(noteId, IPC_CHANNELS.events.noteUpdated, payload)
    broadcastNotes()
  })

  ipcMain.handle(ch.listTrash, () => storage.listTrash())
  ipcMain.handle(ch.restoreFromTrash, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return { ok: false, error: 'Invalid id' }
    const result = await storage.restoreFromTrash(noteId)
    broadcastNotes()
    return result
  })
  ipcMain.handle(ch.permanentlyDelete, async (_e, noteId: string) => {
    if (typeof noteId !== 'string') return
    await storage.permanentlyDelete(noteId)
  })
  ipcMain.handle(ch.emptyTrash, async () => {
    await storage.emptyTrash()
  })

  ipcMain.handle(ch.showCentral, () => windows.showCentral())
  ipcMain.handle(ch.hideCentral, () => windows.hideCentral())
  ipcMain.handle(ch.openSettings, () => windows.openSettings())
  ipcMain.handle(ch.resizeSettingsWindow, (_e, contentHeight: number) => {
    if (typeof contentHeight !== 'number' || !Number.isFinite(contentHeight)) return
    windows.resizeSettingsToContent(contentHeight)
  })
  ipcMain.handle(ch.quitApp, async () => {
    await quitApp()
  })

  storage.onEvent((e) => {
    if (e.type === 'notes-changed') broadcastNotes()
    if (e.type === 'note-external') {
      const payload = editorPayload(e.noteId)
      if (payload) windows.sendToNote(e.noteId, IPC_CHANNELS.events.noteUpdated, payload)
      broadcastNotes()
    }
    if (e.type === 'conflict') {
      const payload = editorPayload(e.conflict.noteId)
      if (payload) windows.sendToNote(e.conflict.noteId, IPC_CHANNELS.events.noteUpdated, payload)
    }
  })
}

export { editorPayload, broadcastNotes }
