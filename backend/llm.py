"""Caption -> visual facts LLM client.

Pluggable client that supports both OpenAI-compatible and Anthropic-style
chat APIs over the public internet. Configure it through environment
variables (see README / .env.example):

    LLM_PROVIDER   "openai" (default) or "anthropic"
    LLM_API_KEY    API key for the provider
    LLM_BASE_URL   override base url (optional, has sane defaults)
    LLM_MODEL      model name, e.g. gpt-4o-mini / claude-3-5-sonnet-latest
    LLM_TIMEOUT    request timeout in seconds (default 60)

The module exposes a single high level function:

    parse_caption_to_facts(caption) -> dict

It returns a dict shaped like:

    {
        "visual_facts": [
            {
                "fact_id": "f001",
                "source_span": "...",
                "source_start": 12,
                "source_end": 34,
                "visual_fact": "...",
                "fact_type": "object"
            },
            ...
        ],
        "unparsed_spans": [{"source_span": "...", "reason": "..."}]
    }
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional

import httpx


FACT_TYPES = [
    "object",
    "count",
    "attribute",
    "action",
    "spatial_relation",
    "scene",
    "ocr",
    "expression",
    "inference",
    "style_atmosphere",
    "object_relation",
]


SYSTEM_PROMPT = """You are a caption preprocessing assistant for image annotation.

Your task is to convert a long image caption into a list of small visual facts.

A visual fact is a short statement that can be checked by looking at the image.

Requirements:
1. Split the caption into atomic visual facts.
2. Each visual fact should contain only one checkable fact whenever possible.
3. Preserve the original source span from the caption.
4. Do not judge whether the fact is correct.
5. Do not use the image.
6. Do not summarize the caption.
7. Do not drop visual information silently.
8. If a phrase contains multiple facts, split it into multiple visual facts.
9. Mark subjective descriptions, emotions, intentions, OCR/text, and style descriptions as separate facts.
10. Output valid JSON only.

Fact types:
- object
- count
- attribute
- action
- spatial_relation
- scene
- ocr
- expression
- inference
- style_atmosphere

Output format:
{
  "visual_facts": [
    {
      "fact_id": "f001",
      "source_span": "...",
      "visual_fact": "...",
      "fact_type": "..."
    }
  ],
  "unparsed_spans": [
    {
      "source_span": "...",
      "reason": "..."
    }
  ]
}
"""


class LLMNotConfigured(RuntimeError):
    """Raised when no API key / provider is configured."""


class LLMError(RuntimeError):
    """Raised when the LLM call or response parsing fails."""


def _config() -> Dict[str, str]:
    provider = (os.getenv("LLM_PROVIDER") or "openai").strip().lower()
    api_key = (os.getenv("LLM_API_KEY") or "").strip()
    model = (os.getenv("LLM_MODEL") or "").strip()
    base_url = (os.getenv("LLM_BASE_URL") or "").strip()
    timeout = (os.getenv("LLM_TIMEOUT") or "60").strip()

    if provider not in {"openai", "anthropic"}:
        provider = "openai"

    if not base_url:
        base_url = (
            "https://api.anthropic.com"
            if provider == "anthropic"
            else "https://api.openai.com/v1"
        )
    base_url = base_url.rstrip("/")

    if not model:
        model = (
            "claude-3-5-sonnet-latest"
            if provider == "anthropic"
            else "gpt-4o-mini"
        )

    try:
        timeout_val = float(timeout)
    except ValueError:
        timeout_val = 60.0

    # Optional: control "thinking"/reasoning for hybrid models (e.g. DeepSeek V4,
    # Qwen3 on SiliconFlow). Only forwarded when explicitly set, since vanilla
    # OpenAI rejects unknown body params. Leave unset for real OpenAI.
    raw_thinking = os.getenv("LLM_ENABLE_THINKING")
    if raw_thinking is None or raw_thinking.strip() == "":
        enable_thinking = None
    else:
        enable_thinking = raw_thinking.strip().lower() in {"1", "true", "yes", "on"}

    return {
        "provider": provider,
        "api_key": api_key,
        "model": model,
        "base_url": base_url,
        "timeout": timeout_val,
        "enable_thinking": enable_thinking,
    }


def is_configured() -> bool:
    return bool((os.getenv("LLM_API_KEY") or "").strip())


def _call_openai(cfg: Dict[str, Any], caption: str) -> str:
    url = f"{cfg['base_url']}/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    body = {
        "model": cfg["model"],
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Caption:\n{caption}"},
        ],
    }
    if cfg.get("enable_thinking") is not None:
        body["enable_thinking"] = cfg["enable_thinking"]
    with httpx.Client(timeout=cfg["timeout"]) as client:
        resp = client.post(url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise LLMError(f"OpenAI API error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise LLMError(f"Unexpected OpenAI response shape: {e}")


def _call_anthropic(cfg: Dict[str, Any], caption: str) -> str:
    url = f"{cfg['base_url']}/v1/messages"
    headers = {
        "x-api-key": cfg["api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    body = {
        "model": cfg["model"],
        "max_tokens": 4096,
        "temperature": 0,
        "system": SYSTEM_PROMPT,
        "messages": [
            {"role": "user", "content": f"Caption:\n{caption}"},
        ],
    }
    with httpx.Client(timeout=cfg["timeout"]) as client:
        resp = client.post(url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise LLMError(f"Anthropic API error {resp.status_code}: {resp.text[:500]}")
    data = resp.json()
    try:
        parts = data["content"]
        return "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    except (KeyError, TypeError) as e:
        raise LLMError(f"Unexpected Anthropic response shape: {e}")


def _extract_json(text: str) -> Dict[str, Any]:
    """Best-effort extraction of a JSON object from a model response."""
    text = (text or "").strip()
    if not text:
        raise LLMError("empty LLM response")

    # Strip ```json ... ``` fences if present.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        # Fall back to the first {...} block.
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1 and end > start:
            text = text[start : end + 1]

    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        raise LLMError(f"could not parse JSON from LLM response: {e}")

    if not isinstance(obj, dict):
        raise LLMError("LLM response JSON is not an object")
    return obj


def _locate_span(caption: str, span: str, cursor: int) -> Optional[tuple]:
    """Find span in caption starting at cursor; case-insensitive fallback.

    Returns (start, end) char offsets, or None if not found.
    """
    if not span:
        return None

    idx = caption.find(span, cursor)
    if idx != -1:
        return idx, idx + len(span)

    idx = caption.find(span)
    if idx != -1:
        return idx, idx + len(span)

    lower_caption = caption.lower()
    lower_span = span.lower()
    idx = lower_caption.find(lower_span, cursor)
    if idx == -1:
        idx = lower_caption.find(lower_span)
    if idx != -1:
        return idx, idx + len(span)

    # Tolerant fallback: the LLM span may collapse newlines / runs of spaces,
    # and often swaps quote characters (e.g. "cyberpunk" -> 'cyberpunk').
    escaped = re.escape(span)
    # Collapse any run of (escaped) whitespace to \s+.
    escaped = re.sub(r"(\\\s|\s)+", r"\\s+", escaped)
    # Treat any quote variant (straight/curly, single/double) as interchangeable.
    quote_class = "[\"'\u201c\u201d\u2018\u2019\u00ab\u00bb`]"
    escaped = re.sub(r"\\?[\"'\u201c\u201d\u2018\u2019\u00ab\u00bb`]", quote_class, escaped)
    try:
        m = re.search(escaped, caption, re.IGNORECASE)
        if m:
            return m.start(), m.end()
    except re.error:
        pass

    return None


def _normalize_facts(caption: str, obj: Dict[str, Any]) -> Dict[str, Any]:
    raw_facts = obj.get("visual_facts") or []
    raw_unparsed = obj.get("unparsed_spans") or []

    facts: List[Dict[str, Any]] = []
    cursor = 0
    for i, raw in enumerate(raw_facts, start=1):
        if not isinstance(raw, dict):
            continue
        source_span = str(raw.get("source_span") or "").strip()
        visual_fact = str(raw.get("visual_fact") or "").strip()
        if not source_span or not visual_fact:
            # The doc requires every fact to carry a source span; drop otherwise.
            continue

        fact_type = str(raw.get("fact_type") or "").strip() or "object"
        fact_id = str(raw.get("fact_id") or "").strip() or f"f{i:03d}"

        located = _locate_span(caption, source_span, cursor)
        if located:
            source_start, source_end = located
            cursor = source_end
        else:
            source_start, source_end = None, None

        facts.append(
            {
                "fact_id": fact_id,
                "source_span": source_span,
                "source_start": source_start,
                "source_end": source_end,
                "visual_fact": visual_fact,
                "fact_type": fact_type,
            }
        )

    unparsed: List[Dict[str, Any]] = []
    for raw in raw_unparsed:
        if not isinstance(raw, dict):
            continue
        span = str(raw.get("source_span") or "").strip()
        if not span:
            continue
        unparsed.append(
            {
                "source_span": span,
                "reason": str(raw.get("reason") or "").strip(),
            }
        )

    return {"visual_facts": facts, "unparsed_spans": unparsed}


def parse_caption_to_facts(caption: str) -> Dict[str, Any]:
    """Call the configured LLM and return normalized visual facts.

    Raises LLMNotConfigured if no API key is set, LLMError on call/parse
    failures.
    """
    caption = (caption or "").strip()
    if not caption:
        return {"visual_facts": [], "unparsed_spans": []}

    if not is_configured():
        raise LLMNotConfigured(
            "LLM_API_KEY is not set. Configure LLM_PROVIDER/LLM_API_KEY/LLM_MODEL "
            "to enable caption-to-facts parsing."
        )

    cfg = _config()
    if cfg["provider"] == "anthropic":
        raw_text = _call_anthropic(cfg, caption)
    else:
        raw_text = _call_openai(cfg, caption)

    obj = _extract_json(raw_text)
    return _normalize_facts(caption, obj)
