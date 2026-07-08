import os

admin_js_path = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp\static\admin.js"

with open(admin_js_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines in admin.js: {len(lines)}")
for i, line in enumerate(lines):
    lower_line = line.lower()
    if "members" in lower_line or "waitinglist" in lower_line or "waiting-list" in lower_line:
        if "function" in lower_line or "render" in lower_line or "const" in lower_line or "let" in lower_line or "tbody" in lower_line:
            print(f"Line {i+1}: {line.strip()[:100]}")
