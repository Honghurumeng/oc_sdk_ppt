import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { getOpencodeHandle, unwrapData } from "@/lib/opencode";
import { snapshotSlideVersions, ensureSlideVersionsInitialized, listHtmlSlides as listHtmlSlidesByJob } from "@/lib/slideVersions";
import { ensureIllustrationsForSlides } from "@/lib/illustrations";
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

function getSvgModelOverride(input: PptJobInput) {
  if (input.svgModel) {
    const parsed = parseProviderModel(input.svgModel);
    if (parsed) return parsed;
  }
  // Back-compat / convenience: default to the main model when svgModel isn't set.
  return getModelOverride(input);
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
    "- 输出为 Markdown，按 slide 分节，使用 ## Slide N: 标题",
    slideConfig.mode === "auto"
      ? "- Slide 必须从 1 连续编号到你决定的最后一页（不要跳号/重复号）"
      : "- Slide 必须从 1 连续编号到最后一页（不要跳号/重复号）",
    "- 每页给出 3-6 个要点（用 - 列表），必要时加一行讲者备注（Notes: ...）",
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
      "        <div data-oc-illust-slot=\"img-XX-hero\" data-oc-illust-prompt=\"图型=概念结构; 元素=本页核心概念+3子点(取自要点); 关系=中心->三个分支; 布局=中心圆+三分支卡片; 强调=核心概念(用accent); 文案=每节点<=6字;\" style=\"height:190pt;background:#E9E3D8;border-radius:10pt;\"></div>",
      "        <p class=\"muted\" style=\"margin-top:8pt;font-size:14pt;line-height:1.25;\">图示/案例占位（无渐变）</p>",
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
      "      <div data-oc-illust-slot=\"img-XX-brief\" data-oc-illust-prompt=\"图型=简化图表; 元素=本页3个关键指标(取自要点); 关系=对比/趋势(按要点决定); 布局=图表居中+标签; 强调=最大/目标值(用accent); 文案=数字+短标签;\" style=\"height:190pt;background:#E9EEF8;border-radius:10pt;\"></div>",
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
    "工具链硬约束（必须全部满足，否则本地转换会失败）：",
    "- HTML body 必须设置为 720pt × 405pt（16:9），所有可见文字必须放在 p/h1-h6/ul/ol 中。",
    "- 禁止任何 CSS 渐变（linear-gradient/radial-gradient）。",
    "- 禁止在任何 <div> 上使用 background-image（包括 url(...)）；如需背景图，只允许设置在 body 上：background-image:url('assets/xxx.png')。",
    "- 图片引用规则：只允许本地相对路径 assets/...；禁止 http(s) 与 data: 图片。",
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow；需要分隔线/底色/阴影请用 div 来实现。",
    "- div 内不要出现裸文本（比如直接写 Notes: ...）；必须用 p/h1-h6/ul/ol 包裹。",
    "- 插图（按需使用）：默认不加图。仅当用纯文字不够直观、读者难以快速理解时，才添加 0-2 个插图槽位（用于帮助理解，而不是装饰）。",
    "  - 适合用插图的场景：流程/循环、架构关系、对比矩阵、概念分层、因果链路、时序、分类映射",
    "  - 不适合：纯结论页、简单要点罗列、已经一眼能懂的短列表（宁可不加图）",
    "  - data-oc-illust-slot：全 deck 唯一的短 ID（必须包含两位页码前缀以避免冲突，例如 img-01-loop / img-02-arch；只含字母数字-_；不要保留模板里的 img-XX-... 占位符）",
    "  - data-oc-illust-prompt：这是给后续“SVG 插图生成器”的工作规格，必须具体到可直接画出来；不要写‘画一张示意图/用简洁图形表达/根据内容自行拟合’之类空话。",
    "    - 推荐写法（单行文本；用分号分隔字段；不要在值里使用双引号，避免 HTML 转义）：",
    "      图型=循环/流程/层级/矩阵/时间线/架构/对比/因果; 元素=3-8个节点短标签; 关系=箭头/分组/包含/映射; 布局=左到右/上到下/环形/2x2/三层; 强调=需要高亮的节点(用accent); 文案=每个标签<=6字;",
    "    - 若本页包含数字/比例/阈值：把关键数字写进 prompt（例如：在节点旁标注 23% / 2x / 7天）。不要编造与要点冲突的数据。",
    "    - 示例 1：图型=循环; 元素=假设/实验/结果/修正; 关系=假设->实验->结果->修正->假设(闭环); 布局=顺时针圆环,每段一个节点; 强调=结果(用accent); 文案=每节点<=4字;",
    "    - 示例 2：图型=架构; 元素=用户/前端/服务A/数据库; 关系=用户->前端->服务A->数据库(读写); 布局=左到右四列,服务A加虚线框; 强调=服务A(用accent); 文案=节点<=4字;",
    "  - 槽位 div 必须有明确的宽高（pt 单位，建议在 style 内写 width/height），用于后续自动生成 SVG 并注入本地 PNG",
    "  - 重要：插图槽位 div 内不要预先写 <img>（图片由后续流程自动生成并注入 slides/assets/<slotId>.png）。若你确实需要额外的本地图片元素，请用 <img src=\"assets/...\">，不要用 div background-image。",
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
    "4) 自检：确认 HTML 文件全部存在且非空；无渐变；无 div background-image；无 http(s)/data: 图片；无 div 裸文本；若需要示意图则包含插图槽位且写明 data-oc-illust-prompt。",
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
    "- 若页面中存在 data-oc-illust-slot / data-oc-illust-prompt 插图槽位：不要删除；默认不要改名/改 prompt；若你确实需要改变插图意图（prompt），为触发插图重新生成，请同时把 slotId 改成新的全 deck 唯一 ID（建议带两位页码前缀），并保留其宽高（pt）",
    "- 若页面内已有 <img src=\"assets/...\">（自动插图），不要改成 http(s)/data:；也不要删除这些 img（除非用户明确要求）",
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
    "- 若页面中存在 data-oc-illust-slot / data-oc-illust-prompt 插图槽位：不要删除；默认不要改名/改 prompt；若你确实需要改变插图意图（prompt），为触发插图重新生成，请同时把 slotId 改成新的全 deck 唯一 ID（建议带两位页码前缀），并保留其宽高（pt）",
    "- 若页面内已有 <img src=\"assets/...\">（自动插图），不要改成 http(s)/data:；也不要删除这些 img（除非为修复而必须且已在输出中说明）",
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
      // Ensure local illustrations are generated and injected before validation.
      try {
        await ensureIllustrationsForSlides({
          jobId,
          slidesDir,
          client,
          model: getSvgModelOverride(input),
          log: (m) => log(jobId, m),
        });
      } catch (illErr) {
        const im = illErr instanceof Error ? illErr.message : String(illErr);
        log(jobId, `插图生成/注入失败（忽略，继续校验 HTML）：${im}`);
      }

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

      // Re-inject illustrations after LLM fixes HTML.
      try {
        await ensureIllustrationsForSlides({
          jobId,
          slidesDir,
          client,
          model: getSvgModelOverride(input),
          log: (m) => log(jobId, m),
        });
      } catch (illErr2) {
        const im2 = illErr2 instanceof Error ? illErr2.message : String(illErr2);
        log(jobId, `插图生成/注入失败（忽略，继续流程）：${im2}`);
      }

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

function extractIllustSlotIdsFromHtml(html: string) {
  const out = new Set<string>();
  const re = /data-oc-illust-slot\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(html))) {
    const v = String(m[1] || "").trim();
    if (v) out.add(v);
  }
  return Array.from(out);
}

type IllustrationSpecSlot = {
  slideFile: string;
  slotId: string;
  prompt?: string;
  targetPxW?: number;
  targetPxH?: number;
};

async function readIllustrationsSpec(absAssetsDir: string): Promise<IllustrationSpecSlot[]> {
  const specPath = path.join(absAssetsDir, "illustrations.spec.json");
  let raw = "";
  try {
    raw = await fs.readFile(specPath, "utf-8");
  } catch {
    return [];
  }
  try {
    const obj = JSON.parse(raw) as { slots?: unknown };
    const slots = Array.isArray(obj?.slots) ? obj.slots : [];
    return slots
      .map((s): IllustrationSpecSlot | null => {
        if (!s || typeof s !== "object") return null;
        const ss = s as Record<string, unknown>;
        if (typeof ss.slideFile !== "string" || typeof ss.slotId !== "string") return null;
        return {
          slideFile: ss.slideFile,
          slotId: ss.slotId,
          ...(typeof ss.prompt === "string" ? { prompt: ss.prompt } : {}),
          ...(typeof ss.targetPxW === "number" ? { targetPxW: ss.targetPxW } : {}),
          ...(typeof ss.targetPxH === "number" ? { targetPxH: ss.targetPxH } : {}),
        };
      })
      .filter((v): v is IllustrationSpecSlot => Boolean(v));
  } catch {
    return [];
  }
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

    const { instruction, outlinePath } = buildOutlineInstruction(jobId, input);

    log(jobId, "向 LLM 发送大纲指令…");
    await client.session.prompt({
      path: { id: session.id },
      body: {
        parts: [{ type: "text", text: instruction }],
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

    setJob(jobId, { outlinePath, outlineMarkdown });
    pushEvent(jobId, { type: "outline", outlineMarkdown, ts: now() });
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
        try {
          await ensureIllustrationsForSlides({
            jobId,
            slidesDir,
            client,
            model: getSvgModelOverride(input),
            log: (m) => log(jobId, m),
          });
        } catch (illErr) {
          const im = illErr instanceof Error ? illErr.message : String(illErr);
          log(jobId, `插图生成/注入失败（忽略，继续构建）：${im}`);
        }

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
        try {
          await ensureIllustrationsForSlides({
            jobId,
            slidesDir,
            client,
            model: getSvgModelOverride(input),
            log: (m) => log(jobId, m),
          });
        } catch (illErr) {
          const im = illErr instanceof Error ? illErr.message : String(illErr);
          log(jobId, `插图生成/注入失败（忽略，继续渲染 PPTX）：${im}`);
        }

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

    // After HTML adjustments, (re)generate and inject local illustrations for the affected slides
    // so the active version matches what the user previews/renders.
    try {
      await ensureIllustrationsForSlides({
        jobId,
        slidesDir,
        client,
        model: getSvgModelOverride(input),
        log: (m) => log(jobId, m),
        slideFiles: scopeFiles,
      });
    } catch (illErr) {
      const im = illErr instanceof Error ? illErr.message : String(illErr);
      log(jobId, `插图生成/注入失败（忽略，继续保存版本）：${im}`);
    }

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

export async function runSvgAdjustJob(
  jobId: string,
  input: PptJobInput,
  target: "all" | string,
  feedback: string
) {
  const job = getJob(jobId);
  if (!job) return;

  setStatus2(jobId, "running");
  log(jobId, "开始按意见调整图片（SVG）…");

  try {
    const { client } = await getOpencodeHandle();

    if (!job.sessionId) {
      log(jobId, "sessionId 缺失，创建新的 opencode session…");
      const session = unwrapData<{ id: string }>(
        await client.session.create({
          body: { title: `PPT SVG Adjust: ${sanitizeOneLine(input.topic).slice(0, 60)}` },
        })
      );
      if (!session?.id) {
        throw new Error("创建 opencode session 失败：未返回 session.id（请检查服务鉴权/日志）");
      }
      setJob(jobId, { sessionId: session.id });
      log(jobId, `sessionId=${session.id}`);
    }

    const sessionId = getJob(jobId)?.sessionId;
    if (!sessionId) throw new Error("缺少 sessionId：无法继续调整图片");

    const slidesDir = `workspace/jobs/${jobId}/slides`;
    const absSlidesDir = path.join(process.cwd(), slidesDir);
    const files = await listHtmlSlides(absSlidesDir);
    if (files.length === 0) {
      throw new Error(`未找到 HTML slides（目录为空）：${slidesDir}`);
    }

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

    // 图片已变化，旧 PPTX/缩略图可能过期；先清理产物引用。
    setJob(jobId, { pptxPath: undefined, thumbnailsPath: undefined });

    const scopeFiles =
      target === "all"
        ? files
        : files.filter((f) => f === path.posix.basename(String(target)));

    const absAssetsDir = path.join(absSlidesDir, "assets");
    const specSlots = await readIllustrationsSpec(absAssetsDir);
    const promptBySlotId = new Map<string, string>();
    for (const s of specSlots) {
      if (s.prompt && !promptBySlotId.has(s.slotId)) promptBySlotId.set(s.slotId, s.prompt);
    }

    const slotsInScope = new Map<string, { slotId: string; slideFiles: Set<string>; prompt?: string }>();
    for (const slideFile of scopeFiles) {
      // Union: spec + HTML parse (spec might be stale).
      const fromSpec = specSlots.filter((s) => s.slideFile === slideFile).map((s) => s.slotId);
      let html = "";
      try {
        html = await fs.readFile(path.join(absSlidesDir, slideFile), "utf-8");
      } catch {
        html = "";
      }
      const fromHtml = html ? extractIllustSlotIdsFromHtml(html) : [];
      const ids = Array.from(new Set([...fromSpec, ...fromHtml]));
      for (const slotId of ids) {
        const cur = slotsInScope.get(slotId) ?? {
          slotId,
          slideFiles: new Set<string>(),
          prompt: promptBySlotId.get(slotId),
        };
        cur.slideFiles.add(slideFile);
        if (!cur.prompt) cur.prompt = promptBySlotId.get(slotId);
        slotsInScope.set(slotId, cur);
      }
    }

    const candidates = Array.from(slotsInScope.values()).sort((a, b) =>
      a.slotId.localeCompare(b.slotId)
    );

    if (candidates.length === 0) {
      if (target !== "all") {
        throw new Error("该页面没有图片槽位，无法进行图片应用调整。");
      }
      log(jobId, "未检测到任何图片槽位（data-oc-illust-slot），跳过图片调整。");
      setStatus2(jobId, "done");
      return;
    }

    const svgEdits: { slotId: string; svgRel: string; slideHint: string; prompt?: string }[] = [];
    for (const c of candidates) {
      const svgRel = `${slidesDir}/assets/${c.slotId}.svg`;
      const svgAbs = path.join(process.cwd(), svgRel);
      try {
        const st = await fs.stat(svgAbs);
        if (st.size <= 0) continue;
      } catch {
        continue;
      }
      const slideHint = Array.from(c.slideFiles).sort().join(", ");
      svgEdits.push({ slotId: c.slotId, svgRel, slideHint, prompt: c.prompt });
    }

    if (svgEdits.length === 0) {
      throw new Error("未找到可调整的 SVG 文件（assets/*.svg）。请先生成插图后再试。");
    }

    const items = svgEdits
      .map((x, idx) => {
        const lines = [
          `${idx + 1}) slotId=${x.slotId}`,
          `- 文件：${x.svgRel}`,
          `- 页面：${x.slideHint}`,
        ];
        if (x.prompt?.trim()) lines.push(`- 插图意图：${sanitizeOneLine(x.prompt).slice(0, 240)}`);
        return lines.join("\n");
      })
      .join("\n\n");

    const instruction = [
      "你是 PPT 图片调整助手（SVG）。",
      "你可以使用 shell/文件工具在当前工作区内编辑文件。",
      "目标：根据用户的修改意见，调整指定 SVG 文件的内容。不要修改任何 HTML 文件。",
      "",
      `用户修改意见（务必严格落实）：\n${sanitizeMultiline(feedback).slice(0, 8000)}`,
      "",
      "需要调整的 SVG 文件如下（逐个修改）：",
      items,
      "",
      "SVG 硬性要求（必须全部满足）：",
      "- 仅编辑上面列出的 SVG 文件，不要编辑/创建其他文件",
      "- 保持每个 SVG 根元素的 width/height/viewBox 数值不变（避免 PNG 尺寸错乱）",
      "- 不要使用 <image>、<foreignObject> 或任何外链资源；不要嵌入位图",
      "- 只用基础矢量元素：<path>/<rect>/<circle>/<line>/<text>",
      "- 线条端点与拐角：stroke-linecap/linejoin=round；避免过细线条",
      "- 若使用文字：仅用 Arial；字号不要小于 14px；文字尽量少",
      "- 画面四周留白，避免贴边被裁切；元素对齐、间距一致",
      "",
      "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
      "1) 逐个打开并修改 SVG 文件，落实修改意见；保持尺寸属性不变",
      "2) 自检：每个 SVG 文件存在且非空；XML/SVG 语法正确；不包含禁止标签",
      "3) 最后只输出：DONE",
    ].join("\n");

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        parts: [{ type: "text", text: instruction }],
        model: getSvgModelOverride(input),
      },
    });

    // Force PNG re-rasterization so the HTML preview picks up SVG edits.
    for (const x of svgEdits) {
      const pngAbs = path.join(absAssetsDir, `${x.slotId}.png`);
      try {
        await fs.unlink(pngAbs);
      } catch {
        // ignore
      }
    }

    try {
      await ensureIllustrationsForSlides({
        jobId,
        slidesDir,
        client,
        model: getSvgModelOverride(input),
        log: (m) => log(jobId, m),
        slideFiles: scopeFiles,
        maxTotalSlots: Math.max(50, svgEdits.length + 8),
      });
    } catch (illErr) {
      const im = illErr instanceof Error ? illErr.message : String(illErr);
      log(jobId, `图片重新渲染失败：${im}`);
    }

    setStatus2(jobId, "done");
    log(jobId, "图片调整完成。可刷新预览或继续渲染 PPTX。");
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
