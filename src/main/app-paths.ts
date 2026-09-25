import fs from 'fs'
import path from 'path'

const SETTINGS_FILE = 'settings.json'
const SESSION_FILE = 'session.json'
const RECOVERY_DIR = 'recovery'
const CACHE_DIR = 'cache'

let appDataOverride: string | null = process.env.TACK_APPDATA ?? null

export function setAppDataRootForTests(dir: string | null): void {
  appDataOverride = dir
}

function electronAppPath(name: 'userData' | 'documents'): string {
  // Lazy require so unit tests can run without a full Electron runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron')
  return app.getPath(name)
}

export function getAppDataRoot(): string {
  if (appDataOverride) return appDataOverride
  return path.join(electronAppPath('userData'))
}

export function getRecoveryDir(): string {
  return path.join(getAppDataRoot(), RECOVERY_DIR)
}

export function getCacheDir(): string {
  return path.join(getAppDataRoot(), CACHE_DIR)
}

export function getDefaultStorageFolder(): string {
  if (appDataOverride) {
    return path.join(appDataOverride, 'Documents', 'Tack Notes')
  }
  return path.join(electronAppPath('documents'), 'Tack Notes')
}

import type { AppSettings, SessionState, ThemePreference } from '@shared/note-model'
import { DEFAULT_NOTE_FONT_SIZE, isNoteFontSize } from '@shared/note-model'

const defaultSettings = (): AppSettings => ({
  storageFolder: null,
  theme: 'system',
  noteFontSize: DEFAULT_NOTE_FONT_SIZE,
  launchAtLogin: false,
  rememberWindowLayout: true,
  hideTaskbarIcon: false,
  hideTrayIcon: false,
  setupComplete: false
})

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback
    const raw = fs.readFileSync(filePath, 'utf8')
    return { ...fallback, ...JSON.parse(raw) } as T
  } catch {
    return fallback
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

export function loadSettings(): AppSettings {
  ensureDir(getAppDataRoot())
  const loaded = readJson(path.join(getAppDataRoot(), SETTINGS_FILE), defaultSettings())
  if (!isNoteFontSize(loaded.noteFontSize)) {
    loaded.noteFontSize = DEFAULT_NOTE_FONT_SIZE
  }
  return loaded
}

export function saveSettings(settings: AppSettings): void {
  writeJson(path.join(getAppDataRoot(), SETTINGS_FILE), settings)
}

export function patchSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch }
  saveSettings(next)
  return next
}

export function loadSession(): SessionState {
  return readJson<SessionState>(path.join(getAppDataRoot(), SESSION_FILE), {
    central: null,
    openNotes: [],
    noteLayouts: []
  })
}

export function saveSession(session: SessionState): void {
  writeJson(path.join(getAppDataRoot(), SESSION_FILE), session)
}

export function resolveTheme(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { nativeTheme } = require('electron') as typeof import('electron')
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function writeRecoverySnapshot(
  noteId: string,
  kind: 'base' | 'local' | 'disk' | 'pending',
  content: string
): string {
  const dir = path.join(getRecoveryDir(), noteId)
  ensureDir(dir)
  const file = path.join(dir, `${kind}-${Date.now()}.md`)
  fs.writeFileSync(file, content, 'utf8')
  pruneRecovery(noteId, 12)
  return file
}

function pruneRecovery(noteId: string, keep: number): void {
  const dir = path.join(getRecoveryDir(), noteId)
  if (!fs.existsSync(dir)) return
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const extra of files.slice(keep)) {
    try {
      fs.unlinkSync(path.join(dir, extra.f))
    } catch {
      /* ignore */
    }
  }
}

export function listPendingRecovery(): Array<{ noteId: string; file: string }> {
  const root = getRecoveryDir()
  if (!fs.existsSync(root)) return []
  const out: Array<{ noteId: string; file: string }> = []
  for (const noteId of fs.readdirSync(root)) {
    const dir = path.join(root, noteId)
    if (!fs.statSync(dir).isDirectory()) continue
    const pending = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('pending-'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    if (pending[0]) {
      out.push({ noteId, file: path.join(dir, pending[0].f) })
    }
  }
  return out
}

export function clearPendingRecovery(noteId: string): void {
  const dir = path.join(getRecoveryDir(), noteId)
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('pending-')) {
      try {
        fs.unlinkSync(path.join(dir, f))
      } catch {
        /* ignore */
      }
    }
  }
}
