# Nocturne Writer — Claude Instructions

> Claude reads this file automatically at the start of every conversation.  
> See also: [AGENTS.md](./AGENTS.md) for the full architecture reference.

## Quick Start

```bash
npm install && npm run dev   # http://localhost:5173
npm run check                # syntax validation (no execution)
```

## Critical Rules

- **`src/main.js`** (~750 KB) is an intentional monolith — make **targeted edits only**, never rewrite wholesale. CSS has been split.
- **ALWAYS MAKE A GIT COMMIT BEFORE STARTING WORK** — immediately commit the current state before executing any tasks or editing any files.
- All persistence goes through **`src/core/db.js`** (IndexedDB). Never use `localStorage` for app data.
- Platform-specific APIs (file dialogs, native share) must go through **`src/platform/file-adapter.js`** and **`src/platform/runtime.js`**.
- Do **not** add npm dependencies without explicit request.
- Electron IPC changes require matching edits in both `electron/main.cjs` and `electron/preload.cjs`.

## Architecture Summary

```
index.html → src/main.js + src/css/*
src/core/       db, crypto, utils, defaults, typos
src/features/   command-palette, ai-context
src/platform/   runtime detection, file I/O abstraction
electron/       main.cjs (main process), preload.cjs (IPC bridge)
scripts/        build, sync, smoke-test helpers
server.mjs      dev HTTP server (no bundler)
```

## Data

Stored in IndexedDB: `projects`, `characters`, `locations`, `events`, `subtimelines`, `notes`.  
Export: `.nocturnedump` (JSON, optionally AES-GCM encrypted via `src/core/crypto.js`).

## Build Targets

| Target | Command |
|--------|---------|
| Web dev | `npm run dev` |
| Production dist | `npm run build` |
| Electron dev | `npm run dev` + `npm run electron:dev` |
| Android debug APK | `npm run android:build:debug` |

## What Not to Touch

- `backup.zip` — not in git, not relevant
- `node_modules/` — not in git
- `dist/`, `release/`, `android/app/build/` — build artifacts, gitignored
