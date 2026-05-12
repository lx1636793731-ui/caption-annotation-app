import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  Eraser,
  FileDown,
  ImagePlus,
  Move,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { motion } from "framer-motion";

const API_BASE = `http://${window.location.hostname}:8000`;

const DEFAULT_ATTRIBUTE_COLORS = ["#DBEAFE", "#FFEDD5", "#DCFCE7", "#FCE7F3", "#EDE9FE", "#FEF9C3", "#E0F2FE", "#FEE2E2"];
const DEFAULT_TEXT_COLORS = ["#1D4ED8", "#C2410C", "#15803D", "#BE185D", "#6D28D9", "#A16207", "#0369A1", "#B91C1C"];

const LAYOUT_ORDER_KEY = "top_layout_order_v15";
const LAYOUT_PANEL_SIZES_KEY = "layout_panel_sizes_v15";
const LAYOUT_CUSTOM_ACTIVE_KEY = "layout_custom_active_v15";
const DEFAULT_TOP_LAYOUT_ORDER = ["image", "caption"];
const LEGACY_LAYOUT_KEYS = [
  "top_layout_order_v13",
  "layout_panel_sizes_v13",
  "layout_custom_active_v13",
  "top_layout_order_v12",
  "layout_panel_sizes_v12",
  "top_layout_order_v11",
  "layout_panel_sizes_v11",
  "top_layout_order_v10",
  "layout_panel_sizes_v10",
];

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

function getRecordStart(record) {
  return record.range?.start ?? record.rangeStart ?? record.range_start ?? null;
}

function getRecordEnd(record) {
  return record.range?.end ?? record.rangeEnd ?? record.range_end ?? null;
}

function normalizeHexColor(color, fallback = "#DBEAFE") {
  if (!color || typeof color !== "string") return fallback;
  const value = color.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toUpperCase();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    return ("#" + value.slice(1).split("").map((x) => x + x).join("")).toUpperCase();
  }
  return fallback;
}

function getAttributeColor(attr, idx = 0) {
  return normalizeHexColor(attr?.color, DEFAULT_ATTRIBUTE_COLORS[idx % DEFAULT_ATTRIBUTE_COLORS.length]);
}

function getAttributeTextColor(idx = 0) {
  return DEFAULT_TEXT_COLORS[idx % DEFAULT_TEXT_COLORS.length];
}

function getRecordAttribute(record, attributes) {
  const id = record.attributeId || record.attribute_id;
  return attributes.find((a) => a.id === id);
}

function getRecordHighlightStyle(record, attributes) {
  const attr = getRecordAttribute(record, attributes);
  const idx = attributes.findIndex((a) => a.id === (record.attributeId || record.attribute_id));
  const safeIdx = idx >= 0 ? idx : 0;
  const bg = getAttributeColor(attr, safeIdx);
  return {
    background: bg,
    borderColor: bg,
    color: getAttributeTextColor(safeIdx),
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function splitBySearch(text, term, keyPrefix) {
  if (!term.trim()) return [<span key={`${keyPrefix}-plain`}>{text}</span>];

  const pieces = [];
  const lowerText = text.toLowerCase();
  const lowerTerm = term.toLowerCase();
  let cursor = 0;
  let i = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerTerm, cursor);
    if (idx === -1) {
      pieces.push(<span key={`${keyPrefix}-tail-${i}`}>{text.slice(cursor)}</span>);
      break;
    }
    if (idx > cursor) {
      pieces.push(<span key={`${keyPrefix}-plain-${i}`}>{text.slice(cursor, idx)}</span>);
    }
    pieces.push(
      <mark key={`${keyPrefix}-mark-${i}`} className="rounded bg-yellow-200 px-0.5 text-slate-950">
        {text.slice(idx, idx + term.length)}
      </mark>
    );
    cursor = idx + term.length;
    i += 1;
  }

  return pieces;
}

export default function CaptionAnnotationApp() {
  const [username, setUsername] = useState(localStorage.getItem("caption_user") || "");
  const [loginName, setLoginName] = useState("");
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState([]);
  const [attributes, setAttributes] = useState([]);
  const [newAttrName, setNewAttrName] = useState("");
  const [newAttrColor, setNewAttrColor] = useState("#DBEAFE");
  const [editingAttrId, setEditingAttrId] = useState(null);
  const [editingAttrName, setEditingAttrName] = useState("");
  const [editingAttrColor, setEditingAttrColor] = useState("#DBEAFE");
  const [selectedText, setSelectedText] = useState("");
  const [selectedRange, setSelectedRange] = useState(null);
  const [selectedAttributeId, setSelectedAttributeId] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [uploadImageFile, setUploadImageFile] = useState(null);
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [batchZipFile, setBatchZipFile] = useState(null);
  const [batchCaptionFile, setBatchCaptionFile] = useState(null);
  const [batchUploading, setBatchUploading] = useState(false);
  const [captionFontSize, setCaptionFontSize] = useState(localStorage.getItem("caption_font_size") || "16");
  const [isEditingCaption, setIsEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [savingCaption, setSavingCaption] = useState(false);
  const [highlightPopup, setHighlightPopup] = useState(null);
  const [captionSearch, setCaptionSearch] = useState("");
  const [attrSearch, setAttrSearch] = useState("");
  const [attributeFontSize, setAttributeFontSize] = useState(localStorage.getItem("attribute_font_size") || "16");
  const [attributeMode, setAttributeMode] = useState(localStorage.getItem("attribute_mode") || "comfortable");
  const captionTextRef = useRef(null);
  const captionPanelRef = useRef(null);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
  const [customLayoutActive, setCustomLayoutActive] = useState(() => localStorage.getItem(LAYOUT_CUSTOM_ACTIVE_KEY) === "1");
  const [topLayoutOrder, setTopLayoutOrder] = useState(() => {
    try {
      const hasCustomLayout = localStorage.getItem(LAYOUT_CUSTOM_ACTIVE_KEY) === "1";
      const saved = JSON.parse(localStorage.getItem(LAYOUT_ORDER_KEY) || "[]");
      return hasCustomLayout && Array.isArray(saved) && saved.length === 2 ? saved : DEFAULT_TOP_LAYOUT_ORDER;
    } catch {
      return DEFAULT_TOP_LAYOUT_ORDER;
    }
  });
  const [draggingPanel, setDraggingPanel] = useState(null);
  const [imageZoom, setImageZoom] = useState(Number(localStorage.getItem("image_zoom") || 100));
  const [imageOffset, setImageOffset] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("image_offset_v15") || "{\"x\":0,\"y\":0}");
    } catch {
      return { x: 0, y: 0 };
    }
  });
  const [imagePanning, setImagePanning] = useState(false);
  const imagePanRef = useRef({ active: false, startX: 0, startY: 0, originX: 0, originY: 0, moved: false });
  const imagePanelRef = useRef(null);
  const captionOuterPanelRef = useRef(null);
  const notePanelRef = useRef(null);
  const bottomPanelRef = useRef(null);
  const DEFAULT_PANEL_SIZES = {
    // Fits the same visual structure as the normal workspace: image + caption on the first row,
    // note on the second row, records/upload on the third row.
    image: { width: 700, height: 560 },
    caption: { width: 760, height: 560 },
    note: { width: 1440, height: 170 },
    bottom: { width: 1440, height: 520 },
  };
  const [panelSizes, setPanelSizes] = useState(() => {
    try {
      const hasCustomLayout = localStorage.getItem(LAYOUT_CUSTOM_ACTIVE_KEY) === "1";
      const saved = JSON.parse(localStorage.getItem(LAYOUT_PANEL_SIZES_KEY) || "{}");
      return hasCustomLayout ? { ...DEFAULT_PANEL_SIZES, ...saved } : DEFAULT_PANEL_SIZES;
    } catch {
      return DEFAULT_PANEL_SIZES;
    }
  });

  const current = items[Math.min(index, Math.max(items.length - 1, 0))];
  const selectedAttr = attributes.find((a) => a.id === selectedAttributeId);

  const annotationRecords = useMemo(() => {
    if (!current?.caption) return [];
    return records
      .filter((r) => r.action === "annotate_caption_span")
      .map((r) => {
        const start = getRecordStart(r);
        const end = getRecordEnd(r);
        return { ...r, start, end };
      })
      .filter((r) => Number.isInteger(r.start) && Number.isInteger(r.end) && r.start >= 0 && r.end > r.start && r.start < current.caption.length)
      .sort((a, b) => a.start - b.start || b.end - a.end);
  }, [records, current?.caption]);

  const visibleHighlightRecords = useMemo(() => {
    const result = [...annotationRecords];
    if (selectedRange && selectedText && selectedAttributeId && current?.caption) {
      const attr = attributes.find((a) => a.id === selectedAttributeId);
      result.push({
        id: "__preview_selection__",
        user: username,
        action: "preview_selection",
        attributeId: selectedAttributeId,
        attributeName: attr?.name || "Selected attribute",
        selectedText,
        start: selectedRange.start,
        end: selectedRange.end,
        note: "Unsaved preview. Click Save selected-word annotation to save it.",
        isPreview: true,
      });
    }
    return result.sort((a, b) => a.start - b.start || (a.isPreview ? -1 : 1));
  }, [annotationRecords, selectedRange, selectedText, selectedAttributeId, attributes, username, current?.caption]);

  const userRecords = useMemo(() => records.filter((r) => r.user === username), [records, username]);

  const filteredAttributes = useMemo(() => {
    const q = attrSearch.trim().toLowerCase();
    if (!q) return attributes;
    return attributes.filter((a) => a.name.toLowerCase().includes(q));
  }, [attributes, attrSearch]);

  useEffect(() => {
    localStorage.setItem("caption_font_size", captionFontSize);
  }, [captionFontSize]);

  useEffect(() => {
    localStorage.setItem("attribute_font_size", attributeFontSize);
  }, [attributeFontSize]);

  useEffect(() => {
    localStorage.setItem("attribute_mode", attributeMode);
  }, [attributeMode]);

  useEffect(() => {
    if (customLayoutActive || layoutEditMode) {
      localStorage.setItem(LAYOUT_ORDER_KEY, JSON.stringify(topLayoutOrder));
    }
  }, [topLayoutOrder, customLayoutActive, layoutEditMode]);

  useEffect(() => {
    localStorage.setItem("image_zoom", String(imageZoom));
  }, [imageZoom]);

  useEffect(() => {
    localStorage.setItem("image_offset_v15", JSON.stringify(imageOffset));
  }, [imageOffset]);

  useEffect(() => {
    if (customLayoutActive || layoutEditMode) {
      localStorage.setItem(LAYOUT_PANEL_SIZES_KEY, JSON.stringify(panelSizes));
    }
  }, [panelSizes, customLayoutActive, layoutEditMode]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_CUSTOM_ACTIVE_KEY, customLayoutActive ? "1" : "0");
  }, [customLayoutActive]);

  function readCurrentPanelSizes() {
    const refs = {
      image: imagePanelRef.current,
      caption: captionOuterPanelRef.current,
      note: notePanelRef.current,
      bottom: bottomPanelRef.current,
    };
    const next = { ...panelSizes };
    for (const [key, node] of Object.entries(refs)) {
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        next[key] = {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }
    }
    return next;
  }

  function persistLayoutSnapshot(nextSizes, nextOrder = topLayoutOrder) {
    localStorage.setItem(LAYOUT_PANEL_SIZES_KEY, JSON.stringify(nextSizes));
    localStorage.setItem(LAYOUT_ORDER_KEY, JSON.stringify(nextOrder));
    localStorage.setItem(LAYOUT_CUSTOM_ACTIVE_KEY, "1");
  }

  function toggleLayoutEditMode() {
    const visibleSizes = readCurrentPanelSizes();
    if (layoutEditMode) {
      // Finish layout: capture exactly what is on screen now and make it the new base layout.
      // The next Edit layout click must start from this just-finished result.
      setPanelSizes(visibleSizes);
      persistLayoutSnapshot(visibleSizes, topLayoutOrder);
      setCustomLayoutActive(true);
      setLayoutEditMode(false);
      return;
    }
    // Start editing from the layout that is currently visible on screen.
    // If the user has never customized the layout, this is the original default workspace.
    // If the user already finished a previous edit, this is the latest saved custom layout.
    setPanelSizes(visibleSizes);
    setLayoutEditMode(true);
  }

  async function resetLayoutAndRefresh() {
    setLayoutEditMode(false);
    setCustomLayoutActive(false);
    setTopLayoutOrder(DEFAULT_TOP_LAYOUT_ORDER);
    setPanelSizes(DEFAULT_PANEL_SIZES);
    localStorage.removeItem(LAYOUT_ORDER_KEY);
    localStorage.removeItem(LAYOUT_PANEL_SIZES_KEY);
    localStorage.removeItem(LAYOUT_CUSTOM_ACTIVE_KEY);
    LEGACY_LAYOUT_KEYS.forEach((key) => localStorage.removeItem(key));
    await loadAll(query);
  }

  function panelStyle(key, options = {}) {
    if (!customLayoutActive && !layoutEditMode) return {};
    const size = panelSizes[key] || DEFAULT_PANEL_SIZES[key];
    return {
      width: `${size.width}px`,
      height: `${size.height}px`,
      minWidth: options.minWidth || 320,
      minHeight: options.minHeight || 220,
      maxWidth: "100%",
    };
  }

  useEffect(() => {
    if (!layoutEditMode || typeof ResizeObserver === "undefined") return;
    const refs = {
      image: imagePanelRef.current,
      caption: captionOuterPanelRef.current,
      note: notePanelRef.current,
      bottom: bottomPanelRef.current,
    };
    const observer = new ResizeObserver((entries) => {
      setPanelSizes((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const entry of entries) {
          const key = Object.entries(refs).find(([, node]) => node === entry.target)?.[0];
          if (!key) continue;
          const rect = entry.contentRect;
          const width = Math.round(rect.width);
          const height = Math.round(rect.height);
          if (width > 0 && height > 0 && (next[key]?.width !== width || next[key]?.height !== height)) {
            next[key] = { width, height };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    Object.values(refs).forEach((node) => node && observer.observe(node));
    return () => observer.disconnect();
  }, [layoutEditMode]);

  useEffect(() => {
    setSelectedText("");
    setSelectedRange(null);
    setHighlightPopup(null);
    setIsEditingCaption(false);
    setCaptionDraft(current?.caption || "");
    setImageOffset({ x: 0, y: 0 });
  }, [current?.id]);

  async function loadAll(nextQuery = query) {
    setLoading(true);
    setError("");
    try {
      const [itemsData, attrsData] = await Promise.all([
        api(`/api/items?query=${encodeURIComponent(nextQuery || "")}`),
        api("/api/attributes"),
      ]);
      setItems(itemsData);
      setAttributes(attrsData);
      if (!selectedAttributeId && attrsData[0]) setSelectedAttributeId(attrsData[0].id);
      if (itemsData.length === 0) setRecords([]);
      setIndex((v) => Math.min(v, Math.max(itemsData.length - 1, 0)));
    } catch (e) {
      setError(`Cannot connect to backend: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadRecords(imageId = current?.id) {
    if (!imageId) return;
    try {
      const data = await api(`/api/records?image_id=${encodeURIComponent(imageId)}`);
      setRecords(data);
    } catch (e) {
      setError(`Failed to load records: ${e.message}`);
    }
  }

  useEffect(() => {
    if (username) loadAll("");
  }, [username]);

  useEffect(() => {
    if (current?.id) loadRecords(current.id);
  }, [current?.id]);

  function handlePanelDrop(targetPanel) {
    if (!layoutEditMode || !draggingPanel || draggingPanel === targetPanel) return;
    setTopLayoutOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(draggingPanel);
      const to = next.indexOf(targetPanel);
      if (from < 0 || to < 0) return prev;
      next.splice(from, 1);
      next.splice(to, 0, draggingPanel);
      return next;
    });
    setDraggingPanel(null);
  }

  const layoutPanelClass = layoutEditMode
    ? "resizable-panel cursor-move ring-2 ring-blue-300 ring-offset-2"
    : "";
  const topLayoutContainerClass = (customLayoutActive || layoutEditMode)
    ? "flex flex-wrap items-start gap-4 mb-4"
    : "grid grid-cols-1 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] gap-4 mb-4";

  function resetImageView() {
    setImageZoom(100);
    setImageOffset({ x: 0, y: 0 });
  }

  function handleImagePanStart(e) {
    if (!current?.imageUrl) return;
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
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
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    setImageOffset({ x: pan.originX + dx, y: pan.originY + dy });
  }

  function handleImagePanEnd(e) {
    const pan = imagePanRef.current;
    if (!pan.active) return;
    e?.preventDefault?.();
    e?.stopPropagation?.();
    const wasClick = !pan.moved;
    imagePanRef.current = { ...pan, active: false };
    setImagePanning(false);
    if (wasClick && current?.imageUrl) {
      setImageZoom((z) => (z >= 300 ? 100 : Math.min(300, z + 25)));
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
    setRecords([]);
    clearSelection();
  }

  function getSelectionOffsetsInsideCaption() {
    const root = captionTextRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return null;

    const selected = selection.toString();
    if (!selected.trim()) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(root);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + selected.length;

    return { start, end, text: selected };
  }

  function handleCaptionSelection() {
    if (!current || isEditingCaption) return;
    const info = getSelectionOffsetsInsideCaption();
    if (!info) return;
    setSelectedText(info.text);
    setSelectedRange({ start: info.start, end: info.end });
    setHighlightPopup(null);
  }

  function clearSelection() {
    setSelectedText("");
    setSelectedRange(null);
    setHighlightPopup(null);
    window.getSelection()?.removeAllRanges();
  }

  function handleHighlightClick(event, record) {
    if (record.isPreview) return;
    event.stopPropagation();
    const panel = captionPanelRef.current;
    const rect = panel?.getBoundingClientRect();
    const x = rect ? clamp(event.clientX - rect.left, 12, Math.max(12, rect.width - 300)) : 20;
    const y = rect ? clamp(event.clientY - rect.top + 12, 50, Math.max(50, rect.height - 170)) : 60;
    setHighlightPopup({ record, x, y });
  }

  function renderCaptionWithHighlights() {
    const text = current?.caption || "";
    if (!text) return <span className="text-slate-400">No caption</span>;

    const pieces = [];
    let cursor = 0;
    let key = 0;

    for (const record of visibleHighlightRecords) {
      const start = clamp(record.start, 0, text.length);
      const end = clamp(record.end, 0, text.length);
      if (start < cursor || end <= start) continue;

      if (start > cursor) {
        pieces.push(<span key={`plain-${key++}`}>{splitBySearch(text.slice(cursor, start), captionSearch, `search-${key}`)}</span>);
      }

      const style = getRecordHighlightStyle(record, attributes);
      pieces.push(
        <span
          key={`hl-${record.id}-${key++}`}
          onClick={(e) => handleHighlightClick(e, record)}
          className={`caption-highlight rounded-md border px-1 py-0.5 mx-0.5 transition ${record.isPreview ? "border-dashed ring-2 ring-offset-1" : "cursor-pointer hover:shadow-sm"}`}
          style={{ ...style, opacity: record.isPreview ? 0.78 : 1 }}
          title={`${record.attributeName || record.attribute_name || "Attribute"}: ${record.selectedText || record.selected_text || ""}`}
        >
          {text.slice(start, end)}
        </span>
      );
      cursor = end;
    }

    if (cursor < text.length) {
      pieces.push(<span key={`plain-${key++}`}>{splitBySearch(text.slice(cursor), captionSearch, `search-tail-${key}`)}</span>);
    }

    return pieces;
  }

  async function addAttribute() {
    const name = newAttrName.trim();
    const color = normalizeHexColor(newAttrColor);
    if (!name || !username) return;
    try {
      const attr = await api("/api/attributes", {
        method: "POST",
        body: JSON.stringify({ name, color, user: username, image_id: current?.id || null }),
      });
      setAttributes((prev) => [...prev, attr]);
      setSelectedAttributeId(attr.id);
      setNewAttrName("");
      setNewAttrColor(DEFAULT_ATTRIBUTE_COLORS[(attributes.length + 1) % DEFAULT_ATTRIBUTE_COLORS.length]);
      if (current?.id) await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to add attribute: ${e.message}`);
    }
  }

  async function removeAttribute(attr) {
    if (!username) return;
    try {
      await api(`/api/attributes/${encodeURIComponent(attr.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ user: username, image_id: current?.id || null }),
      });
      setAttributes((prev) => prev.filter((a) => a.id !== attr.id));
      if (selectedAttributeId === attr.id) setSelectedAttributeId(attributes.find((a) => a.id !== attr.id)?.id || "");
      if (current?.id) await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to delete attribute: ${e.message}`);
    }
  }

  async function saveAttrEdit(attr) {
    const name = editingAttrName.trim();
    const color = normalizeHexColor(editingAttrColor, attr.color || "#DBEAFE");
    if (!name || !username) return;
    try {
      const updated = await api(`/api/attributes/${encodeURIComponent(attr.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, color, user: username, image_id: current?.id || null }),
      });
      setAttributes((prev) => prev.map((a) => (a.id === attr.id ? updated : a)));
      setEditingAttrId(null);
      setEditingAttrName("");
      if (current?.id) await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to edit attribute: ${e.message}`);
    }
  }

  async function quickUpdateAttrColor(attr, color) {
    if (!username) return;
    const safeColor = normalizeHexColor(color, attr.color || "#DBEAFE");
    try {
      const updated = await api(`/api/attributes/${encodeURIComponent(attr.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: attr.name, color: safeColor, user: username, image_id: current?.id || null }),
      });
      setAttributes((prev) => prev.map((a) => (a.id === attr.id ? updated : a)));
    } catch (e) {
      setError(`Failed to update attribute color: ${e.message}`);
    }
  }

  async function saveAnnotation() {
    if (!username || !current || !selectedText.trim() || !selectedAttributeId || !selectedRange) return;
    const attr = attributes.find((a) => a.id === selectedAttributeId);
    try {
      await api("/api/records", {
        method: "POST",
        body: JSON.stringify({
          image_id: current.id,
          user: username,
          action: "annotate_caption_span",
          attribute_id: selectedAttributeId,
          attribute_name: attr?.name || "Unknown",
          selected_text: selectedText,
          range_start: selectedRange.start,
          range_end: selectedRange.end,
          note: note.trim(),
        }),
      });
      setSelectedText("");
      setSelectedRange(null);
      setNote("");
      window.getSelection()?.removeAllRanges();
      await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to save annotation: ${e.message}`);
    }
  }

  async function deleteRecord(id) {
    if (!username) return;
    try {
      await api(`/api/records/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: JSON.stringify({ user: username }),
      });
      setHighlightPopup(null);
      if (current?.id) await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to delete record: ${e.message}`);
    }
  }

  async function eraseOverlappingAnnotation() {
    if (!selectedRange) {
      clearSelection();
      return;
    }
    const overlapping = annotationRecords.find((r) => r.start < selectedRange.end && r.end > selectedRange.start && r.user === username);
    if (overlapping) {
      await deleteRecord(overlapping.id);
    }
    clearSelection();
  }

  async function saveCaptionEdit() {
    if (!username || !current) return;
    const caption = captionDraft.trim();
    if (!caption) {
      setError("Caption cannot be empty.");
      return;
    }

    setSavingCaption(true);
    setError("");
    try {
      const updated = await api(`/api/items/${encodeURIComponent(current.id)}/caption`, {
        method: "PATCH",
        body: JSON.stringify({ caption, user: username }),
      });
      setItems((prev) => prev.map((it) => (it.id === current.id ? updated : it)));
      setIsEditingCaption(false);
      setSelectedText("");
      setSelectedRange(null);
      setHighlightPopup(null);
      await loadRecords(current.id);
    } catch (e) {
      setError(`Failed to save caption: ${e.message}`);
    } finally {
      setSavingCaption(false);
    }
  }

  async function importManifest(file) {
    if (!file) return;
    const text = await file.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      setError("Invalid JSON file.");
      return;
    }
    if (!Array.isArray(data)) {
      setError("Manifest JSON should be an array: [{ id, imageUrl, caption }]");
      return;
    }
    try {
      await api("/api/items/import", {
        method: "POST",
        body: JSON.stringify({ items: data, replace: true, user: username }),
      });
      setIndex(0);
      await loadAll("");
    } catch (e) {
      setError(`Import failed: ${e.message}`);
    }
  }

  async function uploadImageWithCaption() {
    if (!uploadImageFile || !uploadCaption.trim() || !username) {
      setError("Please choose an image and enter its caption first.");
      return;
    }

    setUploading(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", uploadImageFile);
      form.append("caption", uploadCaption.trim());
      form.append("user", username);

      const res = await fetch(`${API_BASE}/api/items/upload`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      await res.json();
      setUploadImageFile(null);
      setUploadCaption("");
      setQuery("");
      await loadAll("");
    } catch (e) {
      setError(`Upload failed: ${e.message}`);
    } finally {
      setUploading(false);
    }
  }

  async function uploadPairedFiles() {
    if (!batchZipFile || !batchCaptionFile || !username) {
      setError("Please choose both the image zip file and the caption file first.");
      return;
    }

    setBatchUploading(true);
    setError("");

    try {
      const form = new FormData();
      form.append("images_zip", batchZipFile);
      form.append("captions_file", batchCaptionFile);
      form.append("user", username);

      const res = await fetch(`${API_BASE}/api/items/upload-paired-files`, {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }

      const data = await res.json();

      setBatchZipFile(null);
      setBatchCaptionFile(null);
      setQuery("");
      setIndex(0);
      await loadAll("");

      alert(
        `Imported ${data.imported} matched pairs.\n` +
        `Missing images: ${data.missingImages?.length || 0}\n` +
        `Unused images: ${data.unusedImages?.length || 0}`
      );
    } catch (e) {
      setError(`Batch upload failed: ${e.message}`);
    } finally {
      setBatchUploading(false);
    }
  }

  async function searchItems(value) {
    setQuery(value);
    setIndex(0);
    await loadAll(value);
  }

  const captionFontStyle = { fontSize: `${captionFontSize}px` };
  const attributeFontStyle = { fontSize: `${attributeFontSize}px` };
  const attributeCardPadding = attributeMode === "compact" ? "p-2" : "p-3";

  if (!username) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md bg-white rounded-2xl shadow-lg border border-slate-200 p-7">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-2xl bg-blue-600 flex items-center justify-center text-white"><LogIn size={22} /></div>
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Caption Annotation App</h1>
              <p className="text-sm text-slate-500">Login by username. Backend: {API_BASE}</p>
            </div>
          </div>
          <input
            value={loginName}
            onChange={(e) => setLoginName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="e.g., user_1 / annotator_a"
            className="w-full border border-slate-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button onClick={login} className="mt-4 w-full bg-blue-600 hover:bg-blue-700 text-white rounded-xl py-3 font-medium transition">Login</button>
          {error && <div className="mt-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl p-3">{error}</div>}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-5">
      <div className="max-w-[1500px] mx-auto">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h1 className="text-2xl font-semibold">Caption Annotation Workspace</h1>
            <p className="text-sm text-slate-500">Current user: <span className="font-medium text-slate-800">{username}</span> · {items.length} images loaded · {records.length} records on current image</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={toggleLayoutEditMode} className={`inline-flex items-center gap-2 border rounded-xl px-3 py-2 shadow-sm text-sm ${layoutEditMode ? "bg-blue-600 text-white border-blue-600" : "bg-white border-slate-200 hover:bg-slate-100"}`} title="Turn on to drag panels and resize boxes with the bottom-right corner">
              <Move size={16} /> {layoutEditMode ? "Finish layout" : "Edit layout"}
            </button>
            <button onClick={resetLayoutAndRefresh} className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm hover:bg-slate-100 text-sm" title="Reload data and restore the original default layout"><RefreshCw size={16} /> Refresh</button>
            <label className="cursor-pointer inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm hover:bg-slate-100 text-sm">
              <Upload size={16} /> Import JSON
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => importManifest(e.target.files?.[0])} />
            </label>
            <button onClick={() => downloadFromUrl(`${API_BASE}/api/export/json`)} className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm hover:bg-slate-100 text-sm"><Download size={16} /> Export JSON</button>
            <button onClick={() => downloadFromUrl(`${API_BASE}/api/export/csv`)} className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2 shadow-sm hover:bg-slate-100 text-sm"><FileDown size={16} /> Export CSV</button>
            <button onClick={logout} className="inline-flex items-center gap-2 bg-slate-900 text-white rounded-xl px-3 py-2 hover:bg-slate-800 text-sm"><LogOut size={16} /> Logout</button>
          </div>
        </div>

        {error && <div className="mb-4 text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl p-3">{error}</div>}
        {loading && <div className="mb-4 text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-xl p-3">Loading...</div>}
        {layoutEditMode && <div className="mb-4 text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-xl p-3">Layout edit mode is on: this edit starts from the exact layout currently shown on screen. Resize panels from the bottom-right corner and drag Image / Caption to reorder them. Finish layout saves this result as the new base layout for the next edit. Refresh restores the original workspace.</div>}

        <div className={topLayoutContainerClass}>
          {topLayoutOrder.map((panelKey) => panelKey === "image" ? (
          <div ref={imagePanelRef} key="image" draggable={layoutEditMode} onDragStart={() => setDraggingPanel("image")} onDragOver={(e) => layoutEditMode && e.preventDefault()} onDrop={() => handlePanelDrop("image")} className={`bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col ${layoutPanelClass}`} style={panelStyle("image", { minWidth: 360, minHeight: 360 })}>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div className="font-semibold">Image</div>
              <div className="flex items-center gap-2 text-sm">
                <button onClick={() => setImageZoom((z) => Math.max(25, z - 25))} className="rounded-lg border border-slate-300 bg-white p-1.5 hover:bg-slate-100" title="Zoom out"><ZoomOut size={16} /></button>
                <input type="range" min="25" max="300" step="5" value={imageZoom} onChange={(e) => setImageZoom(Number(e.target.value))} className="w-24" />
                <button onClick={() => setImageZoom((z) => Math.min(300, z + 25))} className="rounded-lg border border-slate-300 bg-white p-1.5 hover:bg-slate-100" title="Zoom in"><ZoomIn size={16} /></button>
                <button onClick={resetImageView} className="rounded-lg border border-slate-300 bg-white p-1.5 hover:bg-slate-100" title="Reset image view"><RotateCcw size={16} /></button>
                <span className="w-12 text-right text-slate-500">{imageZoom}%</span>
              </div>
              <div className="w-full text-sm text-slate-500 truncate">{current?.id || "No image"}</div>
            </div>
            <div
              className={`image-pan-stage flex-1 min-h-[360px] bg-slate-100 rounded-xl overflow-hidden border border-slate-200 ${imagePanning ? "is-panning" : ""}`}
              onMouseDown={handleImagePanStart}
              onMouseMove={handleImagePanMove}
              onMouseUp={handleImagePanEnd}
              onMouseLeave={handleImagePanEnd}
              onDragStart={(e) => e.preventDefault()}
              title="Click to zoom in. Drag to move the image inside this panel."
            >
              {current?.imageUrl ? (
                <div className="h-full w-full flex items-center justify-center p-3">
                  <img
                    src={current.imageUrl.startsWith("/") ? `${API_BASE}${current.imageUrl}` : current.imageUrl}
                    alt={current.id}
                    draggable={false}
                    className="max-w-full max-h-full object-contain select-none transition-transform duration-100"
                    style={{ transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom / 100})`, transformOrigin: "center center" }}
                  />
                </div>
              ) : <div className="h-full flex items-center justify-center text-slate-400">Import or upload image first.</div>}
            </div>
          </div>
          ) : (

          <div ref={captionOuterPanelRef} key="caption" draggable={layoutEditMode} onDragStart={() => setDraggingPanel("caption")} onDragOver={(e) => layoutEditMode && e.preventDefault()} onDrop={() => handlePanelDrop("caption")} className={`bg-white rounded-2xl shadow-sm border border-slate-200 p-4 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-4 overflow-hidden ${layoutPanelClass}`} style={panelStyle("caption", { minWidth: 560, minHeight: 420 })}>
            <div className="flex flex-col min-h-0">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <div className="font-semibold">Original Caption</div>
                  <div className="text-xs text-slate-400">Drag text to select; selected text previews in the current attribute color before saving.</div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <div className="relative">
                    <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input
                      value={captionSearch}
                      onChange={(e) => setCaptionSearch(e.target.value)}
                      placeholder="Search caption"
                      className="w-40 rounded-lg border border-slate-300 bg-white pl-7 pr-2 py-1 outline-none focus:ring-2 focus:ring-blue-400"
                    />
                  </div>
                  <label className="text-slate-500">Font</label>
                  <select value={captionFontSize} onChange={(e) => setCaptionFontSize(e.target.value)} className="border border-slate-300 rounded-lg px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-blue-400">
                    <option value="14">14px</option>
                    <option value="16">16px</option>
                    <option value="18">18px</option>
                    <option value="20">20px</option>
                    <option value="22">22px</option>
                    <option value="24">24px</option>
                  </select>
                  <button onClick={eraseOverlappingAnnotation} className="inline-flex items-center gap-1 border border-slate-300 rounded-lg px-2 py-1 hover:bg-slate-100" title="Clear selection or erase your overlapping annotation">
                    <Eraser size={14} /> Erase
                  </button>
                  {isEditingCaption ? (
                    <>
                      <button onClick={saveCaptionEdit} disabled={savingCaption} className="bg-blue-600 disabled:bg-slate-300 text-white rounded-lg px-3 py-1 font-medium">
                        {savingCaption ? "Saving" : "Save"}
                      </button>
                      <button onClick={() => { setIsEditingCaption(false); setCaptionDraft(current?.caption || ""); }} className="border border-slate-300 rounded-lg px-3 py-1 hover:bg-slate-100">Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => { setCaptionDraft(current?.caption || ""); setIsEditingCaption(true); setHighlightPopup(null); }} disabled={!current} className="border border-slate-300 rounded-lg px-3 py-1 hover:bg-slate-100 disabled:opacity-50">Edit</button>
                  )}
                </div>
              </div>

              <div ref={captionPanelRef} className="relative flex-1 min-h-[260px] border border-blue-300 rounded-xl bg-white overflow-hidden">
                <div className="sticky top-0 z-10 bg-white/95 backdrop-blur px-5 py-3 border-b border-slate-100 text-slate-500 text-sm">
                  caption:
                </div>

                {isEditingCaption ? (
                  <textarea
                    value={captionDraft}
                    onChange={(e) => setCaptionDraft(e.target.value)}
                    style={captionFontStyle}
                    className="caption-scroll block w-full h-[calc(100%-49px)] resize-none p-5 leading-relaxed outline-none overflow-y-scroll overflow-x-hidden"
                    placeholder="Edit caption here..."
                  />
                ) : (
                  <div onMouseUp={handleCaptionSelection} onClick={() => setHighlightPopup(null)} className="caption-scroll h-[calc(100%-49px)] p-5 leading-relaxed select-text overflow-y-scroll overflow-x-hidden break-words whitespace-pre-wrap" style={captionFontStyle}>
                    <div ref={captionTextRef}>{renderCaptionWithHighlights()}</div>
                  </div>
                )}

                {highlightPopup && !isEditingCaption && (
                  <div className="absolute z-30 w-72 rounded-xl border border-slate-200 bg-white shadow-xl p-3 text-sm" style={{ left: highlightPopup.x, top: highlightPopup.y }} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="font-semibold text-slate-900 flex items-center gap-2">
                        <span className="inline-block w-3 h-3 rounded-full border" style={{ background: getRecordHighlightStyle(highlightPopup.record, attributes).background, borderColor: getRecordHighlightStyle(highlightPopup.record, attributes).borderColor }} />
                        {getRecordAttribute(highlightPopup.record, attributes)?.name || highlightPopup.record.attributeName || highlightPopup.record.attribute_name || "Attribute"}
                      </div>
                      <button onClick={() => setHighlightPopup(null)} className="p-1 rounded-lg hover:bg-slate-100"><X size={14} /></button>
                    </div>
                    <div className="caption-scroll max-h-36 overflow-y-auto pr-2 text-slate-600 mb-2"><span className="font-medium">Selected:</span> {highlightPopup.record.selectedText || highlightPopup.record.selected_text}</div>
                    <div className="text-slate-600 mb-1"><span className="font-medium">User:</span> {highlightPopup.record.user}</div>
                    {highlightPopup.record.note && <div className="caption-scroll max-h-24 overflow-y-auto pr-2 text-slate-600 mb-2"><span className="font-medium">Note:</span> {highlightPopup.record.note}</div>}
                    {highlightPopup.record.user === username && (
                      <button onClick={() => deleteRecord(highlightPopup.record.id)} className="mt-1 inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-red-600 hover:bg-red-100">
                        <Eraser size={14} /> Erase this annotation
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3 bg-blue-50 border border-blue-100 rounded-xl p-3 text-sm">
                <div><span className="font-medium">Selected text:</span> {selectedText || <span className="text-slate-400">Drag to select words in the caption.</span>}</div>
                {selectedRange && <div className="text-slate-500 mt-1">Range: {selectedRange.start}–{selectedRange.end}</div>}
                {selectedText && selectedAttributeId && <div className="text-slate-500 mt-1">Preview color: <span className="inline-flex items-center gap-1 font-medium text-slate-700"><span className="inline-block h-3 w-3 rounded-full border" style={{ background: selectedAttr?.color || "#DBEAFE" }} /> {selectedAttr?.name || "Unknown"}</span>. Click Save to make it permanent.</div>}
              </div>
            </div>

            <div className="border border-blue-300 rounded-xl p-3 flex flex-col min-w-0 overflow-hidden">
              <div className="font-semibold mb-1">Attributes</div>
              <div className="text-xs text-slate-400 mb-2">Click color dot to change color. Use edit to change name.</div>
              <div className="relative mb-2">
                <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
                <input value={attrSearch} onChange={(e) => setAttrSearch(e.target.value)} placeholder="Search attributes" className="w-full rounded-lg border border-slate-300 bg-white pl-7 pr-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-blue-400" />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-2 text-xs">
                <label className="flex items-center gap-1 text-slate-500">
                  Size
                  <select value={attributeFontSize} onChange={(e) => setAttributeFontSize(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-1 py-1 bg-white">
                    <option value="14">14</option>
                    <option value="16">16</option>
                    <option value="18">18</option>
                    <option value="20">20</option>
                  </select>
                </label>
                <label className="flex items-center gap-1 text-slate-500">
                  Mode
                  <select value={attributeMode} onChange={(e) => setAttributeMode(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-1 py-1 bg-white">
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfort</option>
                  </select>
                </label>
              </div>
              <div className="caption-scroll space-y-2 overflow-y-auto pr-1 flex-1 min-h-0">
                {filteredAttributes.map((attr) => {
                  const originalIdx = attributes.findIndex((a) => a.id === attr.id);
                  const attrColor = getAttributeColor(attr, originalIdx >= 0 ? originalIdx : 0);
                  const selected = selectedAttributeId === attr.id;
                  return (
                    <div key={attr.id} className={`rounded-xl border bg-white ${attributeCardPadding}`} style={{ borderColor: selected ? attrColor : "#E2E8F0", boxShadow: selected ? `0 0 0 1px ${attrColor}` : undefined }}>
                      {editingAttrId === attr.id ? (
                        <div className="space-y-2">
                          <input value={editingAttrName} onChange={(e) => setEditingAttrName(e.target.value)} className="w-full border rounded-lg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-blue-400" placeholder="Attribute name" />
                          <div className="flex items-center gap-2">
                            <input type="color" value={editingAttrColor} onChange={(e) => setEditingAttrColor(e.target.value)} className="w-10 h-9 rounded-lg border border-slate-300 bg-white" title="Attribute color" />
                            <button onClick={() => saveAttrEdit(attr)} className="flex-1 inline-flex items-center justify-center gap-1 rounded-lg bg-blue-600 text-white px-2 py-2 text-sm"><Save size={15} /> Save</button>
                            <button onClick={() => { setEditingAttrId(null); setEditingAttrName(""); setEditingAttrColor("#DBEAFE"); }} className="rounded-lg border border-slate-300 px-2 py-2 text-sm hover:bg-slate-100">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between gap-2" style={attributeFontStyle}>
                          <button onClick={() => setSelectedAttributeId(attr.id)} className="min-w-0 flex-1 text-left font-medium break-words flex items-start gap-2">
                            <span className="relative mt-1 inline-block h-4 w-4 shrink-0 overflow-hidden rounded-full border" style={{ background: attrColor, borderColor: attrColor }} onClick={(e) => e.stopPropagation()}>
                              <input type="color" value={attrColor} onChange={(e) => quickUpdateAttrColor(attr, e.target.value)} className="absolute -left-2 -top-2 h-10 w-10 cursor-pointer opacity-0" title="Click to change color" />
                            </span>
                            <span>{attr.name}</span>
                          </button>
                          <button onClick={() => { setEditingAttrId(attr.id); setEditingAttrName(attr.name); setEditingAttrColor(getAttributeColor(attr, originalIdx >= 0 ? originalIdx : 0)); }} className="shrink-0 p-1 rounded-lg hover:bg-slate-100" title="Edit name and color"><Edit3 size={15} /></button>
                          <button onClick={() => removeAttribute(attr)} className="shrink-0 p-1 rounded-lg hover:bg-red-50 text-red-600" title="Delete attribute"><Trash2 size={15} /></button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredAttributes.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 bg-white p-4 text-center text-sm text-slate-400">No attributes matched.</div>}
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="mb-2 text-xs font-semibold text-slate-500">Add attribute</div>
                <input value={newAttrName} onChange={(e) => setNewAttrName(e.target.value)} placeholder="Add attribute" className="mb-2 w-full border border-slate-300 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400" />
                <div className="flex gap-2">
                  <input type="color" value={newAttrColor} onChange={(e) => setNewAttrColor(e.target.value)} className="h-10 w-14 rounded-xl border border-slate-300 bg-white" title="New attribute color" />
                  <button onClick={addAttribute} className="flex-1 inline-flex items-center justify-center gap-2 bg-blue-600 text-white rounded-xl px-3 hover:bg-blue-700"><Plus size={18} /> Add</button>
                </div>
              </div>
            </div>
          </div>
          ))}
        </div>

        <div ref={notePanelRef} className={`bg-white rounded-2xl shadow-sm border border-slate-200 p-4 mb-4 ${layoutEditMode ? "resizable-panel ring-2 ring-blue-300 ring-offset-2" : ""}`} style={panelStyle("note", { minWidth: 360, minHeight: 160 })}>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <div>
              <label className="text-sm font-medium text-slate-700">Modification / annotation note</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g., mark 'dog' as Object; caption should be changed to 'a brown dog'" className="caption-scroll mt-1 h-20 w-full resize-y overflow-y-auto border border-slate-300 rounded-xl px-4 py-3 outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <button onClick={saveAnnotation} disabled={!selectedText || !selectedAttributeId || !current || isEditingCaption} className="bg-blue-600 disabled:bg-slate-300 text-white rounded-xl px-5 py-3 font-medium hover:bg-blue-700 transition">Save selected-word annotation</button>
          </div>
        </div>

        <div ref={bottomPanelRef} className={`bg-white rounded-2xl shadow-sm border border-slate-200 p-4 ${layoutEditMode ? "resizable-panel ring-2 ring-blue-300 ring-offset-2" : ""}`} style={panelStyle("bottom", { minWidth: 360, minHeight: 260 })}>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setIndex((v) => Math.max(v - 1, 0))} className="border border-slate-200 rounded-xl p-2 hover:bg-slate-100"><ChevronLeft size={18} /></button>
              <div className="text-sm text-slate-600">Image {items.length ? index + 1 : 0} / {items.length}</div>
              <button onClick={() => setIndex((v) => Math.min(v + 1, items.length - 1))} className="border border-slate-200 rounded-xl p-2 hover:bg-slate-100"><ChevronRight size={18} /></button>
            </div>
            <div className="relative w-full sm:w-80">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={(e) => searchItems(e.target.value)} placeholder="Search image id or caption" className="w-full border border-slate-300 rounded-xl pl-9 pr-3 py-2 text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 min-h-[260px]">
            <RecordPanel title={`All users' records for ${current?.id || "current image"}`} records={records} onDelete={deleteRecord} canDeleteUser={username} />
            <RecordPanel title={`My records: ${username}`} records={userRecords} onDelete={deleteRecord} canDeleteUser={username} />
            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50">
              <div className="font-semibold mb-3 flex items-center gap-2"><ImagePlus size={17} /> Upload data</div>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 mb-4">
                <div className="font-semibold mb-3">Batch upload: image zip + caption file</div>

                <div className="space-y-3">
                  <label className="block cursor-pointer bg-white border border-slate-200 rounded-xl p-3 hover:bg-slate-100 text-sm">
                    <div className="font-medium">Choose image zip</div>
                    <div className="text-xs text-slate-500 mt-1 truncate">{batchZipFile ? batchZipFile.name : ".zip containing images"}</div>
                    <input type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => setBatchZipFile(e.target.files?.[0] || null)} />
                  </label>

                  <label className="block cursor-pointer bg-white border border-slate-200 rounded-xl p-3 hover:bg-slate-100 text-sm">
                    <div className="font-medium">Choose caption file</div>
                    <div className="text-xs text-slate-500 mt-1 truncate">{batchCaptionFile ? batchCaptionFile.name : ".jsonl / .json"}</div>
                    <input type="file" accept=".json,.jsonl,.txt,application/json" className="hidden" onChange={(e) => setBatchCaptionFile(e.target.files?.[0] || null)} />
                  </label>

                  <button onClick={uploadPairedFiles} disabled={batchUploading || !batchZipFile || !batchCaptionFile} className="w-full bg-emerald-600 disabled:bg-slate-300 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-emerald-700">
                    {batchUploading ? "Matching and importing..." : "Upload and match automatically"}
                  </button>

                  <p className="text-xs text-slate-500 leading-5">Upload your image zip and caption JSONL / JSON file. Matching rule: image_id first, then filename from image_path. Caption uses reference_caption or caption.</p>
                </div>
              </div>

              <div className="font-semibold mt-4 mb-3">Single upload: image + caption</div>
              <div className="space-y-3">
                <label className="block cursor-pointer bg-white border border-slate-200 rounded-xl p-3 hover:bg-slate-100 text-sm">
                  <div className="font-medium">Choose image</div>
                  <div className="text-xs text-slate-500 mt-1 truncate">{uploadImageFile ? uploadImageFile.name : "jpg / png / webp"}</div>
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => setUploadImageFile(e.target.files?.[0] || null)} />
                </label>
                <textarea value={uploadCaption} onChange={(e) => setUploadCaption(e.target.value)} placeholder="Enter caption for this image, e.g., a dog running on the grass" className="caption-scroll w-full h-24 bg-white border border-slate-300 rounded-xl px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 resize-y overflow-y-auto" />
                <button onClick={uploadImageWithCaption} disabled={uploading || !uploadImageFile || !uploadCaption.trim()} className="w-full bg-blue-600 disabled:bg-slate-300 text-white rounded-xl px-4 py-2 text-sm font-medium hover:bg-blue-700">
                  {uploading ? "Uploading..." : "Upload and add to dataset"}
                </button>
              </div>

              <div className="font-semibold mt-6 mb-3">Batch manifest format</div>
              <pre className="text-xs bg-white border border-slate-200 rounded-xl p-3 overflow-auto leading-5">{`[
  {
    "id": "000001",
    "imageUrl": "/images/000001.jpg",
    "caption": "a dog running on the grass"
  }
]`}</pre>
              <p className="text-xs text-slate-500 mt-3 leading-5">For many images, you can either import a manifest JSON or upload an image zip together with a caption JSONL / JSON file.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecordPanel({ title, records, onDelete, canDeleteUser }) {
  return (
    <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 overflow-hidden">
      <div className="font-semibold mb-3">{title}</div>
      <div className="caption-scroll space-y-3 max-h-[430px] overflow-y-auto pr-1">
        {records.length === 0 && <div className="text-sm text-slate-400 bg-white border border-dashed border-slate-200 rounded-xl p-5 text-center">No records yet.</div>}
        {records.map((r) => (
          <div key={r.id} className="bg-white border border-slate-200 rounded-xl p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold break-words">{r.user} · {r.attributeName || r.attribute_name || r.action}</div>
                <div className="text-xs text-slate-400">{r.createdAt || r.created_at}</div>
              </div>
              {r.user === canDeleteUser && <button onClick={() => onDelete(r.id)} className="text-red-600 hover:bg-red-50 p-1 rounded-lg"><Trash2 size={15} /></button>}
            </div>
            <div className="mt-2 text-sm space-y-1">
              <div><span className="text-slate-500">Action:</span> {r.action}</div>
              {(r.selectedText || r.selected_text) && <div className="break-words"><span className="text-slate-500">Selected:</span> <span className="font-medium">“{r.selectedText || r.selected_text}”</span></div>}
              {r.note && <div className="caption-scroll max-h-24 overflow-y-auto pr-2 break-words"><span className="text-slate-500">Note:</span> {r.note}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
