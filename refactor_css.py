import re
import os

css_file = 'src/styles.css'
with open(css_file, 'r', encoding='utf-8') as f:
    css = f.read()

# 1. Font display swap
def add_swap(match):
    content = match.group(0)
    if 'font-display' not in content:
        return content[:-1] + '  font-display: swap;\n}'
    return content

css = re.sub(r'@font-face\s*\{[^}]*?\}', add_swap, css)

# 2. Extract Z-Indexes
z_indexes = set(re.findall(r'z-index:\s*(\d+);', css))
z_vars = []
for z in sorted([int(z) for z in z_indexes]):
    var_name = f'--z-layer-{z}'
    z_vars.append(f'  {var_name}: {z};')
    # replace using regex to avoid matching 1000px
    css = re.sub(rf'z-index:\s*{z}\b;', f'z-index: var({var_name});', css)

# 3. Extract Colors
# find all existing variables so we don't extract them again
existing_vars = set(re.findall(r'--[\w-]+:\s*(#[0-9a-fA-F]{3,8});', css))

# find all hex colors
hex_colors = set(c.lower() for c in re.findall(r'#[0-9a-fA-F]{3,8}(?![a-zA-Z0-9_-])', css))

# we will only extract those not in existing_vars
hardcoded = [c for c in hex_colors if c not in existing_vars]

color_vars = []
for color in sorted(hardcoded):
    var_name = f'--color-hex-{color.replace("#", "")}'
    color_vars.append(f'  {var_name}: {color};')

# We must replace longest hex codes first so we don't accidentally replace #fff inside #ffffff
for color in sorted(hardcoded, key=len, reverse=True):
    var_name = f'--color-hex-{color.replace("#", "")}'
    # Replace the exact color, ignoring case, making sure the next char is not a hex char
    css = re.sub(rf'{color}(?![a-fA-F0-9])', f'var({var_name})', css, flags=re.IGNORECASE)

# Insert new variables into :root
root_match = re.search(r':root\s*\{', css)
if root_match:
    insertion = '\n  /* Auto-extracted vars */\n' + '\n'.join(z_vars) + '\n' + '\n'.join(color_vars) + '\n'
    css = css[:root_match.end()] + insertion + css[root_match.end():]
else:
    print('No :root found, appending.')
    css = f':root {{\n  /* Auto-extracted vars */\n' + '\n'.join(z_vars) + '\n' + '\n'.join(color_vars) + f'\n}}\n{css}'

with open(css_file, 'w', encoding='utf-8') as f:
    f.write(css)

print(f'Refactored styles.css successfully! Extracted {len(z_vars)} z-indexes and {len(color_vars)} colors.')
