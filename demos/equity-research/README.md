# Equity Research Team — Demo Outputs

Selected outputs from the NVDA equity research mission, curated and promoted here for reference.

The live mission workspace (`packages/agent-runtime-worker/missions/equity-research/`) is a
separate git repository managed by the agents themselves — briefs are committed there via the
`git-provenance` skill. Interesting outputs are copied here when worth sharing publicly.

## How to promote a new output

```bash
# After the daemon produces a brief:
cp packages/agent-runtime-worker/missions/equity-research/shared/briefs/YYYY-MM-DD.md \
   demos/equity-research/

git add demos/equity-research/YYYY-MM-DD.md
git commit -m "demo: add equity brief YYYY-MM-DD"
git push
```
