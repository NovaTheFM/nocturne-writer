import os
import sys
import subprocess
import shutil
import json
import glob
import ctypes

def is_admin():
    """Проверяет, запущен ли скрипт от имени Администратора (нужно для symlinks в Windows)"""
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except:
        return False

def clean_old_garbage():
    """Функция для очистки мусора от старых попыток"""
    print("🧹 Очистка старых файлов от прошлой сборки...")
    files_to_remove = ["app_runner.py"]
    for spec_file in glob.glob("*.spec"):
        files_to_remove.append(spec_file)

    for f in files_to_remove:
        if os.path.exists(f):
            os.remove(f)
            print(f"  [-] Удален файл: {f}")

    dirs_to_remove = ["build", "dist"]
    for d in dirs_to_remove:
        if os.path.exists(d) and os.path.isdir(d):
            shutil.rmtree(d)
            print(f"  [-] Удалена папка: {d}")

def clean_electron_cache():
    """Очищает кэш electron-builder, где застревают битые архивы winCodeSign"""
    if os.name == 'nt':
        cache_dir = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'electron-builder', 'Cache', 'winCodeSign')
        if os.path.exists(cache_dir):
            print("🧹 Очистка кэша winCodeSign (чтобы избежать ошибки symlink)...")
            shutil.rmtree(cache_dir, ignore_errors=True)

def check_node_installed():
    """Проверяем наличие npm в системе"""
    try:
        subprocess.run(["npm", "-v"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True, check=True)
        return True
    except Exception:
        return False

def safe_package_name(name):
    safe = "".join(c.lower() for c in name if c.isalnum())
    return safe or "nocturnewriter"

def main():
    print("=== Утилита сборки ES6 проекта в standalone EXE (Electron Builder) ===\n")
    
    # 1. Очистка мусора
    clean_old_garbage()

    # 2. Проверка Node.js
    if not check_node_installed():
        print("\n❌ Ошибка: Для сборки через Electron необходим Node.js и npm!")
        print("Скачайте и установите Node.js с официального сайта: https://nodejs.org/")
        return

    default_app_name = "Nocturne"
    try:
        app_name = input(f"Введите название приложения (нажми Enter, чтобы назвать '{default_app_name}'): ").strip()
    except EOFError:
        app_name = ""

    if not app_name:
        app_name = default_app_name

    if not os.path.isfile("index.html"):
        print("❌ Ошибка: В текущей папке нет главного файла index.html!")
        return

    # Временная папка для инициализации Electron-проекта
    build_dir = ".electron_build"
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)
    os.makedirs(build_dir)

    # 3. Копируем исходники проекта во внутреннюю папку
    app_src_dir = os.path.join(build_dir, "app_src")
    os.makedirs(app_src_dir)
    shutil.copy2("index.html", os.path.join(app_src_dir, "index.html"))
    shutil.copytree("src", os.path.join(app_src_dir, "src"))
    shutil.copytree("electron", os.path.join(build_dir, "electron"))
    
    scripts_dir = os.path.join(build_dir, "scripts")
    os.makedirs(scripts_dir, exist_ok=True)
    shutil.copy2(os.path.join("scripts", "sync-server.mjs"), os.path.join(scripts_dir, "sync-server.mjs"))

    # 4. Генерируем package.json с ASAR и fileAssociations
    package_json = {
        "name": safe_package_name(app_name),
        "version": "1.0.0",
        "description": "Nocturne Writer standalone build",
        "author": "Developer",
        "main": "electron/main.cjs",
        "scripts": {
            "build": "electron-builder --win portable"
        },
        "dependencies": {
            "bonjour-service": "^1.4.0",
            "ws": "^8.21.0"
        },
        "devDependencies": {
            "electron": "^42.2.0",
            "electron-builder": "^26.0.12"
        },
        "build": {
            "appId": f"com.{safe_package_name(app_name)}.app",
            "productName": app_name,
            "asar": True,
            "fileAssociations": [
                {
                    "ext": "nocturnedump",
                    "name": "Nocturne Project Backup",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturnmemory",
                    "name": "Nocturne Knowledge Base",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturnecharacters",
                    "name": "Nocturne Characters Export",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturneplaces",
                    "name": "Nocturne Locations Export",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturnetimelines",
                    "name": "Nocturne Timelines Export",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturnechar",
                    "name": "Nocturne Character Card",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturneplace",
                    "name": "Nocturne Location Card",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturnetime",
                    "name": "Nocturne Timeline Event",
                    "icon": "app_src/src/assets/icon.ico"
                },
                {
                    "ext": "nocturned",
                    "name": "Nocturne Review Document",
                    "icon": "app_src/src/assets/icon.ico"
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
                "node_modules/which-typed-array/**/*"
            ],
            "win": {
                "target": "portable",
                "icon": "app_src/src/assets/icon.ico",
                "signAndEditExecutable": False
            }
        }
    }
    
    with open(os.path.join(build_dir, "package.json"), "w", encoding="utf-8") as f:
        json.dump(package_json, f, indent=2, ensure_ascii=False)

    print("\n📦 Установка зависимостей Electron... (Может занять пару минут)")
    try:
        subprocess.run("npm install", cwd=build_dir, shell=True, check=True)
        
        if os.name == 'nt' and not is_admin():
            print("\n====================================================================")
            print("⚠️ ВНИМАНИЕ: ТЕРМИНАЛ ЗАПУЩЕН БЕЗ ПРАВ АДМИНИСТРАТОРА!")
            print("Windows заблокирует создание символических ссылок (symlinks), которые")
            print("нужны electron-builder для распаковки 'winCodeSign'.")
            print("Если сборка сейчас упадет с ошибкой 'Cannot create symbolic link',")
            print("перезапустите PowerShell ОТ ИМЕНИ АДМИНИСТРАТОРА!")
            print("====================================================================\n")

        clean_electron_cache()

        print("\n⚙️ Сборка .exe файла...")
        subprocess.run("npm run build", cwd=build_dir, shell=True, check=True)
        
        dist_folder = os.path.join(build_dir, "dist")
        print(f"\n✅ Готово! Standalone .exe файл собран в папке:")
        print(f"👉 {os.path.abspath(dist_folder)}")

        # Копируем .exe файл в папку release
        release_dir = os.path.join("release", "electron")
        os.makedirs(release_dir, exist_ok=True)
        exes = glob.glob(os.path.join(dist_folder, "*.exe"))
        for exe in exes:
            target = os.path.join(release_dir, os.path.basename(exe))
            try:
                shutil.copy2(exe, target)
                print(f"  [+] Скопирован в release: {target}")
            except PermissionError:
                target_new = os.path.join(release_dir, f"{os.path.splitext(os.path.basename(exe))[0]}-new.exe")
                shutil.copy2(exe, target_new)
                print(f"  [+] Скопирован в release (новое имя): {target_new}")

    except subprocess.CalledProcessError as e:
        print(f"\n❌ Ошибка сборки npm/electron: Command returned non-zero exit status.")
    except Exception as e:
        print(f"\n❌ Произошла неизвестная ошибка: {e}")

if __name__ == "__main__":
    main()