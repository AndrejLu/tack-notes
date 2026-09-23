# Delivery report — Tack Notes 1.0.0

## What was built

**Tack Notes** — Windows sticky notes app (Electron + React + TypeScript), original branding.

| Artifact | Status |
|----------|--------|
| Source (`src/`, tests, configs) | Complete |
| Unit tests (`npm test`) | **27/27 passed** |
| Production compile (`npm run build`) | Success → `out/` |
| Unpacked app | Success → `packaged/win-unpacked/Tack Notes.exe` |
| NSIS installer | Success → `packaged/Tack-Notes-Setup-1.0.0.exe` |

## Implementation plan (executed)

1. Shared note model + stable Markdown/YAML serialization  
2. Main-process storage service, recovery snapshots, central list  
3. Independent note windows + TipTap rich editing  
4. External change detection + conservative three-way merge / conflicts  
5. Trash, settings, tray, themes, session restore, launch-at-login  
6. Packaging + docs  

## Assumptions

- App name **Tack Notes**; notes default to `Documents\Tack Notes`
- Local app data under `%APPDATA%\tack-notes` (window state, settings, recovery)
- Trash directory: `<collection>/.tack-trash/`
- Links / images / code fences / tables → source or limited mode (no silent loss)
- `signAndEditExecutable: false` so packaging works without `winCodeSign` when offline
- Uses local `node_modules/electron/dist` via `electronDist` when Electron CDN/GitHub is unreachable

## Automated tests covered

- Markdown round-trip: bold, italic, underline (`<u>`), strikethrough, bullets, checklists  
- Unicode + unknown front-matter preservation + stable serialization  
- External edit with clean local state  
- Nonoverlapping merge + overlapping conflict  
- Divergent files sharing one note ID  
- Delete / restore + restore collision refusal  
- Missing storage folder (not treated as mass delete)  
- Pending recovery snapshots + temp-file ignore  

## Manual UI verification

1. `npm run dev` or run `packaged\win-unpacked\Tack Notes.exe`
2. Create → edit → close note → reopen → restart app  
3. Two notes open at once; minimize vs close vs delete  
4. Tray: New note / All notes / Settings / Quit  
5. Always-on-top; theme switch; search; trash restore  

## How to build the NSIS installer

```bash
npm install
npm run build
npx electron-builder --win nsis
```

Expected output: `packaged/Tack-Notes-Setup-1.0.0.exe`  
Configured as **per-user** (`perMachine: false`), custom install directory allowed, no admin required for default install.

## Known limitations

- Read-check-replace still races with cloud sync clients (documented in README)  
- “Saved” means local disk write succeeded, not cloud upload complete  
- Nested lists / ordered-list richness are basic  
- Concurrent multi-device editing is best-effort, not CRDT  

## Remaining issues

- Full interactive tray/monitor-restore QA still recommended on a real desktop session  
- Renaming from **Tack** → **Tack Notes** changes Electron `userData` to `%APPDATA%\tack-notes` (previous `%APPDATA%\tack` settings are not migrated automatically)
