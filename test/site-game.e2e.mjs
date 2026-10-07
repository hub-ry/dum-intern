// Targeted live regression: SITE_E2E_BROWSER=/path/to/chrome node --import tsx --test test/site-game.e2e.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";

test("Dum remains visible throughout a jump at desktop and mobile widths", async () => {
  assert.ok(process.env.SITE_E2E_BROWSER, "provide a Chromium executable with SITE_E2E_BROWSER");
  const root = resolve(process.env.SITE_E2E_ROOT ?? ".");
  const { createServer } = await import(pathToFileURL(join(root, "src/web/server.ts")).href);
  const temporary = mkdtempSync(join(process.cwd(), ".site-game-e2e-"));
  const previousHome = process.env.DUM_HOME;
  process.env.DUM_HOME = join(temporary, "home");
  const server = createServer({ data: join(temporary, "data") });
  let browser;
  try {
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    browser = await puppeteer.launch({
      executablePath: process.env.SITE_E2E_BROWSER,
      headless: true,
      args: ["--no-sandbox"],
      userDataDir: join(temporary, "browser"),
    });
    const page = await browser.newPage();
    const observations = [];
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle0" });
      await page.click("#game-jump");
      await page.waitForFunction(() => document.querySelector("#game-jump")?.textContent === "jump");
      await page.click("#game-jump");
      const frames = await page.$eval("#game-canvas", (element) => new Promise((done) => {
        const canvas = element;
        const context = canvas.getContext("2d");
        const start = performance.now();
        const counts = [];
        const sample = () => {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let ink = 0;
          let top = canvas.height;
          let bottom = -1;
          for (let i = 0; i < pixels.length; i += 4) {
            // Both visible amber colors of the authored Dum character.
            if ((pixels[i] === 217 && pixels[i + 1] === 154 && pixels[i + 2] === 60) ||
                (pixels[i] === 240 && pixels[i + 1] === 194 && pixels[i + 2] === 102)) {
              ink++;
              const y = Math.floor(i / 4 / canvas.width);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
          counts.push({ ink, top, height: bottom - top + 1 });
          if (performance.now() - start < 850) requestAnimationFrame(sample);
          else done(counts);
        };
        sample();
      }));
      observations.push({
        width,
        frames: frames.length,
        minimumVisiblePixels: Math.min(...frames.map((frame) => frame.ink)),
        maximumVisiblePixels: Math.max(...frames.map((frame) => frame.ink)),
        verticalTravel: Math.max(...frames.map((frame) => frame.top)) - Math.min(...frames.map((frame) => frame.top)),
        spriteHeight: Math.max(...frames.map((frame) => frame.height)),
      });
    }
    console.log(JSON.stringify(observations));
    for (const result of observations) {
      assert.ok(result.minimumVisiblePixels > 0,
        `Dum disappears from the rendered game during a jump at ${result.width}px width`);
      // Run and jump poses have slightly different amber counts; clipping loses more.
      assert.ok(result.minimumVisiblePixels >= result.maximumVisiblePixels * 0.95,
        `Dum is partially clipped during a jump at ${result.width}px width`);
      assert.ok(result.verticalTravel > result.spriteHeight,
        `Dum must visibly jump at ${result.width}px width`);
    }
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(() => done()));
    if (previousHome === undefined) delete process.env.DUM_HOME;
    else process.env.DUM_HOME = previousHome;
    rmSync(temporary, { recursive: true, force: true });
  }
});
