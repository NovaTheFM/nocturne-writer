import re

with open('src/css/ui.css', 'r', encoding='utf-8') as f:
    css = f.read()

# Remove the bad SortableJS injections
idx = css.find('/* SortableJS Premium Animations */')
if idx != -1:
    css = css[:idx]

with open('src/css/ui.css', 'w', encoding='utf-8') as f:
    f.write(css)

print("ui.css cleaned.")
