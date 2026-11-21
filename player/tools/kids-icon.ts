import { chromium } from "playwright-core";
import { resolve } from "node:path";
import { THEMES } from "../src/theme";

const colors = THEMES.kids.colors;
const out = resolve(import.meta.dirname, "../public/kids");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="${colors.ground}"/>
  <circle cx="100" cy="100" r="82" fill="${colors.warn}"/>
  <circle cx="100" cy="100" r="70" fill="${colors.highlight}"/>
  <path d="M52 76 C62 52 84 42 108 42" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round" opacity="0.8"/>
  <ellipse cx="76" cy="94" rx="9" ry="13" fill="${colors.ink}"/>
  <ellipse cx="124" cy="94" rx="9" ry="13" fill="${colors.ink}"/>
  <path d="M72 122 C84 144 116 144 128 122" fill="none" stroke="${colors.ink}" stroke-width="8" stroke-linecap="round"/>
</svg>`;

await Bun.write(`${out}/icon.svg`, svg);
const browser = await chromium.launch();
for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]] as const) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.screenshot({ path: `${out}/${name}` });
  await page.close();
}
await browser.close();
