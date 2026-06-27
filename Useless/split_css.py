import re
import os

css_file = 'src/styles.css'
with open(css_file, 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Unify Animations
# Define standard animations
standard_animations = """
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes fade-out { from { opacity: 1; } to { opacity: 0; } }
@keyframes slide-up { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slide-down { from { opacity: 0; transform: translateY(-10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes scale-pop { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
@keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
"""

# Map existing animations to standard ones
anim_map = {
    'command-overlay-in': 'fade-in',
    'command-panel-in': 'slide-up',
    'popup-in': 'scale-pop',
    'suggestion-in': 'slide-down',
    'modal-rise': 'slide-up',
    'popover-rise': 'slide-up',
    'fade-in': 'fade-in',
    'overlay-fade': 'fade-in',
    'mobile-slide-down': 'slide-down',
    'mobile-scale-in': 'scale-pop',
    'mobile-screen-in': 'slide-up',
    'cb-pop': 'scale-pop',
    'note-pin-pulse': 'pulse',
    'save-pulse': 'pulse'
}

for old, new in anim_map.items():
    # Replace animation names in rules. e.g. animation: command-overlay-in 0.2s ...
    css = re.sub(rf'\banimation:\s*{old}\b', f'animation: {new}', css)
    css = re.sub(rf'\banimation-name:\s*{old}\b', f'animation-name: {new}', css)

# Extract all remaining @keyframes blocks using a brace-matching algorithm
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
        
        # Find opening brace
        open_brace = css_text.find('{', idx)
        if open_brace == -1:
            break
            
        # Match braces
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

# Create css directory
os.makedirs('src/css', exist_ok=True)

# Write animations.css
with open('src/css/animations.css', 'w', encoding='utf-8') as f:
    f.write("/* Unified Animations */\n" + standard_animations + "\n\n/* Custom Animations */\n" + "\n".join(extracted_kf))

# 2. Extract Variables
# Extract the :root block
root_match = re.search(r':root\s*\{.*?\n\}', css, re.DOTALL)
root_css = ""
if root_match:
    root_css = root_match.group(0)
    css = css[:root_match.start()] + css[root_match.end():]

with open('src/css/variables.css', 'w', encoding='utf-8') as f:
    f.write("/* Design System & Variables */\n" + root_css)

# 3. Write remaining to editor.css for now, we'll refine later or keep it as ui.css
with open('src/css/ui.css', 'w', encoding='utf-8') as f:
    f.write("/* Main UI and Editor Styles */\n" + css)

print(f"Extracted {len(extracted_kf)} keyframes. Separated variables.css, animations.css, ui.css.")
