// Renders the preview image of every theme in a Slides package's slides.json: a 640x360 PNG of a cover
// slide with the theme's title and "Aa", in the theme's own scheme, written to the theme's `preview`
// path. Hosts show it as the theme swatch. Run it after adding or changing a theme.
//
//   node checks/preview.mjs [--package <dir>]

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { serveSite } from "./serve.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--package");
const packageDir = path.resolve(at >= 0 ? args[at + 1] : path.join(HERE, "..", "slides"));
const { themes } = JSON.parse(await readFile(path.join(packageDir, "slides.json"), "utf8"));

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const browser = await chromium.launch();
try {
  for (const theme of themes) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slides-preview-"));
    await mkdir(path.join(dataDir, "project", "slides"), { recursive: true });
    await writeFile(path.join(dataDir, "project", "deck.json"), JSON.stringify({ v: 1, title: theme.title, order: ["preview"], theme: { preset: theme.id } }));
    await writeFile(path.join(dataDir, "project", "slides", "preview.html"),
      `<section data-layout="title"><p class="eyebrow" style="font-size: 64px">${escapeHtml(theme.title)}</p><h1 style="font-size: 300px">Aa</h1></section>`);
    const site = await serveSite({ packageDir, dataDir });
    const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    try {
      await page.goto(`${site.url}/?theme=${theme.scheme}#preview`);
      await page.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
      await page.addStyleTag({ content: ".toolbar, .progress { display: none !important; }" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const file = path.join(packageDir, theme.preview);
      await mkdir(path.dirname(file), { recursive: true });
      await page.locator(".stage .slide-host").screenshot({ path: file, animations: "disabled" });
      console.log(`${theme.id}: ${path.relative(process.cwd(), file)}`);
    } finally {
      await page.close();
      await site.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
