# Caption Annotation App

A local web-based tool for human caption span annotation. Select text spans in image captions, assign attributes with color coding, and export labeled records — all through an interactive React UI backed by FastAPI and SQLite.

## Key Features

- **Span-level annotation** — drag-select text in captions, assign colored attribute labels, and save structured annotations with start/end offsets
- **Attribute management** — create custom attributes with colors, search, rename, reorder, and toggle compact/comfort display
- **Visual preview** — selected text immediately shows the attribute color before saving, colored spans are clickable for detail popovers
- **Batch import** — upload a zip of images + a JSONL/JSON caption file, auto-matched by image_id or filename
- **Single upload** — upload one image with a caption directly
- **Caption editing** — edit captions inline, adjust font size, search with yellow highlight, scrollable fixed-height display
- **Flexible layout** — three-panel workspace (Image+Caption / Note / Records), with persistent customizable layout via drag-to-resize panels
- **Export** — download all records as JSON or CSV
- **Multi-user** — simple username-based login, each annotator's records are tracked separately; users can only delete their own annotations
- **Erase tool** — remove mistaken selections or overlapping annotations by the current user
- **Network access** — accessible from other devices on the same Wi-Fi

## Quick Start

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Requirements: Python 3.8+, `fastapi`, `uvicorn`, `python-multipart`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Requirements: Node.js 16+, npm 7+.

### 3. Open

```
http://localhost:5173
```

Log in with any username (e.g. `user1`). The account is created automatically on first login.

### Access from Other Devices

Make sure the backend is started with `--host 0.0.0.0`. The frontend dev server will display a network URL (e.g. `http://10.4.147.182:5173`). Open this address on any device connected to the same Wi-Fi.

If the page doesn't load, the network may have device isolation enabled — try a mobile hotspot or deploy to a server instead.

## Annotation Workflow

1. Log in with a username
2. Upload or import images with captions
3. Select an attribute in the right panel (e.g. `Object`)
4. Drag-select text in the `Original Caption` box — a preview highlight appears immediately
5. Optionally add a note in the scrollable text area
6. Click `Save selected-word annotation`
7. The saved annotation appears with the attribute's color; click any colored span to see details
8. Use `Erase` to remove overlapping annotations, or click a colored span and choose `Erase this annotation` in the popover

## Importing Data

### Single Image + Caption

Use the upload form in the UI — select an image file and type or paste the caption.

### Batch: Image Zip + Caption File

Upload a `.zip` file containing images and a `.json` / `.jsonl` caption file.

Matching logic:

1. If `image_id` is present in the caption entry, use it as the match key
2. Otherwise, use the filename from `image_path`

Caption field priority: `reference_caption` > `caption` > `text`

### Manifest Import

Post a JSON array to `/api/items/import`:

```json
[
  {
    "id": "000001",
    "imageUrl": "/images/000001.jpg",
    "caption": "a dog running on the grass near a blue ball"
  }
]
```

Use [`generate_manifest.py`](generate_manifest.py) to convert a CSV (`filename,caption`) into the import format.

## Exporting Data

Two endpoints provide downloads:

- **JSON** — `GET /api/export/json` returns a structured JSON file with items, attributes, and all records
- **CSV** — `GET /api/export/csv` returns a flat CSV of all annotation records

In the UI, use the `Export JSON` and `Export CSV` buttons.

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
