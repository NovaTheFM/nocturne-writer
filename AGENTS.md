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
  main.js           ← monolithic app entry (~750 KB, all UI logic lives here)
  styles.css        ← legacy monolithic stylesheet (~200 KB)
  core/
    db.js           ← IndexedDB wrapper (all persistence)
    crypto.js       ← E2E encryption helpers (AES-GCM via WebCrypto)
    utils.js        ← shared utility functions
    defaults.js     ← default data shapes / constants
    typos.js        ← typo/spell-check dictionary
  features/
    command-palette.js  ← Ctrl+K command palette logic
    ai-context.js       ← AI knowledge context serialisation
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
  build-web.mjs       ← production bundler (copies files to dist/)
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

---

## How to Run

```bash
npm install
npm run dev          # starts dev server on http://localhost:5173
```

Open `http://localhost:5173` in a browser.

Syntax check (no execution):
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

- `projects` — manuscript projects (title, body, settings, snapshots)
- `characters` — character cards
- `locations` — location cards
- `events` — timeline events
- `subtimelines` — sub-timeline groups
- `notes` — free-form notes

Export format: `.nocturnedump` (JSON, optionally AES-GCM encrypted).

---

## Testing

No automated unit test suite yet. Use the Playwright smoke test:

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

---

## File Size Reference (approximate)

| File | Size |
|------|------|
| `src/main.js` | ~750 KB |
| `src/styles.css` | ~200 KB |
| `src/core/typos.js` | ~16 KB |
| `src/features/command-palette.js` | ~16 KB |
| `src/features/ai-context.js` | ~7 KB |
| `src/core/db.js` | ~3.5 KB |
| `src/core/crypto.js` | ~2 KB |

---

## Release and Update Pipeline

To ensure version tracking and seamless update delivery, the application tracks changes via `updates.md` and displays a "What's New" (Что нового) modal to desktop (Electron) users on first launch after an update.

### Rule 1: Log Every Change in `updates.md`
Whenever you edit code or fix bugs, you MUST log your changes in [updates.md](file:///c:/today%20we%20steal%20the%20code%202/updates.md) at the root of the project.
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
   - Update the HTML content inside the `openWhatsNewModal()` method in [main.js](file:///c:/today%20we%20steal%20the%20code%202/src/main.js) to list the newly added features and fixes, keeping it clear, neat, and structured.
3. **Increment Version**:
   - Run the automated version bumping script: `python bump_version.py [X.Y.Z]` (where `[X.Y.Z]` is the target version, e.g. `1.0.3`). If no version is specified, it will auto-increment the patch number.
   - This script automatically updates versions in `package.json`, `src/main.js` (`currentVersion` and `appVersion`), and all query-string cache-busters in `index.html`.
4. **Compile / Package App**:
   - Run the packaging command `python web2exe_fixed.py` to compile the app to executable.
   - Wait for the build process to finish.
5. **Log Release**:
   - Ensure the new release is logged as a version section in `updates.md`.

---

## Contact / Ownership

Repository maintained by **BebraNova**.  
Issues and PRs welcome.
