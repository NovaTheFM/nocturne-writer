import re

# 1. FIX UI CSS
with open('src/css/ui.css', 'r', encoding='utf-8') as f:
    css = f.read()

css = css.replace('cubic-bezier(0.4, 0, 0.2, 1)-in-out', 'cubic-bezier(0.4, 0, 0.2, 1)')
css = css.replace('cubic-bezier(0.4, 0, 0.2, 1)-out', 'cubic-bezier(0.0, 0, 0.2, 1)')
css = re.sub(r'\.cursor-light\s*\{[^}]*\}', '', css)
css = re.sub(r'\.glow-enabled.*?\.cursor-light\s*\{[^}]*\}', '', css)
css = re.sub(r'\.custom-caret\.breath\s*\{[^}]*\}', '.custom-caret.breath { animation: caret-breath 2.2s ease-in-out infinite; }', css)

css += '''
/* Native Caret Glow */
.glow-enabled .custom-caret {
  box-shadow: 0 0 8px var(--accent-glow);
}
.glow-enabled .custom-caret::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 24px;
  height: 24px;
  background: radial-gradient(circle, var(--accent) 0%, transparent 60%);
  opacity: 0.2;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  pointer-events: none;
  z-index: -1;
}

/* SortableJS Premium Animations */
.sortable-ghost {
  opacity: 0.4 !important;
  transform: scale(0.96) !important;
  border-color: var(--accent) !important;
  background: var(--accent-glow) !important;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.sortable-drag {
  opacity: 1 !important;
  transform: scale(1.05) rotate(2deg) !important;
  box-shadow: 0 24px 48px rgba(0,0,0,0.7) !important;
  border-color: var(--accent) !important;
  z-index: 1000 !important;
  cursor: grabbing !important;
}
'''
with open('src/css/ui.css', 'w', encoding='utf-8') as f:
    f.write(css)

# 2. FIX ANIMATIONS CSS
with open('src/css/animations.css', 'r', encoding='utf-8') as f:
    anim = f.read()

anim = re.sub(r'@keyframes caret-breath\s*\{[^}]*\}', '''@keyframes caret-breath {
  0%, 100% { opacity: .25; box-shadow: 0 0 2px var(--accent-glow); }
  50% { opacity: 1; box-shadow: 0 0 14px var(--accent); }
}''', anim)

with open('src/css/animations.css', 'w', encoding='utf-8') as f:
    f.write(anim)

# 3. FIX JS
with open('src/main.js', 'r', encoding='utf-8') as f:
    js = f.read()

if 'experimentalDesign:' not in js:
    js = js.replace('cursorGlow: true,', 'cursorGlow: true,\n      experimentalDesign: false,')

# Add toggle
toggle_html = r"${row('Экспериментальный дизайн', 'Включает ультра-хайповый детализированный UI (Glassmorphism, 3D).', toggle('experimentalDesign'))}"
if 'experimentalDesign' not in js.split('miscSettingsContent() {')[1][:1500]:
    js = re.sub(r'(miscSettingsContent\(\)\s*\{[\s\S]*?)(</div>\s*`;)', r'\1' + toggle_html + r'\n\2', js)

# Inject classes
if 'theme-experimental' not in js:
    js = js.replace("document.body.classList.toggle('is-electron', !!window.ipcRenderer);", "document.body.classList.toggle('is-electron', !!window.ipcRenderer);\n    document.body.classList.toggle('theme-experimental', !!this.state.settings.experimentalDesign);\n    document.body.classList.toggle('glow-enabled', !!this.state.settings.cursorGlow);")

# Clean JS cursor light tracking
js = js.replace('<div class="cursor-light"></div>', '')
js = js.replace('this.updateCursorLight(editable);', '')
js = js.replace('this.updateCursorLight();', '')

js = re.sub(r'updateCursorLight\([^)]*\)\s*\{[\s\S]*?rangeRect\(range\)', 'updateCursorLight() {}\n\n  rangeRect(range)', js)

with open('src/main.js', 'w', encoding='utf-8') as f:
    f.write(js)

print("Fixes applied.")
