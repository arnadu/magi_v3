# Does this watched guard still hold?

A watched guard is a file that holds a security property on its own. The briefing names the
property, why it matters and the tests that attack it. It changed, or it is due for its
periodic review: check that it still does its job.

1. Read the whole file. Note every entry into it (exported functions) and every path out (a
   connection, a file opened, a command run).
2. For each path out, check the property holds before it: every input vetted, no path that
   skips the check, nothing done between the check and the use that the check did not cover.
3. Read the tests it names: does each attack still reach the code as it is now? A test that
   no longer exercises a path is a gap.

Answer:
- `weakened`: a path out is not covered, or a test no longer reaches what it claims. Give
  `reproduction`.
- `holds`: cite the check on each path out and the test that attacks it.
- `could-not-establish`: say where you stopped.

Evidence: `file`, `line` and an exact `quote` for each check, gap and test you rely on.
