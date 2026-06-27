import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BUILD_DIR = ROOT / ".electron_build"
APP_SRC = BUILD_DIR / "app_src"
RELEASE_DIR = ROOT / "release" / "electron"


def run(command, cwd=ROOT):
    print(f"\n==> {command}")
    subprocess.run(command, cwd=cwd, shell=True, check=True)


def safe_package_name(name):
    safe = "".join(ch.lower() for ch in name if ch.isalnum())
    return safe or "nocturnewriter"


def clean_build_dir():
    if BUILD_DIR.exists():
      shutil.rmtree(BUILD_DIR)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    APP_SRC.mkdir(parents=True, exist_ok=True)
    RELEASE_DIR.mkdir(parents=True, exist_ok=True)


def copy_web_app():
    required = [ROOT / "index.html", ROOT / "src"]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise FileNotFoundError(f"Missing production files: {', '.join(missing)}")

    shutil.copy2(ROOT / "index.html", APP_SRC / "index.html")
    shutil.copytree(ROOT / "src", APP_SRC / "src")
    shutil.copytree(ROOT / "electron", BUILD_DIR / "electron")
    scripts_dir = BUILD_DIR / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "scripts" / "sync-server.mjs", scripts_dir / "sync-server.mjs")


def write_package(app_name):
    package = {
        "name": safe_package_name(app_name),
        "version": "1.0.0",
        "description": "Nocturne Writer standalone build",
        "author": "Nocturne Writer",
        "main": "electron/main.cjs",
        "scripts": {
            "build": "electron-builder --win nsis"
        },
        "dependencies": {
            "bonjour-service": "^1.4.0",
            "ws": "^8.21.0",
            "simple-git": "^3.36.0"
        },
        "devDependencies": {
            "electron": "^42.2.0",
            "electron-builder": "^26.0.12"
        },
        "build": {
            "appId": "com.nocturne.writer",
            "productName": app_name,
            "asar": True,
            "fileAssociations": [
                {
                    "ext": "nocturnedump",
                    "name": "Nocturne Project Backup",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnmemory",
                    "name": "Nocturne Knowledge Base",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnecharacters",
                    "name": "Nocturne Characters Export",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturneplaces",
                    "name": "Nocturne Locations Export",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnetimelines",
                    "name": "Nocturne Timelines Export",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnechar",
                    "name": "Nocturne Character Card",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturneplace",
                    "name": "Nocturne Location Card",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnetime",
                    "name": "Nocturne Timeline Event",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturnenote",
                    "name": "Nocturne Note Card",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                },
                {
                    "ext": "nocturned",
                    "name": "Nocturne Review Document",
                    "icon": "app_src/src/assets/in_app_icon.ico"
                }
            ],
            "files": [
                "electron/**/*",
                "app_src/**/*",
                "scripts/**/*",
                "node_modules/ws/**/*",
                "node_modules/bonjour-service/**/*",
                "node_modules/multicast-dns/**/*",
                "node_modules/dns-packet/**/*",
                "node_modules/@leichtgewicht/**/*",
                "node_modules/array-flatten/**/*",
                "node_modules/deep-equal/**/*",
                "node_modules/fast-deep-equal/**/*",
                "node_modules/function-bind/**/*",
                "node_modules/hasown/**/*",
                "node_modules/is-arguments/**/*",
                "node_modules/is-generator-function/**/*",
                "node_modules/is-regex/**/*",
                "node_modules/object-is/**/*",
                "node_modules/object-keys/**/*",
                "node_modules/regexp.prototype.flags/**/*",
                "node_modules/side-channel/**/*",
                "node_modules/side-channel-list/**/*",
                "node_modules/side-channel-map/**/*",
                "node_modules/side-channel-weakmap/**/*",
                "node_modules/call-bind-apply-helpers/**/*",
                "node_modules/dunder-proto/**/*",
                "node_modules/es-define-property/**/*",
                "node_modules/es-errors/**/*",
                "node_modules/es-get-iterator/**/*",
                "node_modules/es-object-atoms/**/*",
                "node_modules/get-intrinsic/**/*",
                "node_modules/get-proto/**/*",
                "node_modules/gopd/**/*",
                "node_modules/has-symbols/**/*",
                "node_modules/has-tostringtag/**/*",
                "node_modules/internal-slot/**/*",
                "node_modules/is-array-buffer/**/*",
                "node_modules/is-date-object/**/*",
                "node_modules/is-map/**/*",
                "node_modules/is-set/**/*",
                "node_modules/is-shared-array-buffer/**/*",
                "node_modules/is-string/**/*",
                "node_modules/is-weakmap/**/*",
                "node_modules/is-weakset/**/*",
                "node_modules/math-intrinsics/**/*",
                "node_modules/which-boxed-primitive/**/*",
                "node_modules/which-collection/**/*",
                "node_modules/which-typed-array/**/*",
                "node_modules/simple-git/**/*",
                "node_modules/@kwsites/**/*",
                "node_modules/@simple-git/**/*",
                "node_modules/debug/**/*",
                "node_modules/ms/**/*"
            ],
            "win": {
                "target": "nsis",
                "icon": "app_src/src/assets/icon.ico",
                "signExecutable": False
            },
            "nsis": {
                "oneClick": False,
                "allowToChangeInstallationDirectory": True,
                "installerIcon": "app_src/src/assets/icon.ico",
                "uninstallerIcon": "app_src/src/assets/icon.ico",
                "shortcutName": app_name
            }
        }
    }
    (BUILD_DIR / "package.json").write_text(json.dumps(package, ensure_ascii=False, indent=2), encoding="utf-8")


def copy_release_exes():
    dist = BUILD_DIR / "dist"
    exes = sorted(dist.glob("*.exe"))
    if not exes:
        raise FileNotFoundError(f"No .exe artifact found in {dist}")
    copied = []
    for exe in exes:
        target = RELEASE_DIR / exe.name
        try:
            shutil.copy2(exe, target)
        except PermissionError:
            target = RELEASE_DIR / f"{exe.stem}-new{exe.suffix}"
            shutil.copy2(exe, target)
        copied.append(target)
    return copied


def main():
    parser = argparse.ArgumentParser(description="Build Nocturne Writer standalone Electron portable EXE.")
    parser.add_argument("--name", default=os.environ.get("NOCTURNE_APP_NAME", "Nocturne Writer"))
    args = parser.parse_args()

    print("=== Nocturne Writer standalone Electron build ===")
    clean_build_dir()
    copy_web_app()
    write_package(args.name)

    run("npm install", cwd=BUILD_DIR)
    run("npm run build", cwd=BUILD_DIR)

    copied = copy_release_exes()
    print("\nStandalone Electron artifacts:")
    for path in copied:
        print(f"{path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
