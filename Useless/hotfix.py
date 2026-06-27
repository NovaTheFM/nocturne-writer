import re

# 1. FIX UI.CSS
with open('src/css/ui.css', 'r', encoding='utf-8') as f:
    css = f.read()

# Fix custom-caret missing brace issue caused by my previous regex
css = css.replace(".glow-enabled .page:focus-within \n.custom-caret {", ".custom-caret {")
css = css.replace(".glow-enabled .page:focus-within\n.custom-caret {", ".custom-caret {")

# Just to be safe if the newline isn't exact
css = re.sub(r'\.glow-enabled\s+\.page:focus-within\s*\n\s*\.custom-caret\s*\{', '.custom-caret {', css)

# Fix preloader brand animation
css = re.sub(
    r'(\.preloader-brand\s*\{[^}]*animation:\s*)breathe.*?forwards;', 
    r'\1breathe 3s ease-in-out infinite alternate, blur-reveal 1.5s ease-out forwards;', 
    css
)

# Fix preloader transition
css = re.sub(
    r'(#preloader\s*\{[^}]*transition:\s*)opacity.*?ease;', 
    r'\1opacity 700ms ease, visibility 700ms ease;', 
    css
)
css = re.sub(
    r'(#preloader\s*\{[^}]*transition:\s*)opacity.*?;', 
    r'\1opacity 700ms ease, visibility 700ms ease;', 
    css
)

with open('src/css/ui.css', 'w', encoding='utf-8') as f:
    f.write(css)

# 2. FIX MAIN.JS
with open('src/main.js', 'r', encoding='utf-8') as f:
    js = f.read()

# Add experimentalDesign to bools array
if "'experimentalDesign'" not in js:
    js = js.replace("'compactPanels',", "'compactPanels', 'experimentalDesign',")

# Add theme-experimental toggle in applySettings
# Wait, let's find `shell.classList.toggle('glow-enabled', s.cursorGlow);`
if "shell.classList.toggle('theme-experimental'" not in js:
    js = js.replace(
        "shell.classList.toggle('glow-enabled', s.cursorGlow);", 
        "shell.classList.toggle('glow-enabled', s.cursorGlow);\n    shell.classList.toggle('theme-experimental', !!s.experimentalDesign);"
    )

with open('src/main.js', 'w', encoding='utf-8') as f:
    f.write(js)

print("Hotfix applied.")
