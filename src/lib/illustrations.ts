import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

import type { LaunchOptions } from "playwright-core";
import { unwrapData, type getOpencodeHandle } from "@/lib/opencode";

import sharp from "sharp";

type OpencodeClient = Awaited<ReturnType<typeof getOpencodeHandle>>["client"];

type ModelOverride =
  | {
      providerID: string;
      modelID: string;
    }
  | undefined;

type Palette = {
  bg?: string;
  fg?: string;
  muted?: string;
  accent?: string;
  accent2?: string;
};

type DomSlot = {
  slotId: string;
  prompt: string;
  rect: { x: number; y: number; w: number; h: number };
  style: { backgroundColor: string; borderRadius: string };
};

type SlideDomData = {
  title: string;
  bullets: string[];
  palette: Palette;
  slots: DomSlot[];
};

type IllustrationSlot = {
  slideFile: string;
  slideTitle: string;
  slideBullets: string[];
  palette: Palette;
  slotId: string;
  prompt: string;
  cssPxW: number;
  cssPxH: number;
  targetPxW: number;
  targetPxH: number;
  backgroundColor: string;
  borderRadius: string;
};

type EnsureIllustrationsResult = {
  ok: boolean;
  slotsFound: number;
  slotsGenerated: number;
  slidesUpdated: string[];
  errors: string[];
};

async function getChromium() {
  // This repo depends on playwright-core (not full playwright).
  return (await import("playwright-core")).chromium;
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeSlotId(raw: string, fallback: string) {
  const v = String(raw || "").trim();
  const cleaned = v
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return cleaned || fallback;
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.round(n);
  return Math.max(min, Math.min(max, x));
}

async function listHtmlSlides(absSlidesDir: string) {
  const files = await fs.readdir(absSlidesDir);
  return files
    .filter((f) => f.toLowerCase().endsWith(".html"))
    .sort((a, b) => {
      const na = Number.parseInt(path.basename(a, ".html"), 10);
      const nb = Number.parseInt(path.basename(b, ".html"), 10);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.localeCompare(b);
    });
}

async function extractSlotsWithPlaywright(opts: {
  absSlidesDir: string;
  slideFiles: string[];
  log?: (msg: string) => void;
}) {
  const { absSlidesDir, slideFiles, log } = opts;
  if (slideFiles.length === 0) return new Map<string, SlideDomData>();

  const chromium = await getChromium();
  const launchOptions: LaunchOptions = { headless: true };
  if (process.platform === "darwin") launchOptions.channel = "chrome";

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const out = new Map<string, SlideDomData>();
  try {
    for (const f of slideFiles) {
      const absHtml = path.join(absSlidesDir, f);
      const url = pathToFileURL(absHtml).toString();
      try {
        await page.goto(url, { waitUntil: "load" });
      } catch (e) {
        log?.(`插图槽位解析失败：无法打开 ${f}（${e instanceof Error ? e.message : String(e)}）`);
        continue;
      }

      const data = (await page.evaluate(() => {
        const getVar = (k: string) =>
          getComputedStyle(document.documentElement).getPropertyValue(k).trim();

        const palette = {
          bg: getVar("--bg"),
          fg: getVar("--fg"),
          muted: getVar("--muted"),
          accent: getVar("--accent"),
          accent2: getVar("--accent2"),
        };

        const title = (document.querySelector("h1")?.textContent || "").trim();

        const bullets = Array.from(document.querySelectorAll("li"))
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean)
          .slice(0, 8);

        const slots = Array.from(document.querySelectorAll("[data-oc-illust-slot]"))
          .map((el) => {
            const slotId = (el.getAttribute("data-oc-illust-slot") || "").trim();
            const prompt = (el.getAttribute("data-oc-illust-prompt") || "").trim();
            const rect = el.getBoundingClientRect();
            const cs = getComputedStyle(el as HTMLElement);
            return {
              slotId,
              prompt,
              rect: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
              style: { backgroundColor: cs.backgroundColor, borderRadius: cs.borderRadius },
            };
          })
          .filter((s) => s.slotId && s.rect.w > 2 && s.rect.h > 2);

        return { title, bullets, palette, slots };
      })) as SlideDomData;

      out.set(f, data);
    }
  } finally {
    await browser.close();
  }

  return out;
}

function buildFallbackSvg(opts: {
  w: number;
  h: number;
  palette: Palette;
  title: string;
}) {
  const { w, h, palette, title } = opts;
  const fg = (palette.fg || "#111111").trim() || "#111111";
  const muted = (palette.muted || "#666666").trim() || "#666666";
  const accent = (palette.accent || "#2F6FED").trim() || "#2F6FED";
  const safeTitle = String(title || "").slice(0, 28).replace(/[<&>"]/g, "");
  const pad = Math.max(12, Math.round(Math.min(w, h) * 0.08));
  const stroke = Math.max(2, Math.round(Math.min(w, h) * 0.012));
  const cx = Math.round(w / 2);
  const cy = Math.round(h / 2);
  const r = Math.round(Math.min(w, h) * 0.28);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect x="${pad}" y="${pad}" width="${w - pad * 2}" height="${h - pad * 2}" rx="${Math.round(pad * 0.75)}" fill="none" stroke="${muted}" stroke-width="${stroke}" opacity="0.55"/>` +
    `<path d="M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0" fill="none" stroke="${accent}" stroke-width="${stroke}" stroke-linecap="round"/>` +
    `<path d="M ${cx + r} ${cy} l ${-Math.round(stroke * 2.2)} ${-Math.round(stroke * 1.6)} l ${Math.round(stroke * 0.2)} ${Math.round(stroke * 3.1)} z" fill="${accent}"/>` +
    (safeTitle
      ? `<text x="${pad}" y="${h - pad}" font-family="Arial" font-size="${Math.max(12, Math.round(Math.min(w, h) * 0.08))}" fill="${fg}" opacity="0.85">${safeTitle}</text>`
      : "") +
    `</svg>`
  );
}

async function rasterizeSvgToPng(svgPath: string, pngPath: string, targetW: number, targetH: number) {
  const svgBuf = await fs.readFile(svgPath);
  const outBuf = await sharp(svgBuf).png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(outBuf).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;

  if (w === targetW && h === targetH) {
    await fs.writeFile(pngPath, outBuf);
    return;
  }

  const resized = await sharp(outBuf)
    .resize(targetW, targetH, { fit: "fill" })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await fs.writeFile(pngPath, resized);
}

function injectSlotImageIntoHtml(html: string, slotId: string, imgSrc: string) {
  const id = escapeRegExp(slotId);
  const imgTag = `<img src="${imgSrc}" style="width:100%;height:100%;display:block;" />`;

  // Fast path: empty slot container.
  const emptyRe = new RegExp(
    `<div([^>]*\\bdata-oc-illust-slot\\s*=\\s*["']${id}["'][^>]*)>\\s*(?:<!--[^]*?-->\\s*)*</div>`,
    "i"
  );
  if (emptyRe.test(html)) {
    return html.replace(emptyRe, `<div$1>${imgTag}</div>`);
  }

  // General path: replace inner content of the first matching container.
  const anyRe = new RegExp(
    `<div([^>]*\\bdata-oc-illust-slot\\s*=\\s*["']${id}["'][^>]*)>([\\s\\S]*?)</div>`,
    "i"
  );
  if (!anyRe.test(html)) return html;
  return html.replace(anyRe, `<div$1>${imgTag}</div>`);
}

export async function ensureIllustrationsForSlides(opts: {
  jobId: string;
  slidesDir: string; // workspace-relative
  client: OpencodeClient;
  model?: ModelOverride;
  log?: (msg: string) => void;
  slideFiles?: string[]; // e.g. ["01.html", ...]
  maxTotalSlots?: number;
  scale?: number; // 2 => ~192dpi
}): Promise<EnsureIllustrationsResult> {
  const {
    jobId,
    slidesDir,
    client,
    model,
    log,
    slideFiles: slideFilesRaw,
    maxTotalSlots = 20,
    scale = 2,
  } = opts;

  const absSlidesDir = path.join(process.cwd(), slidesDir);
  const assetsDirRel = path.posix.join(slidesDir, "assets");
  const absAssetsDir = path.join(absSlidesDir, "assets");

  const errors: string[] = [];
  const slidesUpdated = new Set<string>();

  let slideFiles: string[] = [];
  try {
    slideFiles = Array.isArray(slideFilesRaw) && slideFilesRaw.length > 0
      ? slideFilesRaw
      : await listHtmlSlides(absSlidesDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, slotsFound: 0, slotsGenerated: 0, slidesUpdated: [], errors: [msg] };
  }

  // 1) Extract slots from rendered DOM.
  let domMap: Map<string, SlideDomData>;
  try {
    domMap = await extractSlotsWithPlaywright({ absSlidesDir, slideFiles, log });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, slotsFound: 0, slotsGenerated: 0, slidesUpdated: [], errors: [msg] };
  }

  const slots: IllustrationSlot[] = [];
  for (const f of slideFiles) {
    const slide = domMap.get(f);
    if (!slide) continue;
    for (const s of slide.slots) {
      const fallbackId = `img-${path.basename(f, ".html")}-${slots.length}`;
      const slotId = sanitizeSlotId(s.slotId, fallbackId);
      const cssPxW = s.rect.w;
      const cssPxH = s.rect.h;
      const targetPxW = clampInt(cssPxW * scale, 64, 4096);
      const targetPxH = clampInt(cssPxH * scale, 64, 4096);
      slots.push({
        slideFile: f,
        slideTitle: slide.title,
        slideBullets: slide.bullets,
        palette: slide.palette,
        slotId,
        prompt: s.prompt,
        cssPxW,
        cssPxH,
        targetPxW,
        targetPxH,
        backgroundColor: s.style.backgroundColor,
        borderRadius: s.style.borderRadius,
      });
    }
  }

  if (slots.length === 0) {
    return { ok: true, slotsFound: 0, slotsGenerated: 0, slidesUpdated: [], errors: [] };
  }

  // Cap slot count to avoid runaway generation.
  const cappedSlots = slots.slice(0, Math.max(1, maxTotalSlots));
  if (slots.length > cappedSlots.length) {
    log?.(`检测到 ${slots.length} 个插图槽位；为避免耗时过长，仅处理前 ${cappedSlots.length} 个。`);
  }

  await fs.mkdir(absAssetsDir, { recursive: true });

  // 2) Decide which slots need SVG/PNG generation.
  const need: IllustrationSlot[] = [];
  for (const s of cappedSlots) {
    const svgPath = path.join(absAssetsDir, `${s.slotId}.svg`);
    const pngPath = path.join(absAssetsDir, `${s.slotId}.png`);
    try {
      const st = await fs.stat(pngPath);
      if (st.size > 0) {
        // Verify dimensions; if mismatch, regenerate.
        const meta = await sharp(pngPath).metadata();
        if (meta.width === s.targetPxW && meta.height === s.targetPxH) continue;
      }
    } catch {
      // ignore
    }

    // If svg exists and is non-empty, we can rasterize without LLM.
    try {
      const stSvg = await fs.stat(svgPath);
      if (stSvg.size > 0) {
        need.push(s);
        continue;
      }
    } catch {
      need.push(s);
    }
  }

  // 3) Ask LLM to generate missing SVGs (best-effort).
  const missingSvg: IllustrationSlot[] = [];
  for (const s of need) {
    try {
      const st = await fs.stat(path.join(absAssetsDir, `${s.slotId}.svg`));
      if (st.size > 0) continue;
    } catch {
      // missing
    }
    missingSvg.push(s);
  }

  let slotsGenerated = 0;

  if (missingSvg.length > 0) {
    const items = missingSvg
      .map((s, idx) => {
        const title = (s.slideTitle || "").trim();
        const prompt = (s.prompt || "").trim();
        const bullets = s.slideBullets.slice(0, 6);
        const pal = s.palette;
        return [
          `${idx + 1}) slotId=${s.slotId}`,
          `- 输出：${path.posix.join(assetsDirRel, `${s.slotId}.svg`)}`,
          `- 像素尺寸：${s.targetPxW} x ${s.targetPxH}`,
          title ? `- Slide 标题：${title}` : "- Slide 标题：（空）",
          prompt ? `- 插图意图：${prompt}` : "- 插图意图：根据标题与要点自行拟合",
          bullets.length > 0 ? `- 要点：${bullets.map((b) => sanitizeOneLine(b)).join(" / ")}` : "- 要点：（无）",
          `- 调色板：bg=${pal.bg || ""} fg=${pal.fg || ""} muted=${pal.muted || ""} accent=${pal.accent || ""} accent2=${pal.accent2 || ""}`,
        ].join("\n");
      })
      .join("\n\n");

    const instruction = [
      "你是 PPT 插图生成器（SVG）。",
      "你可以使用 shell/文件工具在当前工作区内创建文件。",
      "目标：为 HTML slides 中的插图槽位生成 SVG 文件。不要修改任何 HTML 文件。",
      "执行原则：严格遵循每个 slot 的 插图意图（data-oc-illust-prompt）。若 prompt 采用类似 '图型=...; 元素=...; 关系=...; 布局=...; 强调=...; 文案=...' 的格式，把它当作规格逐项落实，不要忽略字段。",
      "内容对齐：优先复用 Slide 标题/要点里的术语作为节点标签；不要编造与要点冲突的概念或数字。若需要数字但要点里没有，就只画结构与标签，不要硬填数字。",
      "",
      `输出目录（必须严格一致）：${assetsDirRel}`,
      "",
      "SVG 规范（必须全部满足）：",
      "- 每个 slot 生成 1 个独立 SVG 文件：<slotId>.svg",
      "- 根元素必须包含 width=目标宽度(height 同理) 且 viewBox 必须为 '0 0 width height'（数值必须与像素尺寸一致）",
      "- 背景透明（不要画整块底色），让页面里的卡片底色透出来",
      "- 只用基础矢量元素：<path>/<rect>/<circle>/<line>/<text>，不要用外链资源、不要用 <image>、不要用 <foreignObject>",
      "- 线框插图风格：少量色块 + 清晰线条；stroke-linecap/linejoin=round；避免超细线",
      "- 若使用文字：仅用 Arial；字号不要小于 14px；文字尽量少",
      "- 版式：四周留出约 6-10% 内边距，避免图形贴边或被裁切；元素对齐、间距一致",
      "- 不要在 SVG 中嵌入或引用位图",
      "",
      "需要生成的插图槽位如下（逐个生成，务必按像素尺寸）：",
      items,
      "",
      "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
      `1) 创建目录：mkdir -p ${assetsDirRel}`,
      "2) 为每个 slot 写入对应的 SVG 文件（路径与文件名必须严格一致）",
      "3) 自检：确认每个 SVG 文件存在且非空；width/height/viewBox 与要求一致。",
      "",
      "最后只输出：DONE",
    ].join("\n");

    try {
      log?.(`生成插图 SVG：${missingSvg.length} 个槽位…`);

      // IMPORTANT: generate SVGs in a fresh session (clean context), so the
      // illustration generator is not influenced by the main deck session.
      const svgSession = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT SVG Illustrations: ${jobId}` },
        })
      );
      if (!svgSession?.id) {
        throw new Error("创建 SVG session 失败：未返回 session.id");
      }

      log?.(`SVG sessionId=${svgSession.id}`);
      await client.session.prompt({
        path: { id: svgSession.id },
        body: {
          parts: [{ type: "text", text: instruction }],
          model,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`LLM 生成 SVG 失败：${msg}`);
      log?.(`LLM 生成 SVG 失败（将回退到内置占位插图）：${msg}`);
    }
  }

  // 4) Rasterize SVG -> PNG (with fallback).
  for (const s of need) {
    const svgPath = path.join(absAssetsDir, `${s.slotId}.svg`);
    const pngPath = path.join(absAssetsDir, `${s.slotId}.png`);
    let svgExists = false;
    try {
      const st = await fs.stat(svgPath);
      svgExists = st.size > 0;
    } catch {
      svgExists = false;
    }

    if (!svgExists) {
      const fallback = buildFallbackSvg({
        w: s.targetPxW,
        h: s.targetPxH,
        palette: s.palette,
        title: s.prompt || s.slideTitle || s.slotId,
      });
      try {
        await fs.writeFile(svgPath, fallback, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`写入 fallback SVG 失败（${s.slotId}）：${msg}`);
        continue;
      }
    }

    try {
      await rasterizeSvgToPng(svgPath, pngPath, s.targetPxW, s.targetPxH);
      slotsGenerated++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`SVG 转 PNG 失败（${s.slotId}）：${msg}`);
    }
  }

  // 5) Inject <img> into HTML slides.
  for (const slideFile of slideFiles) {
    const slideSlots = cappedSlots.filter((s) => s.slideFile === slideFile);
    if (slideSlots.length === 0) continue;

    let html = "";
    const absHtml = path.join(absSlidesDir, slideFile);
    try {
      html = await fs.readFile(absHtml, "utf-8");
    } catch {
      continue;
    }
    const before = html;

    for (const s of slideSlots) {
      const pngRel = `assets/${s.slotId}.png`;
      const pngAbs = path.join(absAssetsDir, `${s.slotId}.png`);
      try {
        const st = await fs.stat(pngAbs);
        if (st.size <= 0) continue;
      } catch {
        continue;
      }

      html = injectSlotImageIntoHtml(html, s.slotId, pngRel);
    }

    if (html !== before) {
      try {
        await fs.writeFile(absHtml, html, "utf-8");
        slidesUpdated.add(slideFile);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`写回 HTML 失败（${slideFile}）：${msg}`);
      }
    }
  }

  // 6) Write spec/manifest for debugging.
  try {
    const spec = {
      version: 1,
      jobId,
      scale,
      slots: cappedSlots.map((s) => ({
        slideFile: s.slideFile,
        slotId: s.slotId,
        prompt: s.prompt,
        cssPxW: s.cssPxW,
        cssPxH: s.cssPxH,
        targetPxW: s.targetPxW,
        targetPxH: s.targetPxH,
        backgroundColor: s.backgroundColor,
        borderRadius: s.borderRadius,
        palette: s.palette,
      })),
      generatedAt: Date.now(),
    };
    await fs.writeFile(
      path.join(absAssetsDir, "illustrations.spec.json"),
      JSON.stringify(spec, null, 2),
      "utf-8"
    );
  } catch {
    // ignore
  }

  return {
    ok: errors.length === 0,
    slotsFound: slots.length,
    slotsGenerated,
    slidesUpdated: Array.from(slidesUpdated),
    errors,
  };
}

function sanitizeOneLine(s: string) {
  return String(s || "").replace(/[\r\n\t]+/g, " ").trim();
}
