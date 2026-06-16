import re
import os

with open('src/styles.css', 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Z-Indexes
z_indexes = set(re.findall(r'z-index:\s*(\d+);', css))
z_vars = []
for z in sorted([int(z) for z in z_indexes]):
    var_name = f'--z-layer-{z}'
    z_vars.append(f'  {var_name}: {z};')
    css = re.sub(rf'z-index:\s*{z}\b;', f'z-index: var({var_name});', css)

# 2. Targeted Semantic Unification
# The user specifically hated that `#3b82f6` (blue) was used for location cards instead of being unified.
css = re.sub(r'#3b82f6(?![0-9a-fA-F])', 'var(--accent)', css, flags=re.IGNORECASE)

# Unify random dirty backgrounds that break the premium feel
bg_deep = ['#02040d', '#040713', '#050509', '#07070a', '#070b18', '#09090d', '#0d0d12', '#f4ecdf']
for c in bg_deep: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--bg-deep)', css, flags=re.IGNORECASE)

bg_panel = ['#0b1020', '#111116', '#121217', '#0c1224', '#efe4d2']
for c in bg_panel: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--bg-panel)', css, flags=re.IGNORECASE)

bg_page = ['#121827', '#fffaf1']
for c in bg_page: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--bg-page)', css, flags=re.IGNORECASE)

# For surface elements, we define --bg-surface
css = css.replace('--popover-bg-solid: #111116;', '--popover-bg-solid: #111116;\n  --bg-surface: #1a1a22;\n  --bg-surface-hover: #25252f;\n  --color-success: #34d399;\n  --color-danger: #f87171;\n  --color-warning: #fcd34d;\n  --color-info: #bae6fd;')

bg_surface = ['#1a1a22', '#1c1c24']
for c in bg_surface: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--bg-surface)', css, flags=re.IGNORECASE)

bg_surface_hover = ['#25252f', '#2a2a35']
for c in bg_surface_hover: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--bg-surface-hover)', css, flags=re.IGNORECASE)

# Map specific functional colors to semantic variables to preserve them!
css = re.sub(r'#34d399(?![0-9a-fA-F])', 'var(--color-success)', css, flags=re.IGNORECASE)
css = re.sub(r'#34f5a6(?![0-9a-fA-F])', 'var(--color-success)', css, flags=re.IGNORECASE)
css = re.sub(r'#f87171(?![0-9a-fA-F])', 'var(--color-danger)', css, flags=re.IGNORECASE)
css = re.sub(r'#fca5a5(?![0-9a-fA-F])', 'var(--color-danger)', css, flags=re.IGNORECASE)
css = re.sub(r'#fecaca(?![0-9a-fA-F])', 'var(--color-danger)', css, flags=re.IGNORECASE)

# Text grays
text_muted = ['#555566', '#766b5f', '#7d8aa8']
for c in text_muted: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--text-muted)', css, flags=re.IGNORECASE)

# Unify random purples to accent
purples = ['#c4b5fd', '#a78bfa', '#ddd6fe', '#e9ddff', '#efeaff', '#f0f7ff', '#f5f3ff', '#d8d5e6']
for c in purples: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--accent)', css, flags=re.IGNORECASE)

dark_purples = ['#4c1d95', '#5b21b6', '#3b0764']
for c in dark_purples: css = re.sub(rf'{c}(?![0-9a-fA-F])', 'var(--accent)', css, flags=re.IGNORECASE)

# The remaining colors are safe to leave as they are (unique colors that don't need grouping)

# 3. Animations
# DO NOT TOUCH caret animations or functional pulses.
def replace_easing(match):
    anim_content = match.group(0)
    # If this is a caret animation, skip entirely
    if 'caret' in anim_content.lower() or 'blink' in anim_content.lower() or 'step' in anim_content.lower():
        return anim_content
    # Otherwise unify the easing, but ONLY for ease/ease-in-out
    anim_content = re.sub(r'\bease\b', 'cubic-bezier(0.4, 0, 0.2, 1)', anim_content)
    anim_content = re.sub(r'\bease-in-out\b', 'cubic-bezier(0.4, 0, 0.2, 1)', anim_content)
    return anim_content

# We only modify the animation properties, not the keyframes themselves.
# Actually, keyframes don't have easing in their declaration.
css = re.sub(r'animation:[^;]+;', replace_easing, css)
css = re.sub(r'transition:[^;]+;', replace_easing, css)

# Extract keyframes safely
def extract_keyframes(css_text):
    keyframes = []
    out_css = ""
    i = 0
    while i < len(css_text):
        idx = css_text.find('@keyframes', i)
        if idx == -1:
            out_css += css_text[i:]
            break
        out_css += css_text[i:idx]
        open_brace = css_text.find('{', idx)
        if open_brace == -1: break
        depth = 1
        j = open_brace + 1
        while j < len(css_text) and depth > 0:
            if css_text[j] == '{': depth += 1
            elif css_text[j] == '}': depth -= 1
            j += 1
        kf_block = css_text[idx:j]
        keyframes.append(kf_block)
        i = j
    return out_css, keyframes

css, extracted_kf = extract_keyframes(css)

# 4. Splitting
root_match = re.search(r':root\s*\{.*?\n\}', css, re.DOTALL)
root_css = ""
if root_match:
    root_css = root_match.group(0)
    css = css[:root_match.start()] + css[root_match.end():]
    insertion = '\n  /* Unified Z-Indexes */\n' + '\n'.join(z_vars) + '\n'
    root_css = root_css[:-1] + insertion + '}'

os.makedirs('src/css', exist_ok=True)
with open('src/css/variables.css', 'w', encoding='utf-8') as f: f.write("/* Design System & Variables */\n" + root_css)
with open('src/css/animations.css', 'w', encoding='utf-8') as f: f.write("/* Animations Registry */\n" + "\n\n".join(extracted_kf))
with open('src/css/ui.css', 'w', encoding='utf-8') as f: f.write("/* Main UI */\n" + css)

print("Manual refactor completed successfully.")
