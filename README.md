# Visual Fact Annotation App

A local web-based tool for **visual fact annotation**. A long image caption is automatically split by an LLM into many small, atomic **visual facts** (each keeping its original source span). Annotators then go through the facts one by one and pick a single label for each (correct / unsupported / hallucinated object / wrong attribute / ...). Built with a React UI backed by FastAPI and SQLite.

> The core idea: instead of reading a whole caption and hunting for problems, the annotator reviews one short checkable fact at a time. The LLM only **splits** the caption — it never judges correctness and never sees the image (this is a pure text task).

## Key Features

- **Caption → visual facts (LLM)** — one configurable LLM call turns a long caption into atomic visual facts, each with a `source_span`, character offsets, and a `fact_type` (object / count / attribute / action / spatial_relation / scene / ocr / expression / inference / style_atmosphere)
- **Pluggable LLM** — OpenAI-compatible or Anthropic-style APIs, configured via `backend/.env` or the `configure_llm.py` helper (provider / key / model / base URL / timeout / thinking)
- **Auto-parse on import** — uploading or importing data parses captions into facts **in the background**; the UI shows per-image status (pending / parsing / done / error) and refreshes automatically
- **One-click per-fact labeling** — each fact shows its visual statement, source span, and type; click one of 11 labels (A–K) to save instantly, with an optional note
- **Source-span highlight** — hovering a fact highlights the matching text in the caption; matching is tolerant to whitespace, newlines, and quote-character differences (straight/curly, single/double)
- **Scrollable fact list** — the fact panel has a fixed height with internal scrolling, so long fact lists don't stretch the page; the panel stays in view while you scroll
- **Command-line bulk import** — one script reads a local image directory + a JSONL caption file, symlinks (or copies) matching images, and registers everything via the API
- **Caption editing** — edit a caption inline; saving re-parses it into fresh facts
- **Image viewer** — zoom and pan the image while reviewing facts
- **Export** — download fact-centric results (image → facts → per-user labels) as JSON or CSV
- **Multi-user** — simple username-based login; each user's labels are tracked separately (one label per user per fact)

## Requirements

- Python 3.8+ (backend and import script)
- Node.js 18+ (frontend; see [troubleshooting notes below](#troubleshooting-network--install-issues) if you are on a server without direct internet access)
- An LLM API key (OpenAI-compatible or Anthropic) for caption parsing

## End-to-End Workflow

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

> For long bulk imports, prefer running **without** `--reload` — a hot reload restarts the server and would interrupt in-progress background parsing.

### Step 3 — Configure the LLM

The LLM config lives in a single file, `backend/.env`. Copy the template and fill it in:

```bash
cp .env.example .env   # inside backend/
```

```ini
# backend/.env
LLM_PROVIDER=openai            # "openai" (OpenAI-compatible) or "anthropic"
LLM_API_KEY=sk-...             # your API key
LLM_MODEL=gpt-4o-mini          # model name
LLM_BASE_URL=                  # optional override (see notes)
LLM_TIMEOUT=120                # request timeout (seconds)
LLM_ENABLE_THINKING=           # optional; "false" disables reasoning on hybrid models
```

Or use the helper script (the key is masked when shown):

```bash
python configure_llm.py --show                                   # view current config
python configure_llm.py --model gpt-4o                           # change just the model
python configure_llm.py --preset openai     --key sk-...         # OpenAI
python configure_llm.py --preset anthropic  --key sk-ant-...     # Anthropic
python configure_llm.py --preset siliconflow --key sk-...        # SiliconFlow (OpenAI-compatible)
python configure_llm.py --thinking false                         # disable reasoning
```

**Provider notes**

| Provider | `LLM_BASE_URL` default | Endpoint used | Auth header |
|----------|------------------------|---------------|-------------|
| `openai` | `https://api.openai.com/v1` | `{base_url}/chat/completions` | `Authorization: Bearer` |
| `anthropic` | `https://api.anthropic.com` | `{base_url}/v1/messages` | `x-api-key` |

OpenAI-compatible gateways (SiliconFlow, DeepSeek, Together, etc.) use `provider=openai` with their own `LLM_BASE_URL`, e.g. `https://api.siliconflow.cn/v1` and a model like `deepseek-ai/DeepSeek-V4-Flash`.

`LLM_ENABLE_THINKING` is only forwarded to the API when explicitly set (leave it empty for real OpenAI). On hybrid reasoning models (e.g. DeepSeek V4 / Qwen3 on SiliconFlow), `false` is dramatically faster for this pure text task.

Verify it is configured: the frontend header shows **LLM ready**, or:

```bash
curl http://localhost:8000/api/llm/status   # {"configured": true}
```

### Step 4 — Start the frontend

Open a second terminal and keep it running:

```bash
cd frontend
npm install
npm run dev
```

The frontend dev server starts at `http://localhost:5173`.

### Step 5 — Import your data

Use `setup_server_data.py` to import a local image directory and a JSONL caption file in one shot. It symlinks (or copies) matched images into the backend and registers all items via the API. Captions are then parsed into facts **in the background**.

```bash
python setup_server_data.py \
    --image-dir /path/to/your/images \
    --caption-file /path/to/your/captions.jsonl \
    --user your_name \
    --symlink
```

| Argument | Description |
|----------|-------------|
| `--image-dir` | Directory containing image files (`.jpg`, `.png`, `.webp`, `.gif`). Scanned recursively. |
| `--caption-file` | A `.jsonl` or `.json` file; each line is a JSON object. |
| `--user` | Username for the import audit record. |
| `--symlink` | Optional. Symlink images instead of copying (saves disk for large sets; same filesystem only). The backend serves symlinked images. |
| `--api-base` | Optional. Defaults to `http://127.0.0.1:8000`. |

**Caption file format.** The script reads these fields from each JSON line (first match wins):

| Priority | Field used for matching | Priority | Field used for caption text |
|----------|------------------------|----------|----------------------------|
| 1 | `image_id` | 1 | `reference_caption` |
| 2 | `image_path` (filename part) | 2 | `caption` |
| 3 | `id` / `imageUrl` / `url` | 3 | `text` |

Example `.jsonl`:

```jsonl
{"image_id": "000001.jpg", "reference_caption": "In a warmly lit cafe interior, three individuals are seated around a wooden table ..."}
{"image_path": "photos/beach.jpg", "caption": "people walking on the beach at sunset"}
```

The script prints how many entries matched, how many images are missing, and how many items were imported. Because parsing runs in the background, the import returns quickly even for large batches — facts appear per image as they finish.

> **Cost & time:** each long caption is a real LLM call and can take ~1 minute on a reasoning model. Test with a small subset first.

### Step 6 — Open and log in

```
http://localhost:5173
```

Log in with any username (created automatically on first login).

### Step 7 — Annotate

1. Pick an image (use the prev/next arrows or the search box)
2. Wait for parsing to finish — the **Visual Facts** panel shows a spinner while facts are being generated, then lists them
3. For each fact, read the **visual fact** and its quoted **source span** (hover the card to highlight that span in the caption)
4. Click one of the 11 labels to record your judgement (saved instantly); add an optional note if needed
5. Track progress with the `X / Y annotated` counter in the panel header
6. If a caption looks wrong, edit it (it will re-parse), or click **Re-parse caption** to regenerate facts

**Labels** (design doc section 4):

| Key | Label | Meaning |
|-----|-------|---------|
| A | `correct` | Correct, clearly supported by the image |
| B | `partially_correct` | Partially correct, but overstated |
| C | `unsupported` | Not supported by the image |
| D | `hallucinated_object` | Hallucinated object |
| E | `wrong_attribute` | Wrong attribute |
| F | `wrong_action` | Wrong action |
| G | `wrong_spatial_relation` | Wrong spatial relation |
| H | `ocr_uncertain` | OCR / text uncertain |
| I | `subjective_inference` | Overly subjective inference |
| J | `redundant` | True but redundant |
| K | `unsure` | Unsure, send to review |

### Step 8 — Export

**From the UI:** click `JSON` or `CSV` in the top toolbar.

**From the command line:**

```bash
curl http://localhost:8000/api/export/json -o visual_fact_annotations_$(date +%Y%m%d_%H%M).json
curl http://localhost:8000/api/export/csv  -o visual_fact_annotations_$(date +%Y%m%d_%H%M).csv
```

**Backup the raw database:**

```bash
cp backend/data/annotation.db annotation_backup_$(date +%Y%m%d_%H%M).db
```

## API Reference

All endpoints are under `http://localhost:8000`.

### Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/login` | Create or login user. Body: `{"username": "..."}` |

### LLM

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/llm/status` | Whether an API key is configured: `{"configured": true}` |

### Items

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/items?query=` | List image items (includes `parseStatus` / `factCount`), optional text search |
| `POST` | `/api/items/import` | Import items from a JSON array; queues background parsing. Body: `{"items": [...], "replace": true, "user": "..."}` |
| `POST` | `/api/items/upload` | Upload single image + caption (multipart form); queues background parsing |
| `POST` | `/api/items/upload-paired-files` | Upload image zip + caption file (multipart form); queues background parsing |
| `PATCH` | `/api/items/{image_id}/caption` | Edit a caption; re-queues background parsing |
| `GET` | `/api/items/{image_id}/parse-status` | Parse status: `{"status": "...", "factCount": N, "error": ""}` |

### Visual Facts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/items/{image_id}/facts?user=` | List facts for an image, with the given user's existing labels |
| `POST` | `/api/items/{image_id}/parse-facts` | Synchronously re-parse the caption into facts |
| `POST` | `/api/facts/{fact_row_id}/annotate` | Save a label for a fact. Body: `{"user": "...", "annotator_label": "correct", "annotator_note": ""}` |

### Export

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/export/json` | Download all data as fact-centric JSON |
| `GET` | `/api/export/csv` | Download a flat fact/label table as CSV |

> Legacy span-annotation and attribute endpoints (`/api/attributes*`, `/api/records*`) still exist in the backend for backward compatibility but are no longer used by the UI.

### Export Schema (JSON)

```json
{
  "exportedAt": "2026-06-03T15:00:00",
  "totalImages": 1,
  "items": [
    {
      "image_id": "000001.jpg",
      "image_url": "/images/000001.jpg",
      "caption": "...full caption...",
      "visual_facts": [
        {
          "fact_id": "f001",
          "source_span": "Two white ceramic cups",
          "source_start": 0,
          "source_end": 22,
          "visual_fact": "There are two cups.",
          "fact_type": "count",
          "annotations": [
            { "user": "user1", "annotator_label": "correct", "annotator_note": "", "created_at": "2026-06-03 15:00:00" }
          ]
        }
      ]
    }
  ]
}
```

CSV columns: `image_id, caption, fact_id, fact_type, source_span, source_start, source_end, visual_fact, user, annotator_label, annotator_note` (one row per annotation).

## Project Structure

```
caption-annotation-app/
├── backend/
│   ├── main.py              # FastAPI server: endpoints, SQLite schema, async parsing
│   ├── llm.py               # Pluggable caption→facts LLM client (OpenAI/Anthropic)
│   ├── configure_llm.py     # CLI to view/change LLM config in backend/.env
│   ├── .env.example         # LLM config template (copy to .env)
│   ├── requirements.txt     # Python dependencies (FastAPI, Uvicorn, httpx, ...)
│   └── data/
│       ├── annotation.db    # SQLite database (auto-created)
│       └── images/          # Imported/uploaded images served statically
├── frontend/
│   ├── package.json         # Node dependencies (React, Vite, Tailwind, Framer Motion)
│   ├── index.html
│   └── src/
│       ├── App.jsx          # Main React component (fact list + per-fact labeling UI)
│       ├── main.jsx         # Entry point
│       └── style.css        # Tailwind + custom styles
├── setup_server_data.py     # Import script: image dir + JSONL → backend
├── sample_data/
│   └── manifest_example.json
└── generate_manifest.py     # CSV → manifest JSON helper
```

### Data model

| Table | Purpose |
|-------|---------|
| `items` | One row per image: `caption`, `parse_status`, `fact_count`, ... |
| `visual_facts` | Parsed facts per image: `source_span`, `source_start/end`, `visual_fact`, `fact_type` |
| `fact_annotations` | One label per (fact, user): `annotator_label`, `annotator_note` |
| `users` | Registered usernames |
| `attributes` / `records` | Legacy span-annotation tables (unused by the current UI) |

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18, Vite 5, Tailwind CSS 3, Framer Motion 11, Lucide React icons |
| Backend | FastAPI, Uvicorn, SQLite, httpx |
| LLM | OpenAI-compatible or Anthropic chat API (configurable) |
| Storage | Local filesystem for images, SQLite for metadata |

## Troubleshooting: Network / Install Issues

### `pip install` times out

Use a mirror:

```bash
pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
```

### `npm install` hangs or fails

**Node.js version must be >= 18.** Check with `node -v`. If too old, install Node 20 manually:

```bash
wget https://npmmirror.com/mirrors/node/v20.14.0/node-v20.14.0-linux-x64.tar.xz
tar -xf node-v20.14.0-linux-x64.tar.xz
export PATH=$PWD/node-v20.14.0-linux-x64/bin:$PATH
```

Then point npm at a mirror:

```bash
npm config set registry https://repo.huaweicloud.com/repository/npm/
# or
npm config set registry https://registry.npmmirror.com
```

If a previous install was interrupted, clean up first:

```bash
rm -rf node_modules package-lock.json
npm install
```

### Facts never appear / parsing is stuck

- Check `GET /api/llm/status` and the **LLM ready** badge in the header.
- Long captions on reasoning models are slow; set `LLM_ENABLE_THINKING=false` and/or raise `LLM_TIMEOUT`.
- If the backend was restarted mid-import, some images may stay `pending`; open the image and click **Re-parse caption**, or re-run the import.

### Hovering a fact doesn't highlight the caption

Highlighting locates the fact's `source_span` in the caption. Matching tolerates whitespace and quote differences, but if the LLM materially rewrote the span (paraphrase/summary) it cannot be located. Re-parsing usually helps.

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
