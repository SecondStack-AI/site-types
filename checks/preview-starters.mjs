// Render type-owned starter previews with the package's own viewer and themes.
// node checks/preview-starters.mjs [--package /path/to/slides]
import { readFile, writeFile, mkdir, mkdtemp, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { serveSite } from "./serve.mjs";

const at = process.argv.indexOf("--package");
const packageDir = path.resolve(at < 0 ? "slides" : process.argv[at + 1]);
const manifest = JSON.parse(await readFile(path.join(packageDir, "slides.json"), "utf8"));
const { starters } = JSON.parse(await readFile(path.join(packageDir, manifest.starters), "utf8"));
for (const starter of starters) {
  for (const slide of starter.slides) {
    slide.previews = Object.fromEntries(manifest.themes.map((theme) => [
      theme.id, `${starter.directory}/previews/${theme.id}/${slide.id}.png`
    ]));
  }
}
const browser = await chromium.launch();
try {
  for (const starter of starters) {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "slides-starter-"));
    await cp(path.join(packageDir, starter.directory, "project"), path.join(dataDir, "project"), { recursive: true });
    for (const theme of manifest.themes) {
      const deckPath = path.join(dataDir, "project", "deck.json");
      const deck = JSON.parse(await readFile(deckPath, "utf8"));
      deck.theme = { preset: theme.id };
      await writeFile(deckPath, JSON.stringify(deck));
      const site = await serveSite({ packageDir, dataDir });
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      try {
        await page.goto(site.url + "/?check=1");
        await page.waitForFunction(() => document.documentElement.dataset.slidesCheck === "done");
        const report = await page.evaluate(() => window.slidesCheck);
        const issues = [
          ...report.deck.issues,
          ...(report.package?.issues ?? []),
          ...report.slides.flatMap((slide) => slide.issues.map((issue) => ({ slide: slide.id, ...issue })))
        ];
        if (!report.complete || issues.length) {
          throw new Error(`Starter preview check failed for ${starter.id}/${theme.id}: ${JSON.stringify(issues)}`);
        }
        await page.goto(site.url + "/?thumb=1&theme=" + theme.scheme);
        await page.waitForFunction(() => !document.getElementById("app").hasAttribute("aria-busy"));
        await page.evaluate(() => document.fonts.ready);
        for (const slide of starter.slides) {
          await page.evaluate((id) => { window.location.hash = id; }, slide.id);
          await page.waitForTimeout(100);
          const file = path.join(packageDir, slide.previews[theme.id]);
          await mkdir(path.dirname(file), { recursive: true });
          await page.locator(".stage .slide-host").screenshot({ path: file, animations: "disabled" });
        }
        console.log(`${starter.id}/${theme.id}: ${starter.slides.length} previews`);
      } finally {
        await page.close();
        await site.close();
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
await writeFile(path.join(packageDir, manifest.starters), JSON.stringify({ starters }, null, 2) + "\n");
