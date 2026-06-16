import re
import math

css_file = 'src/css/variables.css'
with open(css_file, 'r', encoding='utf-8') as f:
    css = f.read()

tokens = {
    '--bg-deep': '#08080a',
    '--bg-panel': '#121216',
    '--bg-page': '#16161a',
    '--bg-surface': '#1a1a22',
    '--bg-surface-hover': '#25252f',
    '--border': '#22222a',
    '--border-light': '#3e3e4d',
    '--text-main': '#eaeaea',
    '--text-muted': '#73738c',
    '--text-paper': '#d1d1d8',
    '--accent': '#8b5cf6'
}

def hex_to_rgb(hx):
    hx = hx.lstrip('#')
    if len(hx) == 3:
        hx = "".join([c*2 for c in hx])
    if len(hx) == 8: # skip alpha for distance calc, or just take first 6
        hx = hx[:6]
    return tuple(int(hx[i:i+2], 16) for i in (0, 2, 4))

def color_distance(c1, c2):
    r1, g1, b1 = c1
    r2, g2, b2 = c2
    return math.sqrt((r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2)

# Convert tokens to rgb
token_rgb = {k: hex_to_rgb(v) for k, v in tokens.items()}

def get_closest_token(hx):
    try:
        rgb = hex_to_rgb(hx)
        closest = min(token_rgb.items(), key=lambda x: color_distance(rgb, x[1]))
        
        # Don't merge if distance is too far (e.g. red errors or green success)
        if color_distance(rgb, closest[1]) > 60:
            return hx # keep original
        return f"var({closest[0]})"
    except Exception as e:
        return hx

# Find all --color-hex-* variables and replace their values
def replace_var(match):
    var_name = match.group(1)
    hx = match.group(2)
    mapped = get_closest_token(hx)
    return f"{var_name}: {mapped}; /* orig: {hx} */"

css = re.sub(r'(--color-hex-[\w-]+):\s*(#[a-fA-F0-9]{3,8});', replace_var, css)

with open(css_file, 'w', encoding='utf-8') as f:
    f.write(css)

print("Unified color palette successfully mapped to tokens!")
