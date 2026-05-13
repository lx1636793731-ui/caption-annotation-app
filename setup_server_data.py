"""
Server-side data import script.
Reads images from a directory and captions from a JSONL file,
copies images into backend/data/images/, and imports the manifest via API.

Usage:
    python setup_server_data.py \
        --image-dir /mnt/lixiaofeng/capsbench/data/example-images \
        --caption-file /mnt/lixiaofeng/capsbench/data/output/ref_captions.jsonl \
        --user admin
"""

import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def find_image_file(image_dir: Path, match_name: str) -> Path | None:
    """Find an image file by matching stem or full filename (case-insensitive)."""
    match_lower = match_name.lower()

    # Direct match
    direct = image_dir / match_name
    if direct.is_file():
        return direct

    # Stem match: walk directory for any file whose name (without ext) matches
    for f in image_dir.rglob("*"):
        if f.is_file() and f.suffix.lower() in ALLOWED_SUFFIXES:
            if f.stem.lower() == Path(match_name).stem.lower():
                return f
            if f.name.lower() == match_lower:
                return f

    return None


def parse_captions(caption_file: Path):
    """Parse a JSON or JSONL caption file. Returns list of {match_name, caption}."""
    text = caption_file.read_text(encoding="utf-8").strip()

    if text.startswith("["):
        raw = json.loads(text)
        if not isinstance(raw, list):
            raise ValueError("JSON caption file should be a list")
    else:
        raw = []
        for i, line in enumerate(text.splitlines(), start=1):
            line = line.strip()
            if not line:
                continue
            try:
                raw.append(json.loads(line))
            except json.JSONDecodeError as e:
                raise ValueError(f"invalid JSONL at line {i}: {e}")

    entries = []
    for obj in raw:
        if not isinstance(obj, dict):
            continue

        image_id = str(obj.get("image_id") or obj.get("id") or "").strip()
        image_path = str(
            obj.get("image_path")
            or obj.get("imageUrl")
            or obj.get("image_url")
            or obj.get("image")
            or obj.get("url")
            or ""
        ).strip()

        caption = str(
            obj.get("reference_caption")
            or obj.get("caption")
            or obj.get("text")
            or ""
        ).strip()

        match_name = image_id or Path(image_path).name

        if not match_name or not caption:
            continue

        entries.append({"match_name": match_name, "caption": caption})

    return entries


def main():
    parser = argparse.ArgumentParser(description="Import server-side data into Caption Annotation App")
    parser.add_argument("--image-dir", required=True, help="Path to the image directory")
    parser.add_argument("--caption-file", required=True, help="Path to the JSONL/JSON caption file")
    parser.add_argument("--user", default="admin", help="Username for the import record")
    parser.add_argument("--api-base", default="http://127.0.0.1:8000", help="Backend API base URL")
    parser.add_argument("--target-image-dir", default=None, help="Where to copy images (default: backend/data/images)")
    parser.add_argument("--symlink", action="store_true", help="Use symlinks instead of copying (faster, same filesystem only)")
    args = parser.parse_args()

    image_dir = Path(args.image_dir)
    caption_file = Path(args.caption_file)

    if not image_dir.is_dir():
        print(f"ERROR: image directory not found: {image_dir}")
        sys.exit(1)
    if not caption_file.is_file():
        print(f"ERROR: caption file not found: {caption_file}")
        sys.exit(1)

    # Determine target image directory
    if args.target_image_dir:
        target_image_dir = Path(args.target_image_dir)
    else:
        backend_dir = Path(__file__).parent / "backend" / "data" / "images"
        target_image_dir = backend_dir
    target_image_dir.mkdir(parents=True, exist_ok=True)

    # Parse captions
    print(f"Reading captions from: {caption_file}")
    entries = parse_captions(caption_file)
    print(f"  Found {len(entries)} caption entries")

    # Match and copy images
    image_files = list(image_dir.rglob("*"))
    print(f"Scanning images in: {image_dir}")
    print(f"  Found {len(image_files)} files total")

    manifest = []
    copied = 0
    missing = 0

    for i, entry in enumerate(entries):
        src = find_image_file(image_dir, entry["match_name"])
        if not src:
            missing += 1
            if missing <= 10:
                print(f"  MISSING: {entry['match_name']}")
            continue

        # Preserve original extension, use match_name stem as id
        item_id = Path(entry["match_name"]).stem
        dest_name = f"{item_id}{src.suffix.lower()}"
        dest = target_image_dir / dest_name

        if args.symlink:
            if not dest.exists():
                dest.symlink_to(src.resolve())
        else:
            if not dest.exists() or dest.stat().st_size != src.stat().st_size:
                shutil.copy2(src, dest)

        manifest.append({
            "id": item_id,
            "imageUrl": f"/images/{dest_name}",
            "caption": entry["caption"],
        })
        copied += 1

        if (i + 1) % 100 == 0:
            print(f"  Processed {i + 1}/{len(entries)}...")

    print(f"\nResults: {copied} matched, {missing} missing, {len(manifest)} items in manifest")

    if missing > 10:
        print(f"  (showing first 10 missing, {missing} total)")

    if not manifest:
        print("ERROR: no images matched!")
        sys.exit(1)

    # Import via API
    print(f"\nImporting manifest via {args.api_base}/api/items/import ...")
    payload = json.dumps({
        "items": manifest,
        "replace": True,
        "user": args.user,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{args.api_base}/api/items/import",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read().decode())
            print(f"  Imported: {result.get('imported', 0)} items")
    except urllib.error.URLError as e:
        print(f"  API call failed: {e}")
        print(f"  Manifest has {len(manifest)} items ready.")
        print(f"  Start the backend first, then re-run this script.")
        sys.exit(1)

    print("\nDone! Data is ready for annotation.")


if __name__ == "__main__":
    main()
