"""
Unit tests for adapter_fred/fmp/newsapi.py's CR-04 magi-tool integration.

No real network and no real API keys. A fake `magi-tool` executable (a tiny
script that ignores its args and prints a canned JSON response) stands in
for a real Tool API server round-trip, prepended onto PATH for the adapter
subprocess — this is what proves the adapter no longer needs
FRED_API_KEY/FMP_API_KEY/NEWSAPIORG_API_KEY in its own env at all: these
tests never set any of them.
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

ADAPTERS_DIR = (
    Path(__file__).parent.parent.parent
    / "packages" / "skills" / "data-factory" / "scripts" / "adapters"
)
FRED_ADAPTER = str(ADAPTERS_DIR / "adapter_fred.py")
FMP_ADAPTER = str(ADAPTERS_DIR / "adapter_fmp.py")
NEWSAPI_ADAPTER = str(ADAPTERS_DIR / "adapter_newsapi.py")


def _write_fake_magi_tool(tool_dir: Path, response: dict) -> None:
    """A fake `magi-tool` on PATH: ignores argv, prints `response` as JSON, exits 0."""
    script = tool_dir / "magi-tool"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        f"print(json.dumps({json.dumps(response)}))\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)


def _write_failing_magi_tool(tool_dir: Path, message: str) -> None:
    """A fake `magi-tool` that exits non-zero with a stderr message."""
    script = tool_dir / "magi-tool"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import sys\n"
        f"print({message!r}, file=sys.stderr)\n"
        "sys.exit(1)\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)


def _run_with_fake_tool(adapter: str, args: list, tool_dir: Path) -> subprocess.CompletedProcess:
    # No FRED_API_KEY/FMP_API_KEY/NEWSAPIORG_API_KEY set anywhere here — the
    # whole point is that the adapter subprocess never needs them.
    env = {**os.environ, "PATH": f"{tool_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    for key in ("FRED_API_KEY", "FMP_API_KEY", "NEWSAPIORG_API_KEY"):
        env.pop(key, None)
    return subprocess.run(
        [sys.executable, adapter, *args], capture_output=True, text=True, env=env,
    )


def _tool_response(text: str) -> dict:
    return {"result": {"content": [{"type": "text", "text": text}]}}


# ---------------------------------------------------------------------------
# FRED
# ---------------------------------------------------------------------------

def test_fred_fetch_writes_csv_and_filters_missing_values():
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_fake_magi_tool(tool_dir, _tool_response(json.dumps({
            "observations": [
                {"date": "2024-01-01", "value": "5.33"},
                {"date": "2024-01-02", "value": "."},  # FRED's "missing" marker
                {"date": "2024-01-03", "value": "5.35"},
            ],
        })))
        out = tool_dir / "out.csv"
        result = _run_with_fake_tool(
            FRED_ADAPTER,
            ["--fetch", str(out), "--series-id", "GDP", "--params", '{"series_id":"GDP"}'],
            tool_dir,
        )
        assert result.returncode == 0, result.stderr
        lines = out.read_text().strip().splitlines()
        assert lines[0] == "date,value"
        assert "2024-01-01,5.33" in lines
        assert "2024-01-03,5.35" in lines
        assert not any(",.\n" in line or line.endswith(",.") for line in lines)


def test_fred_surfaces_magi_tool_error_cleanly():
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_failing_magi_tool(tool_dir, "unauthorized")
        out = tool_dir / "out.csv"
        result = _run_with_fake_tool(
            FRED_ADAPTER,
            ["--fetch", str(out), "--series-id", "GDP", "--params", '{"series_id":"GDP"}'],
            tool_dir,
        )
        assert result.returncode == 1
        assert "FRED request failed" in result.stderr
        assert not out.exists()


# ---------------------------------------------------------------------------
# FMP
# ---------------------------------------------------------------------------

def test_fmp_daily_reverses_to_oldest_first():
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_fake_magi_tool(tool_dir, _tool_response(json.dumps({
            "historical": [
                {"date": "2024-01-02", "open": 2, "high": 2, "low": 2, "close": 2, "volume": 200},
                {"date": "2024-01-01", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 100},
            ],
        })))
        out = tool_dir / "out.csv"
        result = _run_with_fake_tool(
            FMP_ADAPTER,
            ["--fetch", str(out), "--series-id", "AAPL", "--params", '{"ticker":"AAPL","type":"daily"}'],
            tool_dir,
        )
        assert result.returncode == 0, result.stderr
        lines = out.read_text().strip().splitlines()
        assert lines[1].startswith("2024-01-01")  # oldest-first after reversal
        assert lines[2].startswith("2024-01-02")


def test_fmp_sec_filings_normalises_schema():
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_fake_magi_tool(tool_dir, _tool_response(json.dumps([
            {"type": "10-K", "date": "2024-01-01", "finalLink": "https://sec.gov/x", "formType": "10-K"},
        ])))
        out = tool_dir / "out.json"
        result = _run_with_fake_tool(
            FMP_ADAPTER,
            ["--fetch", str(out), "--series-id", "AAPL", "--params", '{"ticker":"AAPL","type":"sec_filings"}'],
            tool_dir,
        )
        assert result.returncode == 0, result.stderr
        filings = json.loads(out.read_text())
        assert filings == [{
            "type": "10-K", "date": "2024-01-01",
            "url": "https://sec.gov/x", "description": "10-K",
        }]


def test_fmp_missing_magi_tool_binary_fails_cleanly():
    """FileNotFoundError (magi-tool not on PATH) must not produce an uncaught traceback."""
    with tempfile.TemporaryDirectory() as tmpdir:
        empty_dir = Path(tmpdir)
        out = empty_dir / "out.csv"
        env = {"PATH": "/nonexistent"}
        result = subprocess.run(
            [sys.executable, FMP_ADAPTER, "--fetch", str(out), "--series-id", "AAPL",
             "--params", '{"ticker":"AAPL","type":"daily"}'],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 1
        assert "Traceback" not in result.stderr
        assert "FMP request failed" in result.stderr


# ---------------------------------------------------------------------------
# NewsAPI
# ---------------------------------------------------------------------------

def test_newsapi_normalises_articles():
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_fake_magi_tool(tool_dir, _tool_response(json.dumps({
            "status": "ok",
            "articles": [{
                "title": "NVIDIA Reports Record Revenue",
                "url": "https://example.com/a",
                "source": {"id": None, "name": "Reuters"},
                "publishedAt": "2026-04-03T14:00:00Z",
                "description": "NVIDIA Corporation today reported...",
            }],
        })))
        out = tool_dir / "out.json"
        result = _run_with_fake_tool(
            NEWSAPI_ADAPTER,
            ["--fetch", str(out), "--series-id", "newsapi/nvda", "--params", '{"q":"NVIDIA"}'],
            tool_dir,
        )
        assert result.returncode == 0, result.stderr
        items = json.loads(out.read_text())
        assert items == [{
            "title": "NVIDIA Reports Record Revenue",
            "url": "https://example.com/a",
            "source": "Reuters",
            "published_at": "2026-04-03T14:00:00Z",
            "summary": "NVIDIA Corporation today reported...",
        }]


def test_newsapi_error_status_fails_even_on_200():
    """NewsAPI signals errors via status != "ok" in the JSON body, not HTTP status."""
    with tempfile.TemporaryDirectory() as tmpdir:
        tool_dir = Path(tmpdir)
        _write_fake_magi_tool(tool_dir, _tool_response(json.dumps({
            "status": "error", "message": "apiKey is invalid",
        })))
        out = tool_dir / "out.json"
        result = _run_with_fake_tool(
            NEWSAPI_ADAPTER,
            ["--fetch", str(out), "--series-id", "newsapi/nvda", "--params", '{"q":"NVIDIA"}'],
            tool_dir,
        )
        assert result.returncode == 1
        assert "apiKey is invalid" in result.stderr
        assert not out.exists()
