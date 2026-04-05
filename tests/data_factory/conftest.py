"""Shared fixtures for data_factory unit tests."""
import json
import sys
from pathlib import Path

# Make adapter scripts importable
SCRIPTS_DIR = Path(__file__).parent.parent.parent / "config" / "teams" / "equity-research" / "skills" / "data-factory" / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))
sys.path.insert(0, str(SCRIPTS_DIR / "adapters"))
