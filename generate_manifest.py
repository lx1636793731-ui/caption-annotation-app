import csv
import json
from pathlib import Path

# 用法：
# 1. 把图片放到 backend/data/images/
# 2. 准备 captions.csv，格式：filename,caption
#    例如：000001.jpg,a dog running on the grass
# 3. 运行：python generate_manifest.py

CSV_PATH = Path("captions.csv")
OUT_PATH = Path("manifest.json")

items = []
with CSV_PATH.open("r", encoding="utf-8-sig", newline="") as f:
    reader = csv.DictReader(f)
    for idx, row in enumerate(reader, start=1):
        filename = row.get("filename") or row.get("image") or row.get("file")
        caption = row.get("caption")
        if not filename or not caption:
            continue
        image_id = Path(filename).stem
        items.append({
            "id": image_id,
            "imageUrl": f"/images/{filename}",
            "caption": caption,
        })

OUT_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"Saved {len(items)} items to {OUT_PATH}")
