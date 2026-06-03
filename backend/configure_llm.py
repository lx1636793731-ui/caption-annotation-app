#!/usr/bin/env python3
"""Convenience CLI to view / change the LLM config in backend/.env.

Examples:
    # Show current config (key is masked)
    python configure_llm.py --show

    # Switch model only
    python configure_llm.py --model deepseek-ai/DeepSeek-V3

    # Point at SiliconFlow (OpenAI-compatible) with a new key
    python configure_llm.py \
        --provider openai \
        --base-url https://api.siliconflow.cn/v1 \
        --model deepseek-ai/DeepSeek-V4-Flash \
        --key sk-xxxx \
        --thinking false

    # Quick presets
    python configure_llm.py --preset siliconflow --key sk-xxxx
    python configure_llm.py --preset openai --key sk-xxxx
    python configure_llm.py --preset anthropic --key sk-ant-xxxx
"""

import argparse
from pathlib import Path

ENV_PATH = Path(__file__).parent / ".env"

KEYS = [
    "LLM_PROVIDER",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_BASE_URL",
    "LLM_TIMEOUT",
    "LLM_ENABLE_THINKING",
]

PRESETS = {
    "siliconflow": {
        "LLM_PROVIDER": "openai",
        "LLM_BASE_URL": "https://api.siliconflow.cn/v1",
        "LLM_MODEL": "deepseek-ai/DeepSeek-V4-Flash",
        "LLM_ENABLE_THINKING": "false",
        "LLM_TIMEOUT": "120",
    },
    "openai": {
        "LLM_PROVIDER": "openai",
        "LLM_BASE_URL": "https://api.openai.com/v1",
        "LLM_MODEL": "gpt-4o-mini",
        "LLM_ENABLE_THINKING": "",
        "LLM_TIMEOUT": "120",
    },
    "anthropic": {
        "LLM_PROVIDER": "anthropic",
        "LLM_BASE_URL": "https://api.anthropic.com",
        "LLM_MODEL": "claude-3-5-sonnet-latest",
        "LLM_ENABLE_THINKING": "",
        "LLM_TIMEOUT": "120",
    },
}


def read_env() -> dict:
    data = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            data[k.strip()] = v.strip()
    return data


def write_env(data: dict):
    lines = ["# Managed by configure_llm.py — edit here or re-run the script.", ""]
    for k in KEYS:
        lines.append(f"{k}={data.get(k, '')}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def mask(value: str) -> str:
    if not value:
        return "(empty)"
    if len(value) <= 8:
        return "*" * len(value)
    return value[:4] + "*" * (len(value) - 8) + value[-4:]


def show(data: dict):
    print(f"Config file: {ENV_PATH}")
    for k in KEYS:
        v = data.get(k, "")
        print(f"  {k} = {mask(v) if k == 'LLM_API_KEY' else (v or '(empty)')}")


def main():
    p = argparse.ArgumentParser(description="View/change LLM config in backend/.env")
    p.add_argument("--show", action="store_true", help="print current config and exit")
    p.add_argument("--preset", choices=sorted(PRESETS.keys()), help="apply a provider preset")
    p.add_argument("--provider", choices=["openai", "anthropic"])
    p.add_argument("--key", dest="api_key")
    p.add_argument("--model")
    p.add_argument("--base-url", dest="base_url")
    p.add_argument("--timeout")
    p.add_argument("--thinking", choices=["true", "false", ""], help="enable reasoning (empty = unset)")
    args = p.parse_args()

    data = read_env()

    if args.show and not any([args.preset, args.provider, args.api_key, args.model, args.base_url, args.timeout, args.thinking is not None]):
        show(data)
        return

    if args.preset:
        data.update(PRESETS[args.preset])
    if args.provider:
        data["LLM_PROVIDER"] = args.provider
    if args.api_key is not None:
        data["LLM_API_KEY"] = args.api_key
    if args.model:
        data["LLM_MODEL"] = args.model
    if args.base_url:
        data["LLM_BASE_URL"] = args.base_url
    if args.timeout:
        data["LLM_TIMEOUT"] = args.timeout
    if args.thinking is not None:
        data["LLM_ENABLE_THINKING"] = args.thinking

    write_env(data)
    print("Updated", ENV_PATH)
    show(data)


if __name__ == "__main__":
    main()
