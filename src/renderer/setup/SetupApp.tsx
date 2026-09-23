import { useEffect, useState } from 'react'
import { applyTheme } from '../theme'

export function SetupApp() {
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void applyTheme()
    void window.tack.getDefaultStorageFolder().then(setFolder)
  }, [])

  return (
    <div className="setup">
      <div className="setup-hero">
        <div className="logo" aria-hidden />
        <h1>Tack Notes</h1>
        <p>Sticky notes that live as Markdown files in a folder you choose — including cloud-synced folders.</p>
      </div>

      <label className="field">
        <span>Notes folder</span>
        <div className="row">
          <input readOnly value={folder} />
          <button
            type="button"
            onClick={async () => {
              const picked = await window.tack.pickStorageFolder()
              if (picked) setFolder(picked)
            }}
          >
            Browse…
          </button>
        </div>
      </label>

      {error && <p className="error">{error}</p>}

      <button
        type="button"
        className="primary"
        disabled={!folder}
        onClick={async () => {
          try {
            setError(null)
            await window.tack.completeSetup(folder)
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
          }
        }}
      >
        Get started
      </button>

      <p className="fineprint">
        Settings and window layout stay on this PC. Only note Markdown files go in the folder above.
      </p>
    </div>
  )
}
