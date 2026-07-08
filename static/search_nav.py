import os
import sys

# Ensure UTF-8 printing
try:
    sys.stdout.reconfigure(encoding='utf-8')
except AttributeError:
    pass

templates_dir = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp"

for root, dirs, files in os.walk(templates_dir):
    for filename in files:
        if filename.endswith(".html"):
            filepath = os.path.join(root, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
            except Exception:
                continue
            
            lines = content.splitlines()
            for idx, line in enumerate(lines):
                lower_line = line.lower()
                if any(x in lower_line for x in ["nav", "login", "register"]):
                    # Remove line if it's too long or has too many spaces, just show basic text
                    cleaned = line.strip()
                    if len(cleaned) > 120:
                        cleaned = cleaned[:120] + "..."
                    print(f"{os.path.relpath(filepath, templates_dir)}:{idx+1}: {cleaned}")
