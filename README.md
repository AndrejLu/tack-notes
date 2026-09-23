# Tack Notes

Desktop sticky notes for Windows. Each note is a plain UTF-8 Markdown file with YAML front matter — readable in Notepad++, editable offline, and safe to keep in a folder synced by Nextcloud, Dropbox, Google Drive, or OneDrive.

Tack Notes is an original app. It is not affiliated with Microsoft Sticky Notes.

## Features

- Central notes list with search, color indicators, and sort by last modified
- Independent, movable, resizable note windows (no duplicate windows per note)
- Rich text: bold, italic, underline, strikethrough, bullets, checklists
- Per-note colors and optional always-on-top
- System tray with New note, All notes, Settings, Quit
- Recoverable trash inside the notes collection
- Autosave to Markdown; local window state outside the synced folder
- Light / dark / system themes
- Launch at Windows sign-in (optional)
- Best-effort merge when files change externally, with conflict UI and local recovery snapshots

## Requirements

- Windows 10/11 (x64)
- For development: Node.js 20+ and npm

## Development

```bash
npm install
npm run dev
```

### Scripts

| Command | Description |
|--------|-------------|
| `npm run dev` | Run the app with hot reload |
| `npm test` | Run unit tests (serialization, merge, storage) |
| `npm run build` | Compile main/preload/renderer to `out/` |
| `npm run dist` | Build + create NSIS installer in `packaged/` |
| `npm run dist:dir` | Build unpacked app directory (no installer) |
| `npm run typecheck` | TypeScript check |

## Production build / installer

Per-user NSIS installer (no admin required by default):

```bash
npm install
npm run dist
```

Output: `packaged/Tack-Notes-Setup-1.0.0.exe`

If GitHub is unreachable (electron-builder cannot download NSIS tooling):

1. `npm run build`
2. `npx electron-builder --win dir` — produces `packaged/win-unpacked/Tack Notes.exe`
3. On a networked machine, run `npx electron-builder --win nsis` once so NSIS tools cache under `%LOCALAPPDATA%\electron-builder\Cache`, then rebuild.

If `electron-builder` cannot download Electron binaries (offline CI, proxy, etc.):

1. Ensure `npm install` completed so `node_modules/electron/dist` exists (`electronDist` is configured).
2. Run `npm run build` then `npx electron-builder --win nsis`.
3. NSIS is configured in `package.json` → `build.nsis` with `perMachine: false` (per-user install).

## Storage format

One note per file: `<uuid>.md`

```markdown
---
schema_version: 1
id: "550e8400-e29b-41d4-a716-446655440000"
color: "green"
created_at: "2026-09-23T12:00:00Z"
updated_at: "2026-09-23T12:05:00Z"
---
Shopping list

- [ ] Milk
- [x] Bread

**Bold** *italic* <u>underline</u> ~~strike~~
```

- Filename is the permanent UUID (not derived from title).
- Title in the list is the first nonempty line, or “Untitled note”.
- Underline uses `<u>`; other marks use standard Markdown.
- Trash lives in `.tack-trash/` inside the collection (same Markdown + `deleted_at`).
- App settings, window positions, and recovery history live under `%APPDATA%\tack-notes\` (outside the synced folder).

### Choosing a folder

On first launch, Tack Notes suggests `Documents\Tack Notes` and lets you pick another folder (including an existing cloud-synced directory).

In Settings:

- **Open other folder** — switch to another collection without copying notes.
- **Migrate to folder** — copy notes into a new folder; refuses to overwrite conflicting files.

Tack Notes never silently merges two collections.

## Conflicts and sync

Synced folders do **not** guarantee conflict-free concurrent editing. Tack Notes:

1. Keeps base / editor / disk versions and content hashes
2. Rereads before save; merges unambiguous changes
3. Surfaces overlapping edits with Keep mine / Keep disk / Keep both (new ID)
4. Detects divergent files that share one note ID (sync conflict copies)
5. Writes short-lived `*.tmp` files then replaces; never deletes the original as a blind fallback
6. Stores bounded recovery snapshots under local app data

**Limitation:** read-check-replace still races with other writers and cloud clients. Local “Saved” means the file was written on disk — not that the cloud provider finished uploading.

A missing storage folder is treated as unavailable, not as “delete every note.”

## Architecture (summary)

| Layer | Location |
|-------|----------|
| Note model + Markdown | `src/shared/` |
| Filesystem storage + merge | `src/main/storage.ts` |
| Window management | `src/main/windows.ts` |
| IPC (validated channels) | `src/main/ipc.ts`, `src/preload/` |
| UI | `src/renderer/` |

Renderers run with context isolation, no Node integration, and a restrictive CSP. Note HTML is sanitized; scripts/remote resources are not executed.

## Assumptions

- Single active user per machine collection; multiple devices OK via file sync with best-effort merge
- English UI for v1
- No images, accounts, or direct cloud APIs
- Links and advanced Markdown open in source/limited mode rather than silent data loss

## License

MIT
