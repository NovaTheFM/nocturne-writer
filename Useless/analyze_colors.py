import re

css = open('src/styles.css', 'r', encoding='utf-8').read()
# Find all hex colors with context
matches = re.finditer(r'([a-zA-Z-]+)\s*:\s*[^;}]*?(#[0-9a-fA-F]{3,8})(?![a-zA-Z0-9_-])', css)
color_usage = {}
for m in matches:
    prop = m.group(1).lower()
    color = m.group(2).lower()
    if color not in color_usage:
        color_usage[color] = set()
    color_usage[color].add(prop)

for color, props in sorted(color_usage.items()):
    print(f"{color}: {props}")
