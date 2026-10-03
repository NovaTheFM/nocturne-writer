import sys
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent

def get_current_version():
    pkg_path = ROOT / "package.json"
    if not pkg_path.exists():
        print("Error: package.json not found")
        sys.exit(1)
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    return pkg.get("version", "1.0.0")

def increment_patch(version_str):
    parts = version_str.split(".")
    if len(parts) == 3:
        try:
            parts[2] = str(int(parts[2]) + 1)
            return ".".join(parts)
        except ValueError:
            pass
    return version_str

def update_package_json(new_version):
    pkg_path = ROOT / "package.json"
    with open(pkg_path, "r", encoding="utf-8") as f:
        pkg = json.load(f)
    
    pkg["version"] = new_version
    
    with open(pkg_path, "w", encoding="utf-8") as f:
        json.dump(pkg, f, ensure_ascii=False, indent=2)
    print(f"Updated package.json: version -> {new_version}")
    lock_path = ROOT / "package-lock.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        lock["version"] = new_version
        lock.setdefault("packages", {}).setdefault("", {})["version"] = new_version
        lock_path.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def update_main_js(old_version, new_version):
    main_path = ROOT / "src" / "main.js"
    if not main_path.exists():
        print("Warning: src/main.js not found, skipping")
        return
        
    content = main_path.read_text(encoding="utf-8")
    
    # 1. Update const currentVersion
    cv_pattern = re.compile(rf"(const\s+currentVersion\s*=\s*['\"]){re.escape(old_version)}(['\"])")
    content, count1 = cv_pattern.subn(rf"\g<1>{new_version}\g<2>", content)
    
    # 2. Update appVersion
    av_pattern = re.compile(rf"(appVersion\s*:\s*['\"]){re.escape(old_version)}(['\"])")
    content, count2 = av_pattern.subn(rf"\g<1>{new_version}\g<2>", content)
    modal_start = content.find("openWhatsNewModal() {")
    if modal_start >= 0:
        content = content[:modal_start] + content[modal_start:].replace(f"Версия {old_version}", f"Версия {new_version}", 1)
    
    main_path.write_text(content, encoding="utf-8")
    print(f"Updated src/main.js: currentVersion (replaced {count1}), appVersion (replaced {count2})")

def update_index_html(old_version, new_version):
    html_path = ROOT / "index.html"
    if not html_path.exists():
        print("Warning: index.html not found, skipping")
        return
        
    content = html_path.read_text(encoding="utf-8")
    
    # Replace all occurrences of ?v=old_version
    pattern = re.compile(rf"(\?v=){re.escape(old_version)}")
    content, count = pattern.subn(rf"\g<1>{new_version}", content)
    
    html_path.write_text(content, encoding="utf-8")
    print(f"Updated index.html: replaced {count} cache-buster query strings")


def update_android_version(new_version):
    gradle_path = ROOT / "android" / "app" / "build.gradle"
    if not gradle_path.exists():
        return
    content = gradle_path.read_text(encoding="utf-8")
    code = re.search(r"\bversionCode\s+(\d+)", content)
    if not code:
        raise ValueError("Android versionCode not found")
    content = re.sub(r"(\bversionCode\s+)\d+", lambda match: match.group(1) + str(int(code.group(1)) + 1), content, count=1)
    content = re.sub(r'(\bversionName\s+["\'])[^"\']+(["\'])', lambda match: match.group(1) + new_version + match.group(2), content, count=1)
    gradle_path.write_text(content, encoding="utf-8")

def main():
    old_version = get_current_version()
    print(f"Current version: {old_version}")
    
    if len(sys.argv) > 1:
        new_version = sys.argv[1]
    else:
        new_version = increment_patch(old_version)
        print(f"No version provided, auto-incrementing patch version.")
        
    if not re.fullmatch(r"\d+\.\d+\.\d+", new_version):
        raise ValueError("Version must use X.Y.Z format")
    if tuple(map(int, new_version.split('.'))) < tuple(map(int, old_version.split('.'))):
        raise ValueError("Version must not decrease")
    if old_version == new_version:
        print("No version change detected. Exiting.")
        return
        
    print(f"Bumping version: {old_version} -> {new_version}")
    
    paths = [ROOT / "package.json", ROOT / "package-lock.json", ROOT / "src/main.js", ROOT / "index.html", ROOT / "android/app/build.gradle", ROOT / "electron-package-lock.json"]
    original = {path: path.read_bytes() for path in paths if path.exists()}
    try:
        update_package_json(new_version)
        update_main_js(old_version, new_version)
        update_index_html(old_version, new_version)
        update_android_version(new_version)
        desktop_lock = ROOT / "electron-package-lock.json"
        if desktop_lock.exists():
            lock = json.loads(desktop_lock.read_text(encoding="utf-8"))
            lock["version"] = new_version
            lock["packages"][""]["version"] = new_version
            desktop_lock.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception:
        for path, data in original.items():
            path.write_bytes(data)
        raise
    
    print("Version bump completed successfully!")

if __name__ == "__main__":
    main()
