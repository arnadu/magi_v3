#!/usr/bin/env bash
# read-series.sh - Print the last N rows of a named time series.
#
# Usage:
#   bash read-series.sh <series-id> [--rows N]
#
# Examples:
#   bash read-series.sh fmp/NVDA_daily_price
#   bash read-series.sh fred/DFF --rows 10
#   bash read-series.sh yfinance/NVDA_daily --rows 5
#
# Env:
#   SHARED_DIR  — mission shared directory (set by agent runtime)

set -euo pipefail

SERIES_ID="${1:?Usage: read-series.sh <series-id> [--rows N]}"
ROWS=20

shift
while [[ $# -gt 0 ]]; do
    case "$1" in
        --rows) ROWS="${2:?--rows requires a value}"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

FACTORY="${SHARED_DIR:?SHARED_DIR not set}/data-factory"
CSV="${FACTORY}/series/${SERIES_ID}.csv"

if [[ ! -f "${CSV}" ]]; then
    echo "Series not found: ${CSV}" >&2
    echo "Run: bash read-catalog.sh  to see available series." >&2
    exit 1
fi

# Print header + last N rows
head -1 "${CSV}"
tail -n "${ROWS}" "${CSV}"
