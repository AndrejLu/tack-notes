import { app, nativeTheme } from 'electron'
import { createTray, destroyTray } from './tray'
import { windows } from './windows'
import { storage } from './storage'
import { registerIpc, broadcastNotes } from './ipc'
import { quitApp } from './lifecycle'
import {
  loadSettings,
  patchSettings,
  resolveTheme,
  loadSession
} from './app-paths'

/** Windows taskbar grouping / Jump List identity — must not say "Electron". */
if (process.platform === 'win32') {
  app.setAppUserModelId('app.tack.notes')
}

function setupJumpList(): void {
  if (process.platform !== 'win32') return
  try {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: '--new-note',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'New note',
        description: 'Create a new sticky note'
      },
      {
        program: process.execPath,
        arguments: '--hide-all-notes',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Hide all notes',
        description: 'Hide all open note windows'
      },
      {
        program: process.execPath,
        arguments: '--show-all-notes',
        iconPath: process.execPath,
        iconIndex: 0,
        title: 'Show all notes',
        description: 'Show all note windows'
      }
    ])
  } catch {
    /* Jump lists unavailable */
  }
}

function ensureReadyForNotes(): boolean {
  if (!loadSettings().setupComplete) {
    windows.createSetup()
    return false
  }
  return true
}

function createNewNoteFromShell(): void {
  if (!ensureReadyForNotes()) return
  try {
    const note = storage.createNote()
    broadcastNotes()
    windows.openNote(note.id)
  } catch {
    windows.showCentral()
  }
}

function handleCliArgs(argv: string[]): boolean {
  if (argv.includes('--hide-all-notes')) {
    if (ensureReadyForNotes()) windows.hideAllNotes()
    return true
  }
  if (argv.includes('--show-all-notes')) {
    if (ensureReadyForNotes()) windows.showAllNotes()
    return true
  }
  if (argv.includes('--new-note')) {
    createNewNoteFromShell()
    return true
  }
  return false
}

async function bootstrap(): Promise<void> {
  registerIpc()
  setupJumpList()

  const settings = loadSettings()
  nativeTheme.themeSource = settings.theme === 'system' ? 'system' : settings.theme

  nativeTheme.on('updated', () => {
    windows.broadcast('tack:themeChanged', resolveTheme(loadSettings().theme))
  })

  createTray({
    newNote: () => createNewNoteFromShell(),
    showAll: () => {
      if (!ensureReadyForNotes()) return
      windows.showCentral()
    },
    hideAllNotes: () => {
      if (!ensureReadyForNotes()) return
      windows.hideAllNotes()
    },
    showAllNotes: () => {
      if (!ensureReadyForNotes()) return
      windows.showAllNotes()
    },
    settings: () => {
      if (!ensureReadyForNotes()) return
      windows.openSettings()
    },
    quit: () => {
      void quitApp()
    }
  })

  app.setLoginItemSettings({
    openAtLogin: settings.launchAtLogin,
    path: process.execPath,
    args: []
  })

  if (!settings.setupComplete || !settings.storageFolder) {
    if (!settings.storageFolder) {
      patchSettings({ storageFolder: null })
    }
    windows.createSetup()
    handleCliArgs(process.argv)
    return
  }

  try {
    await storage.setFolder(settings.storageFolder)
  } catch {
    windows.showCentral()
    return
  }

  const session = loadSession()
  const knownIds = new Set(storage.listNotes().map((n) => n.id))
  const remember = settings.rememberWindowLayout !== false
  for (const n of session.openNotes) {
    if (knownIds.has(n.noteId)) {
      windows.openNote(n.noteId, {
        bounds: remember ? n.bounds : undefined,
        alwaysOnTop: n.alwaysOnTop
      })
    }
  }

  if (process.argv.includes('--hide-all-notes')) {
    windows.hideAllNotes()
  } else if (process.argv.includes('--show-all-notes')) {
    windows.showAllNotes()
  } else if (process.argv.includes('--new-note')) {
    createNewNoteFromShell()
  } else {
    windows.showCentral()
  }

  broadcastNotes()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (!handleCliArgs(argv)) {
      if (!loadSettings().setupComplete) windows.createSetup()
      else windows.showCentral()
    }
  })

  app.whenReady().then(() => {
    void bootstrap()
  })
}

app.on('window-all-closed', () => {
  // Stay alive in the tray on Windows
})

app.on('before-quit', () => {
  windows.setQuitting(true)
})

app.on('activate', () => {
  if (!loadSettings().setupComplete) windows.createSetup()
  else windows.showCentral()
})

app.on('will-quit', () => {
  destroyTray()
})
