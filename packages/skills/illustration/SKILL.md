---
name: illustration
description: Get logos, icons, illustrations, diagrams or image edits made with CreateImage — how to write the brief, choose the kind, refine a candidate, and use the results.
---

# Illustration

`CreateImage` hands a brief to an image sub-agent. It picks the image models, makes several
candidates, critiques them against your brief, refines the best, and returns file paths, a
contact sheet and a short summary. The images never enter your context; open the contact
sheet in the Files panel, or call `InspectImage` on a candidate if you need to look at one.

A call takes one to several minutes and costs money (default budget: 8 images, $1.50). Ask
once with a good brief rather than many times with vague ones.

## Write the brief

A good brief answers, in a few lines:

1. **Purpose and use** — a logo for the website header and favicon; a hero image for a landing
   page; a figure for chapter 3 of a textbook.
2. **Subject** — what is shown, concretely.
3. **Style** — flat vector, line icon, watercolour, photographic, isometric, editorial
   illustration; name references if you have them.
4. **Colours** — two or three, named ("deep green and gold").
5. **Exact text to render**, in quotes, if any. Keep it short: image models misspell long text.
6. **Deliverable** — "isolated logo on a plain background, no mock-up", "16:9 banner with room
   for a headline on the left", "diagram with labelled arrows".
7. **Audience and tone** — luxury, playful, technical, for children.

Example:

```
CreateImage({
  brief: "Logo for 'Houseplant Grand Hotel', a luxury hotel for houseplants. Used in the website
header and as a favicon, so it must read at 32 px. A monstera leaf combined with a hotel service
bell. Deep green and gold. The name 'Houseplant Grand Hotel' in a refined serif under the mark.
Deliverable: an isolated logo on a plain background, no mock-up.",
  kind: "vector",
  options: 4
})
```

## Choose the kind (or leave it to the image agent)

| kind | for | returns |
|---|---|---|
| `vector` | logos, icons, marks that must scale | SVG |
| `raster-art` | illustrations, photographic scenes, painterly images, raster logos | PNG |
| `raster-instruct` | diagrams with labels, layouts with legible text, edits of an image by instruction | PNG or JPEG |

Other parameters: `options` (distinct options, 1–6, default 3), `aspectRatio` (`1:1`, `16:9`,
`9:16`, `4:3`, `3:4`, `3:2`, `2:3`), `references` (up to 3 PNG, JPEG or WebP files in your
workdir or the shared folder, as style examples or the image to edit), `maxImages` and
`maxUsd` (raise them for a large job; the platform caps them at 16 images and $5).

## Read the result

The result names the job (`img-…`), its status, the cost, the contact sheet
(`shared/images/<job>/contact-sheet.html`), every candidate file with its model and the image
agent's note, and the image agent's summary with its recommendation.

- `complete` — the image agent finished normally.
- `partial` — it stopped early (budget, time limit, a spending limit); what was made is listed.
- `failed` — nothing usable was made; the reason is given.

Before you hand candidates to the user or a teammate, read the image agent's notes for known
flaws (misspelt text, a detail to fix).

## Refine a candidate

Call `CreateImage` again with the job id and the candidate number, and a brief that says what
to change:

```
CreateImage({
  brief: "Keep everything; make the leaf gold and the lettering 20% larger.",
  refineJob: "img-20261113-…",
  refineCandidate: 2,
  options: 2
})
```

The candidate is passed to the image agent as the reference `parent`. Refinement by instruction
works best on raster candidates; an SVG candidate is passed as a rendered picture, so the
refined result is raster unless you ask for a vector redraw.

## Where files go

Everything is in `shared/images/<job>/`: `candidate-N.svg|png|jpg`, `manifest.json` (brief,
model, prompt, cost and notes per candidate), `contact-sheet.html`. Copy the chosen file to
where your deliverable needs it; do not edit the job folder.
