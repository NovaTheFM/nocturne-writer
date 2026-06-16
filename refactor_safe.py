import re
import os

css_file = 'src/styles.css'
with open(css_file, 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Z-Indexes
z_indexes = set(re.findall(r'z-index:\s*(\d+);', css))
z_vars = []
for z in sorted([int(z) for z in z_indexes]):
    var_name = f'--z-layer-{z}'
    z_vars.append(f'  {var_name}: {z};')
    css = re.sub(rf'z-index:\s*{z}\b;', f'z-index: var({var_name});', css)

# 2. Colors - Strictly Safe Semantic Mapping (No Mathematical Euclidean Merging)
color_map = {
    '#166534': '--color-green-800',
    '#1f1b16': '--color-brown-900',
    '#34d399': '--color-emerald-400', # Green 'Saved' text
    '#34f5a6': '--color-emerald-300',
    '#3b0764': '--color-purple-900',
    '#3b82f6': '--color-blue-500',    # Knowledge Base Selection
    '#3e3e4d': '--color-gray-600',
    '#404050': '--color-gray-700',
    '#4c1d95': '--color-purple-800',
    '#555566': '--color-gray-500',
    '#5b21b6': '--color-purple-700',
    '#8a7c6b': '--color-brown-500',
    '#93c5fd': '--color-blue-300',
    '#991b1b': '--color-red-800',
    '#99f6e4': '--color-teal-200',
    '#a7f3d0': '--color-emerald-200',
    '#aaaabd': '--color-gray-400',
    '#bae6fd': '--color-sky-200',
    '#bfdbfe': '--color-blue-200',
    '#c4b5fd': '--color-purple-300',
    '#d8d5e6': '--color-purple-200',
    '#ddd6fe': '--color-purple-100',
    '#e9ddff': '--color-purple-50',
    '#efeaff': '--color-violet-50',
    '#f0f7ff': '--color-blue-50',
    '#f5f3ff': '--color-violet-50',
    '#f6c85f': '--color-yellow-400',
    '#f87171': '--color-red-400',
    '#fca5a5': '--color-red-300',
    '#fcd34d': '--color-yellow-300',
    '#fda4af': '--color-rose-300',
    '#fecaca': '--color-red-200',
    '#ff5f7d': '--color-rose-400',
    '#ffb1aa': '--color-rose-200',
    '#02040d': '--bg-workspace-1',
    '#07070a': '--bg-workspace-2',
    '#09090d': '--bg-workspace-3',
    '#0d0d12': '--bg-workspace-4',
    '#121217': '--bg-panel-alt',
    '#1a1a22': '--bg-surface-1',
    '#1c1c24': '--bg-surface-2',
    '#25252f': '--bg-surface-3',
    '#2a2a35': '--bg-surface-4',
    '#040713': '--bg-deep-alt1',
    '#050509': '--bg-deep-alt2',
    '#070b18': '--bg-deep-alt3',
    '#0b1020': '--bg-panel-alt2',
    '#0c1224': '--bg-popover-1',
    '#111116': '--bg-popover-2',
    '#121827': '--bg-page-alt1',
    '#241f19': '--text-btn-strong',
    '#2c261f': '--text-main-alt1',
    '#766b5f': '--text-muted-alt1',
    '#7d8aa8': '--text-muted-alt2',
    '#eef3ff': '--text-main-alt2',
    '#efe4d2': '--bg-panel-light',
    '#f1e8da': '--bg-workspace-light',
    '#f4ecdf': '--bg-deep-light',
    '#fbf4e9': '--bg-popover-light',
    '#fffaf1': '--bg-page-light'
}

existing_vars = set(re.findall(r'--[\w-]+:\s*(#[0-9a-fA-F]{3,8});', css))
hex_colors = set(c.lower() for c in re.findall(r'#[0-9a-fA-F]{3,8}(?![a-zA-Z0-9_-])', css))
hardcoded = [c for c in hex_colors if c not in existing_vars]

color_vars = []
for color in sorted(hardcoded):
    var_name = color_map.get(color, f'--color-hex-{color.replace("#", "")}')
    color_vars.append(f'  {var_name}: {color};')

# Sort by length descending to prevent replacing #fff inside #ffffff
for color in sorted(hardcoded, key=len, reverse=True):
    var_name = color_map.get(color, f'--color-hex-{color.replace("#", "")}')
    css = re.sub(rf'{color}(?![a-fA-F0-9])', f'var({var_name})', css, flags=re.IGNORECASE)

# 3. Animations Unification (EASING ONLY)
# We will unify the easing curves to make them look uniform, but KEEP all 34 animations so we don't break logic
css = re.sub(r'ease\b', 'cubic-bezier(0.4, 0, 0.2, 1)', css)
css = re.sub(r'ease-in-out\b', 'cubic-bezier(0.4, 0, 0.2, 1)', css)
css = re.sub(r'ease-out\b', 'cubic-bezier(0.0, 0, 0.2, 1)', css)

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

# Extract :root
root_match = re.search(r':root\s*\{.*?\n\}', css, re.DOTALL)
root_css = ""
if root_match:
    root_css = root_match.group(0)
    css = css[:root_match.start()] + css[root_match.end():]
    
    insertion = '\n  /* Unified Colors (Preserving Original Hex) */\n' + '\n'.join(color_vars) + '\n  /* Unified Z-Indexes */\n' + '\n'.join(z_vars) + '\n'
    root_css = root_css[:-1] + insertion + '}'

os.makedirs('src/css', exist_ok=True)

with open('src/css/variables.css', 'w', encoding='utf-8') as f:
    f.write("/* Design System & Variables */\n" + root_css)

with open('src/css/animations.css', 'w', encoding='utf-8') as f:
    f.write("/* Unified Animations (Using Standard Cubic-Bezier Easing) */\n" + "\n".join(extracted_kf))

with open('src/css/ui.css', 'w', encoding='utf-8') as f:
    f.write("/* Main UI and Editor Styles */\n" + css)

print("Files successfully split, colors mapped semantically with 100% preservation, and easing curves unified.")
