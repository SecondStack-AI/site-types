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
| `checkmode` | check mode's own detector: one slide that fits, one that overflows the safe area, one whose `section` clips |
| `builds` | click-to-reveal steps: `.step`, grouped `data-step`, SVG steps, an author's own effect, an invalid value |
| `sanitizer` | payloads that must stay inert: script, `on*` (including handlers that fire without a click: `onerror` on a failing image, animation and transition events, `ontoggle`, `autofocus` with `onfocus`), `javascript:` and `data:` URLs (links and frames), `srcdoc`, forms, object/embed, SVG animation, base/meta/link, CSS `@import`, `url()` and escapes, mutation XSS |

Besides check mode and the screenshots, every deck is driven once: → through the audience view, every step included, with the counter checked, O for the overview and Escape to close it; the presenter window follows the audience window and the audience follows the presenter back, with the notes read on the way; and each scheme's PDF is printed and its pages counted.

Stage screenshots cover every step of a slide. The last state, with every step shown, has the key `<deck>/<slide>/stage/<scheme>`, which a viewer without builds also produces, so a revealed slide is compared with the previous release; earlier steps are compared once the baseline has builds too.

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
  "notes": { "plain": "The exact text the presenter window shows." },
  "steps": { "list": 3 },
  "navigate": true
}
```

- `warnings` and `deckWarnings` list every warning check mode reports, by slide id. `removed` lists the removed elements (`<script>`), attribute names (`onload`) and `style declaration`; it is required for `unsafe-removed`.
- `errors` lists the error codes a slide must cause: an image whose `src` the sanitizer removed cannot load, and the `checkmode` slides must be reported. Ordinary decks have none.
- `notes` lists every slide with notes and the text the presenter window shows.
- `steps` lists every slide with builds and its step count.
- `navigate` walks every step with → in the presenter window and back with ← in the audience window, checks that the other window follows and that the presenter shows "Step n of N", and checks that each step's deep link (`#id.2`) renders as the stage did when it walked there.
- `activate` clicks, focuses and hovers every interactive element on the stage.

A payload marks execution by setting a `window` property that starts with `__exec`, or by requesting `/api/probe` or any `probe.invalid` URL.

## Not covered

Reload after a repin is not exercised. On `127.0.0.1` the viewer skips the deploy-event socket, `serve.mjs` has no `/api/ws`, and the served version never changes during a run, so `reloadIfRepinned` and its ETag parsing only ever see one version. Test a follow move against a real Spot when that code changes.
