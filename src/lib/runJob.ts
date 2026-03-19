import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { getOpencodeHandle, unwrapData } from "@/lib/opencode";
import {
  buildPptContentOutlineSystemPrompt,
  buildPptDesignOutlineSystemPrompt,
} from "@/lib/pptContentSkill";
import { snapshotSlideVersions, ensureSlideVersionsInitialized, listHtmlSlides as listHtmlSlidesByJob } from "@/lib/slideVersions";
import {
  getJob,
  pushEvent,
  setJob,
  type PptJobInput,
  type PptJobStatus,
} from "@/lib/jobStore";

function now() {
  return Date.now();
}

function log(jobId: string, message: string) {
  pushEvent(jobId, { type: "log", message, ts: now() });
}

function setStatus2(jobId: string, status: PptJobStatus) {
  setJob(jobId, { status });
  pushEvent(jobId, { type: "status", status, ts: now() });
}

function sanitizeOneLine(s: string) {
  return s.replace(/[\r\n\t]+/g, " ").trim();
}

function sanitizeMultiline(s: string) {
  // Keep newlines for context blocks, but remove NUL and normalize CRLF.
  return s.replace(/\0/g, "").replace(/\r\n/g, "\n");
}

function clampInt(n: number, min: number, max: number) {
  const x = Math.round(n);
  return Math.max(min, Math.min(max, x));
}

function getRequestedSlideCount(input: PptJobInput):
  | { mode: "fixed"; count: number }
  | { mode: "auto" } {
  const raw = input.slideCount;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (raw === 0) return { mode: "auto" };
    if (raw > 0) return { mode: "fixed", count: clampInt(raw, 3, 20) };
  }
  return { mode: "fixed", count: 8 };
}

function countSlidesFromOutlineMarkdown(md: string): number | null {
  const lines = md.split("\n");
  let count = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+Slide\s+\d+\s*:/i.test(line)) count++;
  }
  return count > 0 ? count : null;
}

function parseProviderModel(s: string) {
  const v = s.trim();
  const idx = v.indexOf("/");
  if (idx <= 0 || idx >= v.length - 1) return null;
  const providerID = v.slice(0, idx).trim();
  const modelID = v.slice(idx + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function getModelOverride(input: PptJobInput) {
  if (input.model) {
    const parsed = parseProviderModel(input.model);
    if (parsed) return parsed;
  }
  if (process.env.OPENCODE_MODEL_PROVIDER && process.env.OPENCODE_MODEL_ID) {
    return {
      providerID: process.env.OPENCODE_MODEL_PROVIDER,
      modelID: process.env.OPENCODE_MODEL_ID,
    };
  }
  return undefined;
}

function buildOutlineInstruction(jobId: string, input: PptJobInput) {
  const topic = sanitizeOneLine(input.topic);
  const language = sanitizeOneLine(input.language ?? "中文");
  const slideConfig = getRequestedSlideCount(input);
  const audience = sanitizeOneLine(input.audience ?? "一般受众");
  const tone = sanitizeOneLine(input.tone ?? "专业、清晰、偏实用");
  const referenceContentRaw =
    typeof input.referenceContent === "string" ? input.referenceContent.trim() : "";
  const referenceContent = referenceContentRaw
    ? sanitizeMultiline(referenceContentRaw).slice(0, 8000)
    : "";

  // workspace 相对路径：Next 项目根目录下的 web/workspace
  const outDir = `workspace/jobs/${jobId}`;
  const outlinePath = `${outDir}/outline.md`;

  const instruction = [
    "你是一个 PPT 生成助手。你可以使用 shell/文件工具在当前工作区内创建文件。",
    "目标：先生成 PPT 大纲（仅内容结构，不生成 PPTX 文件）。",
    "",
    `主题：${topic}`,
    `语言：${language}`,
    slideConfig.mode === "fixed"
      ? `页数：${slideConfig.count}`
      : "页数：由你决定（输入页数=0；请在 3-20 范围内选择最合适的页数，并在大纲中体现）",
    `受众：${audience}`,
    `语气/风格：${tone}`,
    referenceContent
      ? "\n参考内容（供引用；不要生搬硬套，必要时可压缩改写；可能包含多行）：\n```text\n" +
        referenceContent +
        "\n```\n"
      : "",
    "",
    "强制输出路径（必须严格一致）：",
    `- 输出目录：${outDir}`,
    `- 大纲文件：${outlinePath}`,
    "",
    "大纲格式要求：",
    "- 输出为 Markdown，先写全局视觉规划，再按 slide 分节",
    "- 文件开头先输出一个“## Visual System”区块，至少包含：整体风格、配色、字体层级、页面骨架、图表策略",
    "- 然后按 slide 分节，使用 ## Slide N: 标题",
    slideConfig.mode === "auto"
      ? "- Slide 必须从 1 连续编号到你决定的最后一页（不要跳号/重复号）"
      : "- Slide 必须从 1 连续编号到最后一页（不要跳号/重复号）",
    "- 每页给出 3-6 个要点（用 - 列表），必要时加一行讲者备注（Notes: ...）",
    "- 每页必须加一行视觉说明：Visual: ...（描述布局/图表/流程/视觉重心）",
    "- 内容密度适配页数，不要出现空洞口号",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    `1) 创建目录：mkdir -p ${outDir}`,
    `2) 写入大纲到 ${outlinePath}`,
    "3) 自检：确认大纲文件存在且内容完整；Slide 编号连续；页数与内容密度匹配。",
    "",
    "最后只输出：DONE + 大纲路径，不要输出大段解释。",
  ].join("\n");

  return { instruction, outDir, outlinePath };
}

function buildOutlineReviewInstruction(
  input: PptJobInput,
  opts: { draftOutlinePath: string; outlinePath: string }
) {
  const slideConfig = getRequestedSlideCount(input);
  const topic = sanitizeOneLine(input.topic);
  const language = sanitizeOneLine(input.language ?? "中文");
  const audience = sanitizeOneLine(input.audience ?? "一般受众");
  const tone = sanitizeOneLine(input.tone ?? "专业、清晰、偏实用");

  const slideCountRule =
    slideConfig.mode === "fixed"
      ? `- 保持页数不变：必须仍为 ${slideConfig.count} 页`
      : "- 保持现有 slide 数量，不要新增或删减页数";

  const instruction = [
    "你是 PPT 大纲审稿与精修助手。你可以使用 shell/文件工具在当前工作区内编辑文件。",
    "目标：读取已生成的大纲初稿，做一次严格检查和精修，输出为更清晰、更可讲、更适合后续排版的版本。",
    "",
    `主题：${topic}`,
    `语言：${language}`,
    `受众：${audience}`,
    `语气/风格：${tone}`,
    "",
    "输入与输出路径（必须严格一致）：",
    `- 初稿：${opts.draftOutlinePath}`,
    `- 精修后输出：${opts.outlinePath}`,
    "",
    "精修要求：",
    "- 先完整阅读初稿，再统一精修；不要只改局部措辞。",
    slideCountRule,
    "- 保留并优化“## Visual System”区块，使其和整套 slides 更一致、更可执行。",
    "- 保留 `## Slide N: 标题` 结构，编号必须连续，标题要更具体、更能支撑讲述。",
    "- 每页仍保持 3-6 个要点；去掉重复、空泛或功能重叠的表达。",
    "- 每页必须保留 `Visual: ...`，且描述足够具体，能直接指导后续 HTML 排版。",
    "- `Notes: ...` 仅在确实能帮助讲述时保留或补充；避免把 bullet 重复一遍。",
    "- 优先修正：叙事跳跃、教学链路不顺、前后重复、视觉骨架单一、结论不够聚焦。",
    "",
    "自检清单：",
    "- 内容逻辑是否从开场到收束形成闭环",
    "- 页面职责是否清晰，没有两页在做同一件事",
    "- 视觉描述是否多样且和页面内容匹配",
    "- 大纲是否适合直接进入下一步 HTML 生成",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    `1) 读取初稿：cat ${opts.draftOutlinePath}`,
    `2) 精修后写回：${opts.outlinePath}`,
    "3) 自检：确保文件存在、非空、编号连续、Visual 行完整",
    "",
    "最后只输出：DONE + 精修后大纲路径。",
  ].join("\n");

  return { instruction };
}

function buildOutlineSkillSystemPrompt(input: PptJobInput) {
  return [
    buildPptContentOutlineSystemPrompt(input),
    "",
    buildPptDesignOutlineSystemPrompt(input),
  ].join("\n\n");
}

function buildDeckInstruction(
  jobId: string,
  input: PptJobInput,
  opts?: { effectiveSlideCount?: number | null }
) {
  const topic = sanitizeOneLine(input.topic);
  const language = sanitizeOneLine(input.language ?? "中文");
  const slideConfig = getRequestedSlideCount(input);
  const slideCount =
    typeof opts?.effectiveSlideCount === "number" && Number.isFinite(opts.effectiveSlideCount)
      ? clampInt(opts.effectiveSlideCount, 1, 50)
      : slideConfig.mode === "fixed"
        ? slideConfig.count
        : null;

  const outDir = `workspace/jobs/${jobId}`;
  const slidesDir = `${outDir}/slides`;
  const outlinePath = `${outDir}/outline.md`;
  const pptxPath = `${outDir}/deck.pptx`;

  const stylePreset = sanitizeOneLine(input.stylePreset ?? "Editorial");
  const palette = sanitizeOneLine(input.palette ?? "Sand & Ink");

  function normalizeKey(s: string) {
    return s.trim().toLowerCase();
  }

  function buildStylePresetGuide(presetRaw: string, paletteRaw: string) {
    const preset = normalizeKey(presetRaw);
    const palette = normalizeKey(paletteRaw);

    // Keep this guide short, prescriptive, and safe for the html2pptx validator.
    // The model will likely default to a single UL-heavy layout unless we provide
    // multiple concrete layout skeletons.
    const paletteHints: Record<
      string,
      { bg: string; fg: string; muted: string; accent: string; accent2?: string }
    > = {
      "sand & ink": {
        bg: "#F4F0E6",
        fg: "#141414",
        muted: "#6B6257",
        accent: "#B05A2A",
      },
      "slate & citrus": {
        bg: "#F3F5F7",
        fg: "#111418",
        muted: "#5C6770",
        accent: "#F28C28",
      },
      "navy & brass": {
        bg: "#F6F3EA",
        fg: "#0B1B3A",
        muted: "#5C5A52",
        accent: "#B08D3A",
      },
      "pine & cream": {
        bg: "#FBF7ED",
        fg: "#10221B",
        muted: "#5C6A62",
        accent: "#1E6B4E",
      },
      "teal & coral": {
        bg: "#F3FBFA",
        fg: "#0E1A1A",
        muted: "#4E6766",
        accent: "#0B7285",
        accent2: "#FF6B6B",
      },
      "graphite & sky": {
        bg: "#F6F8FB",
        fg: "#1B1F24",
        muted: "#66707A",
        accent: "#3B82F6",
      },
    };

    const chosenPalette =
      paletteHints[palette] ??
      ({ bg: "#F6F6F6", fg: "#111111", muted: "#666666", accent: "#2F6FED" } as const);

    const presetNotes: Record<string, string> = {
      editorial:
        "杂志排版：大标题 + 导语 + 分区要点；留白更大；避免堆满整页列表。",
      "modern grid": "网格对齐：2 列/3 列卡片、模块分区；对齐线清晰。",
      "minimal swiss": "极简瑞士：少色块、强字号层级、严格对齐与间距。",
      "corporate clean": "企业简报：标题条/分隔线/模块标题清晰，适合汇报。",
      "data brief": "数据简报：每页 1 结论 + 证据点 + 图表占位（可用矩形区块）。",
      "product pitch": "路演：强主张 + 3 个价值点 + 证明/落地；文案短、有冲击。",
    };

    const note = presetNotes[preset] ??
      "自定义 preset：请把它理解为一个排版方向，并用下面的模板库选择最匹配的骨架。";

    // Multi-template library: the model should pick 2-3 templates and mix.
    // IMPORTANT: All visible text must be inside p/h1-h6/ul/ol; div must not contain bare text.
    return [
      "风格预设指南（请严格遵循；不要只用单一 ul 布局）：",
      `- preset 解释：${note}`,
      "- 目标：同一 deck 内可复用 2-3 种页面骨架；保持统一（字号/间距/网格），但不要每页都变成“标题+一个长 ul”。",
      "- 统一 CSS 变量（每页都定义同一套，便于一致性）：",
      "```css",
      ":root{",
      `  --bg:${chosenPalette.bg};`,
      `  --fg:${chosenPalette.fg};`,
      `  --muted:${chosenPalette.muted};`,
      `  --accent:${chosenPalette.accent};`,
      chosenPalette.accent2 ? `  --accent2:${chosenPalette.accent2};` : "  --accent2:var(--accent);",
      "  --pad-x:48pt;",
      "  --pad-top:32pt;",
      "  --pad-bottom:48pt; /* 保证底部安全区 */",
      "}",
      "body{width:720pt;height:405pt;margin:0;padding:var(--pad-top) var(--pad-x) var(--pad-bottom);box-sizing:border-box;background:var(--bg);color:var(--fg);}",
      "h1{margin:0 0 12pt 0;font-size:34pt;line-height:1.08;letter-spacing:-0.2pt;}",
      "h2{margin:0 0 10pt 0;font-size:22pt;line-height:1.15;}",
      "p{margin:0 0 10pt 0;font-size:18pt;line-height:1.25;}",
      "ul,ol{margin:0;padding-left:22pt;}",
      "li{margin:0 0 6pt 0;font-size:18pt;line-height:1.2;}",
      ".muted{color:var(--muted);} ",
      "```",
      "模板库（按 preset 选择；每页选 1 个骨架，必要时微调；不要把所有正文都塞进一个 ul）：",
      "1) Editorial Lead（适合 Editorial/Corporate）：",
      "```html",
      "<body>",
      "  <div style=\"display:flex;flex-direction:column;gap:14pt;\">",
      "    <div>",
      "      <h1>Slide Title</h1>",
      "      <p class=\"muted\">一句导语：用 16-22 个字概括本页观点。</p>",
      "    </div>",
      "    <div style=\"display:flex;gap:28pt;\">",
      "      <div style=\"flex:1;\">",
      "        <h2>要点</h2>",
      "        <ul><li>短要点 1</li><li>短要点 2</li><li>短要点 3</li></ul>",
      "      </div>",
      "      <div style=\"width:220pt;\">",
      "        <div style=\"height:190pt;background:#E9E3D8;border-radius:10pt;padding:14pt;display:flex;align-items:center;justify-content:center;\">",
      "          <p class=\"muted\" style=\"font-size:16pt;\">概念结构 / 关系示意区</p>",
      "        </div>",
      "        <p class=\"muted\" style=\"margin-top:8pt;font-size:14pt;line-height:1.25;\">用原生 HTML/CSS 表达结构图示</p>",
      "      </div>",
      "    </div>",
      "  </div>",
      "</body>",
      "```",
      "2) Modern Grid Cards（适合 Modern Grid/Data Brief/Product Pitch）：",
      "```html",
      "<body>",
      "  <h1>Slide Title</h1>",
      "  <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:14pt;margin-top:10pt;\">",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:6pt;\">模块 A</h2>",
      "      <p class=\"muted\" style=\"font-size:16pt;\">一句解释或 2 条短句。</p>",
      "      <ul><li>要点</li><li>要点</li></ul>",
      "    </div>",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:6pt;\">模块 B</h2>",
      "      <ul><li>要点</li><li>要点</li><li>要点</li></ul>",
      "    </div>",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:6pt;\">模块 C</h2>",
      "      <p class=\"muted\" style=\"font-size:16pt;\">一句说明。</p>",
      "    </div>",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:6pt;\">模块 D</h2>",
      "      <ul><li>要点</li><li>要点</li></ul>",
      "    </div>",
      "  </div>",
      "</body>",
      "```",
      "3) Minimal Swiss Type（适合 Minimal Swiss/Editorial）：",
      "```html",
      "<body>",
      "  <div style=\"display:flex;flex-direction:column;gap:12pt;\">",
      "    <h1 style=\"font-size:38pt;\">一句强标题</h1>",
      "    <div style=\"height:2pt;background:var(--accent);width:64pt;\"></div>",
      "    <p class=\"muted\" style=\"font-size:16pt;\">副标题/限定条件（短）。</p>",
      "    <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:22pt;margin-top:8pt;\">",
      "      <div><h2>原则 1</h2><p>一句解释。</p></div>",
      "      <div><h2>原则 2</h2><p>一句解释。</p></div>",
      "      <div><h2>原则 3</h2><p>一句解释。</p></div>",
      "      <div><h2>原则 4</h2><p>一句解释。</p></div>",
      "    </div>",
      "  </div>",
      "</body>",
      "```",
      "4) Corporate Header + Sections（适合 Corporate Clean）：",
      "```html",
      "<body>",
      "  <div style=\"display:flex;align-items:flex-end;justify-content:space-between;\">",
      "    <h1 style=\"margin-bottom:0;\">Slide Title</h1>",
      "    <p class=\"muted\" style=\"margin:0;font-size:14pt;\">日期/版本</p>",
      "  </div>",
      "  <div style=\"height:1pt;background:#D6D6D6;margin:10pt 0 14pt;\"></div>",
      "  <div style=\"display:grid;grid-template-columns:1fr 1fr;gap:22pt;\">",
      "    <div><h2>现状</h2><ul><li>要点</li><li>要点</li></ul></div>",
      "    <div><h2>下一步</h2><ol><li>动作</li><li>动作</li></ol></div>",
      "  </div>",
      "</body>",
      "```",
      "5) Data Brief（适合 Data Brief）：",
      "```html",
      "<body>",
      "  <h1>本页结论（一个句子）</h1>",
      "  <div style=\"display:flex;gap:18pt;margin-top:8pt;\">",
      "    <div style=\"flex:1;background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:6pt;\">证据</h2>",
      "      <ul><li>数据点/事实 1（含数字）</li><li>数据点/事实 2</li><li>限制条件/口径</li></ul>",
      "    </div>",
      "    <div style=\"width:300pt;background:#FFFFFF;border-radius:12pt;padding:14pt 16pt;\">",
      "      <h2 style=\"margin-bottom:8pt;\">图表占位</h2>",
      "      <div style=\"height:190pt;background:#E9EEF8;border-radius:10pt;padding:12pt;display:flex;align-items:flex-end;gap:10pt;\">",
      "        <div style=\"flex:1;height:56%;background:var(--accent);border-radius:6pt 6pt 0 0;\"></div>",
      "        <div style=\"flex:1;height:80%;background:#9CC6FF;border-radius:6pt 6pt 0 0;\"></div>",
      "        <div style=\"flex:1;height:42%;background:#C8DCF9;border-radius:6pt 6pt 0 0;\"></div>",
      "      </div>",
      "      <p class=\"muted\" style=\"margin-top:8pt;font-size:14pt;\">图注/口径</p>",
      "    </div>",
      "  </div>",
      "</body>",
      "```",
      "6) Product Pitch（适合 Product Pitch）：",
      "```html",
      "<body>",
      "  <h1 style=\"font-size:40pt;\">我们要解决的关键问题</h1>",
      "  <p class=\"muted\" style=\"font-size:16pt;\">一句话定位：面向谁，解决什么，带来什么结果。</p>",
      "  <div style=\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:12pt;margin-top:14pt;\">",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:12pt 12pt;\"><h2 style=\"font-size:18pt;\">价值 1</h2><p class=\"muted\" style=\"font-size:14pt;\">一句解释</p></div>",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:12pt 12pt;\"><h2 style=\"font-size:18pt;\">价值 2</h2><p class=\"muted\" style=\"font-size:14pt;\">一句解释</p></div>",
      "    <div style=\"background:#FFFFFF;border-radius:12pt;padding:12pt 12pt;\"><h2 style=\"font-size:18pt;\">价值 3</h2><p class=\"muted\" style=\"font-size:14pt;\">一句解释</p></div>",
      "  </div>",
      "  <div style=\"margin-top:12pt;\"><h2>证明/落地</h2><ul><li>证据点</li><li>落地动作</li></ul></div>",
      "</body>",
      "```",
    ].join("\n");
  }

  const instruction = [
    "你是一个 PPT 生成助手。你可以使用 shell/文件工具在当前工作区内创建文件并运行脚本。",
    "目标：基于已存在的大纲文件生成每一页的 HTML slide（仅生成 HTML，不需要生成 PPTX）。",
    "",
    `主题：${topic}`,
    `语言：${language}`,
    slideCount ? `页数：${slideCount}` : "页数：与大纲一致（由大纲决定）",
    `风格预设：${stylePreset}`,
    `配色方案：${palette}`,
    "",
    "强制输入/输出路径（必须严格一致）：",
    `- 大纲输入：${outlinePath}`,
    `- HTML slides 目录：${slidesDir}`,
    "",
    "大纲消费规则（必须落实到 HTML）：",
    "- 先完整读取大纲中的 `## Visual System`，把它当作整套 deck 的设计系统来源。",
    "- 每页生成前，读取对应 slide 的 `Visual: ...`，并把它落实为页面布局、信息重心、图表/流程/对比结构。",
    "- `Notes: ...` 只用于理解讲解顺序、强调重点和节奏，不要直接渲染到页面中。",
    "- 优先使用原生 HTML/CSS 构建图表、流程、对比、坐标系、卡片和步骤结构，不依赖图片生成。",
    "",
    "工具链硬约束（必须全部满足，否则本地转换会失败）：",
    "- HTML body 必须设置为 720pt × 405pt（16:9），所有可见文字必须放在 p/h1-h6/ul/ol 中。",
    "- 禁止任何 CSS 渐变（linear-gradient/radial-gradient）。",
    "- 禁止在任何 <div> 上使用 background-image（包括 url(...)）；如需背景图，只允许设置在 body 上：background-image:url('assets/xxx.png')。",
    "- 图片引用规则：只允许本地相对路径 assets/...；禁止 http(s) 与 data: 图片。",
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow；需要分隔线/底色/阴影请用 div 来实现。",
    "- div 内不要出现裸文本（比如直接写 Notes: ...）；必须用 p/h1-h6/ul/ol 包裹。",
    "- 不要生成 data-oc-illust-slot / data-oc-illust-prompt / 自动插图相关结构。",
    "- 不要输出 Notes: 行（避免触发校验问题）。",
    "- 内容必须留出底部至少 0.5 英寸（约 36pt）空白，避免文字贴底或溢出。",
    "",
    buildStylePresetGuide(stylePreset, palette),
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    slideCount
      ? `1) 读取大纲：cat ${outlinePath}（确认 slide 数量为 ${slideCount}，且 Slide 编号连续）`
      : `1) 读取大纲：cat ${outlinePath}（统计 ## Slide N: 标题 的数量 N，且编号连续）`,
    `2) 创建目录：mkdir -p ${slidesDir}`,
    slideCount
      ? `3) 基于大纲生成 ${slideCount} 个 HTML 页面到 ${slidesDir}（命名 01.html, 02.html...），内容要完整可读。`
      : `3) 基于大纲生成 N 个 HTML 页面到 ${slidesDir}（命名 01.html, 02.html... 到 N.html），内容要完整可读。`,
    "4) 自检：确认 HTML 文件全部存在且非空；无渐变；无 div background-image；无 http(s)/data: 图片；无 div 裸文本；无插图槽位相关属性。",
    "",
    "最后只输出：DONE + slides 目录路径，不要输出大段解释。",
  ].join("\n");

  return { instruction, outDir, pptxPath, outlinePath };
}

function buildHtmlAdjustInstruction(
  slidesDir: string,
  target: "all" | string,
  userFeedback: string
) {
  const feedback = sanitizeMultiline(userFeedback).slice(0, 6000).trim();
  const scope = target === "all" ? "修改范围：所有 slides（*.html）" : `修改范围：仅 ${target}`;
  return [
    "你是一个 PPT HTML 调整助手。",
    "目标：在不改变页面尺寸/工具链约束的前提下，按用户意见直接修改已有的 HTML slides 文件。",
    "",
    "必须修改的目录：",
    `- slides 目录：${slidesDir}`,
    scope,
    "",
    "强约束（必须全部满足）：",
    "- body 固定 720pt x 405pt，不要改尺寸",
    "- 所有可见文字必须放在 p/h1-h6/ul/ol 中（div 内不要裸文本）",
    "- 禁止任何 CSS 渐变（linear-gradient/radial-gradient）",
    "- 禁止在任何 <div> 上使用 background-image；如需背景图，只允许设置在 body 上：background-image:url('assets/xxx.png')",
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow",
    "- 任何文字距离底部 >= 0.5 英寸（约 36pt）",
    "- 删除 Notes: 行（不要输出 notes）",
    "- 不要新增或保留任何 data-oc-illust-slot / data-oc-illust-prompt 属性",
    "",
    "用户修改意见：",
    "```text",
    feedback || "(空)",
    "```",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    "1) 读取并理解目标 HTML（必要时先全局扫描目录）",
    "2) 逐页修改并保存（保持页面可读、内容不溢出）",
    "3) 自检：确认不引入裸文本/禁用样式/尺寸变化",
    "",
    "最后只输出：DONE。",
  ].join("\n");
}

async function hashFile(p: string) {
  const buf = await fs.readFile(p);
  return createHash("sha1").update(buf).digest("hex");
}

function buildHtmlFixInstruction(slidesDir: string, errors: string) {
  const msg = errors.length > 1600 ? errors.slice(0, 1600) + "…" : errors;
  return [
    "你刚才生成的 HTML slides 在本地转换为 PPTX 时校验失败。",
    "请直接修改已有的 HTML 文件，修复所有校验错误，然后不要生成 PPTX，只要修复 HTML。",
    "",
    "必须修复的目录：",
    `- slides 目录：${slidesDir}`,
    "",
    "强约束：",
    "- body 固定 720pt x 405pt，不要改尺寸",
    "- 所有可见文字必须放在 p/h1-h6/ul/ol 中（div 内不要裸文本）",
    "- 禁止任何 CSS 渐变（linear-gradient/radial-gradient）",
    "- 禁止在任何 <div> 上使用 background-image；如需背景图，只允许设置在 body 上：background-image:url('assets/xxx.png')",
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow",
    "- 任何文字距离底部 >= 0.5 英寸（约 36pt）",
    "- 删除 Notes: 行（不要输出 notes）",
    "- 不要新增或保留任何 data-oc-illust-slot / data-oc-illust-prompt 属性",
    "",
    "修复策略（尽量不伤内容）：",
    "- 优先通过：调整布局/断行/减小间距/两栏排版/微调字号 来消除溢出或底部安全区问题",
    "- 避免直接删除整条要点或把内容改成空泛口号；除非别无选择才减少信息量",
    "",
    "本次校验错误（逐条修复）：",
    msg,
    "",
    "修复完成后：只输出 DONE。",
  ].join("\n");
}

const execFileAsync = promisify(execFile);

async function validateHtmlSlides(slidesDir: string) {
  const absSlidesDir = path.join(process.cwd(), slidesDir);
  const validateScript = path.join(process.cwd(), "scripts", "validate_slides.mjs");
  try {
    await execFileAsync("node", [validateScript, absSlidesDir], { cwd: process.cwd() });
  } catch (e) {
    const err = e as { stderr?: unknown; message?: unknown };
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const hint = stderr.trim()
      ? stderr.trim()
      : typeof err.message === "string"
        ? err.message
        : String(e);
    throw new Error(`HTML 溢出/尺寸校验失败：${hint}`);
  }
}

async function hashSlides(absSlidesDir: string, slideNames: string[]) {
  const out = new Map<string, string>();
  for (const name of slideNames) {
    if (!/\.html$/i.test(name)) continue;
    try {
      out.set(name, await hashFile(path.join(absSlidesDir, name)));
    } catch {
      // ignore
    }
  }
  return out;
}

async function validateAndAutoFixHtmlSlides(opts: {
  jobId: string;
  input: PptJobInput;
  client: Awaited<ReturnType<typeof getOpencodeHandle>>["client"];
  sessionId: string;
  slidesDir: string; // workspace-relative
  expectedSlideCount: number;
  maxFixAttempts: number;
  mode: "preview" | "pptx";
}) {
  const {
    jobId,
    input,
    client,
    sessionId,
    slidesDir,
    expectedSlideCount,
    maxFixAttempts,
    mode,
  } = opts;

  const absSlidesDir = path.join(process.cwd(), slidesDir);
  let lastErr = "";

  for (let fixAttempt = 0; fixAttempt <= maxFixAttempts; fixAttempt++) {
    try {
      await validateHtmlSlides(slidesDir);
      if (fixAttempt > 0) {
        log(jobId, `HTML 校验通过（已自动修复 ${fixAttempt} 次）。`);
      } else {
        log(jobId, "HTML 校验通过。");
      }
      return { ok: true as const, fixed: fixAttempt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;

      if (fixAttempt >= maxFixAttempts) {
        return { ok: false as const, fixed: fixAttempt, error: lastErr };
      }

      const nth = fixAttempt + 1;
      log(jobId, `HTML 校验失败，尝试修复（第 ${nth}/${maxFixAttempts} 次）：${msg}`);

      const beforeSlides = await listHtmlSlides(absSlidesDir);
      const beforeHashes = await hashSlides(absSlidesDir, beforeSlides);

      const fixInstruction = buildHtmlFixInstruction(slidesDir, msg);
      try {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            parts: [{ type: "text", text: fixInstruction }],
            model: getModelOverride(input),
          },
        });
      } catch (fixErr) {
        const fm = fixErr instanceof Error ? fixErr.message : String(fixErr);
        log(jobId, `修复 HTML 的 LLM 请求失败：${fm}`);
      }

      await ensureExpectedSlides(jobId, slidesDir, expectedSlideCount);

      // Snapshot versions for any changed slides (best-effort).
      try {
        const afterSlides = await listHtmlSlides(absSlidesDir);
        const afterHashes = await hashSlides(absSlidesDir, afterSlides);
        const changed: string[] = [];
        for (const name of afterSlides) {
          const b = beforeHashes.get(name);
          const a = afterHashes.get(name);
          if (b && a && b !== a) changed.push(name);
        }
        if (changed.length > 0) {
          await snapshotSlideVersions(jobId, changed, `auto-fix(${mode}) #${nth}`);
          log(jobId, `已创建版本（auto-fix）：${changed.join(", ")}`);
        }
      } catch {
        // ignore
      }
    }
  }

  return { ok: false as const, fixed: maxFixAttempts, error: lastErr || "unknown" };
}

function listHtmlSlides(absSlidesDir: string) {
  return fs
    .readdir(absSlidesDir)
    .then((files) =>
      files
        .filter((f) => f.toLowerCase().endsWith(".html"))
        .sort((a, b) => {
          const na = Number.parseInt(path.basename(a, ".html"), 10);
          const nb = Number.parseInt(path.basename(b, ".html"), 10);
          if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
          return a.localeCompare(b);
        })
    );
}

async function ensureExpectedSlides(jobId: string, slidesDir: string, expected: number) {
  const absSlidesDir = path.join(process.cwd(), slidesDir);
  const files = await listHtmlSlides(absSlidesDir);

  // Prefer strict check of 01..NN.html to avoid accidentally picking up extra files.
  const missing: string[] = [];
  for (let i = 1; i <= expected; i++) {
    const name = `${String(i).padStart(2, "0")}.html`;
    try {
      const st = await fs.stat(path.join(absSlidesDir, name));
      if (st.size <= 0) missing.push(name);
    } catch {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `HTML slides 不完整（expected=${expected}）：缺少/为空 ${missing.slice(0, 6).join(", ")}`
    );
  }

  log(jobId, `HTML slides 已生成：${files.length} 个`);
}

async function buildDeck(
  jobId: string,
  input: PptJobInput,
  slidesDir: string,
  pptxPath: string
) {
  log(jobId, "本地构建 PPTX（node 脚本）…");

  const absSlidesDir = path.join(process.cwd(), slidesDir);
  const absPptx = path.join(process.cwd(), pptxPath);
  const tmpDir = path.join(process.cwd(), "workspace", "tmp", jobId);
  await fs.mkdir(path.dirname(absPptx), { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });

  const buildScript = path.join(process.cwd(), "scripts", "build_deck.cjs");
  try {
    await execFileAsync(
      "node",
      [
        buildScript,
        absSlidesDir,
        absPptx,
        "--tmpDir",
        tmpDir,
        "--title",
        sanitizeOneLine(input.topic).slice(0, 200),
      ],
      { cwd: process.cwd() }
    );
  } catch (e) {
    const err = e as { stderr?: unknown; message?: unknown };
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const hint = stderr.trim()
      ? stderr.trim()
      : typeof err.message === "string"
        ? err.message
        : String(e);
    throw new Error(`PPTX 构建失败：${hint}`);
  }

  const pptxStat = await fs.stat(absPptx);
  if (pptxStat.size <= 0) {
    throw new Error("PPTX 生成完成但文件为空");
  }
}

async function readTextIfExists(p: string) {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    return null;
  }
}

export async function runOutlineJob(jobId: string, input: PptJobInput) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "开始生成大纲…");

  try {
    await fs.mkdir(path.join(process.cwd(), job.outputDir), { recursive: true });

    const { client } = await getOpencodeHandle();
    log(jobId, "创建 opencode session…");

    const session = unwrapData<{ id: string }>(
      await client.session.create({
        body: { title: `PPT Outline: ${input.topic.slice(0, 60)}` },
      })
    );

    if (!session?.id) {
      throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
    }

    setJob(jobId, { sessionId: session.id });
    log(jobId, `sessionId=${session.id}`);

    const { instruction, outlinePath, outDir } = buildOutlineInstruction(jobId, input);
    const systemPrompt = buildOutlineSkillSystemPrompt(input);

    log(jobId, "向 LLM 发送大纲指令…");
    log(jobId, "已注入 PPT 内容生成 + 视觉设计技能规则（叙事结构/标题/备注/视觉规划）。");
    await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: instruction }],
        system: systemPrompt,
        model: getModelOverride(input),
      },
    });

    const absOutline = path.join(process.cwd(), outlinePath);
    const outlineMarkdown = await readTextIfExists(absOutline);
    if (!outlineMarkdown || outlineMarkdown.trim().length < 50) {
      throw new Error("大纲文件未生成或内容过短，请查看 session 日志");
    }

    if (typeof input.slideCount === "number" && input.slideCount === 0) {
      const n = countSlidesFromOutlineMarkdown(outlineMarkdown);
      if (n) log(jobId, `页数=0：模型在大纲中生成了 ${n} 页`);
    }

    const draftOutlinePath = `${outDir}/outline.initial.md`;
    const absDraftOutline = path.join(process.cwd(), draftOutlinePath);
    await fs.writeFile(absDraftOutline, outlineMarkdown, "utf-8");
    log(jobId, `已保存大纲初稿：${draftOutlinePath}`);

    let finalOutlineMarkdown = outlineMarkdown;
    let refinedOutlineMarkdownResult: string | undefined = undefined;

    try {
      log(jobId, "创建大纲审稿/精修 session…");
      const reviewSession = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT Outline Review: ${input.topic.slice(0, 60)}` },
        })
      );

      if (!reviewSession?.id) {
        throw new Error("创建大纲精修 session 失败：未返回 session.id");
      }

      setJob(jobId, { sessionId: reviewSession.id });
      log(jobId, `reviewSessionId=${reviewSession.id}`);

      const reviewInstruction = buildOutlineReviewInstruction(input, {
        draftOutlinePath,
        outlinePath,
      });

      log(jobId, "向新会话发送大纲检查与精修指令…");
      await client.session.prompt({
        path: { id: reviewSession.id },
        body: {
          parts: [{ type: "text", text: reviewInstruction.instruction }],
          system: systemPrompt,
          model: getModelOverride(input),
        },
      });

      const reviewedOutlineMarkdown = await readTextIfExists(absOutline);
      if (!reviewedOutlineMarkdown || reviewedOutlineMarkdown.trim().length < 50) {
        throw new Error("精修后的大纲为空或内容过短");
      }

      finalOutlineMarkdown = reviewedOutlineMarkdown;
      refinedOutlineMarkdownResult = reviewedOutlineMarkdown;
      log(jobId, "大纲检查与精修完成。");
    } catch (reviewErr) {
      const message = reviewErr instanceof Error ? reviewErr.message : String(reviewErr);
      log(jobId, `大纲精修失败，回退到初稿：${message}`);
      await fs.writeFile(absOutline, outlineMarkdown, "utf-8");
      finalOutlineMarkdown = outlineMarkdown;
    }

    setJob(jobId, {
      outlinePath,
      outlineMarkdown: finalOutlineMarkdown,
      draftOutlineMarkdown: outlineMarkdown,
      refinedOutlineMarkdown: refinedOutlineMarkdownResult,
    });
    pushEvent(jobId, {
      type: "outline",
      outlineMarkdown: finalOutlineMarkdown,
      draftOutlineMarkdown: outlineMarkdown,
      refinedOutlineMarkdown: refinedOutlineMarkdownResult,
      ts: now(),
    });
    setStatus2(jobId, "awaiting_approval");
    log(jobId, "大纲生成完成，等待确认…");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setJob(jobId, { status: "error", error: message });
    pushEvent(jobId, { type: "error", message, ts: now() });
  }
}

export async function runDeckJob(jobId: string, input: PptJobInput) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "开始生成 PPTX…");

  try {
    const slideConfig = getRequestedSlideCount(input);

    const { client } = await getOpencodeHandle();

    // Dev 模式/服务重启后，jobStore 可能被清空；此时可从磁盘恢复 outline，但 sessionId 会丢失。
    // Deck 阶段允许重新创建一个 session 继续执行。
    if (!job.sessionId) {
      log(jobId, "sessionId 缺失，创建新的 opencode session…");
      const session = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT Deck: ${sanitizeOneLine(input.topic).slice(0, 60)}` },
        })
      );
      if (!session?.id) {
        throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
      }
      setJob(jobId, { sessionId: session.id });
      log(jobId, `sessionId=${session.id}`);
    }

    const sessionId = getJob(jobId)?.sessionId;
    if (!sessionId) {
      throw new Error("缺少 sessionId：无法继续生成 PPT");
    }
    const { pptxPath, outlinePath } = buildDeckInstruction(jobId, input);

    const slidesDir = `${path.posix.dirname(pptxPath)}/slides`;

    const absOutline = path.join(process.cwd(), outlinePath);
    const outlineMarkdown = await readTextIfExists(absOutline);
    if (!outlineMarkdown || outlineMarkdown.trim().length < 50) {
      throw new Error("outline.md 不存在或内容过短");
    }

    const outlinedCount = countSlidesFromOutlineMarkdown(outlineMarkdown);
    const effectiveSlideCount =
      slideConfig.mode === "auto" ? outlinedCount : (slideConfig.count as number);
    if (!effectiveSlideCount) {
      throw new Error("输入页数=0，但无法从大纲解析页数（请确保使用 '## Slide N: 标题' 格式）");
    }
    if (slideConfig.mode === "auto") {
      log(jobId, `页数=0：从大纲解析到 ${effectiveSlideCount} 页（将按该页数生成 HTML slides）`);
    }

    const { instruction } = buildDeckInstruction(jobId, input, {
      effectiveSlideCount,
    });

    log(jobId, "向 LLM 发送生成 HTML slides 指令…");
    let promptError: string | null = null;
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: instruction }],
          model: getModelOverride(input),
        },
      });
    } catch (e) {
      promptError = e instanceof Error ? e.message : String(e);
      log(jobId, `LLM 请求失败：${promptError}（将尝试继续本地构建）`);
    }

    await ensureExpectedSlides(jobId, slidesDir, effectiveSlideCount);

    // Validate HTML first (overflow / body size), then try building locally.
    // If validation/build fails, ask LLM to fix the HTML and retry.
    const maxFixes = 5;
    for (let fixed = 0; fixed <= maxFixes; fixed++) {
      try {
        await validateHtmlSlides(slidesDir);
        await buildDeck(jobId, input, slidesDir, pptxPath);

        setJob(jobId, { pptxPath, thumbnailsPath: undefined });
        pushEvent(jobId, { type: "result", pptxPath, thumbnailsPath: null, ts: now() });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (fixed >= maxFixes) {
          throw e;
        }

        const nth = fixed + 1;
        log(jobId, `本地构建失败，尝试修复 HTML（第 ${nth}/${maxFixes} 次）：${msg}`);
        const fixInstruction = buildHtmlFixInstruction(slidesDir, msg);
        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text: fixInstruction }],
              model: getModelOverride(input),
            },
          });
        } catch (fixErr) {
          const fm = fixErr instanceof Error ? fixErr.message : String(fixErr);
          log(jobId, `修复 HTML 的 LLM 请求失败：${fm}`);
        }

        await ensureExpectedSlides(jobId, slidesDir, effectiveSlideCount);
      }
    }

    if (promptError) {
      log(jobId, "注意：LLM 请求在过程中断开，但已通过本地构建完成 PPTX。\n");
    }

    setStatus2(jobId, "done");
    log(jobId, "PPTX 生成完成。");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setJob(jobId, { status: "error", error: message });
    pushEvent(jobId, { type: "error", message, ts: now() });
  }
}

export async function runHtmlOnlyJob(jobId: string, input: PptJobInput) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "开始生成 HTML slides（预览模式）…");

  try {
    const slideConfig = getRequestedSlideCount(input);

    const { client } = await getOpencodeHandle();

    if (!job.sessionId) {
      log(jobId, "sessionId 缺失，创建新的 opencode session…");
      const session = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT HTML Preview: ${sanitizeOneLine(input.topic).slice(0, 60)}` },
        })
      );
      if (!session?.id) {
        throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
      }
      setJob(jobId, { sessionId: session.id });
      log(jobId, `sessionId=${session.id}`);
    }

    const sessionId = getJob(jobId)?.sessionId;
    if (!sessionId) throw new Error("缺少 sessionId：无法继续生成 HTML");

    const { pptxPath, outlinePath } = buildDeckInstruction(jobId, input);
    const slidesDir = `${path.posix.dirname(pptxPath)}/slides`;

    const absOutline = path.join(process.cwd(), outlinePath);
    const outlineMarkdown = await readTextIfExists(absOutline);
    if (!outlineMarkdown || outlineMarkdown.trim().length < 50) {
      throw new Error("outline.md 不存在或内容过短");
    }

    const outlinedCount = countSlidesFromOutlineMarkdown(outlineMarkdown);
    const effectiveSlideCount =
      slideConfig.mode === "auto" ? outlinedCount : (slideConfig.count as number);
    if (!effectiveSlideCount) {
      throw new Error("输入页数=0，但无法从大纲解析页数（请确保使用 '## Slide N: 标题' 格式）");
    }
    if (slideConfig.mode === "auto") {
      log(jobId, `页数=0：从大纲解析到 ${effectiveSlideCount} 页（将按该页数生成 HTML slides）`);
    }

    // 预览模式：生成 HTML 即可，不构建 PPTX
    setJob(jobId, { pptxPath: undefined, thumbnailsPath: undefined });

    const { instruction } = buildDeckInstruction(jobId, input, {
      effectiveSlideCount,
    });

    log(jobId, "向 LLM 发送生成 HTML slides 指令…");
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: instruction }],
        model: getModelOverride(input),
      },
    });

    await ensureExpectedSlides(jobId, slidesDir, effectiveSlideCount);

    // Validate overflow / body size right after HTML generation.
    // Preview mode should keep going even if validation cannot be fully fixed,
    // so the user can still preview and adjust.
    const fixRes = await validateAndAutoFixHtmlSlides({
      jobId,
      input,
      client,
      sessionId,
      slidesDir,
      expectedSlideCount: effectiveSlideCount,
      maxFixAttempts: 3,
      mode: "preview",
    });
    if (!fixRes.ok) {
      setJob(jobId, {
        error:
          `HTML 仍存在校验问题（已自动修复 ${fixRes.fixed} 次）。` +
          `你仍可预览/手动调整，随后再渲染 PPTX。\n` +
          `${fixRes.error}`,
      });
      pushEvent(jobId, {
        type: "error",
        message:
          `HTML 校验未完全通过（已自动修复 ${fixRes.fixed} 次，预览模式继续）。\n${fixRes.error}`,
        ts: now(),
      });
    } else {
      // Clear any previous error once validation passes.
      setJob(jobId, { error: undefined });
    }

    setStatus2(jobId, "done");
    log(jobId, "HTML slides 生成完成（可预览/调整，随后再渲染 PPTX）。");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setJob(jobId, { status: "error", error: message });
    pushEvent(jobId, { type: "error", message, ts: now() });
  }
}

export async function runRenderFromHtmlJob(jobId: string, input: PptJobInput) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "使用已生成的 HTML slides 构建 PPTX…");

  try {
    const { client } = await getOpencodeHandle();

    if (!job.sessionId) {
      log(jobId, "sessionId 缺失，创建新的 opencode session…");
      const session = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT Render: ${sanitizeOneLine(input.topic).slice(0, 60)}` },
        })
      );
      if (!session?.id) {
        throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
      }
      setJob(jobId, { sessionId: session.id });
      log(jobId, `sessionId=${session.id}`);
    }

    const sessionId = getJob(jobId)?.sessionId;
    if (!sessionId) throw new Error("缺少 sessionId：无法继续渲染 PPTX");

    const outDir = `workspace/jobs/${jobId}`;
    const slidesDir = `${outDir}/slides`;
    const pptxPath = `${outDir}/deck.pptx`;

    // Prefer expected count if configured, otherwise just ensure slides exist.
    const expected = input.slideCount ? Math.max(1, Math.min(50, input.slideCount)) : null;
    const absSlidesDir = path.join(process.cwd(), slidesDir);
    const files = await listHtmlSlides(absSlidesDir);
    if (files.length === 0) {
      throw new Error(`未找到 HTML slides（目录为空）：${slidesDir}`);
    }
    if (expected) {
      await ensureExpectedSlides(jobId, slidesDir, expected);
    } else {
      log(jobId, `检测到 HTML slides：${files.length} 个`);
    }

    const maxFixes = 5;
    for (let fixed = 0; fixed <= maxFixes; fixed++) {
      try {
        await buildDeck(jobId, input, slidesDir, pptxPath);
        setJob(jobId, { pptxPath, thumbnailsPath: undefined });
        pushEvent(jobId, { type: "result", pptxPath, thumbnailsPath: null, ts: now() });
        setStatus2(jobId, "done");
        log(jobId, "PPTX 生成完成。");
        return;
      } catch (e) {
        if (fixed >= maxFixes) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        const nth = fixed + 1;
        log(jobId, `本地构建失败，尝试修复 HTML（第 ${nth}/${maxFixes} 次）：${msg}`);
        const fixInstruction = buildHtmlFixInstruction(slidesDir, msg);
        try {
          await client.session.prompt({
            path: { id: sessionId },
            body: {
              parts: [{ type: "text", text: fixInstruction }],
              model: getModelOverride(input),
            },
          });
        } catch (fixErr) {
          const fm = fixErr instanceof Error ? fixErr.message : String(fixErr);
          log(jobId, `修复 HTML 的 LLM 请求失败：${fm}`);
        }

        if (expected) {
          await ensureExpectedSlides(jobId, slidesDir, expected);
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setJob(jobId, { status: "error", error: message });
    pushEvent(jobId, { type: "error", message, ts: now() });
  }
}

export async function runHtmlAdjustJob(
  jobId: string,
  input: PptJobInput,
  target: "all" | string,
  feedback: string
) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "开始按意见调整 HTML slides…");

  try {
    const { client } = await getOpencodeHandle();

    if (!job.sessionId) {
      log(jobId, "sessionId 缺失，创建新的 opencode session…");
      const session = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT HTML Adjust: ${sanitizeOneLine(input.topic).slice(0, 60)}` },
        })
      );
      if (!session?.id) {
        throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
      }
      setJob(jobId, { sessionId: session.id });
      log(jobId, `sessionId=${session.id}`);
    }

    const sessionId = getJob(jobId)?.sessionId;
    if (!sessionId) throw new Error("缺少 sessionId：无法继续调整 HTML");

    const slidesDir = `workspace/jobs/${jobId}/slides`;
    const absSlidesDir = path.join(process.cwd(), slidesDir);
    const files = await listHtmlSlides(absSlidesDir);
    if (files.length === 0) {
      throw new Error(`未找到 HTML slides（目录为空）：${slidesDir}`);
    }

    // Ensure version meta exists before changes.
    await ensureSlideVersionsInitialized(jobId, await listHtmlSlidesByJob(jobId));

    if (target !== "all") {
      const normalized = path.posix.basename(target);
      if (!/\.html$/i.test(normalized)) {
        throw new Error("target 必须是 .html 文件名或 all");
      }
      if (!files.includes(normalized)) {
        throw new Error(`目标 HTML 不存在：${normalized}`);
      }
      target = normalized;
    }

    // HTML 已变化，旧 PPTX 可能过期；先清理产物引用。
    setJob(jobId, { pptxPath: undefined, thumbnailsPath: undefined });

    const scopeFiles =
      target === "all"
        ? files
        : files.filter((f) => f === path.posix.basename(String(target)));

    const beforeHashes = new Map<string, string>();
    for (const f of scopeFiles) {
      try {
        beforeHashes.set(f, await hashFile(path.join(absSlidesDir, f)));
      } catch {
        // ignore
      }
    }

    const instruction = buildHtmlAdjustInstruction(slidesDir, target, feedback);
    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: instruction }],
        model: getModelOverride(input),
      },
    });

    const changed: string[] = [];
    for (const f of scopeFiles) {
      try {
        const after = await hashFile(path.join(absSlidesDir, f));
        const before = beforeHashes.get(f);
        if (!before || before !== after) changed.push(f);
      } catch {
        // ignore
      }
    }

    if (changed.length > 0) {
      await snapshotSlideVersions(jobId, changed, feedback);
      log(jobId, `已创建版本：${changed.join(", ")}`);
    } else {
      log(jobId, "未检测到 HTML 变化（未创建新版本）。");
    }

    setStatus2(jobId, "done");
    log(jobId, "HTML 调整完成。可刷新预览或继续渲染 PPTX。");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    setJob(jobId, { status: "error", error: message });
    pushEvent(jobId, { type: "error", message, ts: now() });
  }
}

export async function runPptJob(jobId: string, input: PptJobInput) {
  const job = getJob(jobId);
  if (!job) return;

  // 兼容旧入口：直接跑“大纲 -> 等待确认”
  await runOutlineJob(jobId, input);
}
