# ADR-0028 — Document/image processing: OCR fallback, image-text transcription, table reconstruction

**Status**: Accepted
**Sprint**: ad hoc (issue #50 investigation) — extends Sprint 25 phase 2
**Date**: 2026-09-11

---

## Context

Sprint 25 phase 2 built `document-processor.ts`: it turns any uploaded or web-fetched file into
an LLM-readable `content.md` artifact, handling PDF (mupdf), DOCX (mammoth), XLSX (exceljs), CSV,
plain text, images, and ZIP. Two real, live incidents on the same document (an academic PDF
uploaded to a running Tutor mission) surfaced two independent gaps in how it turns page/image
content into text:

1. **Issue #50** — a scanned PDF (no embedded text layer) was falling back to a vision model's
   loose description of the rendered page instead of actual transcribed text: lossy for math
   formulae and data tables, and generally unusable for the academic-document case this
   surfaced on.
2. **Investigating #50 against a real exam PDF** (a *different* document from the same mission,
   this one with a genuine text layer) found a second, unrelated problem while verifying the
   first fix worked: reported as "the tables look re-interpreted, not exact." A byte-level diff
   against a fresh, independent mupdf extraction proved the underlying text was already exact —
   what actually looked wrong was `page.toStructuredText().asText()`, which returns table cells
   as a flat linear dump (`"Variable Definition Average Online advertisingt Total spending..."`)
   with no row/column structure at all. Not a bug in mupdf — a documented limitation of that
   extraction mode — but a real quality gap for this pipeline's output.

Both point at the same underlying assumption that turned out to be wrong: the pipeline treated
"the page has *some* text" as "the page is fully and usefully captured." In practice a page can
have accurate-but-unstructured text (gap 2) or effectively no text at all (gap 1) — two different
problems needing two different fixes, discovered back to back on the same real document.

---

## Decision

### 1. Every image-description call also attempts verbatim text transcription — except a PDF page's own visual note

One shared prompt/call (`AUTO_DESCRIBE_PROMPT`, built by `createDescribeImage`) now asks for a
2–4 sentence description **and**, if the image contains legible text (a screenshot, whiteboard
photo, sign, chart with data labels), a verbatim `Text:` section — Markdown tables, LaTeX for
math. The model decides whether transcription applies and omits the section when it doesn't, so
this adds no new vision calls. Applies to standalone image uploads and DOCX-embedded images —
cases where the image's content isn't captured anywhere else.

**Revised after shipping**: this was originally applied to a PDF page's "Page visual" note too
(the caption added when a page already has real extracted text). Found live, immediately: this
reliably re-transcribed the page's own already-correct text a second time — not a rare
mistranscription risk, a near-certain duplication, since the model faithfully does what the
prompt asks (transcribe legible text) and the whole rendered page *is* legible text it can see.
Fixed structurally, not by tweaking prompt wording: a PDF page's visual note now goes through a
separate injection point, `describePageVisual` (`createPageVisualDescribe`,
`PAGE_VISUAL_PROMPT`) — description only, no transcription instruction at all — kept fully
separate from `describeImage` at the type level (`ProcessOptions` has both fields; `processPdf`
only ever receives `describePageVisual`, never `describeImage`) so this can't regress by a future
caller accidentally wiring the wrong one back in.

### 2. A PDF page with no usable extracted text gets OCR'd, not just described

New `OcrPageFn` injection point (`createOcrPage`) — structurally identical to `DescribeImageFn`,
different prompt (`OCR_TRANSCRIBE_PROMPT`: verbatim transcription, explicitly told there is no
text layer to fall back on). A page counts as scanned when its raw extracted text is under
`SCANNED_TEXT_THRESHOLD` (50 characters — see the raw-vs-formatted-length note below). Unlike the
describe-now/defer budget (`maxAutoDescribe`, default 10) that governs optional visual captions,
OCR is attempted for **every** scanned page within the render limit (`maxRenderPages`), not
subject to that smaller cap: a page with zero usable text is a correctness gap, not a
nice-to-have caption, so it doesn't compete with other images for a shared budget.

**Options researched and ruled out** before choosing an implementation (not guessed at):

| Option | Why not |
|---|---|
| mupdf's own OCR mode | Does not exist in the installed npm package (`mupdf` 1.27.0) — confirmed empirically: zero OCR-related exports anywhere in the module (`Object.keys(mupdf)`, `.d.ts`). Would need a completely different, natively-compiled mupdf build with Tesseract linked in. |
| A dedicated OCR provider (Mistral OCR API, Google Vision) | Real quality upside, but needs a brand-new API key/secret, a new external HTTP dependency, and a per-page cost — for an experiment, not proportionate on day one. |
| Mistral OCR via OpenRouter | Checked OpenRouter's live model catalog directly — no OCR-labeled models. Mistral's dedicated OCR product (`api.mistral.ai/v1/ocr`) is a separate, non-chat endpoint OpenRouter doesn't proxy; only their regular chat models are there. |
| **Chosen: reuse the vision model already configured for this pipeline** (`VISION_MODEL` / `OPENROUTER_API_KEY`), prompted for transcription instead of description | Zero new secrets or dependencies. Isolated behind the same `DescribeImageFn`-shaped injection point `describeImage` already uses, so swapping in a dedicated OCR provider later — if quality on real documents proves insufficient — needs no call-site changes, only a new `createOcrPage` implementation. |

### 3. Table structure is reconstructed from PDF page geometry, not left flat

New module, `pdf-tables.ts`: pure geometry (no mupdf dependency in the algorithm itself — takes
plain `{text,x,y,w,h}` lines, fully unit-testable with synthetic layouts). Reads mupdf's
structured-text JSON (`asJSON()`, not `.asText()`), which gives every line's bounding box. Lines
are grouped into row-bands by y-proximity; a contiguous run of **≥2 rows with ≥2 cells each**,
sharing consistent column x-positions (within tolerance), becomes a real Markdown table. A
single-cell row immediately following an active table row, at an x matching one of that table's
columns, is folded in as a wrapped-cell continuation (e.g. a "Definition" cell wrapping onto a
second line) — capped at **one continuation per row**, with a y-gap ceiling, specifically so a
coincidental x-match (a blank spacer line happens to be left-aligned with column 1) can't cause
the table to keep swallowing unrelated paragraph text below it. This exact failure mode was
found and fixed by tracing the real exam PDF's actual line geometry by hand before shipping the
algorithm, not caught after the fact.

Everything outside a detected table passes through in mupdf's own reading order, unchanged.
Confirmed mupdf's own "block" grouping does **not** align with logical table rows (a row's
numeric value routinely lands in a different block than its text label, in the real document
this was built against) — which is why detection works on the flat set of lines across the whole
page, not mupdf's block boundaries.

### Scanned-page detection measures raw extraction, not the final formatted string

`SCANNED_TEXT_THRESHOLD` compares against the sum of trimmed per-line character counts
(`rawLength`), computed before Markdown formatting — not `text.length` on the final reconstructed
string. The formatted output's length now depends on incidental choices (table markup overhead,
tighter blank-line joining than mupdf's own `.asText()` used) that have nothing to do with how
much real text mupdf actually found on the page. Using the formatted length would make the
scanned/not-scanned decision depend on presentation rather than content — concretely, it flipped
one existing test fixture's thin-but-real "Chart" caption page across the threshold purely
because the new joining logic is more compact, with no change in how much real text was there.

---

## The full pipeline, end to end

Both entry points — an operator upload (`monitor-server.ts`'s `/upload` route) and an agent's
`FetchUrl` call on a `.pdf`/image URL — construct the same `describeImage` /
`describePageVisual` / `ocrPage` trio from whatever vision model is configured, and hand bytes to
the one shared `processBuffer()`:

1. **Format detection** (`detectFormat`): extension first, then a magic-byte sniff, then the
   supplied MIME type.
2. **Per format**: plain text/CSV pass through with a preview; XLSX becomes one CSV per sheet;
   DOCX converts to Markdown via mammoth, with embedded images handled per step 4 below; ZIP
   recurses each contained file through this same entry point into its own artifact.
3. **PDF, per page**:
   - Extract text via mupdf's structured JSON, reconstructing any detected tables as Markdown
     (`pdf-tables.ts`, decision 3).
   - If the page's raw extracted text is under `SCANNED_TEXT_THRESHOLD` **and** an `ocrPage` is
     configured: render the page, OCR it (decision 2), and use the transcription as the page's
     real content — not subject to the describe-now/defer budget.
   - Otherwise, if the page is within the render budget: render it and, budget permitting
     (`maxAutoDescribe`, largest-area-first via `selectImages`), auto-caption it via
     `describePageVisual` (description-only, decision 1's revision) — or leave an `InspectImage`
     pointer for the agent to pull on demand.
4. **Standalone/embedded images** (a direct image upload, or an image embedded in a DOCX): same
   describe-now/defer budget, but via `describeImage` — the caption-plus-transcription prompt,
   since here (unlike a PDF page) nothing else has already captured the image's own content.
5. **Assembly**: `content.md` opens with a status line (`complete`/`partial`/`unsupported`) and
   the reconstructed Markdown; page renders, embedded images, and the original file are all saved
   alongside it as artifacts.

---

## Consequences

- Every PDF/DOCX/image processed through this pipeline now recovers more real content and less
  lossy paraphrase, at no new cost for the (common) non-scanned case, and a bounded new cost (one
  OCR call per scanned page, within the existing render-page limit) for the scanned case.
- No new secrets, external dependencies, or trust boundaries — everything reuses the vision model
  this pipeline already calls; nothing in `docs/security/threat-model.md` changes.
- **Known, accepted limitation — not addressed here**: a "sandwich" PDF (one where the original
  scanning tool already embedded its own, possibly low-quality, OCR text layer) passes the
  raw-length check and is never re-OCR'd, even if that embedded layer is garbled. Would need a
  text-quality heuristic, not just a length check, to catch — not built speculatively without
  evidence it's actually being hit in practice.
- **Known, accepted limitation**: a page whose only real text is a running header/footer (its
  actual body being a scanned image) can clear the 50-character threshold on header text alone
  and skip OCR. Same reasoning as above — a density/coverage heuristic would catch this, deferred
  until there's evidence it matters.
- Table reconstruction's false-positive guard (require ≥2 confirmed rows with consistent columns,
  bounded continuation absorption) is deliberately conservative: a genuine table that appears only
  once, with no second row to confirm the column pattern, is left as plain reading-order text
  rather than risk inventing structure that isn't really there.

---

## Related

- `packages/agent-runtime-worker/src/document-processor.ts` — the pipeline itself
- `packages/agent-runtime-worker/src/pdf-tables.ts` — table reconstruction (decision 3)
- `packages/agent-runtime-worker/src/monitor-server.ts` — upload entry point, wires
  `describeImage`/`describePageVisual`/`ocrPage`
- `packages/agent-runtime-worker/src/tools/fetch-url.ts` — web-fetch entry point, same wiring
- `packages/agent-runtime-worker/tests/pdf-tables.unit.test.ts`,
  `packages/agent-runtime-worker/tests/document-processor.unit.test.ts` — including a real exam
  PDF fixture (`testdata/documents/exam-with-tables.pdf`) locking in the table-reconstruction
  regression this ADR fixes
- GitHub issue #50
- `docs/implementation-history.md`'s Sprint 25 phase 2 entry — the original pipeline this ADR
  extends
