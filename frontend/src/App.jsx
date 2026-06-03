import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  FileDown,
  ImagePlus,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  LogIn,
  LogOut,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Upload,
  X,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { motion } from "framer-motion";

const API_BASE = `http://${window.location.hostname}:8000`;

// Annotation labels (design doc section 4). Each fact gets exactly one.
const FACT_LABELS = [
  { key: "A", id: "correct", zh: "正确" },
  { key: "B", id: "partially_correct", zh: "部分正确，但表达过度" },
  { key: "C", id: "unsupported", zh: "图像不支持" },
  { key: "D", id: "hallucinated_object", zh: "物体幻觉" },
  { key: "E", id: "wrong_attribute", zh: "属性错误" },
  { key: "F", id: "wrong_action", zh: "动作错误" },
  { key: "G", id: "wrong_spatial_relation", zh: "空间关系错误" },
  { key: "H", id: "ocr_uncertain", zh: "OCR/文字不确定" },
  { key: "I", id: "subjective_inference", zh: "主观推测过强" },
  { key: "J", id: "redundant", zh: "真实但冗余" },
  { key: "K", id: "unsure", zh: "不确定，交给复核" },
];

const LABEL_BY_ID = Object.fromEntries(FACT_LABELS.map((l) => [l.id, l]));

const POSITIVE_LABELS = new Set(["correct"]);

const FACT_TYPE_STYLES = {
  object: "bg-blue-100 text-blue-700",
  count: "bg-indigo-100 text-indigo-700",
  attribute: "bg-emerald-100 text-emerald-700",
  action: "bg-orange-100 text-orange-700",
  spatial_relation: "bg-cyan-100 text-cyan-700",
  object_relation: "bg-cyan-100 text-cyan-700",
  scene: "bg-lime-100 text-lime-700",
  ocr: "bg-rose-100 text-rose-700",
  expression: "bg-pink-100 text-pink-700",
  inference: "bg-violet-100 text-violet-700",
  style_atmosphere: "bg-amber-100 text-amber-700",
};

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return res.json();
  return res.text();
}

function downloadFromUrl(url) {
  const a = document.createElement("a");
  a.href = url;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function factTypeBadge(type) {
  return FACT_TYPE_STYLES[type] || "bg-slate-100 text-slate-600";
}

export default function VisualFactAnnotationApp() {
  const [username, setUsername] = useState(localStorage.getItem("caption_user") || "");
  const [loginName, setLoginName] = useState("");
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [facts, setFacts] = useState([]);
  const [factsLoading, setFactsLoading] = useState(false);
  const [savingFactId, setSavingFactId] = useState(null);
  const [reparsing, setReparsing] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(true);
  const [parseState, setParseState] = useState(null);
  const pollRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const [isEditingCaption, setIsEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [savingCaption, setSavingCaption] = useState(false);
  const [captionFontSize, setCaptionFontSize] = useState(localStorage.getItem("caption_font_size") || "15");

  const [uploadImageFile, setUploadImageFile] = useState(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [batchZipFile, setBatchZipFile] = useState(null);
  const [batchCaptionFile, setBatchCaptionFile] = useState(null);
  const [batchUploading, setBatchUploading] = useState(false);

  const [imageZoom, setImageZoom] = useState(Number(localStorage.getItem("image_zoom") || 100));
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [imagePanning, setImagePanning] = useState(false);
  const imagePanRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false });

  const hoveredFactRef = useRef(null);
  const [hoveredFactRowId, setHoveredFactRowId] = useState(null);

  const current = items[Math.min(index, Math.max(items.length - 1, 0))];

  const annotatedCount = useMemo(
    () => facts.filter((f) => f.annotatorLabel).length,
    [facts]
  );

  useEffect(() => {
    localStorage.setItem("caption_font_size", captionFontSize);
  }, [captionFontSize]);

  useEffect(() => {
    localStorage.setItem("image_zoom", String(imageZoom));
  }, [imageZoom]);

  useEffect(() => {
    if (username) {
      loadItems("");
      checkLlm();
    }
  }, [username]);

  useEffect(() => {
    setIsEditingCaption(false);
    setCaptionDraft(current?.caption || "");
    setImageOffset({ x: 0, y: 0 });
    clearPoll();
    if (current?.id) {
      loadFacts(current.id);
      const status = current.parseStatus || "none";
      setParseState({ status, factCount: current.factCount || 0, error: current.parseError || "" });
      if (status === "pending" || status === "parsing") pollParseStatus(current.id);
    } else {
      setFacts([]);
      setParseState(null);
    }
    return clearPoll;
  }, [current?.id]);

  function clearPoll() {
    if (pollRef.current) {
      window.clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollParseStatus(imageId) {
    try {
      const s = await api(`/api/items/${encodeURIComponent(imageId)}/parse-status`);
      setParseState(s);
      if (s.status === "pending" || s.status === "parsing") {
        pollRef.current = window.setTimeout(() => pollParseStatus(imageId), 3000);
      } else {
        await loadFacts(imageId);
        setItems((prev) =>
          prev.map((it) =>
            it.id === imageId
              ? { ...it, parseStatus: s.status, factCount: s.factCount, parseError: s.error }
              : it
          )
        );
      }
    } catch {
      // stop polling silently on error
    }
  }

  async function checkLlm() {
    try {
      const data = await api("/api/llm/status");
      setLlmConfigured(!!data.configured);
    } catch {
      setLlmConfigured(false);
    }
  }

  async function loadItems(nextQuery = query) {
    setLoading(true);
    setError("");
    try {
      const data = await api(`/api/items?query=${encodeURIComponent(nextQuery || "")}`);
      setItems(data);
      setIndex((v) => Math.min(v, Math.max(data.length - 1, 0)));
    } catch (e) {
      setError(`Cannot connect to backend: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadFacts(imageId = current?.id) {
    if (!imageId) return;
    setFactsLoading(true);
    try {
      const data = await api(
        `/api/items/${encodeURIComponent(imageId)}/facts?user=${encodeURIComponent(username)}`
      );
      setFacts(data);
    } catch (e) {
      setError(`Failed to load facts: ${e.message}`);
    } finally {
      setFactsLoading(false);
    }
  }

  async function login() {
    const name = loginName.trim();
    if (!name) return;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ username: name }) });
      setUsername(name);
      localStorage.setItem("caption_user", name);
      setLoginName("");
    } catch (e) {
      setError(`Login failed: ${e.message}`);
    }
  }

  function logout() {
    setUsername("");
    localStorage.removeItem("caption_user");
    setItems([]);
    setFacts([]);
  }

  function flashInfo(message) {
    setInfo(message);
    setError("");
    window.clearTimeout(flashInfo._t);
    flashInfo._t = window.setTimeout(() => setInfo(""), 4000);
  }

  async function annotateFact(fact, labelId) {
    if (!username) return;
    setSavingFactId(fact.rowId);
    setError("");
    try {
      const data = await api(`/api/facts/${encodeURIComponent(fact.rowId)}/annotate`, {
        method: "POST",
        body: JSON.stringify({
          user: username,
          annotator_label: labelId,
          annotator_note: fact.annotatorNote || "",
        }),
      });
      setFacts((prev) =>
        prev.map((f) =>
          f.rowId === fact.rowId
            ? { ...f, annotatorLabel: data.annotatorLabel, annotatorNote: data.annotatorNote }
            : f
        )
      );
    } catch (e) {
      setError(`Failed to save label: ${e.message}`);
    } finally {
      setSavingFactId(null);
    }
  }

  function updateFactNoteLocal(rowId, note) {
    setFacts((prev) => prev.map((f) => (f.rowId === rowId ? { ...f, annotatorNote: note } : f)));
  }

  async function saveFactNote(fact) {
    if (!username || !fact.annotatorLabel) return;
    try {
      await api(`/api/facts/${encodeURIComponent(fact.rowId)}/annotate`, {
        method: "POST",
        body: JSON.stringify({
          user: username,
          annotator_label: fact.annotatorLabel,
          annotator_note: fact.annotatorNote || "",
        }),
      });
    } catch (e) {
      setError(`Failed to save note: ${e.message}`);
    }
  }

  async function reparseCurrent() {
    if (!current?.id) return;
    setReparsing(true);
    setError("");
    try {
      const data = await api(`/api/items/${encodeURIComponent(current.id)}/parse-facts`, {
        method: "POST",
        body: JSON.stringify({ user: username }),
      });
      flashInfo(`Parsed ${data.factCount} visual facts.`);
      setParseState({ status: "done", factCount: data.factCount, error: "" });
      await loadFacts(current.id);
    } catch (e) {
      setError(`Parse failed: ${e.message}`);
    } finally {
      setReparsing(false);
    }
  }

  async function saveCaption() {
    if (!current?.id) return;
    const caption = captionDraft.trim();
    if (!caption) return;
    setSavingCaption(true);
    setError("");
    try {
      await api(`/api/items/${encodeURIComponent(current.id)}/caption`, {
        method: "PATCH",
        body: JSON.stringify({ caption, user: username }),
      });
      setItems((prev) => prev.map((it) => (it.id === current.id ? { ...it, caption } : it)));
      setIsEditingCaption(false);
      flashInfo("Caption updated and re-parsed into facts.");
      await loadFacts(current.id);
    } catch (e) {
      setError(`Failed to save caption: ${e.message}`);
    } finally {
      setSavingCaption(false);
    }
  }

  async function uploadSingle() {
    if (!uploadImageFile || !uploadCaption.trim()) return;
    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", uploadImageFile);
      form.append("caption", uploadCaption.trim());
      form.append("user", username);
      const res = await fetch(`${API_BASE}/api/items/upload`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      await res.json();
      setUploadImageFile(null);
      setUploadCaption("");
      flashInfo("Uploaded. Parsing caption into facts in the background...");
      await loadItems("");
    } catch (e) {
      setError(`Upload failed: ${e.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function uploadBatch() {
    if (!batchZipFile || !batchCaptionFile) return;
    setBatchUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("images_zip", batchZipFile);
      form.append("captions_file", batchCaptionFile);
      form.append("user", username);
      const res = await fetch(`${API_BASE}/api/items/upload-paired-files`, { method: "POST", body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setBatchZipFile(null);
      setBatchCaptionFile(null);
      flashInfo(
        `Imported ${data.imported} pairs. Parsing ${data.queuedForParsing} captions in the background...`
      );
      await loadItems("");
    } catch (e) {
      setError(`Batch upload failed: ${e.message}`);
    } finally {
      setBatchUploading(false);
    }
  }

  function goPrev() {
    setIndex((v) => Math.max(0, v - 1));
  }
  function goNext() {
    setIndex((v) => Math.min(items.length - 1, v + 1));
  }

  function resetImageView() {
    setImageZoom(100);
    setImageOffset({ x: 0, y: 0 });
  }

  function handleImagePanStart(e) {
    if (!current?.imageUrl) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    imagePanRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      originX: imageOffset.x,
      originY: imageOffset.y,
      moved: false,
    };
    setImagePanning(true);
  }
  function handleImagePanMove(e) {
    const pan = imagePanRef.current;
    if (!pan.active) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    setImageOffset({ x: pan.originX + dx, y: pan.originY + dy });
  }
  function handleImagePanEnd() {
    const pan = imagePanRef.current;
    if (!pan.active) return;
    const wasClick = !pan.moved;
    imagePanRef.current = { ...pan, active: false };
    setImagePanning(false);
    if (wasClick && current?.imageUrl) {
      setImageZoom((z) => (z >= 300 ? 100 : Math.min(300, z + 25)));
    }
  }

  // Locate the hovered fact's source span in the caption.
  // Falls back to whitespace-tolerant matching when the stored offsets are
  // missing (e.g. the LLM span isn't a verbatim substring of the caption).
  function locateSpan(text, fact) {
    if (!fact) return null;
    const s = fact.sourceStart;
    const e = fact.sourceEnd;
    if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e > s && e <= text.length) {
      // Trust stored offsets only if they actually match the span text.
      if (!fact.sourceSpan || text.slice(s, e).toLowerCase() === fact.sourceSpan.toLowerCase()) {
        return [s, e];
      }
    }

    const span = (fact.sourceSpan || "").trim();
    if (!span) return null;

    // 1) exact, case-insensitive
    const idx = text.toLowerCase().indexOf(span.toLowerCase());
    if (idx !== -1) return [idx, idx + span.length];

    // 2) tolerant regex: collapse whitespace and treat any quote variant
    //    (straight/curly, single/double) as interchangeable, because the LLM
    //    often rewrites "cyberpunk" as 'cyberpunk'.
    const QUOTE_CLASS = "[\"'\u201C\u201D\u2018\u2019\u00AB\u00BB`]";
    const escaped = span
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s+")
      .replace(/["'\u201C\u201D\u2018\u2019\u00AB\u00BB`]/g, QUOTE_CLASS);
    try {
      const m = new RegExp(escaped, "i").exec(text);
      if (m) return [m.index, m.index + m[0].length];
    } catch {
      // ignore bad regex
    }
    return null;
  }

  // Render caption with the hovered fact's source span highlighted.
  function renderCaption() {
    const text = current?.caption || "";
    if (!text) return <span className="text-slate-400">No caption</span>;

    const hovered = facts.find((f) => f.rowId === hoveredFactRowId);
    const range = locateSpan(text, hovered);
    if (!range) return text;

    const start = clamp(range[0], 0, text.length);
    const end = clamp(range[1], 0, text.length);
    return (
      <>
        {text.slice(0, start)}
        <mark className="rounded bg-yellow-200 px-0.5 text-slate-950">{text.slice(start, end)}</mark>
        {text.slice(end)}
      </>
    );
  }

  if (!username) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl"
        >
          <div className="mb-6 flex items-center gap-2 text-slate-800">
            <Sparkles className="h-6 w-6 text-blue-600" />
            <h1 className="text-xl font-semibold">Visual Fact Annotation</h1>
          </div>
          <p className="mb-4 text-sm text-slate-500">
            登录后即可对图片 caption 拆出的 visual facts 逐条确认。
          </p>
          <input
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="Enter your username, e.g. user1"
            className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:border-blue-500"
          />
          <button
            onClick={login}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            <LogIn className="h-4 w-4" /> Login
          </button>
          {error && <p className="mt-4 text-sm text-rose-600">{error}</p>}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <Sparkles className="h-5 w-5 text-blue-600" />
            Visual Fact Annotation
          </div>
          <span
            className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
              llmConfigured ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
            }`}
            title={llmConfigured ? "LLM parser configured" : "LLM parser not configured (set LLM_API_KEY)"}
          >
            {llmConfigured ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
            LLM {llmConfigured ? "ready" : "not configured"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => downloadFromUrl(`${API_BASE}/api/export/json`)}
              className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              <Download className="h-4 w-4" /> JSON
            </button>
            <button
              onClick={() => downloadFromUrl(`${API_BASE}/api/export/csv`)}
              className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              <FileDown className="h-4 w-4" /> CSV
            </button>
            <span className="text-sm text-slate-500">
              <span className="font-medium text-slate-700">{username}</span>
            </span>
            <button
              onClick={logout}
              className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-4">
        {(error || info) && (
          <div
            className={`mb-3 rounded-lg border px-4 py-2 text-sm ${
              error ? "border-rose-200 bg-rose-50 text-rose-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {error || info}
          </div>
        )}

        {/* Navigation bar */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-white p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <button onClick={goPrev} disabled={index <= 0} className="rounded-lg border border-slate-300 p-1.5 disabled:opacity-40 hover:bg-slate-50">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="min-w-[90px] text-center text-sm text-slate-600">
              {items.length ? `${index + 1} / ${items.length}` : "0 / 0"}
            </span>
            <button onClick={goNext} disabled={index >= items.length - 1} className="rounded-lg border border-slate-300 p-1.5 disabled:opacity-40 hover:bg-slate-50">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && loadItems(query)}
                placeholder="Search image id / caption"
                className="w-64 rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-500"
              />
            </div>
            <button onClick={() => loadItems(query)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              Search
            </button>
            <button onClick={() => loadItems("")} className="flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
          {current && (
            <div className="ml-auto text-sm text-slate-500">
              image_id: <span className="font-mono text-slate-700">{current.id}</span>
            </div>
          )}
        </div>

        {/* Main two-column workspace */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          {/* Left: image + caption */}
          <div className="space-y-4">
            <div className="rounded-xl bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-slate-600">Image</span>
                <div className="ml-auto flex items-center gap-1">
                  <button onClick={() => setImageZoom((z) => Math.max(25, z - 25))} className="rounded border border-slate-300 p-1 hover:bg-slate-50">
                    <ZoomOut className="h-4 w-4" />
                  </button>
                  <span className="w-12 text-center text-xs text-slate-500">{imageZoom}%</span>
                  <button onClick={() => setImageZoom((z) => Math.min(300, z + 25))} className="rounded border border-slate-300 p-1 hover:bg-slate-50">
                    <ZoomIn className="h-4 w-4" />
                  </button>
                  <button onClick={resetImageView} className="rounded border border-slate-300 p-1 hover:bg-slate-50">
                    <RotateCcw className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div
                className={`image-pan-stage relative flex h-[360px] items-center justify-center overflow-hidden rounded-lg bg-slate-50 ${imagePanning ? "is-panning" : ""}`}
                onMouseDown={handleImagePanStart}
                onMouseMove={handleImagePanMove}
                onMouseUp={handleImagePanEnd}
                onMouseLeave={handleImagePanEnd}
              >
                {current?.imageUrl ? (
                  <img
                    src={`${API_BASE}${current.imageUrl}`}
                    alt={current.id}
                    draggable={false}
                    style={{
                      transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom / 100})`,
                      maxHeight: "100%",
                      maxWidth: "100%",
                    }}
                  />
                ) : (
                  <span className="text-sm text-slate-400">No image</span>
                )}
              </div>
            </div>

            <div className="rounded-xl bg-white p-3 shadow-sm">
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-slate-600">Original Caption</span>
                <div className="ml-auto flex items-center gap-2">
                  <select
                    value={captionFontSize}
                    onChange={(e) => setCaptionFontSize(e.target.value)}
                    className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                  >
                    {["13", "14", "15", "16", "18", "20"].map((s) => (
                      <option key={s} value={s}>{s}px</option>
                    ))}
                  </select>
                  {!isEditingCaption ? (
                    <button
                      onClick={() => {
                        setCaptionDraft(current?.caption || "");
                        setIsEditingCaption(true);
                      }}
                      disabled={!current}
                      className="flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-40"
                    >
                      <Edit3 className="h-3.5 w-3.5" /> Edit
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={saveCaption}
                        disabled={savingCaption}
                        className="flex items-center gap-1 rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                      >
                        <Save className="h-3.5 w-3.5" /> {savingCaption ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={() => setIsEditingCaption(false)}
                        className="flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50"
                      >
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
              {isEditingCaption ? (
                <textarea
                  value={captionDraft}
                  onChange={(e) => setCaptionDraft(e.target.value)}
                  className="caption-scroll h-40 w-full resize-none rounded-lg border border-slate-300 p-2 outline-none focus:border-blue-500"
                  style={{ fontSize: `${captionFontSize}px` }}
                />
              ) : (
                <div
                  className="caption-scroll h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-2 leading-relaxed"
                  style={{ fontSize: `${captionFontSize}px` }}
                >
                  {renderCaption()}
                </div>
              )}
              <p className="mt-2 text-xs text-slate-400">
                编辑并保存 caption 会自动重新拆分 visual facts（会清空该图已有 facts 标注）。
              </p>
            </div>

            <UploadPanel
              uploadImageFile={uploadImageFile}
              setUploadImageFile={setUploadImageFile}
              uploadCaption={uploadCaption}
              setUploadCaption={setUploadCaption}
              uploading={uploading}
              uploadSingle={uploadSingle}
              batchZipFile={batchZipFile}
              setBatchZipFile={setBatchZipFile}
              batchCaptionFile={batchCaptionFile}
              setBatchCaptionFile={setBatchCaptionFile}
              batchUploading={batchUploading}
              uploadBatch={uploadBatch}
            />
          </div>

          {/* Right: visual facts */}
          <div className="rounded-xl bg-white p-3 shadow-sm lg:sticky lg:top-[72px] lg:self-start">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-600">Visual Facts</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                {annotatedCount} / {facts.length} annotated
              </span>
              <button
                onClick={reparseCurrent}
                disabled={!current || reparsing}
                className="ml-auto flex items-center gap-1 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" /> {reparsing ? "Parsing..." : "Re-parse caption"}
              </button>
            </div>

            {factsLoading ? (
              <p className="py-10 text-center text-sm text-slate-400">Loading facts...</p>
            ) : !current ? (
              <p className="py-10 text-center text-sm text-slate-400">No image selected. Upload data below.</p>
            ) : facts.length === 0 && (parseState?.status === "pending" || parseState?.status === "parsing") ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-blue-300 bg-blue-50/50 p-8 text-center">
                <RefreshCw className="h-5 w-5 animate-spin text-blue-500" />
                <p className="text-sm text-blue-700">
                  正在后台拆分 visual facts… 长 caption 可能需要 1 分钟左右，完成后会自动出现。
                </p>
              </div>
            ) : facts.length === 0 && parseState?.status === "error" ? (
              <div className="rounded-lg border border-dashed border-rose-300 bg-rose-50/50 p-8 text-center">
                <p className="text-sm text-rose-700">解析失败：{parseState.error || "unknown error"}</p>
                <p className="mt-1 text-xs text-rose-500">检查 LLM 配置后点击右上角 Re-parse caption 重试。</p>
              </div>
            ) : facts.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center">
                <p className="text-sm text-slate-500">
                  这张图还没有 visual facts。
                  {llmConfigured
                    ? " 点击右上角 Re-parse caption 生成。"
                    : " 请先配置 LLM_API_KEY，再点击 Re-parse caption。"}
                </p>
              </div>
            ) : (
              <div className="caption-scroll max-h-[calc(100vh-180px)] space-y-3 overflow-y-auto pr-1">
                {facts.map((fact, i) => (
                  <FactCard
                    key={fact.rowId}
                    fact={fact}
                    index={i}
                    saving={savingFactId === fact.rowId}
                    onSelectLabel={(labelId) => annotateFact(fact, labelId)}
                    onNoteChange={(note) => updateFactNoteLocal(fact.rowId, note)}
                    onNoteBlur={() => saveFactNote(fact)}
                    onHover={(hovering) => setHoveredFactRowId(hovering ? fact.rowId : null)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function FactCard({ fact, index, saving, onSelectLabel, onNoteChange, onNoteBlur, onHover }) {
  const isDone = !!fact.annotatorLabel;
  return (
    <div
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={`rounded-lg border p-3 transition ${
        isDone ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-white"
      }`}
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400">Fact {index + 1}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${factTypeBadge(fact.factType)}`}>
          {fact.factType}
        </span>
        {isDone && (
          <span className="ml-auto flex items-center gap-1 text-xs text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {LABEL_BY_ID[fact.annotatorLabel]?.zh || fact.annotatorLabel}
          </span>
        )}
      </div>

      <p className="mb-1 text-[15px] font-medium text-slate-800">{fact.visualFact}</p>
      {fact.sourceSpan && (
        <p className="mb-2 text-xs italic text-slate-500">
          原文片段：“{fact.sourceSpan}”
        </p>
      )}

      <div className="flex flex-wrap gap-1.5">
        {FACT_LABELS.map((label) => {
          const active = fact.annotatorLabel === label.id;
          const positive = POSITIVE_LABELS.has(label.id);
          return (
            <button
              key={label.id}
              disabled={saving}
              onClick={() => onSelectLabel(label.id)}
              title={label.zh}
              className={`rounded-md border px-2 py-1 text-xs transition disabled:opacity-50 ${
                active
                  ? positive
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-blue-500 bg-blue-500 text-white"
                  : "border-slate-300 bg-white text-slate-600 hover:border-slate-400 hover:bg-slate-50"
              }`}
            >
              <span className="font-semibold">{label.key}.</span> {label.zh}
            </button>
          );
        })}
      </div>

      {isDone && (
        <input
          value={fact.annotatorNote || ""}
          onChange={(e) => onNoteChange(e.target.value)}
          onBlur={onNoteBlur}
          placeholder="Optional note..."
          className="mt-2 w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-blue-500"
        />
      )}
    </div>
  );
}

function UploadPanel(props) {
  const {
    uploadImageFile,
    setUploadImageFile,
    uploadCaption,
    setUploadCaption,
    uploading,
    uploadSingle,
    batchZipFile,
    setBatchZipFile,
    batchCaptionFile,
    setBatchCaptionFile,
    batchUploading,
    uploadBatch,
  } = props;

  return (
    <div className="rounded-xl bg-white p-3 shadow-sm">
      <span className="text-sm font-medium text-slate-600">Upload Data</span>
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Single */}
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="mb-2 flex items-center gap-1 text-xs font-medium text-slate-500">
            <ImagePlus className="h-4 w-4" /> Single image + caption
          </p>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setUploadImageFile(e.target.files?.[0] || null)}
            className="mb-2 block w-full text-xs"
          />
          <textarea
            value={uploadCaption}
            onChange={(e) => setUploadCaption(e.target.value)}
            placeholder="Caption text..."
            className="mb-2 h-20 w-full resize-none rounded border border-slate-300 p-2 text-xs outline-none focus:border-blue-500"
          />
          <button
            onClick={uploadSingle}
            disabled={uploading || !uploadImageFile || !uploadCaption.trim()}
            className="flex w-full items-center justify-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" /> {uploading ? "Uploading..." : "Upload"}
          </button>
        </div>

        {/* Batch */}
        <div className="rounded-lg border border-slate-200 p-3">
          <p className="mb-2 flex items-center gap-1 text-xs font-medium text-slate-500">
            <Upload className="h-4 w-4" /> Batch: images.zip + captions(.jsonl/.json)
          </p>
          <label className="mb-1 block text-[11px] text-slate-400">Images zip</label>
          <input
            type="file"
            accept=".zip"
            onChange={(e) => setBatchZipFile(e.target.files?.[0] || null)}
            className="mb-2 block w-full text-xs"
          />
          <label className="mb-1 block text-[11px] text-slate-400">Captions file</label>
          <input
            type="file"
            accept=".json,.jsonl,.txt"
            onChange={(e) => setBatchCaptionFile(e.target.files?.[0] || null)}
            className="mb-2 block w-full text-xs"
          />
          <button
            onClick={uploadBatch}
            disabled={batchUploading || !batchZipFile || !batchCaptionFile}
            className="flex w-full items-center justify-center gap-1 rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
          >
            <Upload className="h-4 w-4" /> {batchUploading ? "Importing..." : "Batch import"}
          </button>
        </div>
      </div>
    </div>
  );
}
