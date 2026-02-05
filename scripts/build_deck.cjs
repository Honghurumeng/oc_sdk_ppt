#!/usr/bin/env node
/*
  Build a PPTX from a directory of HTML slides.

  Usage:
    node web/scripts/build_deck.cjs <absSlidesDir> <absPptxPath> --tmpDir <tmpDir> --title <title>

  Notes:
  - Uses ../pptx/scripts/html2pptx.js for HTML -> slide conversion.
  - Expects each HTML to set body size to 720pt x 405pt (10" x 5.625").
*/

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tmpDir" || a === "--title") {
      const v = argv[i + 1];
      if (typeof v !== "string" || !v) {
        throw new Error(`Missing value for ${a}`);
      }
      args[a.slice(2)] = v;
      i++;
      continue;
    }
    args._.push(a);
  }
  return args;
}

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

async function main() {
  const args = parseArgs(process.argv);
  const [absSlidesDir, absPptxPath] = args._;
  if (!absSlidesDir || !absPptxPath) {
    throw new Error("Usage: build_deck.cjs <absSlidesDir> <absPptxPath> [--tmpDir <tmpDir>] [--title <title>]");
  }

  const slidesDir = path.resolve(absSlidesDir);
  const outPath = path.resolve(absPptxPath);
  const tmpDir = args.tmpDir ? path.resolve(args.tmpDir) : process.env.TMPDIR || "/tmp";

  const html2pptxPath = path.join(__dirname, "..", "..", "pptx", "scripts", "html2pptx.js");
  // eslint-disable-next-line import/no-dynamic-require
  const html2pptx = require(html2pptxPath);

  // eslint-disable-next-line import/no-dynamic-require
  const PptxGenJS = require("pptxgenjs");
  const pptx = new PptxGenJS();

  // Match HTML size: 720pt x 405pt => 10" x 5.625"
  pptx.defineLayout({ name: "LAYOUT_OC_720x405", width: 10, height: 5.625 });
  pptx.layout = "LAYOUT_OC_720x405";
  pptx.author = "OpenCode PPT Studio";
  if (typeof args.title === "string" && args.title.trim()) {
    pptx.title = args.title.trim().slice(0, 200);
  }

  const files = listHtmlSlides(slidesDir);
  if (files.length === 0) {
    throw new Error(`No .html slides found in: ${slidesDir}`);
  }

  for (const f of files) {
    const absHtml = path.join(slidesDir, f);
    // html2pptx accepts absolute paths.
    // eslint-disable-next-line no-await-in-loop
    await html2pptx(absHtml, pptx, { tmpDir });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await pptx.writeFile({ fileName: outPath });

  process.stdout.write(`OK ${outPath}\n`);
}

main().catch((err) => {
  const msg = err && err.stack ? err.stack : String(err);
  process.stderr.write(msg + "\n");
  process.exit(1);
});
