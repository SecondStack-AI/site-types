// PowerPoint export of the rendered deck, loaded by viewer.js on the first export. Each slide is
// mounted as a still 1920x1080 frame, its pseudo-elements are turned into real elements, and the
// laid-out DOM is walked into PptxGenJS objects: text blocks become native text boxes, plain boxes and
// rules native shapes, tables native tables, images, SVG and app posters pictures. Decorations that
// native shapes cannot express (gradients, masks, shadows) are rasterized through an SVG
// foreignObject. Opaque rasters are written as JPEG, the rest as PNG. App posters link to the app.
// Notes become slide notes. What does not map exactly is reported as a warning.

const PX_PER_IN = 144; // 1920 px = 13.333 in (LAYOUT_WIDE)
const inch = (px) => Math.round((px / PX_PER_IN) * 10000) / 10000;
const pt = (px) => Math.round(px * 50) / 100; // 1 pt = 2 px on this canvas

const PICTURES = new Set(["img", "svg", "video", "canvas", "iframe"]);
const SKIP = new Set(["style", "script", "template", "aside", "noscript"]);

const colorCanvas = document.createElement("canvas");
colorCanvas.width = colorCanvas.height = 1;
const colorCtx = colorCanvas.getContext("2d", { willReadFrequently: true });
const colorCache = new Map();

// Any CSS color the browser computes (rgb, color(srgb), oklab from color-mix) as hex plus alpha.
function color(value) {
  if (!value || value === "transparent" || value === "none") return null;
  if (colorCache.has(value)) return colorCache.get(value);
  colorCtx.clearRect(0, 0, 1, 1);
  colorCtx.fillStyle = "#000";
  colorCtx.fillStyle = value;
  colorCtx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = colorCtx.getImageData(0, 0, 1, 1).data;
  const result = a === 0 ? null : { hex: [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase(), alpha: a / 255 };
  colorCache.set(value, result);
  return result;
}

let slideBackground = { hex: "FFFFFF", alpha: 1 };

function blend(top, under) {
  const ch = (hex, i) => parseInt(hex.slice(i, i + 2), 16);
  return [0, 2, 4].map((i) => Math.round(ch(top.hex, i) * top.alpha + ch(under.hex, i) * (1 - top.alpha)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

function transparency(alpha, opacity) {
  return Math.round((1 - alpha * opacity) * 100);
}

function firstFamily(fontFamily) {
  // "Inter Variable" is the web face name; installed copies and Office know the family as "Inter".
  const first = fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "").replace(/ Variable$/, "");
  return first || "Arial";
}

// Pseudo-elements carry most of the decoration (bullets, accent bars, step numbers, title glow).
// Copy each one's computed style onto a real span in its place so the walker can measure it.
function materializePseudos(root, sheetHost) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync("[data-pptx-before]::before, [data-pptx-after]::after { content: none !important; }");
  const elements = [root, ...root.querySelectorAll("*")];
  const pending = [];
  for (const el of elements) {
    if (PICTURES.has(el.localName) || el.closest("svg")) continue;
    for (const which of ["before", "after"]) {
      const cs = getComputedStyle(el, `::${which}`);
      if (!cs.content || cs.content === "none" || cs.content === "normal") continue;
      const span = document.createElement("span");
      span.setAttribute("data-pptx-pseudo", which);
      for (let i = 0; i < cs.length; i += 1) {
        const name = cs[i];
        span.style.setProperty(name, cs.getPropertyValue(name));
      }
      span.textContent = pseudoText(cs.content, el);
      pending.push({ el, which, span });
    }
  }
  for (const { el, which, span } of pending) {
    el.setAttribute(`data-pptx-${which}`, "");
    if (which === "before") el.prepend(span);
    else el.append(span);
  }
  sheetHost.adoptedStyleSheets = [...sheetHost.adoptedStyleSheets, sheet];
}

function pseudoText(content, el) {
  const parts = [];
  const re = /"((?:[^"\\]|\\.)*)"|counter\(\s*([\w-]+)\s*(?:,\s*([\w-]+))?\s*\)|attr\(\s*([\w-]+)\s*\)/g;
  for (let m; (m = re.exec(content)); ) {
    if (m[1] != null) parts.push(m[1].replace(/\\(.)/g, "$1"));
    else if (m[2]) {
      const siblings = [...el.parentElement.children].filter((s) => s.localName === el.localName);
      const start = Number(el.parentElement.getAttribute("start") || 1);
      const n = siblings.indexOf(el) + start;
      parts.push(m[3] === "decimal-leading-zero" ? String(n).padStart(2, "0") : String(n));
    } else if (m[4]) parts.push(el.getAttribute(m[4]) || "");
  }
  return parts.join("");
}

function visible(cs) {
  return cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0;
}

function hasText(el) {
  return /\S/.test(el.textContent);
}

function outOfFlow(cs) {
  return cs.position === "absolute" || cs.position === "fixed";
}

// A text block holds only inline content; out-of-flow children are decorations drawn separately.
function inlineOnly(el) {
  for (const child of el.children) {
    const cs = getComputedStyle(child);
    if (!visible(cs) || SKIP.has(child.localName)) continue;
    if (outOfFlow(cs)) continue;
    if (PICTURES.has(child.localName)) return false;
    if (!cs.display.startsWith("inline") && child.localName !== "br") return false;
    if (!inlineOnly(child)) return false;
  }
  return true;
}

function boxOf(el, origin) {
  const r = el.getBoundingClientRect();
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

function contentBox(el, cs, origin) {
  const b = boxOf(el, origin);
  const l = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const r = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
  const t = parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth);
  const bo = parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth);
  return { x: b.x + l, y: b.y + t, w: Math.max(1, b.w - l - r), h: Math.max(1, b.h - t - bo) };
}

// Lines and the widest line of a block. Balanced and pretty wrapping break earlier than the box
// width, so a wrapped text box is sized to its widest line to keep the browser's line breaks.
function lineInfo(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const tops = [];
  let left = Infinity;
  let right = -Infinity;
  for (const rect of range.getClientRects()) {
    if (rect.width < 1) continue;
    if (!tops.some((top) => Math.abs(top - rect.top) < rect.height / 2)) tops.push(rect.top);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return { lines: tops.length, width: right - left };
}

const ALIGN = { left: "left", start: "left", center: "center", right: "right", end: "right", justify: "justify" };

function runOptions(cs, el, opacity) {
  const c = color(cs.color);
  const options = {
    fontFace: firstFamily(cs.fontFamily),
    fontSize: pt(parseFloat(cs.fontSize)),
    bold: Number(cs.fontWeight) >= 600,
    italic: cs.fontStyle === "italic",
    color: c?.hex || "000000",
  };
  if (c && transparency(c.alpha, opacity)) options.transparency = transparency(c.alpha, opacity);
  const ls = parseFloat(cs.letterSpacing);
  if (ls) options.charSpacing = pt(ls);
  const deco = cs.textDecorationLine;
  if (deco.includes("underline")) options.underline = { style: "sng" };
  if (deco.includes("line-through")) options.strike = "sngStrike";
  if (cs.verticalAlign === "super") options.superscript = true;
  if (cs.verticalAlign === "sub") options.subscript = true;
  const link = el.closest("a[href]");
  if (link && /^(https?|mailto):/i.test(link.href)) options.hyperlink = { url: link.href };
  const bg = color(cs.backgroundColor);
  if (bg && cs.display === "inline") options.highlight = blend(bg, slideBackground);
  return options;
}

function transform(text, cs) {
  if (cs.textTransform === "uppercase") return text.toUpperCase();
  if (cs.textTransform === "lowercase") return text.toLowerCase();
  if (cs.textTransform === "capitalize") return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return text;
}

// Runs of one paragraph-like block, with CSS whitespace collapsing across element boundaries.
function collectRuns(el, opacity, runs, state = { space: true }) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      const cs = getComputedStyle(parent);
      const pre = /^pre/.test(cs.whiteSpace) || cs.whiteSpace === "break-spaces";
      if (pre) {
        node.data.split("\n").forEach((line, i, all) => {
          runs.push({ text: transform(line, cs), options: { ...runOptions(cs, parent, opacity), breakLine: i < all.length - 1 } });
        });
        state.space = false;
        continue;
      }
      let text = node.data.replace(/\s+/g, " ");
      if (state.space) text = text.replace(/^ /, "");
      if (!text) continue;
      state.space = text.endsWith(" ");
      runs.push({ text: transform(text, cs), options: runOptions(cs, parent, opacity) });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.localName === "br") {
        if (runs.length) runs[runs.length - 1].options.breakLine = true;
        else runs.push({ text: "", options: { breakLine: true } });
        state.space = true;
        continue;
      }
      const cs = getComputedStyle(node);
      if (!visible(cs) || SKIP.has(node.localName) || outOfFlow(cs)) continue;
      collectRuns(node, opacity * Number(cs.opacity), runs, state);
    }
  }
  return runs;
}

function trimRuns(runs) {
  while (runs.length && !runs[runs.length - 1].text.trim() && !runs[runs.length - 1].options.breakLine) runs.pop();
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ $/, "");
  return runs;
}

function paragraphOptions(cs) {
  const options = { align: ALIGN[cs.textAlign] || "left" };
  const lh = parseFloat(cs.lineHeight);
  if (lh) options.lineSpacing = pt(lh);
  return options;
}

function textBoxOptions(box, cs, lines, extra) {
  // A one-line block must stay one line when PowerPoint's metrics run wider; a wrapped one gets slack.
  const wrap = lines > 1;
  const slack = wrap ? box.w * 0.06 : Math.max(box.w * 0.1, 40);
  const align = ALIGN[cs.textAlign] || "left";
  let x = box.x;
  if (align === "center") x -= slack / 2;
  if (align === "right") x -= slack;
  return {
    x: inch(x), y: inch(box.y), w: inch(box.w + slack), h: inch(box.h),
    margin: 0, valign: "top", fit: "none", wrap, paraSpaceBefore: 0, paraSpaceAfter: 0,
    ...paragraphOptions(cs), ...extra,
  };
}

class SlideWriter {
  constructor(pptx, slide, frame, warn, bulletColors) {
    this.pptx = pptx;
    // Pictures resolve asynchronously; every object takes its slot in DOM order so z-order holds.
    this.ops = [];
    const later = (name) => (...args) => this.ops.push(() => slide[name](...args));
    this.slide = { addShape: later("addShape"), addText: later("addText"), addTable: later("addTable") };
    this.real = slide;
    this.bulletColors = bulletColors;
    this.frame = frame;
    this.origin = frame.getBoundingClientRect();
    this.warn = warn;
    this.pending = [];
  }

  async write() {
    const cs = getComputedStyle(this.frame);
    const bg = color(cs.backgroundColor);
    if (bg) slideBackground = bg;
    if (bg) this.real.background = { color: bg.hex };
    this.decorate(this.frame, cs, 1, { skipFill: true });
    for (const child of this.frame.children) this.visit(child, 1);
    await Promise.all(this.pending);
    for (const op of this.ops) op?.();
  }

  reserve() {
    const at = this.ops.push(null) - 1;
    return (fn) => { this.ops[at] = fn; };
  }

  visit(el, parentOpacity) {
    if (SKIP.has(el.localName)) return;
    const cs = getComputedStyle(el);
    if (!visible(cs)) return;
    const opacity = parentOpacity * Number(cs.opacity);
    const name = el.localName;
    if (PICTURES.has(name)) return this.picture(el, cs, opacity);
    if (name === "table") return this.table(el, cs, opacity);
    this.decorate(el, cs, opacity);
    if ((name === "ul" || name === "ol") && this.list(el, cs, opacity)) return;
    if (name === "pre") return this.text(el, cs, opacity);
    if (hasText(el) && inlineOnly(el)) {
      for (const child of el.children) {
        const ccs = getComputedStyle(child);
        if (outOfFlow(ccs)) this.visit(child, opacity);
        else this.inlineBoxes(child, opacity);
      }
      return this.text(el, cs, opacity);
    }
    for (const node of el.childNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) this.visit(node, opacity);
      else if (node.nodeType === Node.TEXT_NODE && /\S/.test(node.data)) this.looseText(node, opacity);
    }
  }

  // Inline-block chips inside a text block keep their box.
  inlineBoxes(el, opacity) {
    const cs = getComputedStyle(el);
    if (!visible(cs)) return;
    if (cs.display !== "inline") this.decorate(el, cs, opacity * Number(cs.opacity));
    for (const child of el.children) this.inlineBoxes(child, opacity * Number(cs.opacity));
  }

  // Background, border and rules as native shapes; anything else visual as a rasterized picture.
  decorate(el, cs, opacity, { skipFill = false } = {}) {
    const box = boxOf(el, this.origin);
    if (box.w < 0.5 || box.h < 0.5) return;
    const complex = cs.backgroundImage !== "none" || (cs.maskImage && cs.maskImage !== "none") || (cs.webkitMaskImage && cs.webkitMaskImage !== "none") || cs.boxShadow !== "none" || cs.filter !== "none";
    if (complex) {
      this.warn("rasterized-decoration");
      this.pending.push(this.rasterDecoration(el, cs, box, opacity, this.reserve()));
      return;
    }
    const fill = skipFill ? null : color(cs.backgroundColor);
    const sides = ["Top", "Right", "Bottom", "Left"].map((side) => ({
      side,
      width: parseFloat(cs[`border${side}Width`]) || 0,
      color: cs[`border${side}Style`] === "none" ? null : color(cs[`border${side}Color`]),
    }));
    const drawn = sides.filter((s) => s.width > 0 && s.color);
    const uniform = drawn.length === 4 && drawn.every((s) => s.width === drawn[0].width && s.color.hex === drawn[0].color.hex);
    const radii = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"].map((c) => parseFloat(cs[`border${c}Radius`]) || 0);
    const radius = Math.min(Math.max(...radii), box.w / 2, box.h / 2);
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 ? color(cs.outlineColor) : null;
    if (fill || uniform) {
      const round = radius > 0.5;
      const shape = round && radius >= Math.min(box.w, box.h) / 2 - 0.5 && Math.abs(box.w - box.h) < 1 ? "ellipse" : round ? "roundRect" : "rect";
      const options = { x: inch(box.x), y: inch(box.y), w: inch(box.w), h: inch(box.h) };
      if (shape === "roundRect") options.rectRadius = inch(radius);
      options.fill = fill ? { color: fill.hex, transparency: transparency(fill.alpha, opacity) } : { type: "none" };
      if (uniform) options.line = { color: drawn[0].color.hex, width: pt(drawn[0].width), transparency: transparency(drawn[0].color.alpha, opacity) };
      else options.line = { type: "none" };
      if (radii.some((r) => Math.abs(r - radius) > 0.5) && round) this.warn("radius-approximated");
      this.slide.addShape(shape, options);
    }
    if (!uniform) {
      for (const s of drawn) {
        // A side border is a thin filled rectangle along that edge, which keeps its thickness exact.
        const r = {
          Top: { x: box.x, y: box.y, w: box.w, h: s.width },
          Bottom: { x: box.x, y: box.y + box.h - s.width, w: box.w, h: s.width },
          Left: { x: box.x, y: box.y, w: s.width, h: box.h },
          Right: { x: box.x + box.w - s.width, y: box.y, w: s.width, h: box.h },
        }[s.side];
        this.slide.addShape("rect", {
          x: inch(r.x), y: inch(r.y), w: inch(r.w), h: inch(r.h),
          fill: { color: s.color.hex, transparency: transparency(s.color.alpha, opacity) }, line: { type: "none" },
        });
      }
    }
    if (outline && !uniform && !fill) this.warn("outline-dropped");
  }

  async rasterDecoration(el, cs, box, opacity, put) {
    const props = ["background-color", "background-image", "background-size", "background-position", "background-repeat",
      "border-radius", "border", "box-shadow", "mask", "-webkit-mask", "mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size",
      "mask-position", "-webkit-mask-position", "mask-repeat", "-webkit-mask-repeat", "filter"];
    const style = props.map((p) => `${p}:${cs.getPropertyValue(p)}`).filter((d) => !/:\s*$/.test(d)).join(";");
    const pad = cs.boxShadow !== "none" ? 40 : 0;
    const bgUrls = [...cs.backgroundImage.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);
    let css = style;
    // An image that cannot be fetched (cross-origin without CORS, gone) is left out; the rest of the
    // decoration, such as a gradient over it, is still drawn.
    for (const url of bgUrls) {
      const data = await dataUrl(url);
      if (data) css = css.replaceAll(url, data);
      else {
        css = css.replaceAll(`url("${url}")`, "none");
        this.warn("image-unavailable");
      }
    }
    // Large decorations are smooth gradients; 1x keeps the file small.
    const scale = box.w * box.h > 400000 ? 1 : 2;
    const picture = await rasterize(`<div xmlns="http://www.w3.org/1999/xhtml" style="position:absolute;left:${pad}px;top:${pad}px;width:${box.w}px;height:${box.h}px;${escapeAttr(css)}"></div>`, box.w + pad * 2, box.h + pad * 2, scale);
    if (!picture) {
      this.warn("raster-failed");
      return;
    }
    put(() => this.real.addImage({ data: picture, x: inch(box.x - pad), y: inch(box.y - pad), w: inch(box.w + pad * 2), h: inch(box.h + pad * 2), transparency: Math.round((1 - opacity) * 100) || undefined }));
  }

  text(el, cs, opacity) {
    const runs = trimRuns(collectRuns(el, opacity, []));
    if (!runs.some((r) => r.text.trim())) return;
    const box = contentBox(el, cs, this.origin);
    const info = lineInfo(el);
    if (el.localName !== "pre" && info.lines > 1 && info.width < box.w) {
      const align = ALIGN[cs.textAlign] || "left";
      if (align === "center") box.x += (box.w - info.width) / 2;
      if (align === "right") box.x += box.w - info.width;
      if (align !== "justify") box.w = info.width;
    }
    this.slide.addText(runs, textBoxOptions(box, cs, el.localName === "pre" ? 2 : info.lines));
  }

  looseText(node, opacity) {
    const parent = node.parentElement;
    const cs = getComputedStyle(parent);
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    const text = transform(node.data.replace(/\s+/g, " ").trim(), cs);
    if (!text || r.width < 1) return;
    const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    const box = { x: r.left - this.origin.left, y: r.top - this.origin.top, w: r.width, h: r.height };
    this.slide.addText([{ text, options: runOptions(cs, parent, opacity) }], textBoxOptions(box, cs, lines));
  }

  // A plain bulleted or numbered list as one native text box with one paragraph per item.
  list(el, cs, opacity) {
    if (!cs.display.includes("flex") || cs.flexDirection !== "column") return false;
    const items = [];
    const walk = (list, level, listOpacity) => {
      const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
      for (const li of list.children) {
        if (li.localName !== "li") return false;
        const lcs = getComputedStyle(li);
        if (!visible(lcs)) continue;
        const nested = [...li.children].filter((c) => c.localName === "ul" || c.localName === "ol");
        const marker = li.querySelector(":scope > [data-pptx-pseudo=before]");
        if ([...li.children].some((c) => !nested.includes(c) && c !== marker && !c.matches("[data-pptx-pseudo]") && !getComputedStyle(c).display.startsWith("inline"))) return false;
        // collectRuns needs live computed styles, so the item's own content is walked in place, skipping nested lists.
        const runs = [];
        const state = { space: true };
        for (const node of li.childNodes) {
          if (nested.includes(node) || node === marker || (node.nodeType === 1 && node.matches("[data-pptx-pseudo]"))) continue;
          collectRuns({ childNodes: [node] }, listOpacity * Number(lcs.opacity), runs, state);
        }
        trimRuns(runs);
        if (!runs.length) runs.push({ text: "", options: runOptions(lcs, li, listOpacity) });
        const indent = parseFloat(lcs.paddingLeft) || 0;
        const ordered = list.localName === "ol";
        const mcs = marker && getComputedStyle(marker);
        const check = mcs && mcs.maskImage && mcs.maskImage !== "none";
        const bullet = indent < 1 || !marker ? false : ordered ? { type: "number", style: "arabicPeriod", indent: pt(indent) } : { characterCode: check ? "2713" : level ? "25E6" : "2013", indent: pt(indent) };
        if (bullet) {
          const markerColor = color(ordered || mcs.backgroundColor === "rgba(0, 0, 0, 0)" ? (mcs.borderTopWidth !== "0px" && !ordered ? mcs.borderTopColor : mcs.color) : mcs.backgroundColor);
          this.bulletColors.push(markerColor?.hex || null);
        }
        // PptxGenJS starts a paragraph wherever align changes, so every run of an item carries it.
        for (const run of runs) Object.assign(run.options, paragraphOptions(lcs));
        Object.assign(runs[0].options, { bullet, indentLevel: level, paraSpaceAfter: pt(gap) });
        runs[runs.length - 1].options.breakLine = true;
        items.push(...runs);
        for (const sub of nested) {
          if (walk(sub, level + 1, listOpacity * Number(lcs.opacity)) === false) return false;
        }
      }
      return true;
    };
    if (walk(el, 0, opacity) === false) return false;
    const last = items[items.length - 1];
    if (last) delete last.options.breakLine;
    const box = boxOf(el, this.origin);
    this.slide.addText(items, { ...textBoxOptions(box, cs, 2), w: inch(box.w * 1.03) });
    return true;
  }

  table(el, cs, opacity) {
    const box = boxOf(el, this.origin);
    const rows = [];
    const colW = [];
    const rowH = [];
    for (const tr of el.querySelectorAll("tr")) {
      const row = [];
      rowH.push(inch(tr.getBoundingClientRect().height));
      [...tr.cells].forEach((cell, i) => {
        const ccs = getComputedStyle(cell);
        if (rows.length === 0 || colW[i] == null) colW[i] = inch(cell.getBoundingClientRect().width);
        const runs = trimRuns(collectRuns(cell, opacity, []));
        const fill = color(ccs.backgroundColor);
        const border = ["Top", "Right", "Bottom", "Left"].map((side) => {
          const w = parseFloat(ccs[`border${side}Width`]) || 0;
          const c = color(ccs[`border${side}Color`]);
          return w && c && ccs[`border${side}Style`] !== "none" ? { type: "solid", pt: pt(w), color: c.hex } : { type: "none" };
        });
        row.push({
          text: runs.length ? runs : "",
          options: {
            ...paragraphOptions(ccs),
            valign: ccs.verticalAlign === "middle" ? "middle" : ccs.verticalAlign === "bottom" ? "bottom" : "top",
            fill: fill ? { color: fill.hex } : undefined,
            border,
            margin: [inch(parseFloat(ccs.paddingTop)), inch(parseFloat(ccs.paddingRight)), inch(parseFloat(ccs.paddingBottom)), inch(parseFloat(ccs.paddingLeft))],
            colspan: cell.colSpan > 1 ? cell.colSpan : undefined,
            rowspan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          },
        });
      });
      rows.push(row);
    }
    if (!rows.length) return;
    this.slide.addTable(rows, { x: inch(box.x), y: inch(box.y), w: inch(box.w), colW, rowH, autoPage: false });
  }

  picture(el, cs, opacity) {
    const box = contentBox(el, cs, this.origin);
    if (box.w < 1 || box.h < 1) return;
    const name = el.localName;
    if ((name === "iframe" && !el.getAttribute("data-poster")) || (name === "video" && !el.getAttribute("poster"))) {
      this.decorate(el, cs, opacity);
      this.warn("app-without-poster");
      return;
    }
    const put = this.reserve();
    const job = (async () => {
      let data = null;
      let sizing;
      if (name === "img") {
        data = await imageData(el);
        const fit = cs.objectFit;
        if ((fit === "cover" || fit === "contain") && el.naturalWidth && el.naturalHeight) {
          sizing = { type: fit, w: inch(box.w), h: inch(box.h), natural: { w: el.naturalWidth, h: el.naturalHeight } };
        }
      } else if (name === "svg") {
        data = svgData(el, box);
      } else if (name === "iframe" || name === "video") {
        const poster = name === "iframe" ? el.getAttribute("data-poster") : el.getAttribute("poster");
        if (poster) {
          data = await dataUrl(new URL(poster, location.href).href);
          const probe = new Image();
          probe.src = data;
          await probe.decode().catch(() => {});
          if (probe.naturalWidth) sizing = { type: "cover", w: inch(box.w), h: inch(box.h), natural: { w: probe.naturalWidth, h: probe.naturalHeight } };
        } else {
          return;
        }
      } else if (name === "canvas") {
        data = el.toDataURL("image/png");
      }
      if (!data) {
        this.warn("picture-failed");
        return;
      }
      const radius = parseFloat(cs.borderTopLeftRadius) || 0;
      const options = { data, x: inch(box.x), y: inch(box.y), w: inch(box.w), h: inch(box.h) };
      // object-fit is baked into the picture: LibreOffice ignores the crop rectangle on SVG pictures.
      if (sizing) {
        options.data = await fitImage(data, sizing.natural, box, sizing.type);
        this.warn("image-fit-baked");
      }
      if (opacity < 1) options.transparency = Math.round((1 - opacity) * 100);
      if (radius) options.rounding = false; // PptxGenJS can only round to a full ellipse; corners stay square.
      if (radius) this.warn("image-radius-dropped");
      const app = name === "iframe" ? appLink(el) : null;
      if (app) options.hyperlink = { url: app, tooltip: el.getAttribute("title") || app };
      put(() => this.real.addImage(options));
    })();
    this.pending.push(job);
  }
}

function escapeAttr(text) {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

async function dataUrl(url) {
  if (/^data:[^,]*;base64,/i.test(url)) return url;
  const response = await fetch(url, { credentials: "same-origin" }).catch(() => null); // refused: the caller warns
  const blob = response?.ok ? await response.blob() : null;
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function fitImage(data, natural, box, fit) {
  const img = new Image();
  img.src = data;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(box.w);
  canvas.height = Math.round(box.h);
  const scale = (fit === "cover" ? Math.max : Math.min)(box.w / natural.w, box.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  canvas.getContext("2d").drawImage(img, (box.w - w) / 2, (box.h - h) / 2, w, h);
  return canvasData(canvas);
}

// JPEG is several times smaller for photos and full-slide gradients; any transparent pixel keeps PNG.
function canvasData(canvas) {
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return canvas.toDataURL("image/png");
  return canvas.toDataURL("image/jpeg", 0.9);
}

// The address of a still app frame, absolute, for http(s) apps only.
function appLink(iframe) {
  const src = iframe.getAttribute("data-app-src");
  if (!src) return null;
  const url = new URL(src, location.href);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
}

async function imageData(img) {
  const src = img.currentSrc || img.src;
  if (!src) return null;
  const data = await dataUrl(src);
  if (!data || !/^data:image\/svg/i.test(data)) return data;
  return data; // PptxGenJS writes SVG with its own PNG preview.
}

const SVG_PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
  "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor", "dominant-baseline", "letter-spacing", "color", "stop-color", "stop-opacity", "visibility", "display"];

// Inline SVG uses the deck's CSS variables and classes, which a standalone file does not have, so
// every computed paint property is written onto the copy as a presentation attribute.
function svgData(svg, box) {
  const copy = svg.cloneNode(true);
  const live = [svg, ...svg.querySelectorAll("*")];
  const dead = [copy, ...copy.querySelectorAll("*")];
  live.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dead[i];
    for (const prop of SVG_PROPS) {
      let value = cs.getPropertyValue(prop);
      if (!value) continue;
      if (prop === "fill" || prop === "stroke" || prop === "stop-color" || prop === "color") {
        if (value.startsWith("url(")) value = value.replace(/url\("?[^#]*(#[^")]+)"?\)/, "url($1)");
        else if (value !== "none") {
          const c = color(value);
          value = c ? `#${c.hex}` : "none";
          if (c && c.alpha < 1) target.setAttribute(`${prop === "stop-color" ? "stop" : prop}-opacity`, String(c.alpha));
        }
      }
      if (prop === "font-family") value = value.split(",")[0].trim();
      target.setAttribute(prop, value);
    }
    target.removeAttribute("class");
    target.removeAttribute("style");
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(Math.round(box.w)));
  copy.setAttribute("height", String(Math.round(box.h)));
  if (!copy.getAttribute("viewBox")) copy.setAttribute("viewBox", `0 0 ${box.w} ${box.h}`);
  const xml = new XMLSerializer().serializeToString(copy);
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
}

async function rasterize(html, w, h, scale = 2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${html}</foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return canvasData(canvas);
  } catch {
    return null; // reported by the caller as raster-failed
  }
}

// `deck` gives the title, language and slide ids; `mountStill(index, host)` builds and mounts a still
// frame into the host and returns its notes; `onProgress(done, total)` follows each slide.
export async function buildPptx({ PptxGenJS, JSZip, deck, mountStill, waitForMedia, onProgress }) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = deck.title || "Slides";
  if (deck.lang) pptx.lang = deck.lang;
  const stage = document.createElement("div");
  stage.style.cssText = "position:fixed;left:-30000px;top:0;width:1920px;height:1080px;overflow:hidden;";
  document.body.append(stage);
  const warnings = new Map(); // code -> slide ids
  const bulletsBySlide = [];
  try {
    await document.fonts.ready;
    for (let index = 0; index < deck.ids.length; index += 1) {
      const id = deck.ids[index];
      const warn = (code) => {
        if (!warnings.has(code)) warnings.set(code, new Set());
        warnings.get(code).add(id);
      };
      const host = document.createElement("div");
      host.className = "slide-host";
      host.style.cssText = "width:1920px;height:1080px;";
      stage.replaceChildren(host);
      const { notes } = mountStill(index, host);
      const frame = host.shadowRoot.querySelector(".frame");
      await waitForMedia(frame);
      materializePseudos(frame, host.shadowRoot);
      const slide = pptx.addSlide();
      const bulletColors = [];
      await new SlideWriter(pptx, slide, frame, warn, bulletColors).write();
      bulletsBySlide.push(bulletColors);
      if (notes) slide.addNotes(notes);
      onProgress(index + 1, deck.ids.length);
    }
    const bytes = await fixPptxXml(JSZip, await pptx.write({ outputType: "arraybuffer", compression: true }), bulletsBySlide);
    return { bytes, warnings: [...warnings].map(([code, slides]) => ({ code, slides: [...slides] })) };
  } finally {
    stage.remove();
  }
}

// Fixes for PptxGenJS 4.0.1 output: it has no bullet color, so <a:buClr> is added in paragraph order;
// it writes startAt="1" on every numbered paragraph, which LibreOffice reads as a restart; and it writes
// a <a:pPr> before every run with paragraph options, which is invalid OOXML (PowerPoint offers to
// repair the file, LibreOffice drops the first bullet), so only the first one of a paragraph is kept.
// It also writes a media file per use, so identical pictures (a title glow on every section slide)
// are stored once and every slide points at the first copy.
async function fixPptxXml(JSZip, bytes, bulletsBySlide) {
  const zip = await JSZip.loadAsync(bytes);
  const firstCopy = new Map(); // content -> media name
  const sameAs = new Map(); // duplicate media name -> first copy
  for (const name of Object.keys(zip.files).filter((file) => /^ppt\/media\/[^/]+$/.test(file)).sort()) {
    const content = await zip.file(name).async("base64");
    if (firstCopy.has(content)) sameAs.set(name, firstCopy.get(content));
    else firstCopy.set(content, name);
  }
  for (const name of sameAs.keys()) zip.remove(name);
  for (const name of Object.keys(zip.files).filter((file) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(file))) {
    const rels = await zip.file(name).async("string");
    const fixed = rels.replace(/Target="\.\.\/(media\/[^"]+)"/g, (m, media) => (sameAs.has(`ppt/${media}`) ? `Target="../${sameAs.get(`ppt/${media}`).slice(4)}"` : m));
    if (fixed !== rels) zip.file(name, fixed);
  }
  for (let i = 0; i < bulletsBySlide.length; i += 1) {
    const file = zip.file(`ppt/slides/slide${i + 1}.xml`);
    if (!file) continue;
    const colors = bulletsBySlide[i];
    let n = 0;
    const xml = (await file.async("string"))
      .replace(/<a:buSzPct val="100000"\/>(?=<a:bu(?:Char|Font|AutoNum))/g, (m) => {
        const hex = colors[n++];
        return hex ? `<a:buClr><a:srgbClr val="${hex}"/></a:buClr>${m}` : m;
      })
      .replace(/ startAt="1"/g, "")
      .replace(/<a:p>([\s\S]*?)<\/a:p>/g, (m, inner) => {
        let seen = false;
        return `<a:p>${inner.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (pPr) => (seen ? "" : ((seen = true), pPr)))}</a:p>`;
      });
    zip.file(`ppt/slides/slide${i + 1}.xml`, xml);
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
