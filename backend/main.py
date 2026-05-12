from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
from pathlib import Path
import sqlite3
import time
import uuid
import csv
import io
import json
import zipfile
import shutil
import tempfile
from datetime import datetime

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
IMAGE_DIR = DATA_DIR / "images"
DB_PATH = DATA_DIR / "annotation.db"

DATA_DIR.mkdir(exist_ok=True)
IMAGE_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Caption Annotation Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/images", StaticFiles(directory=str(IMAGE_DIR)), name="images")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def new_id(prefix: str):
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def init_db():
    conn = get_conn()
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        created_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        image_url TEXT NOT NULL,
        caption TEXT NOT NULL
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS attributes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#DBEAFE'
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY,
        image_id TEXT,
        image_url TEXT,
        image_caption TEXT,
        user TEXT,
        action TEXT,
        attribute_id TEXT,
        attribute_name TEXT,
        selected_text TEXT,
        range_start INTEGER,
        range_end INTEGER,
        note TEXT,
        created_at TEXT,
        timestamp INTEGER
    )
    """)

    attr_columns = [row[1] for row in cur.execute("PRAGMA table_info(attributes)").fetchall()]
    if "color" not in attr_columns:
        cur.execute("ALTER TABLE attributes ADD COLUMN color TEXT NOT NULL DEFAULT '#DBEAFE'")

    default_attrs = [
        ("attr_object", "Object", "#DBEAFE"),
        ("attr_action", "Action", "#FFEDD5"),
        ("attr_scene", "Scene", "#DCFCE7"),
    ]

    for attr_id, name, color in default_attrs:
        cur.execute(
            "INSERT OR IGNORE INTO attributes (id, name, color) VALUES (?, ?, ?)",
            (attr_id, name, color),
        )
        cur.execute(
            "UPDATE attributes SET color = COALESCE(NULLIF(color, ''), ?) WHERE id = ?",
            (color, attr_id),
        )

    conn.commit()
    conn.close()


init_db()

ALLOWED_IMAGE_SUFFIX = {".jpg", ".jpeg", ".png", ".webp", ".gif"}


def parse_caption_file_text(text: str):
    text = text.strip()
    if not text:
        raise ValueError("caption file is empty")

    # Support JSON array or JSONL.
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
            except Exception as e:
                raise ValueError(f"invalid JSONL at line {i}: {e}")

    parsed = []
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

        parsed.append({
            "match_name": Path(match_name).name,
            "caption": caption,
        })

    if not parsed:
        raise ValueError("no valid caption entries found")

    return parsed


def normalize_caption_text(caption: str) -> str:
    """If the user accidentally pastes a whole JSON/JSONL object as caption, extract the real caption field."""
    caption = (caption or "").strip()
    if not caption:
        return ""

    try:
        obj = json.loads(caption)
        if isinstance(obj, dict):
            value = obj.get("reference_caption") or obj.get("caption") or obj.get("text")
            if value:
                return str(value).strip()
    except Exception:
        pass

    return caption


def sanitize_color(color: Optional[str], fallback: str = "#DBEAFE") -> str:
    color = (color or "").strip()
    if len(color) == 7 and color.startswith("#"):
        try:
            int(color[1:], 16)
            return color.upper()
        except ValueError:
            return fallback
    if len(color) == 4 and color.startswith("#"):
        try:
            int(color[1:], 16)
            return ("#" + "".join(ch * 2 for ch in color[1:])).upper()
        except ValueError:
            return fallback
    return fallback


def item_out(row):
    return {
        "id": row["id"],
        "imageUrl": row["image_url"],
        "caption": row["caption"],
    }


def attr_out(row):
    color = "#DBEAFE"
    try:
        color = row["color"] or "#DBEAFE"
    except Exception:
        pass
    return {
        "id": row["id"],
        "name": row["name"],
        "color": sanitize_color(color),
    }


def record_out(row):
    range_obj = None
    if row["range_start"] is not None and row["range_end"] is not None:
        range_obj = {
            "start": row["range_start"],
            "end": row["range_end"],
        }

    return {
        "id": row["id"],
        "imageId": row["image_id"],
        "imageUrl": row["image_url"],
        "imageCaption": row["image_caption"],
        "user": row["user"],
        "action": row["action"],
        "attributeId": row["attribute_id"],
        "attributeName": row["attribute_name"],
        "selectedText": row["selected_text"],
        "range": range_obj,
        "rangeStart": row["range_start"],
        "rangeEnd": row["range_end"],
        "note": row["note"],
        "createdAt": row["created_at"],
        "timestamp": row["timestamp"],
    }


def get_item(conn, image_id: Optional[str]):
    if not image_id:
        return None
    row = conn.execute("SELECT * FROM items WHERE id = ?", (image_id,)).fetchone()
    return row


def insert_record(
    conn,
    image_id: Optional[str],
    user: str,
    action: str,
    attribute_id: Optional[str] = None,
    attribute_name: Optional[str] = None,
    selected_text: str = "",
    range_start: Optional[int] = None,
    range_end: Optional[int] = None,
    note: str = "",
):
    item = get_item(conn, image_id)
    image_url = item["image_url"] if item else ""
    image_caption = item["caption"] if item else ""

    record_id = new_id("rec")
    created_at = now_text()
    timestamp = int(time.time() * 1000)

    conn.execute(
        """
        INSERT INTO records (
            id, image_id, image_url, image_caption, user, action,
            attribute_id, attribute_name, selected_text,
            range_start, range_end, note, created_at, timestamp
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record_id,
            image_id,
            image_url,
            image_caption,
            user,
            action,
            attribute_id,
            attribute_name,
            selected_text,
            range_start,
            range_end,
            note,
            created_at,
            timestamp,
        ),
    )


class LoginIn(BaseModel):
    username: str


class ImportItemsIn(BaseModel):
    items: List[Dict[str, Any]]
    replace: bool = True
    user: Optional[str] = None


class AttributeCreateIn(BaseModel):
    name: str
    user: str
    image_id: Optional[str] = None
    color: Optional[str] = "#DBEAFE"


class AttributePatchIn(BaseModel):
    name: str
    user: str
    image_id: Optional[str] = None
    color: Optional[str] = "#DBEAFE"


class DeleteIn(BaseModel):
    user: str
    image_id: Optional[str] = None


class RecordCreateIn(BaseModel):
    image_id: str
    user: str
    action: str = "annotate_caption_span"
    attribute_id: Optional[str] = None
    attribute_name: Optional[str] = None
    selected_text: str = ""
    range_start: Optional[int] = None
    range_end: Optional[int] = None
    note: str = ""


class ItemCaptionPatchIn(BaseModel):
    caption: str
    user: str


@app.post("/api/login")
def login(payload: LoginIn):
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="username is required")

    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO users (username, created_at) VALUES (?, ?)",
        (username, now_text()),
    )
    conn.commit()
    conn.close()

    return {"username": username}


@app.get("/api/items")
def list_items(query: str = ""):
    conn = get_conn()
    q = query.strip().lower()

    if q:
        rows = conn.execute(
            """
            SELECT * FROM items
            WHERE lower(id) LIKE ? OR lower(caption) LIKE ?
            ORDER BY id
            """,
            (f"%{q}%", f"%{q}%"),
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM items ORDER BY id").fetchall()

    conn.close()
    return [item_out(row) for row in rows]




@app.patch("/api/items/{image_id}/caption")
def update_item_caption(image_id: str, payload: ItemCaptionPatchIn):
    caption = normalize_caption_text(payload.caption)
    user = payload.user.strip()

    if not caption:
        raise HTTPException(status_code=400, detail="caption is required")
    if not user:
        raise HTTPException(status_code=400, detail="user is required")

    conn = get_conn()
    old = conn.execute("SELECT * FROM items WHERE id = ?", (image_id,)).fetchone()
    if not old:
        conn.close()
        raise HTTPException(status_code=404, detail="image item not found")

    conn.execute(
        "UPDATE items SET caption = ? WHERE id = ?",
        (caption, image_id),
    )

    insert_record(
        conn,
        image_id=image_id,
        user=user,
        action="edit_caption",
        note="Edited original caption",
    )

    conn.commit()
    row = conn.execute("SELECT * FROM items WHERE id = ?", (image_id,)).fetchone()
    conn.close()

    return item_out(row)


@app.post("/api/items/import")
def import_items(payload: ImportItemsIn):
    conn = get_conn()
    cur = conn.cursor()

    if payload.replace:
        cur.execute("DELETE FROM items")
        cur.execute("DELETE FROM records")

    count = 0

    for i, item in enumerate(payload.items):
        image_id = str(item.get("id") or f"img_{i + 1:06d}")
        image_url = str(
            item.get("imageUrl")
            or item.get("image_url")
            or item.get("image")
            or item.get("url")
            or ""
        )
        caption = normalize_caption_text(str(item.get("caption") or ""))

        if not image_url or not caption:
            continue

        cur.execute(
            """
            INSERT OR REPLACE INTO items (id, image_url, caption)
            VALUES (?, ?, ?)
            """,
            (image_id, image_url, caption),
        )
        count += 1

    if payload.user:
        insert_record(
            conn,
            image_id=None,
            user=payload.user,
            action="import_items",
            note=f"Imported {count} items",
        )

    conn.commit()
    conn.close()

    return {"imported": count}


@app.post("/api/items/upload")
async def upload_image_with_caption(
    file: UploadFile = File(...),
    caption: str = Form(...),
    user: str = Form(...),
    image_id: Optional[str] = Form(None),
):
    caption = normalize_caption_text(caption)
    user = user.strip()

    if not caption:
        raise HTTPException(status_code=400, detail="caption is required")

    if not user:
        raise HTTPException(status_code=400, detail="user is required")

    suffix = Path(file.filename or "").suffix.lower()
    allowed_suffix = {".jpg", ".jpeg", ".png", ".webp", ".gif"}

    if suffix not in allowed_suffix:
        raise HTTPException(
            status_code=400,
            detail="Only jpg, jpeg, png, webp, and gif images are supported",
        )

    item_id = image_id.strip() if image_id else new_id("img")
    safe_filename = f"{item_id}{suffix}"
    save_path = IMAGE_DIR / safe_filename

    content = await file.read()
    save_path.write_bytes(content)

    image_url = f"/images/{safe_filename}"

    conn = get_conn()

    conn.execute(
        """
        INSERT OR REPLACE INTO items (id, image_url, caption)
        VALUES (?, ?, ?)
        """,
        (item_id, image_url, caption),
    )

    insert_record(
        conn,
        image_id=item_id,
        user=user,
        action="upload_image_caption",
        note=f"Uploaded image and caption: {caption}",
    )

    conn.commit()

    row = conn.execute(
        "SELECT * FROM items WHERE id = ?",
        (item_id,),
    ).fetchone()

    conn.close()

    return item_out(row)


@app.post("/api/items/upload-paired-files")
async def upload_paired_files(
    images_zip: UploadFile = File(...),
    captions_file: UploadFile = File(...),
    user: str = Form(...),
):
    user = user.strip()
    if not user:
        raise HTTPException(status_code=400, detail="user is required")

    zip_suffix = Path(images_zip.filename or "").suffix.lower()
    if zip_suffix != ".zip":
        raise HTTPException(status_code=400, detail="images_zip must be a .zip file")

    caption_suffix = Path(captions_file.filename or "").suffix.lower()
    if caption_suffix not in {".json", ".jsonl", ".txt"}:
        raise HTTPException(status_code=400, detail="captions_file must be .json / .jsonl / .txt")

    zip_bytes = await images_zip.read()
    caption_bytes = await captions_file.read()

    try:
        caption_text = caption_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="captions_file must be UTF-8 text")

    try:
        caption_entries = parse_caption_file_text(caption_text)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid captions file: {e}")

    with tempfile.TemporaryDirectory() as tmpdir_raw:
        tmpdir = Path(tmpdir_raw)
        zip_path = tmpdir / "images.zip"
        extract_dir = tmpdir / "unzipped"
        zip_path.write_bytes(zip_bytes)

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(extract_dir)
        except zipfile.BadZipFile:
            raise HTTPException(status_code=400, detail="invalid zip file")

        # Scan all images in the zip file, including nested folders.
        image_map = {}
        for p in extract_dir.rglob("*"):
            if p.is_file() and p.suffix.lower() in ALLOWED_IMAGE_SUFFIX:
                image_map[p.name] = p

        if not image_map:
            raise HTTPException(status_code=400, detail="no images found in zip")

        conn = get_conn()
        imported = 0
        missing_images = []
        matched_names = set()

        for entry in caption_entries:
            filename = Path(entry["match_name"]).name
            caption = entry["caption"]

            src_path = image_map.get(filename)
            if not src_path:
                missing_images.append(filename)
                continue

            matched_names.add(filename)

            # Use the full filename as item id for stable matching and export.
            item_id = filename
            dest_name = filename
            dest_path = IMAGE_DIR / dest_name

            # If a file with the same name already exists, overwrite it.
            shutil.copy2(src_path, dest_path)

            image_url = f"/images/{dest_name}"

            conn.execute(
                """
                INSERT OR REPLACE INTO items (id, image_url, caption)
                VALUES (?, ?, ?)
                """,
                (item_id, image_url, caption),
            )
            imported += 1

        unused_images = sorted(set(image_map.keys()) - matched_names)

        insert_record(
            conn,
            image_id=None,
            user=user,
            action="upload_paired_files",
            note=f"Batch imported {imported} matched image-caption pairs",
        )

        conn.commit()
        conn.close()

    return {
        "imported": imported,
        "missingImages": missing_images,
        "unusedImages": unused_images,
    }


@app.get("/api/attributes")
def list_attributes():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM attributes ORDER BY rowid").fetchall()
    conn.close()
    return [attr_out(row) for row in rows]


@app.post("/api/attributes")
def create_attribute(payload: AttributeCreateIn):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="attribute name is required")

    color = sanitize_color(payload.color)

    conn = get_conn()
    attr_id = new_id("attr")

    conn.execute(
        "INSERT INTO attributes (id, name, color) VALUES (?, ?, ?)",
        (attr_id, name, color),
    )

    insert_record(
        conn,
        image_id=payload.image_id,
        user=payload.user,
        action="add_attribute",
        attribute_id=attr_id,
        attribute_name=name,
        note=f"Added attribute: {name}",
    )

    conn.commit()
    row = conn.execute("SELECT * FROM attributes WHERE id = ?", (attr_id,)).fetchone()
    conn.close()

    return attr_out(row)


@app.patch("/api/attributes/{attr_id}")
def update_attribute(attr_id: str, payload: AttributePatchIn):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="attribute name is required")

    color = sanitize_color(payload.color)

    conn = get_conn()
    old = conn.execute("SELECT * FROM attributes WHERE id = ?", (attr_id,)).fetchone()
    if not old:
        conn.close()
        raise HTTPException(status_code=404, detail="attribute not found")

    conn.execute(
        "UPDATE attributes SET name = ?, color = ? WHERE id = ?",
        (name, color, attr_id),
    )

    insert_record(
        conn,
        image_id=payload.image_id,
        user=payload.user,
        action="edit_attribute",
        attribute_id=attr_id,
        attribute_name=name,
        note=f"Renamed attribute: {old['name']} -> {name}",
    )

    conn.commit()
    row = conn.execute("SELECT * FROM attributes WHERE id = ?", (attr_id,)).fetchone()
    conn.close()

    return attr_out(row)


@app.delete("/api/attributes/{attr_id}")
def delete_attribute(attr_id: str, payload: DeleteIn):
    conn = get_conn()
    old = conn.execute("SELECT * FROM attributes WHERE id = ?", (attr_id,)).fetchone()
    if not old:
        conn.close()
        raise HTTPException(status_code=404, detail="attribute not found")

    conn.execute("DELETE FROM attributes WHERE id = ?", (attr_id,))

    insert_record(
        conn,
        image_id=payload.image_id,
        user=payload.user,
        action="delete_attribute",
        attribute_id=attr_id,
        attribute_name=old["name"],
        note=f"Deleted attribute: {old['name']}",
    )

    conn.commit()
    conn.close()

    return {"ok": True}


@app.get("/api/records")
def list_records(image_id: Optional[str] = None):
    conn = get_conn()

    if image_id:
        rows = conn.execute(
            "SELECT * FROM records WHERE image_id = ? ORDER BY timestamp DESC",
            (image_id,),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM records ORDER BY timestamp DESC"
        ).fetchall()

    conn.close()
    return [record_out(row) for row in rows]


@app.post("/api/records")
def create_record(payload: RecordCreateIn):
    conn = get_conn()

    item = get_item(conn, payload.image_id)
    if not item:
        conn.close()
        raise HTTPException(status_code=404, detail="image item not found")

    insert_record(
        conn,
        image_id=payload.image_id,
        user=payload.user,
        action=payload.action,
        attribute_id=payload.attribute_id,
        attribute_name=payload.attribute_name,
        selected_text=payload.selected_text,
        range_start=payload.range_start,
        range_end=payload.range_end,
        note=payload.note,
    )

    conn.commit()
    conn.close()

    return {"ok": True}


@app.delete("/api/records/{record_id}")
def delete_record(record_id: str, payload: DeleteIn):
    conn = get_conn()

    row = conn.execute(
        "SELECT * FROM records WHERE id = ?",
        (record_id,),
    ).fetchone()

    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="record not found")

    if row["user"] != payload.user:
        conn.close()
        raise HTTPException(status_code=403, detail="you can only delete your own record")

    conn.execute("DELETE FROM records WHERE id = ?", (record_id,))
    conn.commit()
    conn.close()

    return {"ok": True}


@app.get("/api/export/json")
def export_json():
    conn = get_conn()
    attrs = [attr_out(row) for row in conn.execute("SELECT * FROM attributes").fetchall()]
    items = [item_out(row) for row in conn.execute("SELECT * FROM items").fetchall()]
    records = [record_out(row) for row in conn.execute("SELECT * FROM records ORDER BY timestamp").fetchall()]
    conn.close()

    payload = {
        "exportedAt": datetime.now().isoformat(),
        "totalImages": len(items),
        "items": items,
        "attributes": attrs,
        "records": records,
    }

    return JSONResponse(
        payload,
        headers={
            "Content-Disposition": "attachment; filename=caption_annotation_records.json"
        },
    )


@app.get("/api/export/csv")
def export_csv():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM records ORDER BY timestamp").fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow([
        "record_id",
        "image_id",
        "user",
        "action",
        "attribute",
        "selected_text",
        "range_start",
        "range_end",
        "note",
        "created_at",
        "caption",
        "image_url",
    ])

    for row in rows:
        writer.writerow([
            row["id"],
            row["image_id"],
            row["user"],
            row["action"],
            row["attribute_name"],
            row["selected_text"],
            row["range_start"],
            row["range_end"],
            row["note"],
            row["created_at"],
            row["image_caption"],
            row["image_url"],
        ])

    output.seek(0)

    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=caption_annotation_records.csv"
        },
    )
