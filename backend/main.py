from fastapi import FastAPI, HTTPException, UploadFile, File, Form, BackgroundTasks
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
import os
from datetime import datetime

BASE_DIR = Path(__file__).parent


def _load_dotenv():
    """Minimal .env loader so LLM_* settings are picked up without extra deps."""
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()

import llm
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

# follow_symlink=True so server-side bulk imports can symlink large image sets
# into data/images/ instead of duplicating them (see setup_server_data.py --symlink).
app.mount("/images", StaticFiles(directory=str(IMAGE_DIR), follow_symlink=True), name="images")


# Annotation labels for visual facts (design doc section 4).
FACT_LABELS = [
    "correct",
    "partially_correct",
    "unsupported",
    "hallucinated_object",
    "wrong_attribute",
    "wrong_action",
    "wrong_spatial_relation",
    "ocr_uncertain",
    "subjective_inference",
    "redundant",
    "unsure",
]


def get_conn():
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
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

    cur.execute("""
    CREATE TABLE IF NOT EXISTS visual_facts (
        id TEXT PRIMARY KEY,
        image_id TEXT NOT NULL,
        fact_id TEXT NOT NULL,
        order_index INTEGER NOT NULL DEFAULT 0,
        source_span TEXT,
        source_start INTEGER,
        source_end INTEGER,
        visual_fact TEXT NOT NULL,
        fact_type TEXT,
        origin TEXT DEFAULT 'parsed',
        created_at TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS fact_annotations (
        id TEXT PRIMARY KEY,
        fact_row_id TEXT NOT NULL,
        image_id TEXT,
        fact_id TEXT,
        user TEXT NOT NULL,
        annotator_label TEXT,
        annotator_note TEXT,
        created_at TEXT,
        timestamp INTEGER,
        UNIQUE(fact_row_id, user)
    )
    """)

    # Parsing status columns on items (async fact parsing).
    item_columns = [row[1] for row in cur.execute("PRAGMA table_info(items)").fetchall()]
    if "parse_status" not in item_columns:
        cur.execute("ALTER TABLE items ADD COLUMN parse_status TEXT DEFAULT 'none'")
    if "parse_error" not in item_columns:
        cur.execute("ALTER TABLE items ADD COLUMN parse_error TEXT DEFAULT ''")
    if "fact_count" not in item_columns:
        cur.execute("ALTER TABLE items ADD COLUMN fact_count INTEGER DEFAULT 0")

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
    def col(name, default=None):
        try:
            return row[name]
        except (IndexError, KeyError):
            return default

    return {
        "id": row["id"],
        "imageUrl": row["image_url"],
        "caption": row["caption"],
        "parseStatus": col("parse_status", "none") or "none",
        "parseError": col("parse_error", "") or "",
        "factCount": col("fact_count", 0) or 0,
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


def fact_out(row, annotation=None):
    return {
        "rowId": row["id"],
        "imageId": row["image_id"],
        "factId": row["fact_id"],
        "orderIndex": row["order_index"],
        "sourceSpan": row["source_span"],
        "sourceStart": row["source_start"],
        "sourceEnd": row["source_end"],
        "visualFact": row["visual_fact"],
        "factType": row["fact_type"],
        "origin": row["origin"],
        "annotatorLabel": annotation["annotator_label"] if annotation else None,
        "annotatorNote": annotation["annotator_note"] if annotation else "",
    }


def replace_facts_for_item(conn, image_id: str, parsed: dict):
    """Replace stored visual facts for an image with a freshly parsed set."""
    facts = parsed.get("visual_facts") or []
    conn.execute("DELETE FROM visual_facts WHERE image_id = ?", (image_id,))
    # Drop annotations whose fact rows no longer exist.
    conn.execute(
        "DELETE FROM fact_annotations WHERE image_id = ? AND fact_row_id NOT IN "
        "(SELECT id FROM visual_facts WHERE image_id = ?)",
        (image_id, image_id),
    )

    created_at = now_text()
    for order_index, fact in enumerate(facts):
        row_id = new_id("fact")
        conn.execute(
            """
            INSERT INTO visual_facts (
                id, image_id, fact_id, order_index, source_span,
                source_start, source_end, visual_fact, fact_type, origin, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row_id,
                image_id,
                str(fact.get("fact_id") or f"f{order_index + 1:03d}"),
                order_index,
                fact.get("source_span") or "",
                fact.get("source_start"),
                fact.get("source_end"),
                fact.get("visual_fact") or "",
                fact.get("fact_type") or "object",
                "parsed",
                created_at,
            ),
        )
    return len(facts)


def parse_and_store_facts(conn, image_id: str, caption: str) -> dict:
    """Parse caption into facts and persist them. Never raises; reports status."""
    try:
        parsed = llm.parse_caption_to_facts(caption)
    except llm.LLMNotConfigured as e:
        return {"parsed": False, "factCount": 0, "error": str(e), "configured": False}
    except llm.LLMError as e:
        return {"parsed": False, "factCount": 0, "error": str(e), "configured": True}
    except Exception as e:  # network/timeout/etc.
        return {"parsed": False, "factCount": 0, "error": str(e), "configured": True}

    count = replace_facts_for_item(conn, image_id, parsed)
    return {"parsed": True, "factCount": count, "error": "", "configured": True}


def set_parse_status(conn, image_id: str, status: str, error: str = "", fact_count: Optional[int] = None):
    if fact_count is None:
        conn.execute(
            "UPDATE items SET parse_status = ?, parse_error = ? WHERE id = ?",
            (status, error, image_id),
        )
    else:
        conn.execute(
            "UPDATE items SET parse_status = ?, parse_error = ?, fact_count = ? WHERE id = ?",
            (status, error, fact_count, image_id),
        )


def background_parse_items(image_ids: List[str]):
    """Run in a FastAPI BackgroundTask (own DB connection, own thread).

    Parses each image's caption into facts serially and records status so the
    frontend can poll instead of blocking the upload request.
    """
    for image_id in image_ids:
        conn = get_conn()
        try:
            item = conn.execute("SELECT * FROM items WHERE id = ?", (image_id,)).fetchone()
            if not item:
                conn.close()
                continue
            set_parse_status(conn, image_id, "parsing")
            conn.commit()

            status = parse_and_store_facts(conn, image_id, item["caption"])
            if status["parsed"]:
                set_parse_status(conn, image_id, "done", "", status["factCount"])
            else:
                set_parse_status(conn, image_id, "error", status["error"], 0)
            conn.commit()
        except Exception as e:  # never let a background task crash silently
            try:
                set_parse_status(conn, image_id, "error", str(e), 0)
                conn.commit()
            except Exception:
                pass
        finally:
            conn.close()


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


class FactAnnotateIn(BaseModel):
    user: str
    annotator_label: str
    annotator_note: str = ""


class ParseFactsIn(BaseModel):
    user: Optional[str] = None


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
def update_item_caption(image_id: str, payload: ItemCaptionPatchIn, background_tasks: BackgroundTasks):
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
        "UPDATE items SET caption = ?, parse_status = 'pending', parse_error = '', fact_count = 0 WHERE id = ?",
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

    background_tasks.add_task(background_parse_items, [image_id])

    return item_out(row)


@app.post("/api/items/import")
def import_items(payload: ImportItemsIn, background_tasks: BackgroundTasks):
    conn = get_conn()
    cur = conn.cursor()

    if payload.replace:
        cur.execute("DELETE FROM items")
        cur.execute("DELETE FROM records")
        cur.execute("DELETE FROM visual_facts")
        cur.execute("DELETE FROM fact_annotations")

    count = 0
    new_ids = []

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
            INSERT OR REPLACE INTO items (id, image_url, caption, parse_status, parse_error, fact_count)
            VALUES (?, ?, ?, 'pending', '', 0)
            """,
            (image_id, image_url, caption),
        )
        count += 1
        new_ids.append(image_id)

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

    if new_ids:
        background_tasks.add_task(background_parse_items, new_ids)

    return {"imported": count, "queuedForParsing": len(new_ids)}


@app.post("/api/items/upload")
async def upload_image_with_caption(
    background_tasks: BackgroundTasks,
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
        INSERT OR REPLACE INTO items (id, image_url, caption, parse_status, parse_error, fact_count)
        VALUES (?, ?, ?, 'pending', '', 0)
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

    background_tasks.add_task(background_parse_items, [item_id])

    return item_out(row)


@app.post("/api/items/upload-paired-files")
async def upload_paired_files(
    background_tasks: BackgroundTasks,
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
        new_ids = []
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
                INSERT OR REPLACE INTO items (id, image_url, caption, parse_status, parse_error, fact_count)
                VALUES (?, ?, ?, 'pending', '', 0)
                """,
                (item_id, image_url, caption),
            )
            imported += 1
            new_ids.append(item_id)

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

    if new_ids:
        background_tasks.add_task(background_parse_items, new_ids)

    return {
        "imported": imported,
        "queuedForParsing": len(new_ids),
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


@app.get("/api/llm/status")
def llm_status():
    return {"configured": llm.is_configured()}


@app.get("/api/items/{image_id}/facts")
def list_facts(image_id: str, user: Optional[str] = None):
    conn = get_conn()
    fact_rows = conn.execute(
        "SELECT * FROM visual_facts WHERE image_id = ? ORDER BY order_index",
        (image_id,),
    ).fetchall()

    annotations = {}
    if user:
        ann_rows = conn.execute(
            "SELECT * FROM fact_annotations WHERE image_id = ? AND user = ?",
            (image_id, user),
        ).fetchall()
        annotations = {row["fact_row_id"]: row for row in ann_rows}

    conn.close()
    return [fact_out(row, annotations.get(row["id"])) for row in fact_rows]


@app.get("/api/items/{image_id}/parse-status")
def parse_status(image_id: str):
    conn = get_conn()
    row = conn.execute(
        "SELECT parse_status, parse_error, fact_count FROM items WHERE id = ?",
        (image_id,),
    ).fetchone()
    conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="image item not found")
    return {
        "status": row["parse_status"] or "none",
        "error": row["parse_error"] or "",
        "factCount": row["fact_count"] or 0,
    }


@app.post("/api/items/{image_id}/parse-facts")
def parse_facts(image_id: str, payload: ParseFactsIn):
    conn = get_conn()
    item = get_item(conn, image_id)
    if not item:
        conn.close()
        raise HTTPException(status_code=404, detail="image item not found")

    set_parse_status(conn, image_id, "parsing")
    conn.commit()

    status = parse_and_store_facts(conn, image_id, item["caption"])
    if not status["parsed"]:
        set_parse_status(conn, image_id, "error", status["error"], 0)
        conn.commit()
        conn.close()
        code = 400 if status.get("configured") else 503
        raise HTTPException(status_code=code, detail=status["error"] or "parse failed")

    set_parse_status(conn, image_id, "done", "", status["factCount"])
    conn.commit()
    rows = conn.execute(
        "SELECT * FROM visual_facts WHERE image_id = ? ORDER BY order_index",
        (image_id,),
    ).fetchall()
    conn.close()
    return {"factCount": status["factCount"], "facts": [fact_out(row) for row in rows]}


@app.post("/api/facts/{fact_row_id}/annotate")
def annotate_fact(fact_row_id: str, payload: FactAnnotateIn):
    user = payload.user.strip()
    label = payload.annotator_label.strip()

    if not user:
        raise HTTPException(status_code=400, detail="user is required")
    if label not in FACT_LABELS:
        raise HTTPException(status_code=400, detail=f"invalid label: {label}")

    conn = get_conn()
    fact = conn.execute(
        "SELECT * FROM visual_facts WHERE id = ?", (fact_row_id,)
    ).fetchone()
    if not fact:
        conn.close()
        raise HTTPException(status_code=404, detail="visual fact not found")

    existing = conn.execute(
        "SELECT * FROM fact_annotations WHERE fact_row_id = ? AND user = ?",
        (fact_row_id, user),
    ).fetchone()

    created_at = now_text()
    timestamp = int(time.time() * 1000)

    if existing:
        conn.execute(
            """
            UPDATE fact_annotations
            SET annotator_label = ?, annotator_note = ?, created_at = ?, timestamp = ?
            WHERE id = ?
            """,
            (label, payload.annotator_note, created_at, timestamp, existing["id"]),
        )
    else:
        conn.execute(
            """
            INSERT INTO fact_annotations (
                id, fact_row_id, image_id, fact_id, user,
                annotator_label, annotator_note, created_at, timestamp
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                new_id("fann"),
                fact_row_id,
                fact["image_id"],
                fact["fact_id"],
                user,
                label,
                payload.annotator_note,
                created_at,
                timestamp,
            ),
        )

    conn.commit()
    conn.close()
    return {"ok": True, "annotatorLabel": label, "annotatorNote": payload.annotator_note}


def collect_export_items():
    """Build the fact-centric export structure (design doc section 9)."""
    conn = get_conn()
    item_rows = conn.execute("SELECT * FROM items ORDER BY id").fetchall()
    fact_rows = conn.execute("SELECT * FROM visual_facts ORDER BY image_id, order_index").fetchall()
    ann_rows = conn.execute("SELECT * FROM fact_annotations").fetchall()
    conn.close()

    # Map fact_row_id -> list of annotations (one per user).
    ann_by_fact: Dict[str, List[dict]] = {}
    for row in ann_rows:
        ann_by_fact.setdefault(row["fact_row_id"], []).append(
            {
                "user": row["user"],
                "annotator_label": row["annotator_label"],
                "annotator_note": row["annotator_note"],
                "created_at": row["created_at"],
            }
        )

    facts_by_image: Dict[str, List[dict]] = {}
    for row in fact_rows:
        facts_by_image.setdefault(row["image_id"], []).append(
            {
                "fact_id": row["fact_id"],
                "source_span": row["source_span"],
                "source_start": row["source_start"],
                "source_end": row["source_end"],
                "visual_fact": row["visual_fact"],
                "fact_type": row["fact_type"],
                "annotations": ann_by_fact.get(row["id"], []),
            }
        )

    items = []
    for row in item_rows:
        items.append(
            {
                "image_id": row["id"],
                "image_url": row["image_url"],
                "caption": row["caption"],
                "visual_facts": facts_by_image.get(row["id"], []),
            }
        )
    return items


@app.get("/api/export/json")
def export_json():
    items = collect_export_items()
    payload = {
        "exportedAt": datetime.now().isoformat(),
        "totalImages": len(items),
        "items": items,
    }
    return JSONResponse(
        payload,
        headers={
            "Content-Disposition": "attachment; filename=visual_fact_annotations.json"
        },
    )


@app.get("/api/export/csv")
def export_csv():
    items = collect_export_items()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "image_id",
        "caption",
        "fact_id",
        "fact_type",
        "source_span",
        "source_start",
        "source_end",
        "visual_fact",
        "user",
        "annotator_label",
        "annotator_note",
    ])

    for item in items:
        for fact in item["visual_facts"]:
            annotations = fact["annotations"] or [{}]
            for ann in annotations:
                writer.writerow([
                    item["image_id"],
                    item["caption"],
                    fact["fact_id"],
                    fact["fact_type"],
                    fact["source_span"],
                    fact["source_start"],
                    fact["source_end"],
                    fact["visual_fact"],
                    ann.get("user", ""),
                    ann.get("annotator_label", ""),
                    ann.get("annotator_note", ""),
                ])

    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=visual_fact_annotations.csv"
        },
    )
