---
name: daily-brief-template
description: Structure and required fields for the NVDA daily equity brief. Use when writing the morning brief as Lead Analyst.
scope: team
---

# Daily Brief Template

## Purpose

Defines the required structure for each morning brief committed to `sharedDir/briefs/YYYY-MM-DD.md`.
Every section must be present. Omit data only if genuinely unavailable — note the gap explicitly.

## Usage

As Lead Analyst, after receiving research from all three team members:
1. Create the file: `{{sharedDir}}/briefs/YYYY-MM-DD.md`
2. Fill each section using the Economist's and Junior Analyst's committed research notes
3. Commit via git-provenance:
   `bash <platform-skills-path>/git-provenance/scripts/record-work.sh "lead-analyst" "report(daily-brief-YYYY-MM-DD): LONG/SHORT NVDA — <one-line rationale> [sources: <commit-SHAs>]" "{{sharedDir}}/briefs/YYYY-MM-DD.md"`
4. PostMessage user with the recommendation, 3-sentence rationale, and commit SHA

## Template

```markdown
# NVDA Daily Brief — {YYYY-MM-DD}

**Recommendation:** {LONG | SHORT | HOLD}
**Confidence:** {High | Medium | Low}
**Rationale commit:** {git SHA — links to this brief's commit via git-provenance}

---

## 1. Macro snapshot

*Source: `sharedDir/economist/{YYYY-MM-DD}.md` — commit {SHA}*

{2–3 sentences: current macro backdrop — rates, growth, inflation, risk sentiment. Include any material data releases or Fed communications from the past 24 hours.}

## 2. Semiconductor sector view

*Source: `sharedDir/economist/{YYYY-MM-DD}.md` — commit {SHA}*

{2–3 sentences: semiconductor cycle positioning, AI capex trends, NVDA competitive dynamics vs AMD / Intel / hyperscaler custom silicon. Note any competitor announcements.}

## 3. NVDA company view

*Source: `sharedDir/junior-analyst/{YYYY-MM-DD}.md` — commit {SHA}*

{2–3 sentences: NVDA-specific developments — earnings context, product news, SEC filing highlights, key customer signals. Note any material 8-K filings.}

## 4. Synthesis and recommendation

{One paragraph: how the macro, sector, and company views combine to form the recommendation. State the primary driver (e.g. "rates are the dominant risk factor because…" or "Data Center demand signals are the primary positive catalyst because…"). Include the key risk to the thesis — what would flip the recommendation.}

**Long thesis:** {one sentence — if LONG or holding LONG}
**Short thesis:** {one sentence — if SHORT or holding SHORT}
**Key risk:** {one sentence — what invalidates this view}

## 5. Performance tracker

*Tracker: `sharedDir/tracker.csv` — updated by Data Scientist*

| Date | Rec | Entry | Exit | PnL |
|------|-----|-------|------|-----|
| {latest row from tracker.csv} | | | | |

Running record: {N} trading days tracked. Win rate: {X}%. Cumulative PnL: ${Y}.

---

*Brief by: lead-analyst (Alex) | Commit: {SHA} | Economist: {SHA} | Junior: {SHA}*
*Sources: {comma-separated URLs of key articles / filings fetched today}*
```

## Quality checklist

Before committing:
- [ ] All four sections are populated (no empty sections)
- [ ] Recommendation is one of: LONG, SHORT, HOLD
- [ ] Confidence level stated
- [ ] Every claim has a source (URL or commit SHA)
- [ ] Performance tracker row is current (Data Scientist should have updated before synthesis)
- [ ] Key risk to the thesis is stated
