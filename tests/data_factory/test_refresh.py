"""
test_refresh.py — Unit tests for refresh.py.

HOW TO RUN
----------
  # From repo root (no dependencies required beyond stdlib):
  python3 -m unittest tests/data_factory/test_refresh.py -v

  # Or discover all data_factory tests at once:
  python3 -m unittest discover -s tests/data_factory -v

HOW TO EXTEND
-------------
Each test class covers one function from refresh.py.  To add a test for a new
behaviour in a function:

  1. Find the corresponding TestXxx class below.
  2. Add a method named test_<what_you_are_testing>.
  3. Use self._make_log() to get a silent _Log instance that still captures
     messages in self._log.messages for assertion.
  4. Use tempfile.TemporaryDirectory() for any filesystem work — it cleans up
     automatically even if the test fails.
  5. Use unittest.mock.patch to replace external calls (subprocess.run,
     process_news.process, catalog.cmd_refresh) so tests stay fast and offline.

MOCK CHEAT-SHEET
----------------
Patch a function called inside refresh.py's function scope:

    # process_news is imported lazily inside process_news_digests(), so patch
    # the name in the process_news module itself:
    with patch("process_news.process") as mock_proc:
        mock_proc.return_value = None
        ...

    # subprocess.run is imported at module top level, so patch it there:
    with patch("refresh.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stderr="")
        ...

    # To check what arguments a mock was called with:
    args, kwargs = mock_proc.call_args
    self.assertEqual(args[0], "/expected/path")
"""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch, call

# ── Make scripts importable ──────────────────────────────────────────────────
# refresh.py lives in scripts/ alongside catalog.py and process_news.py.
# We add scripts/ to sys.path so `import refresh` works, mirroring what
# main() does at runtime.

SCRIPTS_DIR = (
    Path(__file__).parent.parent.parent
    / "packages" / "skills" / "data-factory" / "scripts"
)
sys.path.insert(0, str(SCRIPTS_DIR))

import refresh  # noqa: E402  (must come after sys.path modification)


# ── Shared helpers ────────────────────────────────────────────────────────────

class _CapturingLog:
    """
    A drop-in for refresh._Log that captures messages without touching files
    or stdout.  Use self.messages to assert on logged output.

    This replaces _Log in tests so we don't pollute test output with refresh
    log lines, and so we can assert on exactly what was logged.
    """
    def __init__(self):
        self.messages: list[str] = []

    def __call__(self, msg: str) -> None:
        self.messages.append(msg)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def contains(self, substr: str) -> bool:
        """Return True if any logged message contains substr."""
        return any(substr in m for m in self.messages)


def _make_sources(news_ids: list[str] = None, series_ids: list[str] = None) -> dict:
    """
    Build a minimal sources.json structure for tests.

    news_ids   — list of news source ids (each gets output_dir = news/<id>)
    series_ids — list of series source ids (each gets output path)
    """
    news = [
        {
            "id": nid,
            "adapter": "newsapi",
            "params": {},
            "schedule": "daily",
            "output_dir": f"news/{nid}",
        }
        for nid in (news_ids or [])
    ]
    series = [
        {
            "id": sid,
            "adapter": "yfinance",
            "params": {"ticker": sid.split("/")[-1]},
            "schedule": "daily",
            "output": f"series/{sid}.csv",
        }
        for sid in (series_ids or [])
    ]
    return {"series": series, "news": news, "documents": []}


def _make_digest(items: list[dict]) -> dict:
    """Build a minimal digest.json structure."""
    from datetime import datetime, timezone
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "items": items,
    }


# =============================================================================
# _resolve_paths
# =============================================================================

class TestResolvePaths(unittest.TestCase):
    """
    _resolve_paths is a pure function — test the path arithmetic only.
    No I/O is performed; no mocking needed.
    """

    def test_factory_is_data_factory_subdir(self):
        factory, _, _, _ = refresh._resolve_paths("/home/agent/missions/m1/shared")
        self.assertEqual(factory, Path("/home/agent/missions/m1/shared/data-factory"))

    def test_sources_path_inside_factory(self):
        factory, _, sources, _ = refresh._resolve_paths("/tmp/shared")
        self.assertEqual(sources, factory / "sources.json")

    def test_schedule_path_inside_factory(self):
        factory, _, _, schedule = refresh._resolve_paths("/tmp/shared")
        self.assertEqual(schedule, factory / "schedule.json")

    def test_skill_dir_is_parent_of_scripts(self):
        # skill_dir should be the data-factory/ directory, one level above scripts/
        _, skill_dir, _, _ = refresh._resolve_paths("/tmp/shared")
        self.assertEqual(skill_dir, SCRIPTS_DIR.parent)


# =============================================================================
# _Log
# =============================================================================

class TestLog(unittest.TestCase):
    """
    _Log is the tee-to-file context manager.  We test:
    - Messages appear in the log file
    - Append mode (second open does not truncate)
    - Graceful failure when the log directory does not exist
    """

    def test_writes_message_to_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "refresh.log"
            with refresh._Log(log_path) as log:
                log("hello world")
            self.assertIn("hello world", log_path.read_text())

    def test_appends_not_overwrites(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "refresh.log"
            with refresh._Log(log_path) as log:
                log("first run")
            with refresh._Log(log_path) as log:
                log("second run")
            content = log_path.read_text()
            self.assertIn("first run", content)
            self.assertIn("second run", content)

    def test_multiple_messages_all_written(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "refresh.log"
            with refresh._Log(log_path) as log:
                log("msg1")
                log("msg2")
                log("msg3")
            content = log_path.read_text()
            for msg in ("msg1", "msg2", "msg3"):
                self.assertIn(msg, content)

    def test_silently_continues_when_directory_missing(self):
        # If the log file's parent directory does not exist, _Log must not raise.
        # It should fall back to stdout-only mode.
        log_path = Path("/nonexistent/directory/refresh.log")
        with redirect_stdout():
            with refresh._Log(log_path) as log:
                log("should not raise")  # no exception expected

    def test_stdout_receives_messages(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "refresh.log"
            buf = io.StringIO()
            with redirect_stdout(buf):
                with refresh._Log(log_path) as log:
                    log("printed message")
            self.assertIn("printed message", buf.getvalue())


# =============================================================================
# bootstrap_config
# =============================================================================

class TestBootstrapConfig(unittest.TestCase):
    """
    bootstrap_config copies sources.json + schedule.json from the skill
    directory into $FACTORY on first run, and never overwrites existing files.
    """

    def _run(self, factory: Path, skill_dir: Path) -> _CapturingLog:
        log = _CapturingLog()
        refresh.bootstrap_config(
            factory,
            skill_dir,
            factory / "sources.json",
            factory / "schedule.json",
            log,
        )
        return log

    def test_copies_both_files_on_first_run(self):
        with tempfile.TemporaryDirectory() as factory_dir, \
             tempfile.TemporaryDirectory() as skill_dir:
            factory   = Path(factory_dir)
            skill     = Path(skill_dir)
            (skill / "sources.json").write_text('{"series":[],"news":[]}')
            (skill / "schedule.json").write_text('{"refresh_cron":"30 5 * * *"}')

            self._run(factory, skill)

            self.assertTrue((factory / "sources.json").exists())
            self.assertTrue((factory / "schedule.json").exists())

    def test_does_not_overwrite_existing_sources(self):
        with tempfile.TemporaryDirectory() as factory_dir, \
             tempfile.TemporaryDirectory() as skill_dir:
            factory = Path(factory_dir)
            skill   = Path(skill_dir)
            (skill   / "sources.json").write_text('{"series":["template"]}')
            (factory / "sources.json").write_text('{"series":["custom"]}')
            (skill   / "schedule.json").write_text("{}")

            self._run(factory, skill)

            # The agent's customised version must survive
            content = json.loads((factory / "sources.json").read_text())
            self.assertEqual(content["series"], ["custom"])

    def test_logs_warning_when_template_missing(self):
        with tempfile.TemporaryDirectory() as factory_dir, \
             tempfile.TemporaryDirectory() as skill_dir:
            factory = Path(factory_dir)
            # skill_dir is empty — no sources.json template

            log = self._run(factory, Path(skill_dir))
            self.assertTrue(log.contains("WARNING"))

    def test_creates_factory_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory   = Path(tmp) / "nested" / "factory"
            skill_dir = Path(tmp) / "skill"
            skill_dir.mkdir()

            self._run(factory, skill_dir)
            self.assertTrue(factory.exists())


# =============================================================================
# process_news_digests
# =============================================================================

class TestProcessNewsDigests(unittest.TestCase):
    """
    process_news_digests reads sources.json, then calls process_news.process()
    for each news source whose raw.json exists.

    We mock process_news.process to avoid running the real pipeline — that is
    already tested in test_process_news.py.  Here we test the orchestration
    logic: which sources are processed, which are skipped, and what arguments
    are passed.
    """

    def _run(self, factory: Path, sources: dict) -> tuple[_CapturingLog, MagicMock]:
        (factory / "sources.json").write_text(json.dumps(sources))
        log = _CapturingLog()
        with patch("process_news.process") as mock_proc:
            refresh.process_news_digests(factory, factory / "sources.json", log)
        return log, mock_proc

    def test_skips_source_when_raw_json_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            sources = _make_sources(news_ids=["nvda_news"])
            # raw.json is NOT created

            log, mock_proc = self._run(factory, sources)

            mock_proc.assert_not_called()
            self.assertTrue(log.contains("raw.json not found"))

    def test_calls_process_when_raw_json_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            sources = _make_sources(news_ids=["nvda_news"])
            (factory / "sources.json").write_text(json.dumps(sources))
            raw_dir = factory / "news" / "nvda_news"
            raw_dir.mkdir(parents=True)
            (raw_dir / "raw.json").write_text("[]")

            with patch("process_news.process") as mock_proc:
                log = _CapturingLog()
                refresh.process_news_digests(factory, factory / "sources.json", log)

            mock_proc.assert_called_once()

    def test_process_called_with_correct_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            sources = _make_sources(news_ids=["nvda_news"])
            raw_dir = factory / "news" / "nvda_news"
            raw_dir.mkdir(parents=True)
            (raw_dir / "raw.json").write_text("[]")
            # Write sources.json so the function can read it
            (factory / "sources.json").write_text(json.dumps(sources))

            with patch("process_news.process") as mock_proc:
                log = _CapturingLog()
                refresh.process_news_digests(factory, factory / "sources.json", log)

            _, kwargs = mock_proc.call_args
            self.assertEqual(kwargs["raw_path"],    str(raw_dir / "raw.json"))
            self.assertEqual(kwargs["output_path"], str(raw_dir / "digest.json"))
            # existing_path points to digest.json (process() handles missing file)
            self.assertEqual(kwargs["existing_path"], str(raw_dir / "digest.json"))

    def test_processes_multiple_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            sources = _make_sources(news_ids=["src_a", "src_b"])
            (factory / "sources.json").write_text(json.dumps(sources))
            for src_id in ("src_a", "src_b"):
                d = factory / "news" / src_id
                d.mkdir(parents=True)
                (d / "raw.json").write_text("[]")

            with patch("process_news.process") as mock_proc:
                refresh.process_news_digests(factory, factory / "sources.json", _CapturingLog())

            self.assertEqual(mock_proc.call_count, 2)

    def test_logs_error_but_continues_when_process_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            sources = _make_sources(news_ids=["src_a", "src_b"])
            (factory / "sources.json").write_text(json.dumps(sources))
            for src_id in ("src_a", "src_b"):
                d = factory / "news" / src_id
                d.mkdir(parents=True)
                (d / "raw.json").write_text("[]")

            call_count = [0]
            def fail_first(*a, **kw):
                call_count[0] += 1
                if call_count[0] == 1:
                    raise RuntimeError("simulated adapter failure")

            with patch("process_news.process", side_effect=fail_first):
                log = _CapturingLog()
                # Must not raise — error is caught and logged
                refresh.process_news_digests(factory, factory / "sources.json", log)

            self.assertTrue(log.contains("ERROR"))
            # src_b should still have been attempted
            self.assertEqual(call_count[0], 2)

    def test_skips_gracefully_when_sources_json_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = Path(tmp)
            # sources.json deliberately not created
            log = _CapturingLog()
            with patch("process_news.process") as mock_proc:
                refresh.process_news_digests(factory, factory / "sources.json", log)
            mock_proc.assert_not_called()
            self.assertTrue(log.contains("sources.json not found"))


# =============================================================================
# synthesise_briefs
# =============================================================================

class TestSynthesiseBriefs(unittest.TestCase):
    """
    synthesise_briefs calls `magi-tool research` via subprocess.

    We mock subprocess.run to avoid needing the daemon running.  Tests focus on:
    - The no-token early-exit
    - Skipping sources with no new items
    - The exact command line constructed (context files, --output, --max-age-hours)
    - First-run behaviour: brief.md not yet a context file when it doesn't exist
    """

    def _make_factory(self, tmp: str, news_ids: list[str],
                      new_item_counts: dict[str, int],
                      briefs_exist: set[str] = None) -> Path:
        """
        Build a minimal factory directory layout for synthesise_briefs tests.

        news_ids          — source ids to create
        new_item_counts   — {source_id: N} how many is_new items each digest has
        briefs_exist      — set of source ids that already have a brief.md
        """
        factory = Path(tmp)
        sources = _make_sources(news_ids=news_ids)
        (factory / "sources.json").write_text(json.dumps(sources))
        (factory / "schedule.json").write_text(json.dumps({"news_max_articles_fetch": 3}))

        for src_id in news_ids:
            d = factory / "news" / src_id
            d.mkdir(parents=True)
            n_new = new_item_counts.get(src_id, 0)
            items = [
                {"title": f"Art {i}", "url": f"https://x.com/{i}", "is_new": i < n_new}
                for i in range(max(n_new, 1))
            ]
            (d / "digest.json").write_text(json.dumps(_make_digest(items)))
            if briefs_exist and src_id in briefs_exist:
                (d / "brief.md").write_text("# Previous brief")

        return factory

    def _run(self, factory: Path, env_token: str | None = "test-token") -> tuple[_CapturingLog, MagicMock]:
        log = _CapturingLog()
        env = {**os.environ, "MAGI_TOOL_TOKEN": env_token} if env_token else \
              {k: v for k, v in os.environ.items() if k != "MAGI_TOOL_TOKEN"}
        with patch.dict(os.environ, env, clear=True):
            with patch("refresh.subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0, stderr="", stdout="")
                refresh.synthesise_briefs(factory, factory / "sources.json", log)
        return log, mock_run

    def test_skips_when_token_not_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2})
            log, mock_run = self._run(factory, env_token=None)
            mock_run.assert_not_called()
            self.assertTrue(log.contains("MAGI_TOOL_TOKEN not set"))

    def test_skips_source_with_no_new_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 0})
            log, mock_run = self._run(factory)
            mock_run.assert_not_called()
            self.assertTrue(log.contains("skipping synthesis"))

    def test_calls_magi_tool_when_new_items_exist(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2})
            _, mock_run = self._run(factory)
            mock_run.assert_called_once()
            cmd = mock_run.call_args[0][0]
            self.assertEqual(cmd[0], "magi-tool")
            self.assertEqual(cmd[1], "research")

    def test_command_includes_digest_as_context_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2})
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            digest_path = str(factory / "news" / "nvda_news" / "digest.json")
            # "--context-file <digest>" must appear in the command
            self.assertIn("--context-file", cmd)
            idx = cmd.index("--context-file")
            self.assertEqual(cmd[idx + 1], digest_path)

    def test_brief_md_not_in_context_on_first_run(self):
        """On first run brief.md does not exist — it must NOT appear as a --context-file value."""
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2},
                                          briefs_exist=set())  # no brief yet
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            brief_path = str(factory / "news" / "nvda_news" / "brief.md")
            # Collect all values that follow a --context-file flag
            context_files = [
                cmd[i + 1] for i, arg in enumerate(cmd)
                if arg == "--context-file" and i + 1 < len(cmd)
            ]
            self.assertNotIn(brief_path, context_files)

    def test_brief_md_added_as_context_on_subsequent_runs(self):
        """On subsequent runs, the existing brief.md is passed as a second context file."""
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2},
                                          briefs_exist={"nvda_news"})
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            brief_path = str(factory / "news" / "nvda_news" / "brief.md")
            self.assertIn(brief_path, cmd)

    def test_command_includes_output_and_max_age(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 1})
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            self.assertIn("--output", cmd)
            self.assertIn("--max-age-hours", cmd)
            # max-age-hours must be "0" to always bypass the research cache
            idx = cmd.index("--max-age-hours")
            self.assertEqual(cmd[idx + 1], "0")

    def test_output_path_points_to_brief_md(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 1})
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            idx = cmd.index("--output")
            expected = str(factory / "news" / "nvda_news" / "brief.md")
            self.assertEqual(cmd[idx + 1], expected)

    def test_logs_error_on_subprocess_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2})
            log = _CapturingLog()
            with patch.dict(os.environ, {"MAGI_TOOL_TOKEN": "tok"}, clear=False):
                with patch("refresh.subprocess.run") as mock_run:
                    mock_run.return_value = MagicMock(returncode=1, stderr="API error")
                    refresh.synthesise_briefs(factory, factory / "sources.json", log)
            self.assertTrue(log.contains("ERROR"))

    def test_respects_max_fetch_from_schedule(self):
        """The max_fetch value from schedule.json appears in the research question."""
        with tempfile.TemporaryDirectory() as tmp:
            factory = self._make_factory(tmp, ["nvda_news"], {"nvda_news": 2})
            # Override schedule with a distinct max_fetch value
            (factory / "schedule.json").write_text(json.dumps({"news_max_articles_fetch": 7}))
            _, mock_run = self._run(factory)
            cmd = mock_run.call_args[0][0]
            question = cmd[cmd.index("--question") + 1]
            self.assertIn("7", question)


# =============================================================================
# Helpers
# =============================================================================

from contextlib import contextmanager

@contextmanager
def redirect_stdout(buf=None):
    """Redirect sys.stdout to buf (or /dev/null) for the duration of the block."""
    buf = buf or io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        yield buf
    finally:
        sys.stdout = old


if __name__ == "__main__":
    unittest.main()
