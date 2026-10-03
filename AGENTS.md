# Nocturne Writer — AI Agent Guide

> This file is the primary reference for AI coding agents (Gemini, Codex, Claude, Copilot, etc.).  
> Read it fully before making any changes to the codebase.

---

## Project Overview

**Nocturne Writer** is a local-first, offline-capable writing application.  
Stack: vanilla HTML + CSS + ES6 JavaScript (no bundler required for dev).  
Targets: Browser (served via Node), Electron desktop, Android (Capacitor).

---

## Architecture at a Glance

```
index.html          ← entry point (loads src/css/* + src/main.js)
src/
  main.js           ← monolithic app entry (~1.26 MB, UI orchestration)
  styles.css        ← legacy monolithic stylesheet (~200 KB)
  core/
    db.js           ← IndexedDB wrapper (all persistence)
    crypto.js       ← E2E encryption helpers (AES-GCM via WebCrypto)
    record-protection.js ← protected records and locked views
    sync-auth.js    ← protocol 3 pairing proofs; code stays local
    utils.js        ← shared utility functions
    defaults.js     ← default data shapes / constants
    typos.js        ← typo/spell-check dictionary
  features/
    command-palette.js  ← Ctrl+K command palette logic
    ai-context.js       ← AI knowledge context serialisation
    database-sync.js    ← record versions, tombstones and conflicts
    local-sync.js       ← authenticated LAN client
    backups.js          ← backup rotation and restore
  editor/             ← Tiptap bridge, model adapters and visual pagination
  ui/
    icons.js            ← SVG icon library
  platform/
    runtime.js          ← platform detection (browser / electron / android)
    file-adapter.js     ← file I/O abstraction over platform differences
  vendor/             ← vendored third-party libs (no npm import at runtime)
  css/                ← canonical CSS partials (loaded by index.html)
  assets/             ← static assets

electron/
  main.cjs            ← Electron main process
  preload.cjs         ← contextBridge / IPC preload

scripts/
  build-web.mjs       ← copies current web assets to dist/ after vendor build
  build-android-apk.mjs
  sync-server.mjs     ← LAN sync server
  desktop-smoke.mjs   ← Playwright smoke test

server.mjs            ← dev HTTP server (serves project root, no bundler)
capacitor.config.json ← Capacitor / Android config
```

---

## Key Conventions

| Rule | Detail |
|------|--------|
| **No bundler in dev** | `npm run dev` serves files directly via `server.mjs`. No Vite/Webpack. |
| **ES Modules** | All source files use `import`/`export` (package.json `"type":"module"`). Electron files use `.cjs` (CommonJS). |
| **Single monolith files** | `src/main.js` is intentionally large. Do not split without explicit instruction. CSS has been split. |
| **Platform abstraction** | Never call `fs`, `electron`, or Capacitor APIs directly from `src/`. Go through `src/platform/file-adapter.js` and `src/platform/runtime.js`. |
| **Persistence** | All data goes through `src/core/db.js` (IndexedDB). Do not use localStorage for app data. |
| **Encryption** | Projects can be E2E encrypted. Always route sensitive data through `src/core/crypto.js`. |

UX Principle

When modifying existing UI:

- Preserve the existing interaction language.
- Prefer animating existing DOM over replacing it.
- Reuse existing FLIP/layout transition helpers.
- Never introduce instant visual changes where surrounding UI is animated.
- Match placement with surrounding controls instead of simply finding an available container.

---

## How to Run

```bash
npm install
npm run dev          # starts dev server on http://localhost:5173
```

Open `http://localhost:5173` in a browser.

Source syntax and pure document adapter checks (no vendor rebuild):
```bash
npm run check
```

---

## How to Build

```bash
npm run build        # outputs to dist/
```

For Electron:
```bash
npm run dev          # in one terminal
npm run electron:dev # in another
```

For Android APK:
```bash
npm run android:build:debug
# APK → android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Data Model (brief)

All entities stored in IndexedDB (`db.js`). Key object stores:

- `docs`, `folders` — manuscript chapters and folders
- `lore` — worlds containing characters, locations, timeline/subevents, notes and rules
- `settings`, `snapshots`, `stats`, `floatingNotes`, `typoRules`, `reviewMarks`
- `syncDevices`, `syncMappings`, `syncQueue`, `syncConflicts`, `syncJournal`, `syncTrash`
- `backups`, `activity`, `drafts`, `trash`

The canonical list of all 19 stores is `DATABASE_STORES` in `src/core/db.js`. Protected stores use `record-protection.js` and `crypto.js`. Small UI preferences may use existing localStorage keys; manuscript data and identity go through IndexedDB.

Export format: `.nocturnedump` (JSON, optionally AES-GCM encrypted).

---

## Testing

Automated Node unit tests and Playwright regression suites use isolated profiles. Run the complete verification pipeline:

```bash
npm test
node scripts/verify-project.mjs --artifacts # after fresh Android/Electron builds
```

Smoke test against the running development server:

```bash
npm run dev &
npm run smoke:desktop
```

---

## Common Pitfalls for AI Agents

1. **Do not rewrite `src/main.js` wholesale** — it is large and interleaved. Make targeted edits.
2. **Do not introduce npm dependencies** without explicit instruction — the app is intentionally dependency-light.
3. **Do not use `localStorage`** for persistent data — only IndexedDB via `db.js`.
4. **Electron IPC** — any new native feature needs both a handler in `electron/main.cjs` and a bridge in `electron/preload.cjs`.
5. **CSS partials** in `src/css/` are the canonical stylesheets. Edits go to `src/css/*`. `src/styles.css` is considered legacy.
6. **`backup.zip`** is gitignored and is never part of the codebase.
7. **ALWAYS MAKE A GIT COMMIT BEFORE STARTING WORK** — immediately commit the current state before executing any tasks or editing any files to ensure no uncommitted changes are ever lost.
8. **DO NOT TOUCH OR REMOVE `1fr` FROM CARD GRIDS (`.character-grid`, `.locations-grid`)** — the Nocturne grid system strictly relies on `1fr` (`repeat(auto-fill, minmax(220px, 1fr))`) for natural responsive layout and card stretching. Never remove `1fr` or replace it with fixed pixel widths.

---

## File Size Reference (approximate)

| File | Size |
|------|------|
| `src/main.js` | ~1.26 MB |
| `src/styles.css` | ~200 KB |
| `src/core/typos.js` | ~16 KB |
| `src/features/command-palette.js` | ~16 KB |
| `src/features/ai-context.js` | ~7 KB |
| `src/core/db.js` | ~10 KB |
| `src/core/crypto.js` | ~2 KB |

---

## Release and Update Pipeline

To ensure version tracking and seamless update delivery, the application tracks changes via `updates.md` and displays a "What's New" (Что нового) modal to desktop (Electron) users on first launch after an update.

### Rule 1: Log Every Change in `updates.md`
Whenever you edit code or fix bugs, you MUST log your changes in [updates.md](updates.md) at the root of the project.
Format:
```markdown
## [YYYY-MM-DD HH:MM] Версия X.Y.Z — Short Release Header
### Новые функции
- **Компонент**: Описание нововведения.

### Исправления ошибок
- **Компонент**: Описание исправленного бага.
```

### Rule 2: Release Workflow on "Обновляем" Command
When the user gives the command `"Обновляем"` (or similar release/update command), you must execute the following sequence:
1. **Read `updates.md`**: Collect all changes logged since the last version change.
2. **Compile "What's New" Content**:
   - Update the HTML content inside the `openWhatsNewModal()` method in [main.js](src/main.js) to list the newly added features and fixes, keeping it clear, neat, and structured.
3. **Increment Version**:
   - Run the automated version bumping script: `python bump_version.py [X.Y.Z]` (where `[X.Y.Z]` is the target version, e.g. `1.0.3`). If no version is specified, it will auto-increment the patch number.
   - This script updates `package.json`, both lockfiles, `src/main.js` (`currentVersion`, `appVersion`, current What's New header), query-string cache-busters, Android `versionName` and incrementing `versionCode`. Invalid/decreasing versions are rejected; failures restore the original files.
4. **Compile / Package App**:
   - Run the packaging command `python web2exe_fixed.py` to compile the app to executable.
   - Wait for the build process to finish.
   - The packager first builds current web/vendor assets, uses `electron-package-lock.json`, and creates both installer and portable EXE. Version is not bumped during ordinary fixes.
5. **Log Release**:
   - Ensure the new release is logged as a version section in `updates.md`.

---

### CODE COMMENTING RULES
- **DO NOT over-comment.** Write clean, self-documenting code with clear variable/function names instead of relying on comments.
- **NO obvious comments.** Never write comments that just repeat what the code does (e.g., `// loop through array` or `// fetch data`).
- **Explain the "WHY", not the "WHAT".** Add comments ONLY if the business logic is complex, requires a hack, or has non-obvious edge cases. 
- Keep the code visually clean. Less noise, more signal.


## Contact / Ownership

Repository maintained by **BebraNova**.  
Issues and PRs welcome.
