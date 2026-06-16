from pathlib import Path


# Summary is intentionally limited to the production web app:
# index.html -> ./src/styles.css + ./src/main.js and related ./src modules.
PROJECT_ROOT = Path(__file__).resolve().parent
OUTPUT_FILE = PROJECT_ROOT / "project_code_summary.txt"

TARGET_EXTENSIONS = {".html", ".css", ".js"}
ROOT_FILES = {"index.html"}
SOURCE_DIRS = {"src"}

IGNORE_DIRS = {
    ".android-sdk-download",
    ".electron_build",
    ".git",
    ".idea",
    ".vscode",
    "__pycache__",
    "android",
    "backup",
    "build",
    "dist",
    "electron",
    "node_modules",
    "out",
    "release",
}

IGNORE_FILES = {
    "Primer.html",
    "Subtimeline+animation.html",
    "web2exe.py",
    "web2exe_fixed.py",
    OUTPUT_FILE.name,
    Path(__file__).name,
}


def is_hidden_or_ignored(path: Path) -> bool:
    return any(part.startswith(".") or part in IGNORE_DIRS for part in path.parts)


def is_main_project_file(path: Path) -> bool:
    relative = path.relative_to(PROJECT_ROOT)

    if relative.name in IGNORE_FILES:
        return False
    if path.suffix.lower() not in TARGET_EXTENSIONS:
        return False
    if is_hidden_or_ignored(relative.parent):
        return False

    if len(relative.parts) == 1:
        return relative.name in ROOT_FILES

    return relative.parts[0] in SOURCE_DIRS


def iter_main_project_files():
    files = []
    for path in PROJECT_ROOT.rglob("*"):
        if path.is_file() and is_main_project_file(path):
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(PROJECT_ROOT).as_posix().lower())


def generate_code_summary():
    files = iter_main_project_files()

    with OUTPUT_FILE.open("w", encoding="utf-8", newline="\n") as outfile:
        outfile.write("Nocturne Writer main web project summary\n")
        outfile.write("Included: index.html and src/**/*.{html,css,js}\n")
        outfile.write("Excluded: Electron, Android/Capacitor, builds, node_modules, backups, standalone prototypes\n\n")

        for filepath in files:
            relative = filepath.relative_to(PROJECT_ROOT).as_posix()
            try:
                content = filepath.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                print(f"Skipped non-UTF-8 file: {relative}")
                continue

            outfile.write("=" * 80 + "\n")
            outfile.write(f"FILE: {relative}\n")
            outfile.write("=" * 80 + "\n\n")
            outfile.write(content)
            outfile.write("\n\n")

            print(f"Added file: {relative}")

    return len(files)


if __name__ == "__main__":
    print("Generating summary for the main Nocturne Writer web project...")
    print("Electron, Android, build folders, backups and standalone prototypes are ignored.")
    print("-" * 50)

    count = generate_code_summary()

    print("-" * 50)
    if count:
        print(f"Done. Files processed: {count}")
        print(f"Summary saved to: {OUTPUT_FILE.name}")
    else:
        print("No matching main project files found.")
