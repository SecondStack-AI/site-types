# Release check

`run.mjs` checks the Slides package in `../slides` against the sample decks in `decks/`; see the root README for what it fails on and the release procedure. `serve.mjs` is the server it uses, and also previews a deck by hand: `node serve.mjs decks/layouts`, then open the printed URL. `preview.mjs` renders the preview image of every theme in `slides.json`.

| Deck | Covers |
|---|---|
| `layouts` | every `data-layout`, `data-theme` and `data-footer` value, sections |
| `blocks` | plain HTML styling and every building block in `SKILL.md` |
| `theme` | `theme` colors for both schemes, fonts from a project file, a Google Fonts stylesheet and a font file URL |
| `styles` | per-slide `<style>`, animations, transitions, layers, allowed CSS `url()` |
| `apps` | same-origin and external app frames, with and without posters |
| `notes` | presenter notes |
| `checkmode` | check mode's own detector: one slide that fits, one that overflows the safe area, one whose `section` clips |
| `builds` | click-to-reveal steps: `data-step`, equal numbers together, SVG steps, an author's own effect, empty and invalid values, a `data-step` on the section (ignored), nested steps, and a `step` class from a deck's own markup that must stay a non-build (steps 0, stage identical to 1.0.0) |
| `presets` | `theme.preset` with a fork-shaped `slides.json` in `type/`: theme colors under the deck's own light accent, a display font in two `unicodeRange` subsets, a stylesheet with shape tokens and scoped rules, a dark default scheme |
| `preset-unknown` | a preset the package lacks: `unknown-preset`, and the default theme, identical to 1.1.0 |
| `embed` | the host protocol, below |
| `sanitizer` | payloads that must stay inert: script, `on*` (including handlers that fire without a click: `onerror` on a failing image, animation and transition events, `ontoggle`, `autofocus` with `onfocus`), `javascript:` and `data:` URLs (links and frames), `srcdoc`, forms, object/embed, SVG animation, base/meta/link, CSS `@import`, `url()` and escapes, mutation XSS |

Besides check mode and the screenshots, every deck is driven once: → through the audience view, every step included, with the counter checked, O for the overview and Escape to close it, a step announcing what it revealed and waiting steps inert, and a link whose fragment ends in a line break still opening the deck; the presenter window follows the audience window and the audience follows the presenter back, with the notes read on the way; and each scheme's PDF is printed and its pages counted.

Stage screenshots cover every step of a slide. The last state, with every step shown, has the key `<deck>/<slide>/stage/<scheme>`, which a viewer without builds also produces, so a revealed slide is compared with the previous release; earlier steps are compared once the baseline has builds too.

The `embed` deck is also framed by `embed-host.html`, served from `localhost` so that it is another site than the deck on `127.0.0.1`, with one listed slide missing. The run checks `ready` and its outline (missing slide, sections, theme), `slide` after `goto`, a strip click and →, errors for an unknown slide and an invalid scheme, silence for unknown commands and another major, no effect for a command from a frame that is not the parent or for a viewer framed with another host origin (which also sends nothing), `outline` after `scheme` and after the missing slide is published, fullscreen from a host click with delegation (and `fullscreen-denied` without a click), the strip hidden in fullscreen, `print`, and a presenter window, opened by the viewer and by the host page, that follows the viewer and leads it. `BroadcastChannel` is removed in that run, as storage partitioning separates an embedded viewer from its presenter window in browsers that partition, so the presenter sync goes through window references.

A deck is a site directory: `project/` is what would be published, and `type/` holds files served under `/_type/` instead of the package's, as a fork would ship them. Requests to other hosts never leave the machine: Google Fonts URLs get the package's own fonts, other pages get a stub, and `probe.invalid` counts as an execution marker.

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
  "navigate": true,
  "preset": "sample",
  "scheme": "dark",
  "deckErrors": ["unknown-preset"],
  "embed": { "missing": "results" }
}
```

- `warnings` and `deckWarnings` list every warning check mode reports, by slide id. `removed` lists the removed elements (`<script>`), attribute names (`onload`) and `style declaration`; it is required for `unsafe-removed`.
- `errors` lists the error codes a slide must cause: an image whose `src` the sanitizer removed cannot load, and the `checkmode` slides must be reported. Ordinary decks have none.
- `notes` lists every slide with notes and the text the presenter window shows.
- `steps` lists every slide with builds and its step count; every other slide must have none, and listing one with 0 makes that explicit.
- `announce` maps a step state (`list.1`) to the exact text the live region must announce after → reaches it.
- `navigate` walks every step with → in the presenter window and back with ← in the audience window, checks that the other window follows and that the presenter shows "Step n of N", and checks that each step's deep link (`#id.2`) renders as the stage did when it walked there.
- `activate` clicks, focuses and hovers every interactive element on the stage.
- `preset` is the theme check mode must show the deck in; `scheme` is the scheme the deck opens in without `?theme` (default: `deck.json` `theme.scheme`, else `light`); `deckErrors` lists the deck-level error codes the deck must cause.
- `embed` runs the host protocol check, with the `missing` slide removed until the run publishes it.

A payload marks execution by setting a `window` property that starts with `__exec`, or by requesting `/api/probe` or any `probe.invalid` URL.

## Not covered

Popup blocking and storage partitioning are off in Playwright's Chromium, and a frame's `window.open` after a host's message is blocked in a real browser (`popup-blocked`); the presenter command is therefore checked only where popups are allowed. Fullscreen delegation is Chromium-only; Firefox and Safari are expected to answer `present` with `fullscreen-denied`, which no check exercises.

Reload after a repin is not exercised. On `127.0.0.1` the viewer skips the deploy-event socket, `serve.mjs` has no `/api/ws`, and the served version never changes during a run, so `reloadIfRepinned` and its ETag parsing only ever see one version. Test a follow move against a real Spot when that code changes.
