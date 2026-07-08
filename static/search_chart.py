import os

dashboard_html_path = r"c:\Users\OLAJUWON\OneDrive\Desktop\MonarchApp\templates\dashboard.html"

with open(dashboard_html_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

print(f"Total lines in dashboard.html: {len(lines)}")
for i, line in enumerate(lines):
    lower_line = line.lower()
    if "chart" in lower_line or "canvas" in lower_line or "graph" in lower_line:
        print(f"Line {i+1}: {line.strip()[:100]}")
