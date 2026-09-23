import type { NoteColor } from '@shared/note-model'

export const COLOR_VALUES: Record<NoteColor, { light: string; darkAccent: string; header: string }> = {
  yellow: { light: '#fff6a5', darkAccent: '#e6c200', header: '#f0e07a' },
  green: { light: '#c8f0c8', darkAccent: '#3d9e5f', header: '#a8e0a8' },
  pink: { light: '#f8c8dc', darkAccent: '#d46b9a', header: '#f0b0cc' },
  purple: { light: '#e0d0f8', darkAccent: '#8b6cc4', header: '#d0b8f0' },
  blue: { light: '#c8e4f8', darkAccent: '#4a90c4', header: '#a8d4f0' },
  teal: { light: '#b8ebe3', darkAccent: '#2a9b8a', header: '#90d8cc' },
  orange: { light: '#ffd8b0', darkAccent: '#e08a40', header: '#f0c090' },
  red: { light: '#f8c8c4', darkAccent: '#c45c52', header: '#e8a8a0' },
  gray: { light: '#e4e4e4', darkAccent: '#888888', header: '#d0d0d0' }
}

export async function applyTheme(): Promise<'light' | 'dark'> {
  const theme = await window.tack.getThemeResolved()
  document.documentElement.dataset.theme = theme
  return theme
}

export function useThemeListener(): void {
  // called from components via useEffect
}
