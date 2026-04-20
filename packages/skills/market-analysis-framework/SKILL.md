---
name: market-analysis-framework
description: Structural-forces methodology for macro market analysis. Defines the 9-section living analysis format, conviction scoring, daily brief format, and analytical discipline. Designed for gold but applicable to any macro asset.
scope: platform
---

# Market Analysis Framework

## Core philosophy

Markets are driven by **structural forces** — persistent macro and fundamental drivers that accumulate
over weeks and months, not one-day price catalysts. Good analysis identifies and tracks these forces
systematically. Good conviction arises from the weight and direction of structural forces, not from
price momentum or narrative alignment.

The goal is always to be **well-founded**: your directional view must be anchored in observable
structural developments. A view that happens to be in the same direction as recent price action
but lacks structural grounding is **detached conviction** — the most dangerous kind.

---

## Vocabulary

| Term | Definition |
|------|-----------|
| **Structural force** | A persistent macro or fundamental driver that meaningfully affects the asset's supply/demand balance or store-of-value attractiveness. Distinguished from one-day catalysts. |
| **Directional conviction** | The net direction implied by the current structural force map. |
| **Breadth** | The number of distinct structural forces pointing in a given direction. Each force counts once regardless of how many data points support it. |
| **Intensity** | The assessed strength of a single force: 1 = weak/tentative, 2 = moderate/building, 3 = strong/dominant. |
| **Conviction score** | `breadth × average_intensity`, computed separately for bullish and bearish forces. |
| **Directional imbalance** | `bullish_score − bearish_score`. Meaningful (worth expressing a directional view) when |imbalance| ≥ 3. |
| **Well-founded conviction** | A directional view grounded in structural forces with observable evidence. The evidence exists independently of the price action. |
| **Detached conviction** | A directional view where price action aligns with the view but structural forces have not materially reinforced it. Flag explicitly; do not present as confident analysis. |
| **Marginal change** | A shift in an existing structural force (intensity up or down) or the emergence/disappearance of a force. The daily brief reports only marginal changes. |

---

## The 9-section structural force map

The living analysis document (`analysis/gold-analysis.md` or equivalent) is organised into these
9 sections. Update only the sections where something changed. Append observations — do not overwrite
prior context unless it is demonstrably wrong.

### Section 1 — Real interest rate environment
- 10-year TIPS yield (DFII10): level, direction, and trend
- Real rate regime: negative real rates (bullish gold), rising real rates (headwind)
- Fed Funds rate path and market expectations
- Force assessment: direction + intensity

### Section 2 — USD dynamics
- DXY level and 30-day momentum
- Dollar strength / weakness and its structural drivers (divergence trade, current account, safe-haven bid)
- Gold/USD correlation: is the inverse relationship intact or breaking down?
- Force assessment: direction + intensity

### Section 3 — Inflation expectations
- 10-year breakeven inflation rate (T10YIE)
- CPI trend (CPIAUCSL) and deviation from Fed target
- Are inflation expectations anchored or drifting?
- Force assessment: direction + intensity

### Section 4 — Risk-off / safe-haven demand
- Equity volatility and drawdown context (VIX, SPY drawdown)
- Geopolitical or systemic risk events driving safe-haven flows
- Gold vs. alternatives (USD, Treasuries, JPY) as safe haven
- Force assessment: direction + intensity

### Section 5 — Central bank and official sector demand
- Net central bank buying/selling (WGC data, news signals)
- Key buyers and any policy changes (China PBoC, India RBI, Middle East)
- De-dollarisation narrative: is it a structural force or detached narrative?
- Force assessment: direction + intensity

### Section 6 — Supply, mine economics, and recycling
- Gold mine supply outlook (production cost, capex cycle)
- Recycling supply (price-responsive, high at multi-year highs)
- ETF flow trend (GLD holdings: accumulation or liquidation?)
- Force assessment: direction + intensity

### Section 7 — Market positioning and sentiment
- CFTC COT positioning (net speculative longs in gold futures)
- ETF holdings trend (GLD AUM direction)
- Retail sentiment signals (anomalously elevated = risk of reversal)
- Force assessment: direction + intensity

### Section 8 — Technical structure (context only)
- Primary trend (200-day MA relationship)
- Key support / resistance levels
- Gold miners ratio (GDX/GLD): leading or lagging price?
- Note: technical factors are *context*, not structural forces. They inform timing, not conviction.

### Section 9 — Conviction summary
```
Bullish forces: [list each force with intensity score]
Bearish forces: [list each force with intensity score]

Bullish score: [breadth × avg_intensity]
Bearish score: [breadth × avg_intensity]
Directional imbalance: [score]

Direction: BULLISH / BEARISH / NEUTRAL
Confidence: HIGH (|imbalance| ≥ 6) / MEDIUM (3–5) / LOW or NEUTRAL (< 3)

Key risk to the view: [one sentence]
Detachment check: [WELL-FOUNDED or DETACHED — brief note]
```

---

## Daily brief format

File: `briefs/YYYY-MM-DD.md`

The daily brief reports **only marginal changes**. If a section did not change materially, omit it.
The brief should be readable in under 2 minutes.

```markdown
# Gold Market Brief — YYYY-MM-DD

## Changes since yesterday
<!-- Only list sections where something shifted. Omit unchanged sections entirely. -->
- **[Section name]**: [What changed and why it matters for the structural force map]

## Conviction state
Direction: BULLISH / BEARISH / NEUTRAL
Score: [bullish_score] vs [bearish_score] (imbalance: [delta])
Confidence: HIGH / MEDIUM / LOW

## Key risk
[One sentence: what development would change the conviction state most quickly]

## Self-challenge
<!-- Steelman the opposing view. 2 sentences. Mandatory before publishing. -->
[Best case for the opposite direction]
```

---

## Analytical discipline

### Before every brief — self-challenge
1. State the 2–3 strongest structural arguments **against** your current directional view.
2. Identify the observable development that would cause you to flip the view.
3. Check for detachment: does the price action confirm your view while the structural forces are neutral or mixed? If so, label the conviction as DETACHED and lower confidence to LOW.

### Conviction escalation
- Do not escalate from NEUTRAL to BULLISH/BEARISH unless at least 2 new structural forces have shifted.
- Do not de-escalate from HIGH to LOW in one step without a genuine structural reversal.
- A change in Fed language is not a structural force until it produces a change in real rates or inflation expectations.

### Persistence bias
- Every assessment has a prior. Document the prior explicitly in the conviction summary.
- If the prior is unchanged, say so. Don't restate unchanged analysis as new insight.
- If today's evidence contradicts the prior, update the section immediately — do not hold the prior beyond its evidence.

---

## Living analysis update procedure

```bash
SHARED="$SHARED_DIR"       # or {{sharedDir}} in system prompt
ANALYSIS="$SHARED/analysis/gold-analysis.md"
BRIEF="$SHARED/briefs/$(date +%Y-%m-%d).md"

# 1. Read current analysis (only the sections you need — head/grep, not cat)
head -n 100 "$ANALYSIS"

# 2. Read data factory
FACTORY="$SHARED/data-factory"
SKILL_SCRIPTS="$SHARED/skills/_platform/data-factory/scripts"
magi-python3 "$SKILL_SCRIPTS/catalog.py" list "$FACTORY"

# 3. Read news digests (new items only)
bash "$SHARED/skills/_platform/data-factory-client/scripts/read-digest.sh" \
  "$SHARED/data-factory/news/gold_newsapi"

# 4. Update only changed sections in ANALYSIS (use EditFile, not full rewrite)
# 5. Write BRIEF with marginal changes only
# 6. Commit both via git-provenance
# 7. PostMessage user with direction, score, one-sentence rationale, commit SHA
```
