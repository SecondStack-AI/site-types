# Slides 1.1.0

A Slides site is a presentation. The viewer is part of the site type: it shows each slide in a 16:9 frame, with keyboard and touch navigation, an overview, a presenter window with notes and a timer, fullscreen, light and dark themes and print to PDF. You write only the deck data: one JSON file and one HTML fragment per slide. Do not write `index.html`, CSS files or JavaScript.

## Files

Everything lives under `project/` in the site directory:

```
project/deck.json            title, slide order, sections, theme
project/slides/<id>.html     one slide each
project/assets/...           images and other media
```

`deck.json`:

```json
{
  "v": 1,
  "title": "Q3 review",
  "lang": "en",
  "order": ["cover", "agenda", "results", "next-steps"],
  "sections": {
    "now": { "title": "Where we are", "start": "results" }
  },
  "theme": { "scheme": "light" }
}
```

- `v` is always `1`. `order` lists the slide ids; an id is 1-64 lowercase letters, digits and inner hyphens, and names the file `project/slides/<id>.html`.
- `sections` is optional. A section runs from its `start` slide to the next section's start; the overview groups slides by section and the slide footer shows the section title.
- `lang` is optional and sets the language of the slide text.
- `theme` is optional. Leave it out unless the user asks for a look: the default design is complete. `scheme` is `light` or `dark` (the audience can switch). `light` and `dark` each take any of the colors `background`, `surface`, `foreground`, `muted`, `accent`, `onAccent`, `border` as CSS color strings. `fonts` takes the roles `display`, `body` and `mono`, each `{"family": "...", "href": "https://fonts.googleapis.com/css2?family=..."}` (Google Fonts only) or `{"family": "...", "faces": [{"src": "assets/fonts/x.woff2", "weight": "100 900"}]}` (files under `project/`).

## Slide files

A slide file holds exactly one `<section>`. An optional last child `<aside>` holds the speaker notes as plain text; it is shown only in the presenter window.

```html
<section>
  <h2>Revenue grew in every region</h2>
  <ul>
    <li><strong>EMEA +18%</strong>, driven by renewals</li>
    <li><strong>Americas +11%</strong>, two large new accounts</li>
  </ul>
  <aside>Mention the currency effect if asked.</aside>
</section>
```

- The frame is 1920×1080 px with generous margins. Plain HTML is already styled: `h1` to `h4`, `p`, `ul`, `ol`, `blockquote` with `cite`, `figure` with `figcaption`, `table`, `pre`/`code`, `strong`, `em`, `mark`, `a`, `kbd`, `hr`.
- Choose a layout with `data-layout` on the section; without it the slide is a title with content below:
  - `title`: cover slide, content at the bottom left. Use `h1`, `p.lead`, `p.meta`.
  - `section`: divider between parts. Use `p.eyebrow` and `h2`.
  - `statement`: one large sentence in `h2`; `em` or `strong` words are highlighted.
  - `quote`: one `blockquote` with a `cite`.
  - `center`: centered content, for a closing slide.
  - `image`: the first child `img` or `figure` fills the slide; text after it sits on a dark scrim at the bottom.
  - `split`: first child is a `div` with the text, last child an `img`, `figure` or `div.media` filling the right half.
  - `blank`: no margins and no footer, for a slide you compose entirely yourself.
- `data-theme="dark"`, `"light"` or `"accent"` on the section gives one slide its own colors, for emphasis.
- A footer with the deck title, section and slide number appears on every slide except `title`, `section`, `image` and `blank` layouts. `data-footer="off"` hides it on one slide, `data-footer="on"` shows it on one of those layouts.
- Building blocks:
  - `p.eyebrow` small label above a heading; `p.lead` larger intro text; `.muted`, `.accent`, `.small`.
  - `div.cols` puts its children side by side in equal columns; add `wide-left` or `wide-right` for 3:2, `middle` to center them vertically.
  - `div.cards` with `div.card` children (`h3` + `p`); `card highlight` marks one.
  - `div.stats` with `div.stat` children: `<strong>42%</strong><span>label</span>`.
  - `ol.steps` for a numbered process: `<li><strong>Step</strong>Description</li>`.
  - `p.callout` or `div.callout` for a key takeaway. `ul.check` for a checklist, `ul.plain` without markers.
  - `.grow` makes an element take the remaining height; `.bottom` pushes it to the bottom; `figure.fill` makes an image fill the remaining space.
  - `td.num` / `th.num` align numbers right; `tr.highlight` emphasizes a row.
- Use the theme colors in inline SVG and styles through `var(--accent)`, `var(--foreground)`, `var(--muted)`, `var(--surface)` and `var(--border)`, so the slide works in both themes.
- A `<style>` element inside the section applies only to that slide, and its rules win over the built-in styles. Prefer the layouts and building blocks above.
- CSS animations and transitions are allowed; they replay each time the slide is shown. Write the base style as the end state and animate only from the start (`@keyframes x { from { opacity: 0 } }`): the overview, the presenter's preview, print and check mode show slides without animation.
- Builds reveal parts of a slide one click at a time. Use them in decks that someone presents live, so the speaker can talk through a list or a diagram point by point; leave them out of decks that people mostly read on their own. Add `class="step"` to reveal elements in document order, or `data-step="N"` to set the order yourself (equal numbers appear together). A hidden step keeps its space and fades in; to change the effect, style `[data-step-hidden]` (a step not shown yet) and the `transition` of `.step` in the slide's `<style>`. The overview, print and check mode show every step, and check mode reports `steps` per slide.
- Relative paths are relative to `project/`: write `src="assets/chart.png"` for `project/assets/chart.png`. To replace an image, save the new one under a new file name and update the slide; viewers that already have the deck open keep showing a file whose name did not change.
- Slide HTML is shown in several places at once (stage, overview, presenter, print, check), so it must be plain markup; anything interactive goes into an app page (see Interactive slides). The viewer sanitizes slide HTML:
  - `<script>`, `on*` attributes, `javascript:` URLs, forms, `object`, `embed`, SVG animation, `base` and `meta` are removed. Draw charts and diagrams as inline SVG or images.
  - Links may be `https:`, `http:`, `mailto:` or relative. Images, video and other resources load only from `project/` files or `https:` addresses; `<img>` also accepts `data:image/...`.
  - CSS `url()` may point only to `project/` files, `https:` addresses or `data:` images; other declarations, and declarations that use backslash escapes, are dropped; `@import` and linked stylesheets are ignored.
  - An `iframe` may show a page under `project/` or any `https:` page (videos, Excalidraw, Figma, forms). A page from another site stays isolated from the deck and cannot navigate it; a page under `project/` is part of the deck (see Interactive slides). SVG `<use>` may reference only `#id` inside the slide.
  - Check mode lists everything the sanitizer removed.
- Keep each slide to one idea: a heading and at most about six short bullets, one table of up to about seven rows, or one diagram. Split content that does not fit.

## Interactive slides

Use an app page for anything that reacts: a poll, a form, a quiz, a small game, a live chart. Inline slide HTML is enough for everything else, including CSS animation and hover effects.

- Write the app as a complete HTML page with its own scripts and styles, for example `project/apps/poll.html`, and embed it: `<iframe src="apps/poll.html" title="Live poll" data-poster="assets/poll.png"></iframe>`. For a full-slide app use `data-layout="blank"` and give the iframe `width: 100%; height: 100%`; inside another layout, give it an explicit `width` and `height` (attributes or style), or it gets the browser default of 300×150.
- The app runs only on the stage and in the presenter's current slide. The overview, print and check mode show the `data-poster` image (optional) in the frame's place. Leaving the slide reloads the app, so keep shared or lasting state in the site's data.
- The app page has the site's own authority and is fully trusted with the deck: it can read and change the deck page and navigate it, so only embed pages you would publish on the site itself. It can load the browser SDK with `<script src="/spot.js"></script>` and use collections, realtime rooms and `spot.me()` as described in the sites Skill (Interactive features). For example, a poll stores each vote with `spot.db.collection("poll").create(...)` and shows results with `subscribe(..., { replay: true })`.
- `/spot.js` exists only on the published site. Under the local preview server the app must still load and say that saving works once published; test the SDK part on the published deck with the user.
- While an app has focus, it gets all key presses. For an app under `project/`, Escape gives the keys back to the deck (an app that uses Escape itself can call `preventDefault()`); for an embedded page from another site, the presenter clicks outside it instead. Say this on the slide if the app uses the keyboard.

## Build a deck

1. Call `site_types` with `name="slides"`. Use the exact `type` it reports, for example `slides@1.1.0`, in every call below.
2. Plan the deck: the story, the sections and the slide ids, one idea per slide. Start with a `title` slide and end with a closing slide.
3. Write `project/deck.json` with the complete `order` first, then the slide files one by one. The viewer shows a placeholder for each listed slide whose file does not exist yet and fills it when the file appears, so you can publish early and keep writing.
4. Preview and check (below), fix every error, then publish.

## Preview and check

The workspace cannot open the published site. Check the deck locally with the viewer package:

1. Call `import_site` with `type="slides@1.1.0"` and a new directory, for example `/workspace/sites/<name>-preview/`. It contains `index.html` and `_type/`.
2. Copy the deck data into it, replacing any earlier copy, so deleted files do not linger: `rm -rf /workspace/sites/<name>-preview/project && cp -r /workspace/sites/<name>/project /workspace/sites/<name>-preview/`. Repeat after each change. Never publish the preview directory.
3. Serve it: `python3 -m http.server 8765 --bind 127.0.0.1 --directory /workspace/sites/<name>-preview` in the background.
4. Open `http://127.0.0.1:8765/?check=1` in the workspace browser. Check mode lists every slide with its issues and outlines overflowing elements. When `document.documentElement.dataset.slidesCheck` is `"done"`, the full report is the JSON text of `#slides-check-report` and the `[slides-check]` console line. `ok` is `false` while any error remains. While slides are still missing, the browser console also shows 404 errors for their files; that is expected.
5. Fix each error: `overflow` and `clipped` mean the content does not fit, so shorten it or split the slide; `missing`, `malformed`, `asset-missing`, `asset-timeout` and deck issues name the file to fix. Rerun the check until `ok` is `true` and `complete` is `true`, then look at a few slides in normal mode (`http://127.0.0.1:8765/#<slide-id>`).

## Publish

- Publish the data directory, `/workspace/sites/<name>/`, which holds `project/` and optionally `_spot.json`, with `publish_site(path=..., site=<name>, type="slides@1.1.0")`. It needs no `index.html`; never include the preview files. Leave `type_target` empty.
- Only files under `project/` and `_spot.json` belong in it. Publishing refuses other files and names the first offending path; every `.json` file must be valid JSON.
- An edit of an existing deck starts with `import_site(site=<name>, path=<empty directory>)`, which reports the exact type to publish with. Edit, check and publish with that `type`. A pin mismatch error (409) means the site now pins another version: import it again and redo the edit there.
- Give the user the link with one sentence on what the deck covers. The presenter view opens with `S`, the overview with `O`, fullscreen with `F`; browser print saves a PDF with one page per slide.
