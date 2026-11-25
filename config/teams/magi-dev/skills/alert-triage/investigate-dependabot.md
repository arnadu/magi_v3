# Is MAGI exposed to this vulnerable dependency?

A dependency has a published vulnerability. Whether it matters depends on where the package is
used and whether MAGI reaches the vulnerable part.

1. Find where the package comes from: `package-lock.json` (or the manifest named) says whether
   it is a direct or a transitive dependency, and whether it is `dev` (never shipped) or
   production.
2. If production: find which of MAGI's packages pull it in, and whether the images ship it
   (the Dockerfiles prune development dependencies).
3. Read the advisory's summary and vulnerable range. Search the code for uses of the
   vulnerable function or feature (`grep -rn` over `packages/`).

Answer:
- `exposed`: shipped, and MAGI uses the vulnerable part, or you cannot rule it out. Give
  `reproduction` when you can, and `upgrade`: the version that fixes it and what pulls it in.
- `not-exposed`: development only, or not shipped, or the vulnerable part is never used. Cite why.
- `could-not-establish`: say what stopped you.

Evidence: `file`, `line` and an exact `quote` (the lock-file entry, the use or its absence's
nearest neighbour, the Dockerfile's prune line).
