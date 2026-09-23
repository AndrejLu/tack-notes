import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type IpcApi } from '@shared/ipc'
import type { AppSettings, NoteColor, ThemePreference } from '@shared/note-model'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api: IpcApi = {
  getSettings: () => invoke(IPC_CHANNELS.invoke.getSettings),
  updateSettings: (patch) => invoke(IPC_CHANNELS.invoke.updateSettings, patch),
  pickStorageFolder: () => invoke(IPC_CHANNELS.invoke.pickStorageFolder),
  completeSetup: (folder) => invoke(IPC_CHANNELS.invoke.completeSetup, folder),
  changeStorageFolder: (folder, mode) =>
    invoke(IPC_CHANNELS.invoke.changeStorageFolder, folder, mode),
  getDefaultStorageFolder: () => invoke(IPC_CHANNELS.invoke.getDefaultStorageFolder),
  setTheme: (theme: ThemePreference) => invoke(IPC_CHANNELS.invoke.setTheme, theme),
  setLaunchAtLogin: (enabled: boolean) =>
    invoke(IPC_CHANNELS.invoke.setLaunchAtLogin, enabled),
  getThemeResolved: () => invoke(IPC_CHANNELS.invoke.getThemeResolved),

  listNotes: () => invoke(IPC_CHANNELS.invoke.listNotes),
  createNote: (color?: NoteColor) => invoke(IPC_CHANNELS.invoke.createNote, color),
  openNote: (noteId) => invoke(IPC_CHANNELS.invoke.openNote, noteId),
  deleteNote: (noteId) => invoke(IPC_CHANNELS.invoke.deleteNote, noteId),
  searchNotes: (query) => invoke(IPC_CHANNELS.invoke.searchNotes, query),

  getNote: (noteId) => invoke(IPC_CHANNELS.invoke.getNote, noteId),
  updateNoteBody: (noteId, body) => invoke(IPC_CHANNELS.invoke.updateNoteBody, noteId, body),
  setNoteColor: (noteId, color) => invoke(IPC_CHANNELS.invoke.setNoteColor, noteId, color),
  setAlwaysOnTop: (noteId, value) => invoke(IPC_CHANNELS.invoke.setAlwaysOnTop, noteId, value),
  closeNoteWindow: (noteId) => invoke(IPC_CHANNELS.invoke.closeNoteWindow, noteId),
  minimizeNoteWindow: (noteId) => invoke(IPC_CHANNELS.invoke.minimizeNoteWindow, noteId),
  flushNote: (noteId) => invoke(IPC_CHANNELS.invoke.flushNote, noteId),
  resolveConflict: (noteId, resolution) =>
    invoke(IPC_CHANNELS.invoke.resolveConflict, noteId, resolution),
  retrySave: (noteId) => invoke(IPC_CHANNELS.invoke.retrySave, noteId),

  listTrash: () => invoke(IPC_CHANNELS.invoke.listTrash),
  restoreFromTrash: (noteId) => invoke(IPC_CHANNELS.invoke.restoreFromTrash, noteId),
  permanentlyDelete: (noteId) => invoke(IPC_CHANNELS.invoke.permanentlyDelete, noteId),
  emptyTrash: () => invoke(IPC_CHANNELS.invoke.emptyTrash),

  showCentral: () => invoke(IPC_CHANNELS.invoke.showCentral),
  hideCentral: () => invoke(IPC_CHANNELS.invoke.hideCentral),
  openSettings: () => invoke(IPC_CHANNELS.invoke.openSettings),
  resizeSettingsWindow: (contentHeight: number) =>
    invoke(IPC_CHANNELS.invoke.resizeSettingsWindow, contentHeight),
  quitApp: () => invoke(IPC_CHANNELS.invoke.quitApp),

  onNotesChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, notes: Parameters<typeof cb>[0]) => cb(notes)
    ipcRenderer.on(IPC_CHANNELS.events.notesChanged, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.events.notesChanged, listener)
  },
  onNoteUpdated: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.events.noteUpdated, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.events.noteUpdated, listener)
  },
  onThemeChanged: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, theme: Parameters<typeof cb>[0]) => cb(theme)
    ipcRenderer.on(IPC_CHANNELS.events.themeChanged, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.events.themeChanged, listener)
  },
  onSaveStatus: (cb) => {
    const listener = (_: Electron.IpcRendererEvent, payload: Parameters<typeof cb>[0]) => cb(payload)
    ipcRenderer.on(IPC_CHANNELS.events.saveStatus, listener)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.events.saveStatus, listener)
  }
}

contextBridge.exposeInMainWorld('tack', api)

export type { IpcApi, AppSettings }
