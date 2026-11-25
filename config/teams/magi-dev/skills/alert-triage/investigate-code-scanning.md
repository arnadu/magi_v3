# Is this code-scanning alert a real vulnerability?

A scanner (CodeQL, Semgrep, trivy or one of the platform's own tools) flagged a line. Scanners
cannot see everything: a value may be validated in another function, a path contained by a
helper, a request pinned to a vetted address. Your job is to find out which it is at this commit.

1. Read the flagged line and the function around it.
2. Follow the flagged value back to where it enters (a request, a file, a tool argument, the
   environment) and forward to where it is used. Read every function it passes through.
3. Look for the guard that would make it safe, and read it: a check that is called on another
   path, or after the use, does not count.
4. Look for a test that attacks this path (the briefing names any the catalog knows).

Answer:
- `real`: a value an attacker controls reaches the flagged use without a guard that holds.
  Give `reproduction`: the request, file or call that would show it.
- `false-positive`: a guard holds on every path to the flagged use. Cite the guard.
- `could-not-establish`: you could not follow the value to its source or the guard to its end.
  Say where you stopped.

Evidence: each item is a `file` (repository-relative), a `line` and a `quote` copied exactly
from that line. Cite the flagged line, the guard (or its absence), and the entry point. If the
alert would not exist with a correct catalog (an operation or invariant missing), say so in
`catalogProposal`.
