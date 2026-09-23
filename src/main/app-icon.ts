import fs from 'fs'
import path from 'path'
import { app, nativeImage, type NativeImage } from 'electron'

function candidates(...names: string[]): string[] {
  const roots = [
    typeof process.resourcesPath === 'string' ? process.resourcesPath : '',
    path.join(__dirname, '../../build'),
    path.join(app.getAppPath(), 'build')
  ].filter(Boolean)

  const out: string[] = []
  for (const root of roots) {
    for (const name of names) {
      out.push(path.join(root, name))
    }
  }
  return out
}

export function getIconPath(): string {
  for (const p of candidates('icon.ico', 'icon.png', 'icon-256.png')) {
    if (fs.existsSync(p)) return p
  }
  return path.join(__dirname, '../../build/icon.ico')
}

export function loadAppIcon(): NativeImage {
  const file = getIconPath()
  if (fs.existsSync(file)) {
    return nativeImage.createFromPath(file)
  }
  return nativeImage.createEmpty()
}

export function loadTrayIcon(): NativeImage {
  for (const p of candidates('icon-32.png', 'icon-16.png', 'icon.ico', 'icon.png')) {
    if (!fs.existsSync(p)) continue
    const img = nativeImage.createFromPath(p)
    if (img.isEmpty()) continue
    // Windows tray looks best around 16–32px
    if (img.getSize().width > 32) {
      return img.resize({ width: 16, height: 16, quality: 'best' })
    }
    return img
  }
  return loadAppIcon().resize({ width: 16, height: 16, quality: 'best' })
}
