import { Menu, Tray } from 'electron'
import { loadTrayIcon } from './app-icon'
import { loadSettings } from './app-paths'

export type TrayHandlers = {
  newNote: () => void
  showAll: () => void
  hideAllNotes: () => void
  showAllNotes: () => void
  settings: () => void
  quit: () => void
}

let tray: Tray | null = null
let handlers: TrayHandlers | null = null

export function createTray(next: TrayHandlers): Tray | null {
  handlers = next
  return applyTrayVisibility()
}

export function applyTrayVisibility(): Tray | null {
  const hide = loadSettings().hideTrayIcon === true
  if (hide) {
    destroyTray()
    return null
  }
  if (tray) return tray
  if (!handlers) return null

  tray = new Tray(loadTrayIcon())
  tray.setToolTip('Tack Notes')
  rebuildTrayMenu(handlers)
  tray.on('double-click', () => handlers?.showAll())
  return tray
}

export function rebuildTrayMenu(next?: TrayHandlers): void {
  if (next) handlers = next
  if (!tray || !handlers) return
  const h = handlers
  const contextMenu = Menu.buildFromTemplate([
    { label: 'New note', click: () => h.newNote() },
    { label: 'All notes', click: () => h.showAll() },
    { type: 'separator' },
    { label: 'Hide all notes', click: () => h.hideAllNotes() },
    { label: 'Show all notes', click: () => h.showAllNotes() },
    { type: 'separator' },
    { label: 'Settings', click: () => h.settings() },
    { label: 'Quit', click: () => h.quit() }
  ])
  tray.setContextMenu(contextMenu)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
