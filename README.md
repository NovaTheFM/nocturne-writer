# Nocturne Writer

Local web writing app: manuscript editor, knowledge base, characters, locations, timeline, subtimelines, notes, AI review, snapshots, export and optional E2E encryption.

## Running Web Version

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

The production entrypoint remains `index.html`, loading `src/css/*` and `src/main.js`.

## Command Palette

Open with `Ctrl+K` on Windows/Linux or `Cmd+K` on macOS. The toolbar command button opens the same palette on desktop and mobile.

The palette can create/open documents, characters, locations, timeline events, subtimelines, settings, AI actions and `.nocturnedump` import/export.

## `.nocturnedump` Backup

Project dump export/import is available from:

- Command Palette: `export`, `dump`, `backup`, `import`
- Settings -> Export

Browser mode downloads/opens files through standard web APIs. Electron mode uses dialog IPC through preload. Android/Capacitor tries native filesystem/share APIs and falls back to browser download/input.

E2E projects export in encrypted-safe mode by default. Plaintext export is available only after an explicit warning.

## AI Knowledge Context

The AI panel contains a `Knowledge Context` section. It can include relevant characters, locations, timeline events, subtimelines and notes. Context is serialized as plain JSON reference material and is not inserted into the manuscript.

Use `Preview context` to inspect the exact context before running an AI action.

## Electron Preparation

Electron support is prepared but not packaged by Codex.

Files:

- `electron/main.cjs`
- `electron/preload.cjs`
- `src/platform/runtime.js`
- `src/platform/file-adapter.js`

Renderer code does not import Node/Electron modules directly. File operations go through `contextBridge` and IPC.

Dev run:

```bash
npm run dev
npm run electron:dev
```

Local-file run:

```bash
npm run build
npm run electron:start
```

Packaging/installer generation is intentionally not configured as an automatic step.

## Android Build

Capacitor is configured with:

- app id: `com.nocturne.writer`
- app name: `Nocturne Writer`
- web assets: `dist`

Commands:

```bash
npm install
npm run build
npx cap add android
npm run android:sync
npm run android:build:debug
```

Expected debug APK path:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

If the build fails, check Java/JDK, Android SDK, Gradle and Android licenses.

## Platform Limitations

Browser mode depends on IndexedDB/localStorage availability. Android WebView storage can be cleared by OS/browser settings, so regular `.nocturnedump` backups are recommended.

Native file dialogs are available only in Electron. Capacitor file sharing depends on the installed platform plugins and Android environment.
