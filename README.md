# Caption Annotation App

A local web-based tool for human caption span annotation. Each annotator runs the app on their own machine, imports their assigned batch of images and captions, labels text spans with colored attributes, and exports structured records — all through an interactive React UI backed by FastAPI and SQLite.

## Key Features

- **Span-level annotation** — drag-select text in captions, assign colored attribute labels, and save structured annotations with start/end offsets
- **Attribute management** — create custom attributes with colors, search, rename, reorder, and toggle compact/comfort display
- **Visual preview** — selected text immediately shows the attribute color before saving, colored spans are clickable for detail popovers
- **Command-line data import** — one script reads a local image directory + a JSONL caption file, copies matching images, and imports everything into the app
- **Caption editing** — edit captions inline, adjust font size, search with yellow highlight, scrollable fixed-height display
- **Flexible layout** — three-panel workspace (Image+Caption / Note / Records), with persistent customizable layout via drag-to-resize panels
- **Export** — download all records as JSON or CSV from the UI or the command line
- **Multi-user** — simple username-based login, each annotator's records are tracked separately; users can only delete their own annotations
- **Erase tool** — remove mistaken selections or overlapping annotations by the current user

## Requirements

- Python 3.8+ (for the backend and the import script)
- Node.js 18+ (for the frontend; see [troubleshooting notes below](#troubleshooting-network--install-issues) if you are on a server without direct internet access)

## End-to-End Workflow

Each annotator follows these steps on their own machine.

### Step 1 — Clone the repository

```bash
git clone https://github.com/lx1636793731-ui/caption-annotation-app.git
cd caption-annotation-app
```

### Step 2 — Start the backend

Open a dedicated terminal and keep it running:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

The backend listens on `http://localhost:8000`. The `--host 0.0.0.0` flag makes it reachable from the frontend dev server.

### Step 3 — Start the frontend

Open a second terminal and keep it running:

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server starts at `http://localhost:5173`.

### Step 4 — Import your data

Use `setup_server_data.py` to import a local image directory and a JSONL caption file in one shot. This script copies matched images into the backend and registers all items via the API.

```bash
python setup_server_data.py \
    --image-dir /path/to/your/images \
    --caption-file /path/to/your/captions.jsonl \
    --user your_name
```

| Argument | Description |
|----------|-------------|
| `--image-dir` | Directory containing image files (`.jpg`, `.png`, `.webp`, `.gif`). Can contain subdirectories — the script scans recursively. |
| `--caption-file` | A `.jsonl` or `.json` file. Each line is a JSON object. |
| `--user` | A username for the audit log (shown in the import record). |
| `--symlink` | Optional. Use symlinks instead of copying images (saves disk, but only works on the same filesystem). |
| `--api-base` | Optional. Defaults to `http://127.0.0.1:8000`. Change if the backend runs elsewhere. |

**Caption file format.** The script reads these fields from each JSON line (first match wins):

| Priority | Field used for matching | Priority | Field used for caption text |
|----------|------------------------|----------|----------------------------|
| 1 | `image_id` | 1 | `reference_caption` |
| 2 | `image_path` (filename part) | 2 | `caption` |
| 3 | `id` / `imageUrl` / `url` | 3 | `text` |

Example `.jsonl`:

```jsonl
{"image_id": "000001", "reference_caption": "a dog running on grass"}
{"image_path": "photos/beach.jpg", "caption": "people walking on the beach at sunset"}
```

The script will print a summary: how many entries matched, how many images are missing, and how many items were imported. If any images referenced in the JSONL are not found under `--image-dir`, their filenames are listed so you can investigate.

### Step 5 — Open and log in

```
http://localhost:5173
```

Log in with any username (e.g. your name). The account is created automatically on first login. You are now ready to annotate.

### Step 6 — Annotate

1. Select an attribute in the right panel (e.g. `Object`)
2. Drag-select text in the `Original Caption` box — a preview highlight appears immediately in the attribute's color
3. Optionally add a note in the middle panel
4. Click `Save selected-word annotation`
5. The saved annotation appears with the attribute's color; click any colored span to see details and notes
6. Use `Erase` to remove overlapping annotations, or click a colored span and choose `Erase this annotation` in the popover
7. Navigate between images with the arrow buttons at the bottom

### Step 7 — Export your annotations

Once you finish annotating, export your records. Two options:

**From the UI:** Click `Export JSON` or `Export CSV` in the top toolbar — the file downloads immediately.

**From the command line:**

```bash
# JSON export (items + attributes + all records)
curl http://localhost:8000/api/export/json \
    -o annotations_$(date +%Y%m%d_%H%M).json

# CSV export (flat record table)
curl http://localhost:8000/api/export/csv \
    -o annotations_$(date +%Y%m%d_%H%M).csv
```

**Backup the raw database:**

```bash
cp backend/data/annotation.db annotation_backup_$(date +%Y%m%d_%H%M).db
```

### Step 8 — Submit

Send your exported `.json` or `.csv` file to whoever is collecting the results. Each annotator's records are tagged with their username, so multiple exports can be merged safely.

## API Reference

All endpoints are under `http://localhost:8000`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Create or login user. Body: `{"username": "..."}` |

### Items

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/items?query=` | List all image items, optional text search |
| `POST` | `/api/items/import` | Import items from a JSON array. Body: `{"items": [...], "replace": true, "user": "..."}` |
| `POST` | `/api/items/upload` | Upload single image + caption (multipart form) |
| `POST` | `/api/items/upload-paired-files` | Upload image zip + caption file (multipart form) |
| `PATCH` | `/api/items/{image_id}/caption` | Edit an item's caption |

### Attributes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/attributes` | List all attributes |
| `POST` | `/api/attributes` | Create attribute. Body: `{"name": "...", "color": "#DBEAFE", "user": "..."}` |
| `PATCH` | `/api/attributes/{attr_id}` | Rename or recolor an attribute |
| `DELETE` | `/api/attributes/{attr_id}` | Delete an attribute |

### Records

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/records?image_id=` | List records, optionally filtered by image |
| `POST` | `/api/records` | Create annotation record |
| `DELETE` | `/api/records/{record_id}` | Delete own record (user must match) |

### Export

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/export/json` | Download all data as JSON |
| `GET` | `/api/export/csv` | Download records as CSV |

### Record Schema

```json
{
  "id": "rec_abc123",
  "image_id": "000001",
  "user": "user1",
  "action": "annotate_caption_span",
  "attribute_id": "attr_object",
  "attribute_name": "Object",
  "selected_text": "a dog",
  "range": { "start": 0, "end": 11 },
  "note": "subject of the scene",
  "created_at": "2026-05-12 14:30:00"
}
```

## Layout Customization

The workspace has three sections: top (Image + Caption/Attributes), middle (Note), and bottom (Records + Upload).

- **Edit layout** — enters drag-to-resize mode starting from the current layout state; resize panels freely
- **Finish layout** — saves the current layout to localStorage and exits edit mode; subsequent `Edit layout` sessions build on the last saved state
- **Refresh / Reset layout** — clears all cached layout data and restores the default three-section layout

Panel sizes persist across page reloads.

## Project Structure

```
caption-annotation-app/
├── backend/
│   ├── main.py              # FastAPI server with all endpoints and SQLite schema
│   ├── requirements.txt     # Python dependencies
│   └── data/
│       ├── annotation.db    # SQLite database (auto-created)
│       └── images/          # Uploaded images served statically
├── frontend/
│   ├── package.json         # Node dependencies (React, Vite, Tailwind, Framer Motion)
│   ├── index.html
│   └── src/
│       ├── App.jsx          # Main React component (~60k, all UI logic)
│       ├── main.jsx         # Entry point
│       └── style.css        # Tailwind + custom styles
├── setup_server_data.py     # Import script: image dir + JSONL → backend
├── sample_data/
│   └── manifest_example.json
└── generate_manifest.py     # CSV → manifest JSON helper
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite 5, Tailwind CSS 3, Framer Motion 11, Lucide React icons |
| Backend | FastAPI, Uvicorn, SQLite |
| Storage | Local filesystem for images, SQLite for metadata |

## Troubleshooting: Network / Install Issues

### `pip install` times out

Use a mirror:

```bash
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### `npm install` hangs or fails

**Node.js version must be >= 18.** Check with `node -v`.

If the version is too old (e.g. v16), install Node 20 manually:

```bash
wget https://npmmirror.com/mirrors/node/v20.14.0/node-v20.14.0-linux-x64.tar.xz
tar -xf node-v20.14.0-linux-x64.tar.xz
export PATH=$PWD/node-v20.14.0-linux-x64/bin:$PATH
```

Then set the npm registry to a mirror before installing:

```bash
npm config set registry https://repo.huaweicloud.com/repository/npm/
# or
npm config set registry https://registry.npmmirror.com
```

If a previous `npm install` was interrupted, clean up first:

```bash
rm -rf node_modules package-lock.json
npm install
```

## Development

```bash
# Backend (with auto-reload)
cd backend
source .venv/bin/activate
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Frontend (with HMR)
cd frontend
npm run dev
```
