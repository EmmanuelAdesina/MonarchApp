import os

style_css_path = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp\static\style.css"

with open(style_css_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines in style.css: {len(lines)}")
for i, line in enumerate(lines):
    lower_line = line.lower()
    if "nav" in lower_line or "hamburger" in lower_line or "mobile" in lower_line:
        print(f"Line {i+1}: {line.strip()[:100]}")
