/** Narrow IPC contract between main and renderer processes. */

import type {
  AppSettings,
  NoteColor,
  NoteConflict,
  NoteSummary,
  ThemePreference,
  WindowBounds
} from './note-model'

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'unsaved'

export interface NoteEditorPayload {
  id: string
  color: NoteColor
  bodyMarkdown: string
  title: string
  updatedAt: string
  unsupportedMarkup: boolean
  unsupportedReason?: string
  alwaysOnTop: boolean
  saveStatus: SaveStatus
  conflict: NoteConflict | null
}

export interface TrashEntry extends NoteSummary {
  deletedAt: string
}

export interface IpcApi {
  // App lifecycle / settings
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  pickStorageFolder(): Promise<string | null>
  completeSetup(storageFolder: string): Promise<void>
  changeStorageFolder(folder: string, mode: 'open' | 'migrate'): Promise<{ ok: boolean; error?: string }>
  getDefaultStorageFolder(): Promise<string>
  setTheme(theme: ThemePreference): Promise<void>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  getThemeResolved(): Promise<'light' | 'dark'>

  // Notes list
  listNotes(): Promise<NoteSummary[]>
  createNote(color?: NoteColor): Promise<NoteSummary>
  openNote(noteId: string): Promise<void>
  deleteNote(noteId: string): Promise<void>
  searchNotes(query: string): Promise<NoteSummary[]>

  // Note window
  getNote(noteId: string): Promise<NoteEditorPayload | null>
  updateNoteBody(noteId: string, bodyMarkdown: string): Promise<{ status: SaveStatus; conflict?: NoteConflict }>
  setNoteColor(noteId: string, color: NoteColor): Promise<void>
  setAlwaysOnTop(noteId: string, value: boolean): Promise<void>
  closeNoteWindow(noteId: string): Promise<void>
  minimizeNoteWindow(noteId: string): Promise<void>
  flushNote(noteId: string): Promise<{ status: SaveStatus; error?: string }>
  resolveConflict(
    noteId: string,
    resolution: 'keep_local' | 'keep_disk' | 'keep_both'
  ): Promise<void>
  retrySave(noteId: string): Promise<{ status: SaveStatus; error?: string }>

  // Trash
  listTrash(): Promise<TrashEntry[]>
  restoreFromTrash(noteId: string): Promise<{ ok: boolean; error?: string }>
  permanentlyDelete(noteId: string): Promise<void>
  emptyTrash(): Promise<void>

  // Windows / shell
  showCentral(): Promise<void>
  hideCentral(): Promise<void>
  openSettings(): Promise<void>
  resizeSettingsWindow(contentHeight: number): Promise<void>
  quitApp(): Promise<void>

  // Events from main
  onNotesChanged(cb: (notes: NoteSummary[]) => void): () => void
  onNoteUpdated(cb: (payload: NoteEditorPayload) => void): () => void
  onThemeChanged(cb: (theme: 'light' | 'dark') => void): () => void
  onSaveStatus(cb: (payload: { noteId: string; status: SaveStatus; error?: string }) => void): () => void
}

export const IPC_CHANNELS = {
  invoke: {
    getSettings: 'tack:getSettings',
    updateSettings: 'tack:updateSettings',
    pickStorageFolder: 'tack:pickStorageFolder',
    completeSetup: 'tack:completeSetup',
    changeStorageFolder: 'tack:changeStorageFolder',
    getDefaultStorageFolder: 'tack:getDefaultStorageFolder',
    setTheme: 'tack:setTheme',
    setLaunchAtLogin: 'tack:setLaunchAtLogin',
    getThemeResolved: 'tack:getThemeResolved',
    listNotes: 'tack:listNotes',
    createNote: 'tack:createNote',
    openNote: 'tack:openNote',
    deleteNote: 'tack:deleteNote',
    searchNotes: 'tack:searchNotes',
    getNote: 'tack:getNote',
    updateNoteBody: 'tack:updateNoteBody',
    setNoteColor: 'tack:setNoteColor',
    setAlwaysOnTop: 'tack:setAlwaysOnTop',
    closeNoteWindow: 'tack:closeNoteWindow',
    minimizeNoteWindow: 'tack:minimizeNoteWindow',
    flushNote: 'tack:flushNote',
    resolveConflict: 'tack:resolveConflict',
    retrySave: 'tack:retrySave',
    listTrash: 'tack:listTrash',
    restoreFromTrash: 'tack:restoreFromTrash',
    permanentlyDelete: 'tack:permanentlyDelete',
    emptyTrash: 'tack:emptyTrash',
    showCentral: 'tack:showCentral',
    hideCentral: 'tack:hideCentral',
    openSettings: 'tack:openSettings',
    resizeSettingsWindow: 'tack:resizeSettingsWindow',
    quitApp: 'tack:quitApp'
  },
  events: {
    notesChanged: 'tack:notesChanged',
    noteUpdated: 'tack:noteUpdated',
    themeChanged: 'tack:themeChanged',
    saveStatus: 'tack:saveStatus'
  }
} as const

export type BoundsUpdate = { noteId?: string; bounds: WindowBounds }
