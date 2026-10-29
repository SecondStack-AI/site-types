// Release check for the Slides viewer. For every sample deck under checks/decks/ it serves the candidate
// package (slides/) the way Spot serves a typed site and:
//   - runs check mode and compares the report with the deck's check.json: no errors, and exactly the
//     expected warnings, sanitizer removals included;
//   - fails on any script execution marker: a window property starting with __exec, a request to
//     /api/probe, or a request to probe.invalid;
//   - screenshots every slide on the stage and in print, light and dark, and compares each screenshot
//     with the same deck rendered by the previous release (the highest slides-v* tag at or below the
//     candidate version) in the same browser;
//   - drives the host protocol from a host page on another site, for a deck whose check.json has "embed".
// It also checks the package: viewer.js TYPE_NAME and TYPE_VERSION equal type.json, changed package
// bytes come with a higher version than the baseline tag and the --base ref, and every theme in
// slides.json has its preview (16:9), stylesheet and font files.
//
//   node checks/run.mjs [--deck <name>]... [--baseline <git ref>|none] [--base <git ref>] [--package <dir>] [--save]
//
// --package checks another Slides-family package, such as a fork, against these decks. It has no
// release history here, so there is no visual baseline unless --baseline names one.
//
// --save writes every candidate screenshot to checks/out/shots/. Failing screenshots always go to
// checks/out/diff/<key>/ as baseline.png, candidate.png and diff.png.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serveSite } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// TYPE is the package folder and tag prefix in this repository; TYPE_NAME and CANDIDATE_DIR follow
// --package when it is given.
const TYPE = "slides";
let CANDIDATE_DIR = path.join(ROOT, TYPE);
let TYPE_NAME = TYPE;
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
  const opts = { decks: [], baseline: null, base: null, package: null, save: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deck") opts.decks.push(argv[++i]);
    else if (arg === "--baseline") opts.baseline = argv[++i];
    else if (arg === "--base") opts.base = argv[++i];
    else if (arg === "--package") opts.package = argv[++i];
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
    decks.push({ name: entry.name, dir, order: deck.order, title: deck.title, scheme: deck.theme?.scheme, expect });
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
  if (report.type !== `${TYPE_NAME}@${version}`) problems.push(`check report type is ${report.type}, expected ${TYPE_NAME}@${version}`);
  if (!report.complete) problems.push("check mode reports the deck as incomplete");
  if (report.slides.length !== deck.order.length) problems.push(`check mode reports ${report.slides.length} slides, deck.json lists ${deck.order.length}`);
  compareIssues("_type/slides.json", report.package?.issues || [], [], [], problems);
  compareIssues("project/deck.json", report.deck.issues, deck.expect.deckWarnings || [], deck.expect.deckErrors || [], problems);
  if (deck.expect.preset !== undefined && report.deck.preset !== deck.expect.preset) problems.push(`check mode shows the deck in theme ${JSON.stringify(report.deck.preset)}, check.json says ${JSON.stringify(deck.expect.preset)}`);
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
  await context.route((url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && !url.hostname.endsWith(".localhost"), (route) => fulfilExternal(route, record, packageDir));
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

// The viewer chrome has no ::before or ::after content of its own, so any is a theme or slide rule that
// escaped the slide frames.
function chromePseudos(page) {
  return page.evaluate(() => [...document.querySelectorAll("body *")].flatMap((el) => ["::before", "::after"]
    .filter((pseudo) => !["none", "normal"].includes(getComputedStyle(el, pseudo).content))
    .map((pseudo) => `${el.localName}${[...el.classList].map((name) => `.${name}`).join("")}${pseudo}`)));
}

// Keyboard on the audience view: → walks every step of the deck and the counter and hash follow; a
// step announces what it revealed in the live region, and waiting steps are inert. O opens the overview
// with every slide and the current one marked, and Escape closes it.
async function interact(context, site, deck, steps, problems) {
  const total = deck.order.length;
  const page = await openDeck(context, site, "", deck.order[0]);
  // Without ?theme the scheme comes from deck.json, then from the preset.
  const scheme = await page.evaluate(() => document.documentElement.dataset.scheme);
  const wantScheme = deck.expect.scheme ?? deck.scheme ?? "light";
  if (scheme !== wantScheme) problems.push(`the deck opens in the ${scheme} scheme, expected ${wantScheme}`);
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
    for (const item of await chromePseudos(page)) problems.push(`the overview shows a theme or slide decoration on ${item}`);
    await page.keyboard.press("Escape");
    if (!(await overview.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false))) problems.push("Escape did not close the overview");
  } else {
    problems.push("O did not open the overview");
  }
  await page.keyboard.press("?");
  if (await page.locator("dialog.help[open]").waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    for (const item of await chromePseudos(page)) problems.push(`the shortcuts dialog shows a theme or slide decoration on ${item}`);
    await page.keyboard.press("Escape");
  } else {
    problems.push("? did not open the shortcuts dialog");
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

// Width and height of a PNG (IHDR) or an SVG (viewBox, else width and height).
function imageSize(bytes, file) {
  if (file.endsWith(".png")) return bytes.length > 24 && bytes.toString("latin1", 1, 4) === "PNG" ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  const svg = bytes.toString("utf8");
  const box = /<svg\b[^>]*\bviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i.exec(svg);
  if (box) return { width: Number(box[1]), height: Number(box[2]) };
  const width = /<svg\b[^>]*\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svg)?.[1];
  const height = /<svg\b[^>]*\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(svg)?.[1];
  return width && height ? { width: Number(width), height: Number(height) } : null;
}

// The files slides.json names, read the way the site serves /_type/: the deck's type/ overlay first.
// The viewer checks the rest of slides.json, and check mode reports it on every deck.
async function checkThemeFiles(dirs, label) {
  const problems = [];
  const read = async (rel) => {
    for (const dir of dirs) {
      const bytes = await readFile(path.join(dir, rel)).catch(() => null);
      if (bytes) return bytes;
    }
    return null;
  };
  const text = await read("slides.json");
  if (!text) return [`${label}: slides.json is missing`];
  const { themes = [] } = JSON.parse(text);
  for (const theme of themes) {
    const preview = typeof theme.preview === "string" ? await read(theme.preview) : null;
    const size = preview && imageSize(preview, theme.preview.toLowerCase());
    if (!preview) problems.push(`${label}: theme ${theme.id} preview ${theme.preview} is missing`);
    else if (!size || Math.abs(size.width / size.height - 16 / 9) > 0.01) problems.push(`${label}: theme ${theme.id} preview ${theme.preview} is ${size ? `${size.width}x${size.height}` : "not a readable PNG or SVG"}, not 16:9`);
    if (theme.stylesheet && !(await read(theme.stylesheet))) problems.push(`${label}: theme ${theme.id} stylesheet ${theme.stylesheet} is missing`);
    for (const spec of Object.values(theme.fonts || {})) {
      for (const face of spec.faces || []) if (!(await read(face.src))) problems.push(`${label}: theme ${theme.id} font ${face.src} is missing`);
    }
  }
  return problems;
}

// Edit mode, on the deck's `edit` slide and its `headStyle` slide (a <style> before the section):
// - toggling edit mode or moving between slides without typing sends nothing;
// - a typed text comes back as the slide file, sanitized, with the file's markup, notes, relative URLs
//   and <style> text kept verbatim (also a style the CSS sanitizer trims), and a second edit changes
//   only its own text; a head <style> moves into the section, so the look is kept;
// - the stage keeps an edit through a refresh that returns the old file and through the host's save,
//   gives it up after three refreshes without the save, and takes a version from another writer.
async function editProtocol({ page, viewer, site, dataDir, deck, waitMessage, noMessage, fail }) {
  const id = deck.expect.embed.edit;
  const index = deck.order.indexOf(id);
  const file = path.join(dataDir, "project", "slides", `${id}.html`);
  const styleText = /<style>[\s\S]*?<\/style>/.exec(await readFile(file, "utf8"))[0];
  const stage = viewer.locator(".stage .slide-host");
  const send = (message) => page.evaluate((m) => window.send(m), message);
  const isSlide = (target) => (message) => message.type === "slide" && message.id === target;
  const editableOn = (target) => (message) => message.type === "editable" && message.id === target;
  const editableCount = () => viewer.evaluate(() => document.querySelector(".stage .slide-host").shadowRoot.querySelectorAll("[contenteditable]").length);
  const typeInto = async (locator, keys, text) => {
    await locator.click();
    await page.keyboard.press(keys);
    await page.keyboard.type(text);
    await locator.evaluate((el) => { el.__kept = true; el.blur(); });
  };
  const keeps = async (label, locator, text) => {
    await sleep(800);
    const state = await locator.evaluate((el) => ({ kept: el.__kept === true, text: el.textContent }));
    if (!state.kept || state.text !== text) fail(`${label}: the stage shows ${JSON.stringify(state.text)}${state.kept ? "" : ", rebuilt"}`);
  };

  await send({ type: "goto", id });
  await waitMessage("goto before editing", isSlide(id));
  await send({ type: "edit", on: "yes" });
  await waitMessage("edit without a boolean", (message) => message.type === "error" && message.code === "command-invalid");
  await send({ type: "edit", on: true });
  const announced = await waitMessage("editable", editableOn(id));
  if (announced && (!announced.count || announced.count !== await editableCount())) fail(`editable says ${announced.count} block(s), the stage has ${await editableCount()}`);
  await send({ type: "edit", on: false });
  await noMessage("edit on and off without typing", "edited");
  await send({ type: "edit", on: true });
  await waitMessage("editable again", editableOn(id));
  const neighbour = deck.order[(index + 1) % deck.order.length];
  await send({ type: "goto", id: neighbour });
  await waitMessage("goto while editing", isSlide(neighbour));
  await send({ type: "goto", id });
  await waitMessage("goto back while editing", isSlide(id));
  await noMessage("moving between slides while editing", "edited");
  await send({ type: "edit", on: true });
  await waitMessage("editable after navigation", editableOn(id));

  const shown = await viewer.evaluate(() => {
    const root = document.querySelector(".stage .slide-host").shadowRoot;
    return { hidden: root.querySelectorAll("[data-step-hidden]").length, editable: [...root.querySelectorAll("[contenteditable]")].map((el) => el.localName) };
  });
  if (shown.hidden) fail(`edit mode leaves ${shown.hidden} build step(s) hidden`);
  if (shown.editable.some((name) => ["img", "svg", "iframe", "section", "ol", "aside"].includes(name))) fail(`edit mode made ${shown.editable.join(", ")} editable`);
  const heading = stage.locator("h2");
  await typeInto(heading, "ControlOrMeta+a", "Plan");
  const edited = await waitMessage("edited", (message) => message.type === "edited" && message.id === id);
  if (edited) {
    const { html } = edited;
    const markup = html.replace(styleText, "");
    if (edited.path !== `project/slides/${id}.html`) fail(`edited names the path ${edited.path}`);
    const want = ["<h2>Plan</h2>", "<aside>Keep this short.</aside>", 'src="assets/dot.svg"', 'data-step="1"', "<em>Finance</em>"];
    const unwanted = ["onclick", "onerror", "Agenda", "data-slides", "contenteditable", "sandbox", "/project/", "data-step-hidden", "inert", "<style"];
    if (!html.includes(styleText)) fail(`edited html does not keep the slide's <style> text as written: ${html}`);
    for (const text of want) if (!markup.includes(text)) fail(`edited html lacks ${text}: ${html}`);
    for (const text of unwanted) if (markup.includes(text)) fail(`edited html has ${text} outside its <style>: ${html}`);
    if (!/^<section>[\s\S]*<\/section>\n$/.test(html)) fail(`edited html is not one section file: ${JSON.stringify(html)}`);
  }
  await waitMessage("outline after the edit", (message) => message.type === "outline" && message.outline.slides[index].title === "Plan");
  site.deploy(); // a refresh that still reads the old file
  await keeps("a refresh before the host saved", heading, "Plan");
  if (edited) await writeFile(file, edited.html);
  site.deploy();
  await keeps("the refresh after the host saved", heading, "Plan");
  // The saved file comes back unchanged except for the next edit's own text.
  await typeInto(stage.locator("em"), "End", " team");
  const second = await waitMessage("a second edit", (message) => message.type === "edited" && message.id === id);
  if (edited && second && second.html !== edited.html.replace("<em>Finance</em>", "<em>Finance team</em>")) fail(`a second edit changed more than its text: ${JSON.stringify(edited.html)} then ${JSON.stringify(second.html)}`);
  if (second) await writeFile(file, second.html);
  site.deploy();
  await keeps("the refresh after the second save", heading, "Plan");
  await writeFile(file, (await readFile(file, "utf8")).replace("<h2>Plan</h2>", "<h2>Remote</h2>"));
  site.deploy();
  if (!(await stage.locator("h2[contenteditable]", { hasText: "Remote" }).waitFor({ timeout: 5000 }).then(() => true, () => false))) fail("a version from another writer did not replace the edit");

  // A remount while typed text waits for the pause: a deck.json change keeps the typing (it is sent
  // first and the new stage shows it), a new version of the same slide discards it.
  const stageText = (text) => viewer.waitForFunction((want) => document.querySelector(".stage .slide-host").shadowRoot.querySelector("h2")?.textContent === want, text, { timeout: 5000 }).then(() => true, () => false);
  const deckFile = path.join(dataDir, "project", "deck.json");
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type("ZZZ");
  await writeFile(deckFile, JSON.stringify({ ...JSON.parse(await readFile(deckFile, "utf8")), lang: "en" }, null, 2));
  site.deploy();
  const typed = await waitMessage("edited before a deck.json remount", (message) => message.type === "edited" && message.id === id);
  if (typed && !typed.html.includes("<h2>RemoteZZZ</h2>")) fail(`edited before a deck.json remount carries ${JSON.stringify(typed.html)}`);
  if (!(await stageText("RemoteZZZ"))) fail(`after a deck.json remount the stage shows ${JSON.stringify(await heading.textContent())}, not the typed RemoteZZZ`);
  if (typed) await writeFile(file, typed.html);
  site.deploy();
  await sleep(800);
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type("QQQ");
  await writeFile(file, (await readFile(file, "utf8")).replace("<h2>RemoteZZZ</h2>", "<h2>Other</h2>"));
  site.deploy();
  if (!(await stageText("Other"))) fail(`a new version of the slide during typing shows ${JSON.stringify(await heading.textContent())}, not Other`);
  await noMessage("a new version of the slide during typing", "edited");

  const styled = deck.expect.embed.headStyle;
  const headStyle = /<style>[\s\S]*?<\/style>/.exec(await readFile(path.join(dataDir, "project", "slides", `${styled}.html`), "utf8"))[0];
  await send({ type: "goto", id: styled });
  await waitMessage("goto the slide with a head style", isSlide(styled));
  await send({ type: "edit", on: true });
  await waitMessage("editable on the slide with a head style", editableOn(styled));
  const styledHeading = stage.locator("h2");
  const before = await styledHeading.textContent();
  await typeInto(styledHeading, "End", "!");
  const carried = await waitMessage("edited with a head style", (message) => message.type === "edited" && message.id === styled);
  if (carried && !/^<section[^>]*>/.test(carried.html.trimStart())) fail(`edited html does not start with the section: ${JSON.stringify(carried.html)}`);
  if (carried && !carried.html.includes(headStyle)) fail(`edited html drops the head <style>: ${JSON.stringify(carried.html)}`);
  for (let refresh = 1; refresh <= 3; refresh += 1) {
    site.deploy();
    await keeps(`unsaved edit, refresh ${refresh}`, styledHeading, `${before}!`);
  }
  site.deploy();
  if (!(await viewer.waitForFunction((text) => document.querySelector(".stage .slide-host").shadowRoot.querySelector("h2")?.textContent === text, before, { timeout: 5000 }).then(() => true, () => false))) fail("an edit the host never saved outlived three refreshes");

  await send({ type: "edit", on: false });
  if (!(await viewer.waitForFunction(() => !document.querySelector(".stage .slide-host").shadowRoot.querySelector("[contenteditable]"), null, { timeout: 5000 }).then(() => true, () => false))) fail("edit off left text editable");
}

// Exercises the selection toolbar contract through the actual cross-origin host and scaled stage.
async function selectionProtocol({ page, viewer, deck, waitMessage, noMessage, fail }) {
  const id = deck.expect.embed.edit;
  const send = (message) => page.evaluate((m) => window.send(m), message);
  const stage = viewer.locator(".stage .slide-host");
  const heading = stage.locator("h2");
  const selected = () => waitMessage("selected word", (m) => m.type === "selection" && typeof m.token === "string");
  const editState = (on) => waitMessage(`editing ${on}`, (m) => m.type === "editing" && m.on === on && m.id === id);
  const doubleClickWord = () => heading.dblclick({ position: { x: 15, y: 20 } });
  const selectHeading = async () => {
    await doubleClickWord();
    return selected();
  };
  await send({ type: "goto", id });
  await waitMessage("selection slide", (m) => m.type === "slide" && m.id === id);
  await send({ type: "edit", on: false, enabled: false });
  await heading.dispatchEvent("dblclick");
  if (await stage.locator("[contenteditable]").count()) fail("shared deck double-click enabled editing");
  await send({ type: "edit", on: false, enabled: true });
  if (await stage.locator("[contenteditable]").count()) fail("arming permission entered edit mode");
  await doubleClickWord();
  await editState(true);
  const first = await selected();
  if (!first?.text.trim()) fail("double-click did not select a word");
  await send({ type: "clear-selection" });
  await waitMessage("clear before cross-block selection", (m) => m.type === "selection" && m.selection === null);
  await heading.evaluate((el) => {
    el.focus();
    const root = el.getRootNode();
    const paragraph = [...root.querySelectorAll("[data-slides-edit]")].find((block) => block !== el);
    const range = document.createRange();
    range.setStart(el.firstChild, 0);
    range.setEnd(paragraph.firstChild, 1);
    const selection = root.getSelection ? root.getSelection() : window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const bounded = await selected();
  if (bounded?.text !== await heading.textContent()) fail("cross-block selection was not trimmed to its first text block");
  if (first && bounded) {
    const rect = await heading.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (Object.keys(rect).some((key) => Math.abs(first.rect[key] - rect[key]) > 1) || first.rect.width <= 0) fail(`selection geometry differs from the transformed text: ${JSON.stringify({ selection: first.rect, rect })}`);
    await page.locator("#present").focus(); // Parent toolbar focus must retain the saved range.
    await send({ type: "replace", id, token: bounded.token, text: "<script>plain & safe</script>" });
    const edited = await waitMessage("selection replacement", (m) => m.type === "edited" && m.id === id);
    if (!edited?.html.includes("&lt;script&gt;plain &amp; safe&lt;/script&gt;")) fail(`replacement was not saved as plain text: ${edited?.html}`);
    await send({ type: "replace", id, token: bounded.token, text: "duplicate" });
    await waitMessage("reused token rejected", (m) => m.type === "error" && m.code === "selection-stale");
  }
  const stale = await selectHeading();
  await heading.evaluate((el) => { const text = el.firstChild; const old = text.textContent; text.textContent = `${old}!`; text.textContent = old; });
  await waitMessage("mutation cleared selection", (m) => m.type === "selection" && m.selection === null);
  if (stale) await send({ type: "replace", id, token: stale.token, text: "stale" });
  await waitMessage("restored mutation rejected", (m) => m.type === "error" && m.code === "selection-stale");
  const cleared = await selectHeading();
  await send({ type: "clear-selection" });
  await waitMessage("explicit clear", (m) => m.type === "selection" && m.selection === null);
  if (cleared) await send({ type: "replace", id, token: cleared.token, text: "cleared" });
  await waitMessage("cleared token rejected", (m) => m.type === "error" && m.code === "selection-stale");
  await heading.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Escape flush");
  await page.keyboard.press("Escape");
  await waitMessage("Escape flush", (m) => m.type === "edited" && m.html.includes(" Escape flush"));
  await editState(false);
  await doubleClickWord();
  await editState(true);
  await selected();
  await viewer.locator(".stage").click({ position: { x: 2, y: 2 } });
  await editState(false);
  await doubleClickWord();
  await editState(true);
  const navigated = await selected();
  const neighbour = deck.order.at(-1);
  await send({ type: "goto", id: neighbour });
  await editState(false);
  if (await stage.locator("[contenteditable]").count()) fail("navigation left editing enabled");
  if (navigated) await send({ type: "replace", id, token: navigated.token, text: "wrong slide" });
  await waitMessage("previous slide token rejected", (m) => m.type === "error" && m.code === "selection-stale");
  await noMessage("stale replacements", "edited");
}

// Export: progress per slide, then the file, transferred, with its warnings.
async function exportProtocol({ page, viewer, deck, waitMessage, fail }) {
  await page.evaluate(() => window.send({ type: "export", format: "pdf" }));
  await waitMessage("export of another format", (message) => message.type === "error" && message.code === "command-invalid");
  await page.evaluate(() => window.send({ type: "export", format: "pptx" }));
  await waitMessage("exporting", (message) => message.type === "exporting" && message.total === deck.order.length && message.done === deck.order.length, 30000);
  const exported = await waitMessage("exported", (message) => message.type === "exported", 30000);
  if (!exported) return;
  if (exported.format !== "pptx" || exported.filename !== `${deck.title}.pptx` || !exported.bytes) fail(`exported is ${JSON.stringify(exported)}`);
  if (!Array.isArray(exported.warnings) || exported.warnings.some((item) => typeof item.code !== "string" || !Array.isArray(item.slides))) fail(`exported warnings are ${JSON.stringify(exported.warnings)}`);
  const bytes = Buffer.from(await page.evaluate(() => {
    const data = window.received.findLast((entry) => entry.data.type === "exported").data;
    let text = "";
    const view = new Uint8Array(data.bytes);
    for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
    return btoa(text);
  }), "base64");
  const pptx = await inspectPptx(viewer, bytes);
  if (pptx.count !== deck.order.length || pptx.problems.length) fail(`the exported file has ${pptx.count} slides and ${JSON.stringify(pptx.problems)}`);
  if (!pptx.notes.includes(deck.expect.notes[deck.expect.embed.edit])) fail(`the exported notes are ${JSON.stringify(pptx.notes)}`);
  // results has a decoration whose background image cannot be fetched; its gradient is still exported.
  if (!exported.warnings?.some((item) => item.code === "image-unavailable" && item.slides.includes(deck.expect.embed.missing))) fail(`exported warnings lack image-unavailable for ${deck.expect.embed.missing}: ${JSON.stringify(exported.warnings)}`);
}

// The host protocol (the C3 contract): the host page embed-host.html, served from 127.0.0.1, frames the
// viewer from deck.localhost, another site, and records what the viewer frame sends. On a host name the
// viewer subscribes to deploy events, so every refresh here is deploy-driven. The deck starts with one
// listed slide missing, which is published during the run, and a hand edit is saved as a host would.
async function embedProtocol(browser, deck, version, problems) {
  const fail = (text) => problems.push(`host protocol: ${text}`);
  const order = deck.order;
  // The deck names no preset and no scheme: it shows the package's default theme in its scheme.
  const themeList = JSON.parse(await readFile(path.join(CANDIDATE_DIR, "slides.json"), "utf8"));
  const theme = themeList.themes.find((item) => item.id === themeList.defaultTheme);
  const missingId = deck.expect.embed.missing;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slides-embed-"));
  await cp(deck.dir, dataDir, { recursive: true });
  const missingFile = path.join(dataDir, "project", "slides", `${missingId}.html`);
  const missingText = await readFile(missingFile);
  await rm(missingFile);
  const site = await serveSite({ packageDir: CANDIDATE_DIR, dataDir });
  const siteUrl = `http://deck.localhost:${site.port}`;
  const hostPage = await readFile(path.join(HERE, "embed-host.html"));
  const hostServer = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(hostPage);
  });
  await new Promise((resolve) => hostServer.listen(0, "127.0.0.1", resolve));
  const record = { errors: [], markers: [] };
  const context = await newContext(browser, record, CANDIDATE_DIR);
  // A browser that partitions storage keeps an embedded viewer and its presenter window on different
  // BroadcastChannels; without the channel, presenter sync must work through window references.
  await context.addInitScript(() => { delete window.BroadcastChannel; });
  let cursor = 0;
  const page = await context.newPage();
  const messages = () => page.evaluate(() => window.received.map(({ data }) => (data?.bytes instanceof ArrayBuffer ? { ...data, bytes: data.bytes.byteLength } : data)));
  const waitMessage = async (label, test, timeout = 5000) => {
    for (const until = Date.now() + timeout; Date.now() < until; await sleep(50)) {
      const list = await messages();
      const at = list.findIndex((message, index) => index >= cursor && test(message));
      if (at >= 0) {
        cursor = at + 1;
        return list[at];
      }
    }
    fail(`${label}: no such message; after the last expected one the viewer sent ${JSON.stringify((await messages()).slice(cursor))}`);
    return null;
  };
  const noMessage = async (label, type) => {
    await sleep(700);
    const list = await messages();
    const found = list.slice(cursor).filter((message) => message.type === type);
    if (found.length) fail(`${label}: the viewer sent ${JSON.stringify(found)}`);
    cursor = list.length;
  };
  const quiet = async (label) => {
    await sleep(700);
    const list = await messages();
    if (list.length > cursor) fail(`${label}: the viewer answered ${JSON.stringify(list.slice(cursor))}`);
    cursor = list.length;
  };
  const isSlide = (index) => (message) => message.type === "slide" && message.id === order[index] && message.index === index;
  try {
    await page.goto(`http://127.0.0.1:${hostServer.address().port}/?site=${encodeURIComponent(siteUrl)}&id=${order[0]}`);
    const ready = await waitMessage("ready", (message) => message.type === "ready");
    const viewer = await (await page.$("#viewer")).contentFrame();
    const wrong = await (await page.$("#wrong")).contentFrame();
    if (ready) {
      const { outline } = ready;
      if (ready.slides !== 1 || ready.contract !== 1) fail(`ready has slides ${ready.slides} and contract ${ready.contract}, expected 1 and 1`);
      if (ready.siteType?.name !== TYPE_NAME || ready.siteType?.version !== version) fail(`ready names the site type ${JSON.stringify(ready.siteType)}`);
      if (outline.title !== deck.title) fail(`outline title is ${JSON.stringify(outline.title)}`);
      if (outline.theme?.preset !== theme.id || outline.theme?.scheme !== theme.scheme) fail(`outline theme is ${JSON.stringify(outline.theme)}, expected ${theme.id} in ${theme.scheme}`);
      if (outline.slides.map((slide) => slide.id).join() !== order.join()) fail(`outline lists ${outline.slides.map((slide) => slide.id)}`);
      for (const slide of outline.slides) {
        if (slide.missing !== (slide.id === missingId)) fail(`outline says ${slide.id} is ${slide.missing ? "" : "not "}missing`);
      }
      if (outline.slides.find((slide) => slide.id === missingId)?.section !== "Results" || outline.slides[0].section !== null) fail(`outline sections are ${JSON.stringify(outline.slides.map((slide) => slide.section))}`);
    }
    await waitMessage("the first slide message", isSlide(0));
    // A slide that is not written yet has nothing to edit.
    await page.evaluate((id) => window.send({ type: "goto", id }), missingId);
    await waitMessage("goto the missing slide", (message) => message.type === "slide" && message.id === missingId);
    await page.evaluate(() => window.send({ type: "edit", on: true }));
    await waitMessage("editable on the missing slide", (message) => message.type === "editable" && message.id === missingId && message.count === 0);
    await page.evaluate(() => window.send({ type: "edit", on: false }));
    await page.evaluate((id) => window.send({ type: "goto", id }), order[0]);
    await waitMessage("back to the first slide", isSlide(0));

    const layout = await viewer.evaluate(() => ({
      toolbar: Boolean(document.querySelector(".toolbar")),
      strip: document.querySelectorAll(".strip-item").length,
      placeholder: Boolean(document.querySelectorAll(".strip-item .slide-host")[2]?.shadowRoot?.querySelector(".is-placeholder")),
    }));
    if (layout.toolbar || layout.strip !== order.length) fail(`embed mode shows a toolbar: ${layout.toolbar}, ${layout.strip} strip items for ${order.length} slides`);
    if (!layout.placeholder) fail(`the strip shows no placeholder for the missing slide ${missingId}`);

    await page.evaluate((id) => window.send({ type: "goto", id }), order[2]);
    await waitMessage("goto", isSlide(2));
    await page.evaluate(() => window.send({ type: "goto", id: "no-such-slide" }));
    await waitMessage("goto to an unknown slide", (message) => message.type === "error" && message.code === "slide-unknown");
    await page.evaluate(() => window.send({ type: "scheme", scheme: "blue" }));
    await waitMessage("an invalid scheme", (message) => message.type === "error" && message.code === "command-invalid");
    await page.evaluate(() => window.send({ type: "present", on: "yes" }));
    await waitMessage("present without a boolean", (message) => message.type === "error" && message.code === "command-invalid");
    await page.evaluate((site) => {
      window.send({ type: "no-such-command" });
      document.getElementById("viewer").contentWindow.postMessage({ slides: 2, type: "goto", id: "cover" }, site);
    }, siteUrl);
    await quiet("an unknown command and another contract major");
    await page.evaluate((id) => window.attack({ type: "goto", id }), order[0]);
    await quiet("a goto from a frame of the host origin that is not the parent");
    if ((await hashOf(viewer)) !== order[2]) fail(`a frame that is not the parent moved the viewer to #${await hashOf(viewer)}`);

    await wrong.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
    await page.evaluate((id) => window.sendWrong({ type: "goto", id }), order[3]);
    await sleep(500);
    if ((await hashOf(wrong)) !== order[0]) fail(`a viewer framed with another host origin took a command from this host: it is at #${await hashOf(wrong)}`);
    const strays = await page.evaluate(() => window.strays.filter((entry) => entry.fromWrong).length);
    if (strays) fail(`a viewer framed with another host origin sent ${strays} message(s) to this host`);

    await viewer.locator(".strip-item button").nth(1).click();
    await waitMessage("a click on the strip", isSlide(1));
    await page.keyboard.press("ArrowRight"); // the slide's one build step
    await page.keyboard.press("ArrowRight");
    await waitMessage("→ in the viewer frame", isSlide(2));
    for (const key of ["o", "?"]) {
      await page.keyboard.press(key);
      if (await viewer.locator("dialog[open]").count()) fail(`${key} opened a dialog in embed mode`);
    }
    // The host opens the presenter window, not the embedded viewer.
    const pagesBefore = context.pages().length;
    for (const key of ["s", "p"]) await page.keyboard.press(key);
    await sleep(700);
    if (context.pages().length !== pagesBefore) fail("S or P opened a presenter window from the embedded viewer");

    const other = theme.scheme === "light" ? "dark" : "light";
    await page.evaluate((scheme) => window.send({ type: "scheme", scheme }), other);
    await waitMessage(`scheme ${other}`, (message) => message.type === "outline" && message.outline.theme.scheme === other);
    if ((await viewer.evaluate(() => document.documentElement.dataset.scheme)) !== other) fail(`scheme ${other} did not switch the viewer`);
    await page.evaluate((scheme) => window.send({ type: "scheme", scheme }), theme.scheme);
    await waitMessage(`scheme ${theme.scheme}`, (message) => message.type === "outline" && message.outline.theme.scheme === theme.scheme);

    await writeFile(missingFile, missingText);
    site.deploy();
    await waitMessage(`${missingId} published`, (message) => message.type === "outline" && message.outline.slides.every((slide) => !slide.missing), 20000);

    // Present: the host's fullscreen frame shows the stage alone and keeps keyboard navigation; leaving
    // fullscreen brings the strip back.
    const presentLayout = () => viewer.evaluate(() => ({
      strip: getComputedStyle(document.querySelector(".strip")).display,
      stageLeft: document.querySelector(".stage").getBoundingClientRect().left,
    }));
    await page.click("#present");
    if (!(await page.waitForFunction(() => document.fullscreenElement?.id === "viewer", null, { timeout: 5000 }).then(() => true, () => false))) fail("the host page could not make the viewer frame fullscreen");
    if (!(await viewer.waitForFunction(() => document.getElementById("app").classList.contains("presenting"), null, { timeout: 5000 }).then(() => true, () => false))) fail("present on: the viewer did not switch to presenting");
    else {
      const layout = await presentLayout();
      if (layout.strip !== "none" || layout.stageLeft !== 0) fail(`presenting shows the strip (${layout.strip}) or offsets the stage by ${layout.stageLeft}px`);
    }
    await page.keyboard.press("ArrowRight");
    await waitMessage("→ while presenting", isSlide(3));
    await page.keyboard.press("ArrowLeft");
    await waitMessage("← while presenting", isSlide(2));
    await page.evaluate(() => document.exitFullscreen());
    if (!(await viewer.waitForFunction(() => !document.getElementById("app").classList.contains("presenting"), null, { timeout: 5000 }).then(() => true, () => false))) fail("present on: false did not end presenting");
    else if ((await presentLayout()).strip === "none") fail("the strip stays hidden after presenting");

    await page.evaluate(() => window.send({ type: "print" }));
    await sleep(300);
    const pages = await viewer.locator("#print-root .print-page").count();
    if (pages !== order.length) fail(`print built ${pages} pages for ${order.length} slides`);

    await editProtocol({ page, viewer, site, dataDir, deck, waitMessage, noMessage, fail });
    await selectionProtocol({ page, viewer, deck, waitMessage, noMessage, fail });
    await exportProtocol({ page, viewer, deck, waitMessage, fail });

    // The presenter window the host page opens follows the embedded viewer and leads it. A second viewer
    // of the deck would answer the presenter too.
    await page.evaluate(() => document.getElementById("wrong").remove());
    await page.evaluate((id) => window.send({ type: "goto", id }), order[0]);
    await waitMessage("goto before the presenter", isSlide(0));
    await page.evaluate((id) => window.send({ type: "goto", id }), order[3]);
    await waitMessage("goto the presenter's start", isSlide(3));
    const [presenter] = await Promise.all([context.waitForEvent("page"), page.click("#open-presenter")]);
    await presenter.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
    if (!(await textIs(presenter, ".pv-counter", `4 / ${order.length}`))) fail(`the presenter window shows ${await presenter.locator(".pv-counter").textContent()}, not the viewer's slide 4`);
    await page.evaluate((id) => window.send({ type: "goto", id }), order[2]);
    await waitMessage("goto with the presenter open", isSlide(2));
    if (!(await textIs(presenter, ".pv-counter", `3 / ${order.length}`))) fail("the presenter window did not follow the viewer to slide 3");
    await presenter.keyboard.press("ArrowLeft");
    await waitMessage("← in the presenter window", isSlide(1));
    await closePage(presenter);
    for (const frame of page.frames()) {
      const keys = await frame.evaluate((prefix) => Object.keys(window).filter((key) => key.startsWith(prefix)), MARKER_PREFIX).catch(() => []);
      for (const key of keys) record.markers.push(`${key} set in ${frame.url()}`);
    }
  } finally {
    await context.close();
    await site.close();
    await new Promise((resolve) => hostServer.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
  // The browser refuses the posts of the viewer framed with another host origin, and logs each refusal.
  problems.push(...record.errors.filter((line) => !line.includes("'https://wrong.invalid'")).map((line) => `host protocol: ${line}`));
  problems.push(...record.markers.map((line) => `host protocol: execution marker: ${line}`));
}

// Reads a .pptx in a page that has JSZip (the viewer's after an export): every XML part must parse,
// no paragraph may carry two <a:pPr>, and each slide's notes are the text of its notes body. It also
// returns the media file names and each slide's external link targets.
async function inspectPptx(page, bytes) {
  return page.evaluate(async (base64) => {
    const zip = await window.JSZip.loadAsync(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
    const problems = [];
    const docs = new Map();
    for (const name of Object.keys(zip.files).filter((file) => /\.(xml|rels)$/.test(file))) {
      const doc = new DOMParser().parseFromString(await zip.file(name).async("string"), "application/xml");
      if (doc.getElementsByTagName("parsererror").length) problems.push(`${name} is not well-formed XML`);
      docs.set(name, doc);
    }
    const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
    const count = [...docs.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
    const notes = [];
    const links = [];
    const media = Object.keys(zip.files).filter((name) => /^ppt\/media\/[^/]+$/.test(name));
    const contents = new Map();
    const svgElements = {};
    for (const name of media) {
      const content = await zip.file(name).async("base64");
      if (contents.has(content)) problems.push(`${name} has the same bytes as ${contents.get(content)}`);
      else contents.set(content, name);
      if (name.endsWith(".svg")) {
        const svg = new DOMParser().parseFromString(await zip.file(name).async("string"), "image/svg+xml");
        for (const el of svg.querySelectorAll("[id]")) svgElements[el.id] = Object.fromEntries([...el.attributes].map((attr) => [attr.name, attr.value]));
      }
    }
    for (let i = 1; i <= count; i += 1) {
      const rels = docs.get(`ppt/slides/_rels/slide${i}.xml.rels`);
      for (const rel of rels ? rels.getElementsByTagName("Relationship") : []) {
        const target = rel.getAttribute("Target");
        if (rel.getAttribute("TargetMode") !== "External" && target.startsWith("../") && !zip.file(`ppt/${target.slice(3)}`)) problems.push(`slide ${i} points at a missing ${target}`);
      }
      links.push(rels ? [...rels.getElementsByTagName("Relationship")].filter((rel) => rel.getAttribute("Type").endsWith("/hyperlink")).map((rel) => rel.getAttribute("Target")) : []);
      for (const p of docs.get(`ppt/slides/slide${i}.xml`).getElementsByTagNameNS(A, "p")) {
        if ([...p.children].filter((child) => child.localName === "pPr").length > 1) problems.push(`slide ${i} has a paragraph with more than one a:pPr`);
      }
      const doc = docs.get(`ppt/notesSlides/notesSlide${i}.xml`);
      const body = doc && [...doc.getElementsByTagNameNS(P, "sp")].find((sp) => sp.getElementsByTagNameNS(P, "ph")[0]?.getAttribute("type") === "body");
      notes.push(body ? [...body.getElementsByTagNameNS(A, "p")].map((p) => [...p.getElementsByTagNameNS(A, "*")]
        .filter((el) => el.localName === "t" || el.localName === "br").map((el) => (el.localName === "br" ? "\n" : el.textContent)).join("")).join("\n").trim() : "");
    }
    return { count, notes, links, media, svgElements, problems };
  }, Buffer.from(bytes).toString("base64"));
}

// The toolbar's PowerPoint export downloads a file with one slide and its notes per deck slide.
async function exportCheck(context, site, deck, problems) {
  const page = await openDeck(context, site, "", deck.order[0]);
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.click(".toolbar .export-btn")]);
  const bytes = await readFile(await download.path());
  const filename = `${deck.title}.pptx`;
  if (download.suggestedFilename() !== filename) problems.push(`the export is named ${download.suggestedFilename()}, expected ${filename}`);
  const pptx = await inspectPptx(page, bytes);
  problems.push(...pptx.problems.map((line) => `export: ${line}`));
  if (pptx.count !== deck.order.length) problems.push(`the export has ${pptx.count} slides, deck.json lists ${deck.order.length}`);
  const notes = deck.expect.notes || {};
  deck.order.forEach((id, index) => {
    const want = notes[id] ?? "";
    if (pptx.notes[index] !== undefined && pptx.notes[index] !== want) problems.push(`export notes for ${id}: ${JSON.stringify(pptx.notes[index])}, expected ${JSON.stringify(want)}`);
  });
  // Opaque rasters are JPEG, and app posters link to their app; text links are listed too.
  const expected = deck.expect.export;
  if (expected) {
    const jpegs = pptx.media.filter((name) => /\.jpe?g$/.test(name)).length;
    if (expected.jpeg !== jpegs) problems.push(`the export has ${jpegs} JPEG pictures, expected ${expected.jpeg}: ${pptx.media.join(", ")}`);
    deck.order.forEach((id, index) => {
      const want = expected.links[id] || [];
      const got = (pptx.links[index] || []).map((url) => url.replace(site.url, ""));
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`export links for ${id}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    });
    for (const [id, attributes] of Object.entries(expected.svg || {})) {
      for (const [attribute, want] of Object.entries(attributes)) {
        const got = pptx.svgElements[id]?.[attribute];
        const matches = typeof want === "number" ? got !== undefined && Math.abs(Number(got) - want) <= 1 / 255 : got === want;
        if (!matches) problems.push(`export SVG ${id} ${attribute} is ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
      }
    }
  }
  if (await page.locator(".update-banner").count()) problems.push(`the export shows ${JSON.stringify(await page.locator(".update-banner").textContent())}`);
  await closePage(page);
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
    await exportCheck(context, site, deck, problems);
    if (deck.expect.embed) await embedProtocol(browser, deck, version, problems);
    if (existsSync(path.join(deck.dir, "type"))) problems.push(...await checkThemeFiles([path.join(deck.dir, "type"), CANDIDATE_DIR], `${deck.name}/type`));
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
  if (opts.package) {
    if (opts.base) throw new Error("--base compares with this repository's own package; it does not apply to --package");
    CANDIDATE_DIR = path.resolve(opts.package);
    opts.baseline ??= "none";
  }
  const manifest = JSON.parse(await readFile(path.join(CANDIDATE_DIR, "type.json"), "utf8"));
  TYPE_NAME = manifest.name;
  const candidate = parseVersion(manifest.version);
  if (!candidate) throw new Error(`type.json version ${manifest.version} is not SemVer`);
  const viewer = await readFile(path.join(CANDIDATE_DIR, "viewer.js"), "utf8");
  const declared = /const TYPE_VERSION = "([^"]+)"/.exec(viewer)?.[1];
  if (declared !== candidate.text) failures.push(`viewer.js TYPE_VERSION is ${JSON.stringify(declared)}, type.json version is ${candidate.text}: repin detection compares the two`);
  const declaredName = /const TYPE_NAME = "([^"]+)"/.exec(viewer)?.[1];
  if (declaredName !== manifest.name) failures.push(`viewer.js TYPE_NAME is ${JSON.stringify(declaredName)}, type.json name is ${manifest.name}: repin detection and the host protocol use it`);
  failures.push(...await checkThemeFiles([CANDIDATE_DIR], TYPE_NAME));

  const baselineRef = opts.baseline === "none" ? null : opts.baseline ?? pickBaseline(candidate);
  if (opts.base) checkVersion(candidate, "base", opts.base, failures);
  if (baselineRef) checkVersion(candidate, "baseline", baselineRef, failures);
  const baseline = baselineRef ? await extractPackage(baselineRef) : null;
  const baselineVersion = baselineRef ? versionAt(baselineRef).text : null;
  const accepted = await loadAccepted(candidate.text);
  const decks = await loadDecks(opts.decks);
  console.log(`candidate ${TYPE_NAME}@${candidate.text}, baseline ${baselineRef ? `${baselineRef} (${baselineVersion})` : "none: no visual diff"}, ${decks.length} decks`);

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
