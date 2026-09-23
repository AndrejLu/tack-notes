/** Shared types for Tack Notes — platform-independent. */

export const SCHEMA_VERSION = 1

export const NOTE_COLORS = [
  'yellow',
  'green',
  'pink',
  'purple',
  'blue',
  'teal',
  'orange',
  'red',
  'gray'
] as const

export type NoteColor = (typeof NOTE_COLORS)[number]

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === 'string' && (NOTE_COLORS as readonly string[]).includes(value)
}

export interface NoteFrontMatter {
  schema_version: number
  id: string
  color: NoteColor
  created_at: string
  updated_at: string
  /** Unknown fields preserved from disk. */
  [key: string]: unknown
}

export interface NoteDocument {
  frontMatter: NoteFrontMatter
  /** Markdown body without front matter. */
  bodyMarkdown: string
  /** True when body cannot safely round-trip through the rich editor. */
  unsupportedMarkup: boolean
  /** Human-readable reason when unsupportedMarkup is true. */
  unsupportedReason?: string
}

export interface NoteSummary {
  id: string
  color: NoteColor
  title: string
  preview: string
  createdAt: string
  updatedAt: string
  fileName: string
  trashed: boolean
  unsupportedMarkup: boolean
}

export interface NoteSnapshot {
  id: string
  fileName: string
  raw: string
  contentHash: string
  frontMatter: NoteFrontMatter
  bodyMarkdown: string
  mtimeMs: number
  unsupportedMarkup: boolean
  unsupportedReason?: string
}

export type ConflictKind =
  | 'body'
  | 'color'
  | 'metadata'
  | 'duplicate_id'
  | 'deleted_externally'
  | 'merge_failed'

export interface NoteConflict {
  noteId: string
  kind: ConflictKind
  message: string
  baseHash: string
  localHash: string
  diskHash: string
  localBody?: string
  diskBody?: string
  localColor?: NoteColor
  diskColor?: NoteColor
  duplicatePath?: string
}

export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppSettings {
  storageFolder: string | null
  theme: ThemePreference
  launchAtLogin: boolean
  /** Remember note (and central) window positions and sizes. */
  rememberWindowLayout: boolean
  /** Hide app windows from the Windows taskbar (tray-only). */
  hideTaskbarIcon: boolean
  /** Hide the system tray icon. */
  hideTrayIcon: boolean
  /** First-run setup completed. */
  setupComplete: boolean
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface NoteWindowState {
  noteId: string
  bounds: WindowBounds
  alwaysOnTop: boolean
  isMinimized?: boolean
}

export interface CentralWindowState {
  bounds: WindowBounds
  wasVisible: boolean
}

export interface SessionState {
  central: CentralWindowState | null
  /** Notes that should be reopened on launch. */
  openNotes: NoteWindowState[]
  /** Last known bounds / always-on-top for notes (kept after close). */
  noteLayouts: NoteWindowState[]
}

export const DEFAULT_NOTE_COLOR: NoteColor = 'yellow'

export function createEmptyFrontMatter(id: string, color: NoteColor = DEFAULT_NOTE_COLOR): NoteFrontMatter {
  const now = new Date().toISOString()
  return {
    schema_version: SCHEMA_VERSION,
    id,
    color,
    created_at: now,
    updated_at: now
  }
}

export function deriveTitle(bodyMarkdown: string): string {
  const lines = bodyMarkdown.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const cleaned = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+\.\s+/, '')
      .replace(/[*_~`]+/g, '')
      .replace(/<\/?u>/gi, '')
      .trim()
    if (cleaned.length > 0) {
      return cleaned.length > 80 ? `${cleaned.slice(0, 77)}…` : cleaned
    }
  }
  return 'Untitled note'
}

export function derivePreview(bodyMarkdown: string, maxLen = 120): string {
  const plain = bodyMarkdown
    .replace(/\r\n/g, '\n')
    .replace(/^---[\s\S]*?---\n?/, '')
    .replace(/[*_~`>#\[\]()!-]/g, ' ')
    .replace(/<\/?u>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return ''
  return plain.length > maxLen ? `${plain.slice(0, maxLen - 1)}…` : plain
}
