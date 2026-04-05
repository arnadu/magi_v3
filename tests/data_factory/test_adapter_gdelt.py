"""Unit tests for adapter_gdelt.py — no API key needed, uses network."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ADAPTER = str(
    Path(__file__).parent.parent.parent
    / "config" / "teams" / "equity-research" / "skills" / "data-factory" / "scripts"
    / "adapters" / "adapter_gdelt.py"
)

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent
    / "config" / "teams" / "equity-research" / "skills" / "data-factory" / "scripts"
    / "adapters"
)
sys.path.insert(0, str(SCRIPTS_DIR))


def run_adapter(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, ADAPTER, *args],
        capture_output=True,
        text=True,
    )


# ── discover ──────────────────────────────────────────────────────────────────

def test_discover_valid_json():
    """--discover emits valid JSON with at least one series entry."""
    result = run_adapter("--discover")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data.get("adapter") == "gdelt"
    assert isinstance(data.get("series"), list)
    assert len(data["series"]) >= 1

    first = data["series"][0]
    assert "id" in first
    assert "params" in first
    assert "query" in first["params"]


# ── date parsing ──────────────────────────────────────────────────────────────

def test_parse_gdelt_date_valid():
    """GDELT date format converts to ISO-8601."""
    from adapter_gdelt import _parse_gdelt_date
    result = _parse_gdelt_date("20260404T060000Z")
    assert result == "2026-04-04T06:00:00+00:00"


def test_parse_gdelt_date_empty():
    """Empty string returns empty string."""
    from adapter_gdelt import _parse_gdelt_date
    assert _parse_gdelt_date("") == ""


def test_parse_gdelt_date_invalid():
    """Invalid format returns the original string unchanged."""
    from adapter_gdelt import _parse_gdelt_date
    assert _parse_gdelt_date("not-a-date") == "not-a-date"


# ── fetch ─────────────────────────────────────────────────────────────────────

def test_fetch_returns_json_array():
    """--fetch writes a JSON array (may be empty if GDELT returns nothing)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / "gdelt.json"
        result = run_adapter(
            "--fetch", str(out),
            "--series-id", "gdelt/nvidia_news",
            "--params", '{"query":"NVIDIA","max_records":5}',
        )

        if result.returncode != 0:
            if "request failed" in result.stderr.lower():
                pytest.skip("GDELT API unavailable (network issue)")
            pytest.fail(f"Adapter failed: {result.stderr}")

        assert out.exists(), "Output JSON not created"
        items = json.loads(out.read_text())
        assert isinstance(items, list)

        # Validate item schema if any returned
        for item in items:
            assert "title" in item
            assert "url" in item
            assert "source" in item
            assert "published_at" in item
            assert "summary" in item


def test_fetch_max_records_respected():
    """Adapter honours max_records limit."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / "gdelt.json"
        result = run_adapter(
            "--fetch", str(out),
            "--series-id", "gdelt/nvidia_news",
            "--params", '{"query":"NVIDIA","max_records":3}',
        )

        if result.returncode != 0:
            pytest.skip("GDELT API unavailable")

        items = json.loads(out.read_text())
        assert len(items) <= 3, f"Expected ≤3 items, got {len(items)}"
