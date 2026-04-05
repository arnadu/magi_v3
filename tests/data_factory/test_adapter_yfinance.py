"""Unit tests for adapter_yfinance.py — no API key needed, uses network."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ADAPTER = str(
    Path(__file__).parent.parent.parent
    / "config" / "teams" / "equity-research" / "skills" / "data-factory" / "scripts"
    / "adapters" / "adapter_yfinance.py"
)


def run_adapter(*args) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, ADAPTER, *args],
        capture_output=True,
        text=True,
    )


def test_discover_valid_json():
    """--discover emits valid JSON with at least one series entry."""
    result = run_adapter("--discover")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert "adapter" in data
    assert data["adapter"] == "yfinance"
    assert isinstance(data.get("series"), list)
    assert len(data["series"]) >= 1

    first = data["series"][0]
    assert "id" in first
    assert "params" in first
    assert "description" in first


def test_discover_series_have_ticker():
    """Each series in --discover has a ticker param."""
    result = run_adapter("--discover")
    data = json.loads(result.stdout)
    for series in data["series"]:
        assert "ticker" in series["params"], f"Series {series['id']} missing ticker param"


def test_fetch_nvda_csv():
    """--fetch writes a CSV with the expected columns and at least one data row."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / "nvda.csv"
        result = run_adapter(
            "--fetch", str(out),
            "--series-id", "yfinance/NVDA_daily",
            "--params", '{"ticker":"NVDA"}',
        )

        if result.returncode != 0:
            if "yfinance not installed" in result.stderr:
                pytest.skip("yfinance not installed")
            if "no data returned" in result.stderr.lower():
                pytest.skip("yfinance returned no data (network issue)")
            pytest.fail(f"Adapter failed: {result.stderr}")

        assert out.exists(), "Output CSV not created"
        lines = out.read_text().strip().splitlines()
        assert len(lines) >= 2, "CSV has no data rows"

        header = lines[0]
        assert header == "date,open,high,low,close,volume", f"Unexpected header: {header}"

        # Spot-check first data row has 6 columns
        first_row = lines[1].split(",")
        assert len(first_row) == 6, f"Data row has wrong number of columns: {lines[1]}"

        # Date column should look like a date
        date_col = first_row[0]
        assert len(date_col) == 10 and date_col[4] == "-", f"Unexpected date format: {date_col}"


def test_fetch_missing_ticker_error():
    """--fetch without ticker param exits non-zero."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / "out.csv"
        result = run_adapter(
            "--fetch", str(out),
            "--series-id", "yfinance/test",
            "--params", "{}",
        )
        assert result.returncode != 0
        assert "ticker" in result.stderr.lower()


def test_fetch_smh_csv():
    """SMH ETF ticker also works."""
    with tempfile.TemporaryDirectory() as tmpdir:
        out = Path(tmpdir) / "smh.csv"
        result = run_adapter(
            "--fetch", str(out),
            "--series-id", "yfinance/SMH_daily",
            "--params", '{"ticker":"SMH"}',
        )

        if result.returncode != 0:
            if "yfinance not installed" in result.stderr or "no data" in result.stderr.lower():
                pytest.skip("yfinance unavailable")
            pytest.fail(f"Adapter failed: {result.stderr}")

        assert out.exists()
        lines = out.read_text().strip().splitlines()
        assert lines[0] == "date,open,high,low,close,volume"
        assert len(lines) >= 2
