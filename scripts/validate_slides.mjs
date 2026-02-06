#!/usr/bin/env node
/*
  Validate generated HTML slides for:
  1) Body size equals 720pt x 405pt (CSS pixels ~= 960 x 540 at 96dpi)
  2) No overflow: body.scrollWidth/scrollHeight should not exceed body box size

  Usage:
    node scripts/validate_slides.mjs <absSlidesDir>

  Exit codes:
    0: OK
    1: Validation errors
*/

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PT_PER_PX = 0.75; // 1px = 0.75pt in CSS @ 96dpi
const EXPECT_W_PX = 960; // 720pt -> 960px
const EXPECT_H_PX = 540; // 405pt -> 540px

function listHtmlSlides(absSlidesDir) {
  const files = fs
    .readdirSync(absSlidesDir)
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .sort((a, b) => {
      const na = Number.parseInt(path.basename(a, ".html"), 10);
      const nb = Number.parseInt(path.basename(b, ".html"), 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
  return files;
}

async function getChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    return (await import("playwright-core")).chromium;
  }
}

function fmtPt(n) {
  return `${n.toFixed(1)}pt`;
}

function fmtPx(n) {
  return `${Math.round(n)}px`;
}

async function validateOne(page, absHtml) {
  const url = pathToFileURL(absHtml).toString();
  await page.goto(url, { waitUntil: "load" });

  const res = await page.evaluate(() => {
    const body = document.body;
    const rect = body.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      scrollWidth: body.scrollWidth,
      scrollHeight: body.scrollHeight,
    };
  });

  const errors = [];
  const wDiff = Math.abs(res.width - EXPECT_W_PX);
  const hDiff = Math.abs(res.height - EXPECT_H_PX);
  if (wDiff > 2 || hDiff > 2) {
    errors.push(
      `Body size mismatch: got ${fmtPx(res.width)} x ${fmtPx(res.height)}, expected ${EXPECT_W_PX}px x ${EXPECT_H_PX}px (CSS: 720pt x 405pt)`
    );
  }

  const widthOverflowPx = Math.max(0, res.scrollWidth - res.width - 1);
  const heightOverflowPx = Math.max(0, res.scrollHeight - res.height - 1);
  if (widthOverflowPx > 0 || heightOverflowPx > 0) {
    const directions = [];
    if (widthOverflowPx > 0) directions.push(`${fmtPt(widthOverflowPx * PT_PER_PX)} horizontally`);
    if (heightOverflowPx > 0) directions.push(`${fmtPt(heightOverflowPx * PT_PER_PX)} vertically`);
    errors.push(`HTML content overflows body by ${directions.join(" and ")}`);
  }

  return errors;
}

async function main() {
  const absSlidesDir = process.argv[2];
  if (!absSlidesDir) {
    throw new Error("Usage: node scripts/validate_slides.mjs <absSlidesDir>");
  }

  const slidesDir = path.resolve(absSlidesDir);
  const files = listHtmlSlides(slidesDir);
  if (files.length === 0) {
    throw new Error(`No .html slides found in: ${slidesDir}`);
  }

  const chromium = await getChromium();
  const browser = await chromium.launch({ headless: true });

  const failures = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: EXPECT_W_PX, height: EXPECT_H_PX },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();

    for (const f of files) {
      const absHtml = path.join(slidesDir, f);
      // eslint-disable-next-line no-await-in-loop
      const errs = await validateOne(page, absHtml);
      if (errs.length > 0) failures.push({ file: f, errors: errs });
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    for (const item of failures) {
      process.stderr.write(`\n[${item.file}]\n`);
      for (const e of item.errors) process.stderr.write(`- ${e}\n`);
    }
    process.stderr.write(`\nFAIL ${failures.length}/${files.length} slides\n`);
    process.exit(1);
  }

  process.stdout.write(`OK ${files.length} slides\n`);
}

main().catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
