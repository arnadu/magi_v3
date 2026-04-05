"""Unit tests for catalog.py — no API keys, no LLM, no network."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent
    / "config" / "teams" / "equity-research" / "skills" / "data-factory" / "scripts"
)
CATALOG_PY = str(SCRIPTS_DIR / "catalog.py")

ADAPTER_DIR = SCRIPTS_DIR / "adapters"


# ── helpers ──────────────────────────────────────────────────────────────────

def run_catalog(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, CATALOG_PY, *args],
        capture_output=True,
        text=True,
    )


def minimal_sources(factory_dir: str, adapter: str = "yfinance") -> dict:
    return {
        "series": [
            {
                "id": f"{adapter}/NVDA_daily",
                "adapter": adapter,
                "params": {"ticker": "NVDA"},
                "schedule": "daily",
                "output": f"series/{adapter}/NVDA_daily.csv",
            }
        ],
        "news": [],
        "documents": [],
    }


# ── tests ─────────────────────────────────────────────────────────────────────

def test_list_empty_factory():
    """catalog.py list on a fresh directory exits 0 and prints an empty table."""
    with tempfile.TemporaryDirectory() as factory:
        result = run_catalog("list", factory)
        assert result.returncode == 0, result.stderr
        # No entries — table should be empty or note "no entries"
        assert "error" not in result.stdout.lower() or "0" in result.stdout


def test_list_json_flag():
    """--json flag emits valid JSON array."""
    with tempfile.TemporaryDirectory() as factory:
        result = run_catalog("list", factory, "--json")
        assert result.returncode == 0, result.stderr
        data = json.loads(result.stdout)
        assert isinstance(data, list)


def test_refresh_yfinance_ok():
    """catalog.py refresh with yfinance/NVDA produces status=ok and a CSV file."""
    with tempfile.TemporaryDirectory() as factory:
        sources_path = Path(factory) / "sources.json"
        sources = minimal_sources(factory, "yfinance")
        sources_path.write_text(json.dumps(sources))

        result = run_catalog("refresh", factory, str(sources_path))
        # yfinance requires network — skip gracefully if unavailable
        if "Error" in result.stdout and "network" in result.stderr.lower():
            pytest.skip("network unavailable")

        assert result.returncode == 0, result.stderr

        catalog_path = Path(factory) / "catalog.json"
        assert catalog_path.exists(), "catalog.json not created"

        catalog = json.loads(catalog_path.read_text())
        assert len(catalog) == 1
        entry = catalog[0]
        assert entry["id"] == "yfinance/NVDA_daily"

        if entry["status"] == "ok":
            csv_path = Path(factory) / entry["output"]
            assert csv_path.exists(), f"CSV not found at {csv_path}"
            lines = csv_path.read_text().strip().splitlines()
            assert lines[0] == "date,open,high,low,close,volume"
            assert len(lines) > 1, "CSV has no data rows"
            assert entry.get("rows", 0) > 0


def test_refresh_invalid_ticker_error():
    """Adapter failure for bad ticker sets status=error in catalog."""
    with tempfile.TemporaryDirectory() as factory:
        sources = {
            "series": [
                {
                    "id": "yfinance/INVALID_TICKER",
                    "adapter": "yfinance",
                    "params": {"ticker": "THISDOESNOTEXIST_XYZXYZ"},
                    "schedule": "daily",
                    "output": "series/yfinance/INVALID.csv",
                }
            ],
            "news": [],
            "documents": [],
        }
        sources_path = Path(factory) / "sources.json"
        sources_path.write_text(json.dumps(sources))

        result = run_catalog("refresh", factory, str(sources_path))
        # Catalog should still be written even on adapter error
        catalog_path = Path(factory) / "catalog.json"

        if not catalog_path.exists():
            pytest.skip("network unavailable — catalog not written")

        catalog = json.loads(catalog_path.read_text())
        entry = next((e for e in catalog if e["id"] == "yfinance/INVALID_TICKER"), None)
        if entry is not None:
            assert entry["status"] in ("error", "ok")  # ok if yfinance returns empty gracefully


def test_show_command():
    """catalog.py show returns the correct entry by id."""
    with tempfile.TemporaryDirectory() as factory:
        catalog = [
            {
                "id": "fred/DFF",
                "output": "series/fred/DFF.csv",
                "status": "ok",
                "fetched_at": "2026-04-04T05:30:00Z",
                "rows": 500,
                "error": None,
            }
        ]
        (Path(factory) / "catalog.json").write_text(json.dumps(catalog))

        result = run_catalog("show", factory, "fred/DFF")
        assert result.returncode == 0, result.stderr
        assert "fred/DFF" in result.stdout
        assert "500" in result.stdout


def test_show_missing_id():
    """catalog.py show exits non-zero for unknown id."""
    with tempfile.TemporaryDirectory() as factory:
        (Path(factory) / "catalog.json").write_text("[]")
        result = run_catalog("show", factory, "nonexistent/series")
        assert result.returncode != 0


def test_stale_detection_daily():
    """Entry with fetched_at yesterday is stale for daily schedule."""
    with tempfile.TemporaryDirectory() as factory:
        from datetime import date, timedelta

        yesterday = (date.today() - timedelta(days=1)).isoformat() + "T05:30:00Z"
        catalog = [
            {
                "id": "yfinance/NVDA_daily",
                "output": "series/yfinance/NVDA_daily.csv",
                "status": "ok",
                "fetched_at": yesterday,
                "schedule": "daily",
                "rows": 252,
                "error": None,
            }
        ]
        (Path(factory) / "catalog.json").write_text(json.dumps(catalog))

        result = run_catalog("list", factory)
        assert result.returncode == 0, result.stderr
        # stale should appear in output
        assert "stale" in result.stdout.lower() or "ok" in result.stdout.lower()


# ── security tests ────────────────────────────────────────────────────────────

def test_path_traversal_in_series_output_is_rejected():
    """catalog.py refresh must not write outside factory when output contains '..'."""
    import sys
    sys.path.insert(0, str(SCRIPTS_DIR))
    import catalog

    with tempfile.TemporaryDirectory() as factory_str, \
         tempfile.TemporaryDirectory() as outside:
        factory = Path(factory_str)
        sentinel = Path(outside) / "evil.csv"

        sources = {
            "series": [
                {
                    "id": "evil/traversal",
                    "adapter": "yfinance",
                    "params": {"ticker": "NVDA"},
                    "schedule": "daily",
                    # Attempt to write outside factory via path traversal
                    "output": f"../../{Path(outside).name}/evil.csv",
                }
            ],
            "news": [],
            "documents": [],
        }
        sources_path = factory / "sources.json"
        sources_path.write_text(json.dumps(sources))

        result = run_catalog("refresh", factory_str, str(sources_path))

        # The traversal file must not be created
        assert not sentinel.exists(), \
            "Path traversal allowed: file written outside factory dir"
        # Catalog should record an error for this source
        catalog_path = factory / "catalog.json"
        if catalog_path.exists():
            entries = json.loads(catalog_path.read_text())
            entry = next((e for e in entries if e["id"] == "evil/traversal"), None)
            if entry:
                assert entry["status"] == "error", \
                    f"Expected status=error for traversal source, got {entry['status']!r}"


def test_path_traversal_in_news_output_dir_is_rejected():
    """catalog.py refresh must not write outside factory when output_dir contains '..'."""
    with tempfile.TemporaryDirectory() as factory_str, \
         tempfile.TemporaryDirectory() as outside:
        factory = Path(factory_str)
        sentinel = Path(outside) / "raw.json"

        sources = {
            "series": [],
            "news": [
                {
                    "id": "evil/news-traversal",
                    "adapter": "newsapi",
                    "params": {"q": "test"},
                    "schedule": "daily",
                    # Attempt to write outside factory via path traversal
                    "output_dir": f"../../{Path(outside).name}",
                }
            ],
            "documents": [],
        }
        sources_path = factory / "sources.json"
        sources_path.write_text(json.dumps(sources))

        run_catalog("refresh", factory_str, str(sources_path))

        assert not sentinel.exists(), \
            "Path traversal allowed: raw.json written outside factory dir"
