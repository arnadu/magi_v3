"""Unit tests for process_news.py — no API keys, no LLM, no network."""
import json
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pytest

# Import process_news directly
SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent
    / "packages" / "skills" / "data-factory" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import process_news  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────────────────

def make_item(title: str, url: str, published_at: str = "2026-04-04T06:00:00+00:00", source: str = "Reuters") -> dict:
    return {
        "title": title,
        "url": url,
        "source": source,
        "published_at": published_at,
        "summary": f"Summary for {title}",
    }


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def offset_iso(minutes: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    return dt.isoformat(timespec="seconds")


# ── deduplication ─────────────────────────────────────────────────────────────

def test_dedup_identical_url():
    """Two items with the same URL deduplicate to one."""
    items = [
        make_item("NVIDIA Beats Estimates", "https://example.com/nvda-beats"),
        make_item("NVIDIA Beats Estimates Again", "https://example.com/nvda-beats"),  # same URL
    ]
    result = process_news.deduplicate(items)
    assert len(result) == 1


def test_dedup_near_identical_title():
    """Two items with very similar titles (Levenshtein ratio > 0.85) deduplicate to one."""
    title_a = "NVIDIA announces record quarterly revenue"
    title_b = "NVIDIA announces record quarterly revenues"  # one character diff → ratio ≈ 0.97
    items = [
        make_item(title_a, "https://example.com/nvda-a"),
        make_item(title_b, "https://example.com/nvda-b"),
    ]
    result = process_news.deduplicate(items)
    assert len(result) == 1


def test_dedup_distinct_titles_kept():
    """Two items with dissimilar titles are both kept."""
    items = [
        make_item("NVIDIA beats earnings", "https://example.com/a"),
        make_item("AMD releases new GPU", "https://example.com/b"),
    ]
    result = process_news.deduplicate(items)
    assert len(result) == 2


# ── is_new flag ───────────────────────────────────────────────────────────────

def test_is_new_new_url():
    """URL not in existing digest gets is_new=True."""
    raw = [make_item("Fresh NVDA news", "https://example.com/fresh")]
    existing = {
        "generated_at": now_iso(),
        "items": [make_item("Old news", "https://example.com/old")],
    }
    result = process_news.mark_new(raw, existing)
    assert result[0]["is_new"] is True


def test_is_new_existing_url():
    """URL already in existing digest gets is_new=False."""
    url = "https://example.com/existing"
    raw = [make_item("Same news", url)]
    existing = {
        "generated_at": now_iso(),
        "items": [make_item("Old title", url)],
    }
    result = process_news.mark_new(raw, existing)
    assert result[0]["is_new"] is False


def test_is_new_no_existing():
    """When existing digest is empty/missing, all items are new."""
    raw = [make_item("Any news", "https://example.com/a")]
    result = process_news.mark_new(raw, {})
    assert result[0]["is_new"] is True


# ── ranking ───────────────────────────────────────────────────────────────────

def test_newer_ranked_before_older():
    """Newer article ranks above older article with equal relevance."""
    items = [
        make_item("NVDA news", "https://example.com/old", published_at=offset_iso(120)),
        make_item("NVDA news 2", "https://example.com/new", published_at=offset_iso(10)),
    ]
    ranked = process_news.rank(items)
    assert ranked[0]["url"] == "https://example.com/new"


def test_nvda_keyword_boosts_relevance():
    """Article mentioning NVIDIA/NVDA keywords ranks above one that does not."""
    items = [
        make_item("Apple announces new iPhone", "https://example.com/apple", published_at=offset_iso(10)),
        make_item("NVIDIA GPU dominates AI training", "https://example.com/nvda", published_at=offset_iso(60)),
    ]
    ranked = process_news.rank(items)
    assert ranked[0]["url"] == "https://example.com/nvda"


# ── truncation ────────────────────────────────────────────────────────────────

def test_truncates_to_max_30():
    """process() output is capped at 30 items even with 50 inputs."""
    import json, subprocess, tempfile
    items = [
        make_item(f"News item {i}", f"https://example.com/{i}", published_at=offset_iso(i))
        for i in range(50)
    ]
    PROCESS_NEWS = str(SCRIPTS_DIR / "process_news.py")
    with tempfile.TemporaryDirectory() as tmpdir:
        raw_path = Path(tmpdir) / "raw.json"
        out_path = Path(tmpdir) / "digest.json"
        raw_path.write_text(json.dumps(items))
        result = subprocess.run(
            [sys.executable, PROCESS_NEWS, "--raw", str(raw_path), "--output", str(out_path)],
            capture_output=True, text=True,
        )
        assert result.returncode == 0, result.stderr
        digest = json.loads(out_path.read_text())
        assert len(digest["items"]) <= 30


# ── end-to-end CLI ────────────────────────────────────────────────────────────

def test_cli_end_to_end():
    """CLI writes digest.json with correct structure."""
    import subprocess

    PROCESS_NEWS = str(SCRIPTS_DIR / "process_news.py")

    raw_items = [
        make_item("NVIDIA crushes estimates", "https://example.com/nvda-1"),
        make_item("AMD competitive threat", "https://example.com/amd-1"),
    ]

    with tempfile.TemporaryDirectory() as tmpdir:
        raw_path = Path(tmpdir) / "raw.json"
        out_path = Path(tmpdir) / "digest.json"
        raw_path.write_text(json.dumps(raw_items))

        result = subprocess.run(
            [sys.executable, PROCESS_NEWS,
             "--raw", str(raw_path),
             "--existing", str(out_path),
             "--output", str(out_path)],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr
        assert out_path.exists()

        digest = json.loads(out_path.read_text())
        assert "generated_at" in digest
        assert "items" in digest
        assert isinstance(digest["items"], list)
        assert all("is_new" in it for it in digest["items"])
