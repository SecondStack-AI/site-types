// Release check for the Slides viewer. For every sample deck under checks/decks/ it serves the candidate
// package (slides/) the way Spot serves a typed site and:
//   - runs check mode and compares the report with the deck's check.json: no errors, and exactly the
//     expected warnings, sanitizer removals included;
//   - fails on any script execution marker: a window property starting with __exec, a request to
//     /api/probe, or a request to probe.invalid;
//   - screenshots every slide on the stage and in print, light and dark, and compares each screenshot
//     with the same deck rendered by the previous release (the highest slides-v* tag at or below the
//     candidate version) in the same browser.
// It also checks the version: viewer.js TYPE_VERSION equals type.json, and changed package bytes come
// with a higher version than the baseline tag and the --base ref.
//
//   node checks/run.mjs [--deck <name>]... [--baseline <git ref>|none] [--base <git ref>] [--save]
//
// --save writes every candidate screenshot to checks/out/shots/. Failing screenshots always go to
// checks/out/diff/<key>/ as baseline.png, candidate.png and diff.png.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serveSite } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TYPE = "slides";
const CANDIDATE_DIR = path.join(ROOT, TYPE);
const DECKS_DIR = path.join(HERE, "decks");
const OUT_DIR = path.join(HERE, "out");
const SCHEMES = ["light", "dark"];
const VIEWPORT = { width: 1920, height: 1080 };
// A pixel differs when one of its channels moves by more than PIXEL_TOLERANCE; a screenshot fails when
// more than MAX_DIFF_RATIO of its pixels differ. Both renders come from the same browser in one run, so
// an unchanged viewer gives identical bytes.
const PIXEL_TOLERANCE = 2;
const MAX_DIFF_RATIO = 0.0005;
const MARKER_PREFIX = "__exec";
const PROBE_HOST = "probe.invalid";
// The toolbar and progress bar float over the stage; they are viewer chrome, not slide rendering.
const HIDE_CHROME = ".toolbar, .progress { display: none !important; }";
const CORS = { "Access-Control-Allow-Origin": "*" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function parseArgs(argv) {
  const opts = { decks: [], baseline: null, base: null, save: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deck") opts.decks.push(argv[++i]);
    else if (arg === "--baseline") opts.baseline = argv[++i];
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--save") opts.save = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

// SemVer 2.0 precedence; build metadata is dropped, as in the registry.
function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text));
  if (!match) return null;
  return { major: +match[1], minor: +match[2], patch: +match[3], pre: match[4] ? match[4].split(".") : [], text: String(text).replace(/\+.*$/, "") };
}

function compareVersions(a, b) {
  for (const key of ["major", "minor", "patch"]) if (a[key] !== b[key]) return a[key] - b[key];
  if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (!nx && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function packageChangedSince(ref) {
  try {
    execFileSync("git", ["diff", "--quiet", ref, "--", TYPE], { cwd: ROOT, stdio: "ignore" });
  } catch (error) {
    if (error.status === 1) return true;
    throw error;
  }
  return git("ls-files", "--others", "--exclude-standard", "--", TYPE) !== "";
}

function versionAt(ref) {
  return parseVersion(JSON.parse(git("show", `${ref}:${TYPE}/type.json`)).version);
}

// An installed version never changes: Reload refuses different bytes under a version it already has.
function checkVersion(candidate, label, ref, failures) {
  const previous = versionAt(ref);
  const order = compareVersions(candidate, previous);
  if (order < 0) failures.push(`type.json version ${candidate.text} is lower than ${previous.text} at ${label} ${ref}`);
  else if (order === 0 && packageChangedSince(ref)) {
    failures.push(`${TYPE}/ differs from ${label} ${ref} but type.json is still ${candidate.text}: bump the version in type.json and viewer.js`);
  }
}

function pickBaseline(candidate) {
  let best = null;
  for (const tag of git("tag", "--list", `${TYPE}-v*`).split("\n").filter(Boolean)) {
    const version = parseVersion(tag.slice(TYPE.length + 2));
    if (!version || compareVersions(version, candidate) > 0) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

async function extractPackage(ref) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slides-baseline-"));
  const tar = execFileSync("git", ["archive", "--format=tar", ref, TYPE], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return { root: dir, packageDir: path.join(dir, TYPE) };
}

async function loadDecks(only) {
  const entries = await readdir(DECKS_DIR, { withFileTypes: true });
  const decks = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (only.length && !only.includes(entry.name)) continue;
    const dir = path.join(DECKS_DIR, entry.name);
    const deck = JSON.parse(await readFile(path.join(dir, "project", "deck.json"), "utf8"));
    const expectFile = path.join(dir, "check.json");
    const expect = existsSync(expectFile) ? JSON.parse(await readFile(expectFile, "utf8")) : {};
    decks.push({ name: entry.name, dir, order: deck.order, expect });
  }
  for (const name of only) if (!decks.some((deck) => deck.name === name)) throw new Error(`no deck named ${name} in ${DECKS_DIR}`);
  return decks;
}

// Check-mode issue messages are text; the comparable parts are the code, the removed items (a tag
// such as <script>, an attribute name, or a phrase from the URL hook) and a declaration count.
function removedItems(message) {
  const list = message.slice(message.indexOf("): ") + 3);
  const items = [];
  for (const part of list.split(", ")) {
    if (/^<[\w-]+>$/.test(part) || /^[\w:-]+="/.test(part) || /^style declaration/.test(part)) items.push(part);
    else if (items.length) items[items.length - 1] += `, ${part}`;
  }
  return [...new Set(items.map((item) => (item.startsWith("<") ? item : item.startsWith("style declaration") ? "style declaration" : item.slice(0, item.indexOf("=")))))].sort();
}

function describeIssue(item) {
  if (item.code === "unsafe-removed") return { code: item.code, removed: removedItems(item.message), message: item.message };
  if (item.code === "css-url-removed") return { code: item.code, count: Number.parseInt(item.message, 10), message: item.message };
  return { code: item.code, message: item.message };
}

function formatIssue(issue) {
  return `${issue.code}${issue.removed ? ` [${issue.removed.join(", ")}]` : ""}${issue.count != null ? ` (${issue.count})` : ""}`;
}

function sameIssue(expected, actual) {
  if (expected.code !== actual.code) return false;
  if (expected.removed && expected.removed.join("\n") !== actual.removed?.join("\n")) return false;
  if (expected.count != null && expected.count !== actual.count) return false;
  return true;
}

// Every issue must be expected, and every expected issue must occur. Errors are expected only where a
// payload deck needs them (an image whose src the sanitizer removed cannot load).
function compareIssues(file, issues, expected, expectedErrors, problems) {
  const errorCodes = [...expectedErrors];
  for (const item of issues.filter((issue) => issue.level === "error")) {
    const at = errorCodes.indexOf(item.code);
    if (at >= 0) errorCodes.splice(at, 1);
    else problems.push(`${file}: error ${item.code}: ${item.message}`);
  }
  for (const code of errorCodes) problems.push(`${file}: expected error ${code} did not occur`);
  const wanted = expected.map((entry) => {
    const issue = typeof entry === "string" ? { code: entry } : { ...entry };
    if (issue.code === "unsafe-removed" && !issue.removed) throw new Error(`${file}: an expected unsafe-removed warning must list "removed"`);
    if (issue.removed) issue.removed = [...issue.removed].sort();
    return issue;
  });
  for (const actual of issues.filter((item) => item.level !== "error").map(describeIssue)) {
    const at = wanted.findIndex((issue) => sameIssue(issue, actual));
    if (at >= 0) wanted.splice(at, 1);
    else problems.push(`${file}: unexpected warning ${formatIssue(actual)}: ${actual.message}`);
  }
  for (const issue of wanted) problems.push(`${file}: expected warning ${formatIssue(issue)} did not occur`);
}

function compareReport(report, deck, version) {
  const problems = [];
  if (report.type !== `${TYPE}@${version}`) problems.push(`check report type is ${report.type}, expected ${TYPE}@${version}`);
  if (!report.complete) problems.push("check mode reports the deck as incomplete");
  if (report.slides.length !== deck.order.length) problems.push(`check mode reports ${report.slides.length} slides, deck.json lists ${deck.order.length}`);
  compareIssues("project/deck.json", report.deck.issues, deck.expect.deckWarnings || [], [], problems);
  const warnings = deck.expect.warnings || {};
  const errors = deck.expect.errors || {};
  const notes = deck.expect.notes || {};
  const steps = deck.expect.steps || {};
  for (const slide of report.slides) {
    if ((slide.steps || 0) !== (steps[slide.id] || 0)) problems.push(`${slide.file}: check mode reports ${slide.steps ?? "no"} steps, check.json says ${steps[slide.id] || 0}`);
    compareIssues(slide.file, slide.issues, warnings[slide.id] || [], errors[slide.id] || [], problems);
    if (slide.notes !== slide.id in notes) problems.push(`${slide.file}: check mode says notes ${slide.notes ? "present" : "absent"}, check.json says ${slide.id in notes ? "present" : "absent"}`);
  }
  for (const id of [...Object.keys(warnings), ...Object.keys(errors), ...Object.keys(notes), ...Object.keys(steps)]) {
    if (!deck.order.includes(id)) problems.push(`check.json names ${id}, which is not in deck.json order`);
  }
  return problems;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// No request leaves the machine. Google Fonts URLs get the fonts vendored in the package the context
// serves, documents (embeds, popups) get a stub page, and probe.invalid is an execution marker.
async function fulfilExternal(route, record, packageDir) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.hostname === PROBE_HOST) {
    record.markers.push(`request to ${url.href}`);
    return route.abort();
  }
  if (url.hostname === "fonts.googleapis.com" && url.pathname === "/css2") {
    const family = (url.searchParams.get("family") || "").split(":")[0].replace(/["\\]/g, "");
    const body = `@font-face { font-family: "${family}"; font-weight: 100 900; src: url(https://fonts.gstatic.com/s/corpus/inter-latin-standard-italic.woff2) format("woff2"); }`;
    return route.fulfill({ status: 200, contentType: "text/css", headers: CORS, body });
  }
  if (url.hostname === "fonts.gstatic.com" && url.pathname.startsWith("/s/corpus/")) {
    const body = await readFile(path.join(packageDir, "fonts", path.basename(url.pathname))).catch(() => null);
    return route.fulfill(body ? { status: 200, contentType: "font/woff2", headers: CORS, body } : { status: 404, headers: CORS, body: "" });
  }
  if (request.resourceType() === "document") {
    const body = `<!doctype html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#dee2e6;color:#343a40;font:40px/1.2 sans-serif">External page ${escapeHtml(url.host + url.pathname)}</body>`;
    return route.fulfill({ status: 200, contentType: "text/html", body });
  }
  return route.fulfill({ status: 404, body: "" });
}

async function newContext(browser, record, packageDir) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" });
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => fulfilExternal(route, record, packageDir));
  context.on("page", (page) => watchPage(page, record));
  return context;
}

// Records page errors and console errors, and counts requests in flight so a screenshot waits for
// images, fonts and frames. A missing file shows up in the server log, so resource errors are skipped.
function watchPage(page, record) {
  const net = { inflight: 0, last: Date.now() };
  page.on("pageerror", (error) => record.errors.push(`page error at ${page.url()}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) record.errors.push(`console error at ${page.url()}: ${message.text()}`);
  });
  page.on("request", () => { net.inflight += 1; net.last = Date.now(); });
  const done = () => { net.inflight -= 1; net.last = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.net = net;
  page.record = record;
}

async function settle(page) {
  const start = Date.now();
  while ((page.net.inflight > 0 || Date.now() - page.net.last < 150) && Date.now() - start < 15000) await sleep(25);
  await page.evaluate(async () => {
    const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frames();
    await document.fonts.ready;
    const roots = [document, ...[...document.querySelectorAll("*")].filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
    await Promise.all(roots.flatMap((root) => [...root.querySelectorAll("img")]).map((img) => img.decode().catch(() => {})));
    await frames();
  });
}

async function collectMarkers(page) {
  for (const frame of page.frames()) {
    const keys = await frame.evaluate((prefix) => Object.keys(window).filter((key) => key.startsWith(prefix)), MARKER_PREFIX).catch(() => []);
    for (const key of keys) page.record.markers.push(`${key} set in ${frame.url()}`);
  }
}

// Markers live in the page, so they are read before every close.
async function closePage(page) {
  await collectMarkers(page);
  await page.close();
}

async function openDeck(context, site, query, id) {
  const page = await context.newPage();
  await page.goto(`${site.url}/${query}#${id}`);
  await page.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
  return page;
}

// Sets the hash and waits until the viewer has handled it. `target` is a slide id, or "<id>.<step>".
async function showSlide(page, target, index, selector, prefix) {
  await page.evaluate((hash) => new Promise((resolve) => {
    if (decodeURIComponent(location.hash.slice(1)) === hash) return resolve();
    addEventListener("hashchange", () => requestAnimationFrame(() => resolve()), { once: true });
    location.hash = hash;
  }), target);
  await page.waitForFunction(([sel, text]) => (document.querySelector(sel)?.getAttribute("aria-label") ?? document.querySelector(sel)?.textContent ?? "").startsWith(text), [selector, prefix(index)]);
}

async function runCheckMode(context, site) {
  const page = await context.newPage();
  await page.goto(`${site.url}/?check=1`);
  await page.waitForFunction(() => document.documentElement.dataset.slidesCheck === "done", null, { timeout: 90000 });
  const report = await page.evaluate(() => window.slidesCheck);
  await closePage(page);
  return report;
}

// The stage states of a deck in presentation order: every step of every slide. A slide's last state,
// with every step shown, is "<deck>/<id>/stage/<scheme>", the key a viewer without builds produces.
function stageStates(deck, steps) {
  return deck.order.flatMap((id, index) => Array.from({ length: (steps[index] || 0) + 1 }, (_, step) => ({
    id,
    index,
    hash: step ? `${id}.${step}` : id,
    key: step === (steps[index] || 0) ? `${deck.name}/${id}/stage` : `${deck.name}/${id}/stage-step-${step}`,
  })));
}

async function stageShot(page) {
  return page.locator(".stage .slide-host").screenshot({ animations: "disabled", caret: "hide" });
}

async function stageShots(context, site, deck, steps, scheme, shots) {
  const page = await openDeck(context, site, `?theme=${scheme}`, deck.order[0]);
  await page.addStyleTag({ content: HIDE_CHROME });
  for (const state of stageStates(deck, steps)) {
    await showSlide(page, state.hash, state.index, ".stage", (i) => `Slide ${i + 1} of `);
    await settle(page);
    shots.set(`${state.key}/${scheme}`, await stageShot(page));
  }
  await closePage(page);
}

// Builds: → and ← walk every step in the presenter window and the audience follows, both ways; the
// presenter shows "Step n of N"; each state's deep link renders as the stage did when it walked there.
async function navigate(context, site, deck, steps, shots, diff, problems) {
  const states = stageStates(deck, steps);
  const audience = await openDeck(context, site, "?theme=light", deck.order[0]);
  await audience.addStyleTag({ content: HIDE_CHROME });
  const presenter = await openDeck(context, site, "?presenter=1", deck.order[0]);
  const expectState = async (state, label) => {
    const want = state.hash;
    try {
      await Promise.all([audience, presenter].map((page) => page.waitForFunction((hash) => decodeURIComponent(location.hash.slice(1)) === hash, want, { timeout: 5000 })));
    } catch {
      problems.push(`${label}: expected #${want}, presenter at #${await hashOf(presenter)}, audience at #${await hashOf(audience)}`);
      return false;
    }
    const count = steps[state.index] || 0;
    const step = Number(want.split(".")[1] || 0);
    const shown = (await presenter.locator(".pv-step").textContent()) || "";
    const expected = count ? `Step ${step} of ${count}` : "";
    if (shown !== expected) problems.push(`${label}: presenter shows ${JSON.stringify(shown)} at #${want}, expected ${JSON.stringify(expected)}`);
    return true;
  };
  for (let i = 1; i < states.length; i += 1) {
    await presenter.keyboard.press("ArrowRight");
    if (!(await expectState(states[i], "→ in the presenter window"))) break;
  }
  await presenter.keyboard.press("ArrowRight");
  await expectState(states.at(-1), "→ at the end");
  for (let i = states.length - 2; i >= 0; i -= 1) {
    await audience.keyboard.press("ArrowLeft");
    if (!(await expectState(states[i], "← in the audience window"))) break;
  }
  await closePage(presenter);
  for (const state of states) {
    await audience.goto(`${site.url}/?theme=light#${state.hash}`);
    await audience.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
    await audience.addStyleTag({ content: HIDE_CHROME });
    if ((await hashOf(audience)) !== state.hash) problems.push(`deep link #${state.hash} ended at #${await hashOf(audience)}`);
    await settle(audience);
    const walked = shots.get(`${state.key}/light`);
    const { ratio } = await diff(walked, await stageShot(audience), false);
    if (ratio > MAX_DIFF_RATIO) problems.push(`deep link #${state.hash} renders differently from walking there (${(ratio * 100).toFixed(3)}% of pixels)`);
  }
  await closePage(audience);
}

async function printShots(context, site, deck, scheme, shots, problems) {
  const page = await openDeck(context, site, `?theme=${scheme}`, deck.order[0]);
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => dispatchEvent(new Event("beforeprint")));
  await settle(page);
  const pages = page.locator("#print-root .print-page");
  const count = await pages.count();
  if (count !== deck.order.length) problems?.push(`print has ${count} pages, deck.json lists ${deck.order.length} slides`);
  for (let i = 0; i < Math.min(count, deck.order.length); i += 1) {
    shots.set(`${deck.name}/${deck.order[i]}/print/${scheme}`, await pages.nth(i).screenshot({ animations: "disabled" }));
  }
  // The real PDF, so a change in @page or page breaking that splits or merges pages shows up.
  if (problems) {
    const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString("latin1");
    const pdfPages = pdf.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
    if (pdfPages !== deck.order.length) problems.push(`the ${scheme} PDF has ${pdfPages} pages, deck.json lists ${deck.order.length} slides`);
  }
  await closePage(page);
}

const hashOf = (page) => page.evaluate(() => decodeURIComponent(location.hash.slice(1)));
const textIs = (page, selector, text) => page.waitForFunction(([sel, want]) => document.querySelector(sel)?.textContent === want, [selector, text], { timeout: 5000 }).then(() => true, () => false);
const hashIs = (page, hash) => page.waitForFunction((want) => decodeURIComponent(location.hash.slice(1)) === want, hash, { timeout: 5000 }).then(() => true, () => false);

// The presenter window follows the audience window over the BroadcastChannel, and the audience follows
// the presenter back; the notes are read on the way.
async function presenterSync(context, site, deck, problems) {
  const notes = deck.expect.notes || {};
  const total = deck.order.length;
  const audience = await openDeck(context, site, "", deck.order[0]);
  const presenter = await openDeck(context, site, "?presenter=1", deck.order[0]);
  for (const [index, id] of deck.order.entries()) {
    await showSlide(audience, id, index, ".stage", (i) => `Slide ${i + 1} of `);
    if (!(await textIs(presenter, ".pv-counter", `${index + 1} / ${total}`))) {
      problems.push(`presenter did not follow the audience to ${id}: it shows ${await presenter.locator(".pv-counter").textContent()}`);
      break;
    }
    const shown = await presenter.locator(".pv-notes-text").textContent();
    const expected = notes[id] ?? "No notes for this slide.";
    if (shown !== expected) problems.push(`presenter notes for ${id}: ${JSON.stringify(shown)}, expected ${JSON.stringify(expected)}`);
  }
  for (let index = total - 2; index >= 0; index -= 1) {
    await showSlide(presenter, deck.order[index], index, ".pv-counter", (i) => `${i + 1} / `);
    if (!(await hashIs(audience, deck.order[index]))) {
      problems.push(`audience did not follow the presenter to ${deck.order[index]}: it is at #${await hashOf(audience)}`);
      break;
    }
  }
  await closePage(presenter);
  await closePage(audience);
}

// Keyboard on the audience view: → walks every step of the deck and the counter and hash follow; a
// step announces what it revealed in the live region, and waiting steps are inert. O opens the overview
// with every slide and the current one marked, and Escape closes it.
async function interact(context, site, deck, steps, problems) {
  const total = deck.order.length;
  const page = await openDeck(context, site, "", deck.order[0]);
  for (const state of stageStates(deck, steps).slice(1)) {
    await page.keyboard.press("ArrowRight");
    if (!(await textIs(page, ".counter", `${state.index + 1} / ${total}`)) || !(await hashIs(page, state.hash))) {
      problems.push(`→ to #${state.hash}: counter shows ${await page.locator(".counter").textContent()}, hash is #${await hashOf(page)}`);
      break;
    }
    const step = await page.evaluate(() => {
      const root = document.querySelector(".stage .slide-host").shadowRoot;
      const items = [...root.querySelectorAll("[data-step]")];
      return {
        sectionHidden: Boolean(root.querySelector(".frame > section")?.hasAttribute("data-step-hidden")),
        live: document.querySelector("#app [aria-live]")?.textContent ?? "",
        hiddenNotInert: items.filter((el) => el.hasAttribute("data-step-hidden") && !el.hasAttribute("inert")).length,
        shownInert: items.filter((el) => !el.hasAttribute("data-step-hidden") && el.hasAttribute("inert")).length,
      };
    });
    const announce = deck.expect.announce?.[state.hash];
    if (announce !== undefined && step.live !== announce) problems.push(`→ to #${state.hash}: the live region says ${JSON.stringify(step.live)}, expected ${JSON.stringify(announce)}`);
    else if (state.hash.includes(".") && (!step.live || step.live.startsWith("Slide "))) problems.push(`→ to #${state.hash}: the live region says ${JSON.stringify(step.live)}, not what the step revealed`);
    if (step.sectionHidden) problems.push(`#${state.hash}: the slide's own section is hidden as a step`);
    if (step.hiddenNotInert || step.shownInert) problems.push(`#${state.hash}: ${step.hiddenNotInert} waiting step(s) not inert, ${step.shownInert} shown step(s) inert`);
  }
  await page.keyboard.press("o");
  const overview = page.locator("dialog.overview[open]");
  if (await overview.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    const items = await overview.locator(".ov-item").count();
    const current = await overview.locator('.ov-item[aria-current="true"]').getAttribute("data-index").catch(() => null);
    if (items !== total) problems.push(`the overview lists ${items} slides, deck.json lists ${total}`);
    if (current !== String(total - 1)) problems.push(`the overview marks slide index ${current} as current, expected ${total - 1}`);
    await page.keyboard.press("Escape");
    if (!(await overview.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false))) problems.push("Escape did not close the overview");
  } else {
    problems.push("O did not open the overview");
  }
  await closePage(page);
  // A malformed fragment, such as a copied link with a line break, still opens the deck on a fresh load.
  for (const junk of ["%0A", "%0D"]) {
    const fresh = await context.newPage();
    await fresh.goto(`${site.url}/#${deck.order[0]}${junk}`);
    if (!(await hashIs(fresh, deck.order[0]))) problems.push(`#${deck.order[0]}${junk} did not open the deck: hash is #${JSON.stringify(await hashOf(fresh))}`);
    await closePage(fresh);
  }
}

// Activates every link, button and focusable element on the stage, so a handler or URL that survived
// the sanitizer would run and leave a marker.
async function activate(context, site, deck) {
  const page = await openDeck(context, site, "", deck.order[0]);
  for (const [index, id] of deck.order.entries()) {
    if (new URL(page.url()).pathname !== "/") await page.goto(`${site.url}/#${id}`);
    await showSlide(page, id, index, ".stage", (i) => `Slide ${i + 1} of `);
    await settle(page);
    await page.evaluate(() => {
      const root = document.querySelector(".stage .slide-host").shadowRoot;
      for (const el of root.querySelectorAll("a, area, button, input, [tabindex], [onclick], [onmouseover], [onfocus]")) {
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, composed: true }));
        el.focus?.();
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true }));
      }
    });
    await sleep(200);
  }
  await settle(page);
  await closePage(page);
}

async function createDiffer(browser) {
  const page = await (await browser.newContext()).newPage();
  return (a, b, withImage) => page.evaluate(async ({ a, b, tolerance, withImage }) => {
    const decode = async (base64) => createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const [ia, ib] = await Promise.all([decode(a), decode(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { pixels: -1, ratio: 1, image: null, size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const { width, height } = ia;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, width, height).data;
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, width, height).data;
    const out = withImage ? ctx.createImageData(width, height) : null;
    let pixels = 0;
    for (let i = 0; i < da.length; i += 4) {
      const differs = Math.abs(da[i] - db[i]) > tolerance || Math.abs(da[i + 1] - db[i + 1]) > tolerance || Math.abs(da[i + 2] - db[i + 2]) > tolerance;
      if (differs) pixels += 1;
      if (out) {
        const gray = 225 + (db[i] + db[i + 1] + db[i + 2]) / 25;
        out.data.set(differs ? [230, 30, 60, 255] : [gray, gray, gray, 255], i);
      }
    }
    let image = null;
    if (out) {
      ctx.putImageData(out, 0, 0);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      image = btoa(binary);
    }
    return { pixels, ratio: pixels / (width * height), image };
  }, { a: a.toString("base64"), b: b.toString("base64"), tolerance: PIXEL_TOLERANCE, withImage });
}

async function loadAccepted(version) {
  const data = JSON.parse(await readFile(path.join(HERE, "accept.json"), "utf8"));
  return Object.entries(data[version] || {}).map(([pattern, reason]) => {
    if (typeof reason !== "string" || !reason.trim()) throw new Error(`accept.json: ${version} ${pattern} needs a reason`);
    const re = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return { pattern, reason, re, used: false };
  });
}

async function saveShot(file, bytes) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

// Serves one deck with the candidate package and checks everything but the visual diff.
const stepsOf = (report) => report.slides.map((slide) => slide.steps || 0);

async function runCandidate(browser, deck, version, diff) {
  const problems = [];
  const record = { errors: [], markers: [] };
  const missing = [];
  const site = await serveSite({ packageDir: CANDIDATE_DIR, dataDir: deck.dir, log: (entry) => { if (entry.status >= 400) missing.push(`${entry.status} ${entry.method} ${entry.path}`); } });
  const context = await newContext(browser, record, CANDIDATE_DIR);
  const shots = new Map();
  try {
    const report = await runCheckMode(context, site);
    problems.push(...compareReport(report, deck, version));
    const steps = stepsOf(report);
    for (const scheme of SCHEMES) {
      await stageShots(context, site, deck, steps, scheme, shots);
      await printShots(context, site, deck, scheme, shots, problems);
    }
    await presenterSync(context, site, deck, problems);
    await interact(context, site, deck, steps, problems);
    if (deck.expect.navigate) await navigate(context, site, deck, steps, shots, diff, problems);
    if (deck.expect.activate) await activate(context, site, deck);
    for (const page of context.pages()) await collectMarkers(page);
  } finally {
    await context.close();
    await site.close();
  }
  problems.push(...record.errors, ...missing.map((line) => `server answered ${line}`));
  problems.push(...record.markers.map((line) => `execution marker: ${line}`));
  problems.push(...site.probes.map((url) => `execution marker: request to ${url}`));
  return { problems, shots };
}

async function runBaseline(browser, deck, packageDir) {
  const record = { errors: [], markers: [] };
  const site = await serveSite({ packageDir, dataDir: deck.dir });
  const context = await newContext(browser, record, packageDir);
  const shots = new Map();
  try {
    const steps = stepsOf(await runCheckMode(context, site));
    for (const scheme of SCHEMES) {
      await stageShots(context, site, deck, steps, scheme, shots);
      await printShots(context, site, deck, scheme, shots);
    }
  } finally {
    await context.close();
    await site.close();
  }
  return shots;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const failures = [];
  const manifest = JSON.parse(await readFile(path.join(CANDIDATE_DIR, "type.json"), "utf8"));
  const candidate = parseVersion(manifest.version);
  if (!candidate) throw new Error(`type.json version ${manifest.version} is not SemVer`);
  const viewer = await readFile(path.join(CANDIDATE_DIR, "viewer.js"), "utf8");
  const declared = /const TYPE_VERSION = "([^"]+)"/.exec(viewer)?.[1];
  if (declared !== candidate.text) failures.push(`viewer.js TYPE_VERSION is ${JSON.stringify(declared)}, type.json version is ${candidate.text}: repin detection compares the two`);

  const baselineRef = opts.baseline === "none" ? null : opts.baseline ?? pickBaseline(candidate);
  if (opts.base) checkVersion(candidate, "base", opts.base, failures);
  if (baselineRef) checkVersion(candidate, "baseline", baselineRef, failures);
  const baseline = baselineRef ? await extractPackage(baselineRef) : null;
  const baselineVersion = baselineRef ? versionAt(baselineRef).text : null;
  const accepted = await loadAccepted(candidate.text);
  const decks = await loadDecks(opts.decks);
  console.log(`candidate ${TYPE}@${candidate.text}, baseline ${baselineRef ? `${baselineRef} (${baselineVersion})` : "none: no visual diff"}, ${decks.length} decks`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const diff = await createDiffer(browser);
  const report = { candidate: candidate.text, baseline: baselineRef, browser: browser.version(), threshold: { pixelTolerance: PIXEL_TOLERANCE, maxDiffRatio: MAX_DIFF_RATIO }, failures, decks: [] };
  try {
    for (const deck of decks) {
      const started = Date.now();
      const [result, baseShots] = await Promise.all([
        runCandidate(browser, deck, candidate.text, diff),
        baseline ? runBaseline(browser, deck, baseline.packageDir) : null,
      ]);
      const visual = { identical: 0, withinThreshold: [], accepted: [], failed: [], new: [] };
      // A screenshot the baseline has and the candidate lacks is lost coverage, such as step states of a
      // build that stopped working.
      for (const key of baseShots?.keys() ?? []) {
        if (!result.shots.has(key)) result.problems.push(`${key} exists in ${baselineRef} but not in the candidate`);
      }
      for (const [key, shot] of result.shots) {
        if (opts.save) await saveShot(path.join(OUT_DIR, "shots", `${key}.png`), shot);
        if (!baseShots) continue;
        const base = baseShots.get(key);
        if (!base) {
          visual.new.push(key);
          continue;
        }
        if (base.equals(shot)) {
          visual.identical += 1;
          continue;
        }
        const { ratio, size } = await diff(base, shot, false);
        if (ratio <= MAX_DIFF_RATIO) {
          visual.withinThreshold.push({ key, ratio });
          continue;
        }
        const accept = accepted.find((entry) => entry.re.test(key));
        const { image } = await diff(base, shot, true);
        const dir = path.join(OUT_DIR, "diff", key);
        await saveShot(path.join(dir, "baseline.png"), base);
        await saveShot(path.join(dir, "candidate.png"), shot);
        if (image) await saveShot(path.join(dir, "diff.png"), Buffer.from(image, "base64"));
        if (accept) {
          accept.used = true;
          visual.accepted.push({ key, ratio, reason: accept.reason });
        } else {
          visual.failed.push({ key, ratio, size });
          result.problems.push(`${key} differs from ${baselineRef} in ${(ratio * 100).toFixed(3)}% of pixels${size ? ` (${size})` : ""}; see checks/out/diff/${key}/`);
        }
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const status = result.problems.length ? "FAIL" : "ok";
      console.log(`${status.padEnd(4)} ${deck.name}: ${deck.order.length} slides, ${result.shots.size} screenshots, ${visual.identical} identical, ${visual.withinThreshold.length} within threshold, ${visual.accepted.length} accepted, ${visual.failed.length} changed, ${visual.new.length} new (${seconds} s)`);
      for (const line of result.problems) console.log(`     ${line}`);
      report.decks.push({ name: deck.name, slides: deck.order.length, problems: result.problems, visual });
      failures.push(...result.problems.map((line) => `${deck.name}: ${line}`));
    }
  } finally {
    await browser.close();
    if (baseline) await rm(baseline.root, { recursive: true, force: true });
  }
  for (const entry of accepted) if (!entry.used && !opts.decks.length) console.log(`note: accept.json ${candidate.text} "${entry.pattern}" matched no changed screenshot`);
  await writeFile(path.join(OUT_DIR, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (failures.length) {
    console.log(`\n${failures.length} problem(s):`);
    for (const line of failures) console.log(`- ${line}`);
    process.exitCode = 1;
  } else {
    console.log("\nrelease check passed");
  }
}

await main();
