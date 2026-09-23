import { app } from 'electron'
import { destroyTray } from './tray'
import { windows } from './windows'
import { storage } from './storage'

let quitting = false

export function isAppQuitting(): boolean {
  return quitting
}

export async function quitApp(): Promise<void> {
  if (quitting) return
  quitting = true
  windows.setQuitting(true)
  try {
    await storage.flushAll()
  } catch {
    /* best effort */
  }
  windows.persistSession()
  destroyTray()
  await storage.close()
  app.quit()
}
