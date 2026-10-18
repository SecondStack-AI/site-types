# Release check

`run.mjs` checks the Slides package in `../slides` against the sample decks in `decks/`; see the root README for what it fails on and the release procedure. `serve.mjs` is the server it uses, and also previews a deck by hand: `node serve.mjs decks/layouts`, then open the printed URL.

| Deck | Covers |
|---|---|
| `layouts` | every `data-layout`, `data-theme` and `data-footer` value, sections |
| `blocks` | plain HTML styling and every building block in `SKILL.md` |
| `theme` | `theme` colors for both schemes, fonts from a project file, a Google Fonts stylesheet and a font file URL |
| `styles` | per-slide `<style>`, animations, transitions, layers, allowed CSS `url()` |
| `apps` | same-origin and external app frames, with and without posters |
| `notes` | presenter notes |
| `sanitizer` | payloads that must stay inert: script, `on*`, `javascript:` and `data:` URLs, `srcdoc`, forms, object/embed, SVG animation, base/meta/link, CSS `@import`, `url()` and escapes, mutation XSS |

A deck is a site directory: `project/` is what would be published. Requests to other hosts never leave the machine: Google Fonts URLs get the package's own fonts, other pages get a stub, and `probe.invalid` counts as an execution marker.

## `check.json`

Optional, beside `project/`. Without it a deck must produce no issues and no notes.

```json
{
  "activate": true,
  "deckWarnings": ["font-href"],
  "warnings": {
    "inline-script": [{ "code": "unsafe-removed", "removed": ["<script>"] }],
    "css-urls": [{ "code": "css-url-removed", "count": 3 }],
    "head-style": ["style-outside-section"]
  },
  "errors": { "resources": ["asset-missing"] },
  "notes": { "plain": "The exact text the presenter window shows." }
}
```

- `warnings` and `deckWarnings` list every warning check mode reports, by slide id. `removed` lists the removed elements (`<script>`), attribute names (`onload`) and `style declaration`; it is required for `unsafe-removed`.
- `errors` lists error codes a payload slide is allowed to cause. Ordinary decks have none.
- `notes` lists every slide with notes and the text the presenter window shows.
- `activate` clicks, focuses and hovers every interactive element on the stage.

A payload marks execution by setting a `window` property that starts with `__exec`, or by requesting `/api/probe` or any `probe.invalid` URL.
