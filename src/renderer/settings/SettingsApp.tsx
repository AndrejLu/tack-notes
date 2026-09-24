import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AppSettings, ThemePreference } from '@shared/note-model'
import type { TrashEntry } from '@shared/ipc'
import { applyTheme } from '../theme'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { Switch } from '../components/Switch'
import '../components/confirm.css'
import '../components/switch.css'

type PendingConfirm =
  | { kind: 'open'; folder: string }
  | { kind: 'migrate'; folder: string }
  | { kind: 'deleteOne'; id: string }
  | { kind: 'emptyTrash' }

export function SettingsApp() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<'general' | 'trash'>('general')
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const generalHeightRef = useRef(0)

  const reload = async () => {
    setSettings(await window.tack.getSettings())
    setTrash(await window.tack.listTrash())
  }

  useEffect(() => {
    void applyTheme()
    void reload()
    const off = window.tack.onThemeChanged((t) => {
      document.documentElement.dataset.theme = t
    })
    return off
  }, [])

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return

    const fit = () => {
      if (tab === 'general') {
        el.style.height = ''
        el.style.minHeight = ''
        el.style.maxHeight = ''
        const height = Math.ceil(el.getBoundingClientRect().height)
        if (height > 0) {
          generalHeightRef.current = height
          void window.tack.resizeSettingsWindow(height)
        }
        return
      }

      // Trash tab: lock to General height so the list scrolls inside
      const locked = generalHeightRef.current
      if (locked > 0) {
        el.style.height = `${locked}px`
        el.style.minHeight = `${locked}px`
        el.style.maxHeight = `${locked}px`
        void window.tack.resizeSettingsWindow(locked)
      } else {
        const height = Math.ceil(el.getBoundingClientRect().height)
        if (height > 0) void window.tack.resizeSettingsWindow(height)
      }
    }

    fit()
    const frame = requestAnimationFrame(fit)
    const ro = new ResizeObserver(() => {
      if (tab === 'general') fit()
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [settings, tab, trash, message, pending])

  const runConfirm = async () => {
    if (!pending) return
    const action = pending
    setPending(null)
    if (action.kind === 'open') {
      const result = await window.tack.changeStorageFolder(action.folder, 'open')
      setMessage(result.ok ? 'Opened collection.' : result.error ?? 'Failed')
      await reload()
    } else if (action.kind === 'migrate') {
      const result = await window.tack.changeStorageFolder(action.folder, 'migrate')
      setMessage(result.ok ? 'Migrated collection.' : result.error ?? 'Failed')
      await reload()
    } else if (action.kind === 'deleteOne') {
      await window.tack.permanentlyDelete(action.id)
      await reload()
    } else if (action.kind === 'emptyTrash') {
      await window.tack.emptyTrash()
      await reload()
    }
  }

  if (!settings) {
    return (
      <div className="settings" ref={rootRef}>
        Loading…
      </div>
    )
  }

  return (
    <div className="settings" ref={rootRef}>
      <header className="settings-header">
        <h1>Settings</h1>
        <div className="tabs">
          <button type="button" className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>
            General
          </button>
          <button type="button" className={tab === 'trash' ? 'active' : ''} onClick={() => setTab('trash')}>
            Trash ({trash.length})
          </button>
        </div>
        {message && <p className="banner">{message}</p>}
      </header>

      {tab === 'general' && (
        <div className="panel panel-general">
          <section>
            <h2>Notes folder</h2>
            <p className="path">{settings.storageFolder ?? 'Not set'}</p>
            <p className="hint">
              Any local folder works, including cloud-synced ones. Tack Notes only reads and writes Markdown
              files.
            </p>
            <div className="row">
              <button
                type="button"
                disabled={!settings.storageFolder}
                onClick={async () => {
                  const result = await window.tack.openStorageFolder()
                  if (!result.ok) {
                    setMessage(result.error ?? 'Could not open folder')
                  }
                }}
              >
                Open Tack Notes folder
              </button>
              <button
                type="button"
                onClick={async () => {
                  const folder = await window.tack.pickStorageFolder()
                  if (!folder) return
                  setPending({ kind: 'open', folder })
                }}
              >
                Open other folder…
              </button>
              <button
                type="button"
                onClick={async () => {
                  const folder = await window.tack.pickStorageFolder()
                  if (!folder) return
                  setPending({ kind: 'migrate', folder })
                }}
              >
                Migrate to folder…
              </button>
            </div>
          </section>

          <section>
            <h2>Appearance</h2>
            <label className="select-label">
              Theme
              <select
                value={settings.theme}
                onChange={async (e) => {
                  const theme = e.target.value as ThemePreference
                  await window.tack.setTheme(theme)
                  setSettings(await window.tack.getSettings())
                  await applyTheme()
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </section>

          <section>
            <h2>Windows</h2>
            <Switch
              label="Remember window positions and sizes"
              checked={settings.rememberWindowLayout !== false}
              onChange={async (checked) => {
                await window.tack.updateSettings({ rememberWindowLayout: checked })
                setSettings(await window.tack.getSettings())
              }}
            />
            <p className="hint">Notes and the list reopen where you left them when this is on.</p>

            <div className="switch-stack">
              <Switch
                label="Hide taskbar icon"
                checked={settings.hideTaskbarIcon === true}
                onChange={async (checked) => {
                  await window.tack.updateSettings({ hideTaskbarIcon: checked })
                  setSettings(await window.tack.getSettings())
                }}
              />
              <Switch
                label="Hide system tray icon"
                checked={settings.hideTrayIcon === true}
                onChange={async (checked) => {
                  await window.tack.updateSettings({ hideTrayIcon: checked })
                  setSettings(await window.tack.getSettings())
                }}
              />
            </div>
            <p className="hint">
              Keep at least one visible (taskbar or tray) so you can still reach the app when windows
              are closed.
            </p>
          </section>

          <section>
            <h2>Startup</h2>
            <Switch
              label="Launch Tack Notes when I sign in to Windows"
              checked={settings.launchAtLogin}
              onChange={async (checked) => {
                await window.tack.setLaunchAtLogin(checked)
                setSettings(await window.tack.getSettings())
              }}
            />
          </section>
        </div>
      )}

      {tab === 'trash' && (
        <div className="panel panel-trash">
          <p className="hint">Deleted notes stay recoverable until you permanently delete them.</p>
          {trash.length === 0 ? (
            <p className="empty">Trash is empty.</p>
          ) : (
            <ul className="trash-list">
              {trash.map((t) => (
                <li key={t.id}>
                  <div>
                    <strong>{t.title}</strong>
                    <span>Deleted {new Date(t.deletedAt).toLocaleString()}</span>
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      onClick={async () => {
                        const r = await window.tack.restoreFromTrash(t.id)
                        setMessage(r.ok ? 'Restored.' : r.error ?? 'Restore failed')
                        await reload()
                      }}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setPending({ kind: 'deleteOne', id: t.id })}
                    >
                      Delete forever
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {trash.length > 0 && (
            <button type="button" className="danger" onClick={() => setPending({ kind: 'emptyTrash' })}>
              Empty trash
            </button>
          )}
        </div>
      )}

      {pending?.kind === 'open' && (
        <ConfirmDialog
          title="Open folder"
          message="Open this folder as a different note collection? Your current notes will not be copied."
          confirmLabel="Open"
          onCancel={() => setPending(null)}
          onConfirm={() => void runConfirm()}
        />
      )}
      {pending?.kind === 'migrate' && (
        <ConfirmDialog
          title="Migrate notes"
          message="Copy all notes from the current folder into the selected folder? Originals are kept. Migration is canceled if the destination already has conflicting files."
          confirmLabel="Migrate"
          onCancel={() => setPending(null)}
          onConfirm={() => void runConfirm()}
        />
      )}
      {pending?.kind === 'deleteOne' && (
        <ConfirmDialog
          title="Delete forever"
          message="Permanently delete this note? This cannot be undone."
          confirmLabel="Delete"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => void runConfirm()}
        />
      )}
      {pending?.kind === 'emptyTrash' && (
        <ConfirmDialog
          title="Empty trash"
          message="Permanently delete all notes in trash? This cannot be undone."
          confirmLabel="Empty trash"
          danger
          onCancel={() => setPending(null)}
          onConfirm={() => void runConfirm()}
        />
      )}
    </div>
  )
}
