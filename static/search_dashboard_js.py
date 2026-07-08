import os

dashboard_js_path = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp\static\dashboard.js"

with open(dashboard_js_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines in dashboard.js: {len(lines)}")
for i, line in enumerate(lines):
    lower_line = line.lower()
    if "performancechart" in lower_line or "chart" in lower_line or "svg" in lower_line or "color" in lower_line:
        if any(x in lower_line for x in ["function", "const", "let", "var", "draw", "render", "stroke", "fill"]):
            print(f"Line {i+1}: {line.strip()[:100]}")
