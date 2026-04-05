"""
magi_tool.py — Python SDK for the MAGI Tool API server.

Stdlib only (urllib.request) — no pip install required.
Works in any Python 3.8+ environment including the shared venv.

Usage in a background script:
    import sys, os
    sys.path.insert(0, os.path.join(os.environ["SKILL_DIR"], "..", "run-background", "scripts"))
    import magi_tool

    result = magi_tool.fetch_url("https://example.com")
    result = magi_tool.research("What is NVDA's current P/E ratio?")
    magi_tool.post_message("lead-analyst", "Done", "Refresh complete.")

Environment (injected by daemon when running as a background job):
    MAGI_TOOL_URL    — Tool API base URL (default: http://localhost:4001)
    MAGI_TOOL_TOKEN  — Bearer token (required)
"""

import json
import os
import urllib.error
import urllib.request

_url = os.environ.get("MAGI_TOOL_URL", "http://localhost:4001")
_token = os.environ.get("MAGI_TOOL_TOKEN", "")


class ToolError(Exception):
    """Raised when the tool API returns an error field."""


def call_tool(name: str, **params) -> dict:
    """
    POST /tools/<name> with JSON params and return the parsed response.

    Raises:
        ToolError: if the server returns {"error": "..."}.
        urllib.error.URLError: on network failures.
        ValueError: on non-200 HTTP status.
    """
    if not _token:
        raise RuntimeError("MAGI_TOOL_TOKEN is not set — run this script via the daemon")

    body = json.dumps(params).encode("utf-8")
    req = urllib.request.Request(
        f"{_url}/tools/{name}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            "Authorization": f"Bearer {_token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        raise ValueError(f"Tool API HTTP {e.code}: {body_text}") from e

    if "error" in data:
        raise ToolError(data["error"])
    return data


# ---------------------------------------------------------------------------
# Convenience wrappers
# ---------------------------------------------------------------------------

def fetch_url(url: str, max_images: int = 3) -> dict:
    """Fetch a URL, extract text (Readability/mupdf), optionally caption images."""
    return call_tool("fetch-url", url=url, max_images=max_images)


def research(
    question: str,
    max_age_hours: int = 12,
    context_files: list[str] | None = None,
    output_path: str | None = None,
) -> dict:
    """
    Delegate a research question to the Research agentic sub-loop.

    Args:
        question:       The specific research question to answer.
        max_age_hours:  Cache freshness threshold (0 = always fresh).
        context_files:  Paths to files injected as context (SearchWeb disabled).
        output_path:    Write the finding text to this file as well.
    """
    kwargs: dict = {"question": question, "max_age_hours": max_age_hours}
    if context_files:
        kwargs["context_files"] = context_files
        kwargs["max_age_hours"] = 0  # always fresh when context provided
    if output_path:
        kwargs["output_path"] = output_path
    return call_tool("research", **kwargs)


def search_web(query: str) -> dict:
    """Search the web via Brave Search API."""
    return call_tool("search-web", query=query)


def inspect_image(path: str, question: str = "Describe this image in detail.") -> dict:
    """Run the vision LLM on a local image file."""
    return call_tool("inspect-image", path=path, question=question)


def post_message(to: str, subject: str, body: str) -> dict:
    """Send a mailbox message to another agent."""
    return call_tool("post-message", to=to, subject=subject, body=body)


def get_text(result: dict) -> str:
    """Extract the concatenated text from a tool result dict."""
    content = result.get("result", {}).get("content", [])
    return "".join(
        block.get("text", "") for block in content if block.get("type") == "text"
    )
