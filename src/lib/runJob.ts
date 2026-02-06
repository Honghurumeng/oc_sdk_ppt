import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { getOpencodeHandle, unwrapData } from "@/lib/opencode";
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
    "工具链约束：",
    "- HTML body 必须设置为 720pt × 405pt（16:9），所有文字必须放在 p/h1-h6/ul/ol 中。",
    "- 禁止 CSS 渐变；需要渐变/图标就先用 sharp 渲染成 PNG 再引用。",
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow；需要分隔线/底色请用 div 来实现。",
    "- div 内不要出现裸文本（比如直接写 Notes: ...）；必须用 p/h1-h6/ul/ol 包裹。",
    "- 不要输出 Notes: 行（避免触发校验问题）。",
    "- 内容必须留出底部至少 0.5 英寸（约 36pt）空白，避免文字贴底或溢出。",
    "",
    "推荐模板（每页都复用这套排版，避免溢出/校验失败）：",
    "- body: width:720pt; height:405pt; padding:32pt 48pt 48pt; box-sizing:border-box;",
    "- h1: margin:0 0 14pt 0; font-size:34pt; line-height:1.1;",
    "- ul: margin:0; padding-left:22pt;",
    "- li: margin:0 0 6pt 0; font-size:18pt; line-height:1.2;",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    slideCount
      ? `1) 读取大纲：cat ${outlinePath}（确认 slide 数量为 ${slideCount}，且 Slide 编号连续）`
      : `1) 读取大纲：cat ${outlinePath}（统计 ## Slide N: 标题 的数量 N，且编号连续）`,
    `2) 创建目录：mkdir -p ${slidesDir}`,
    slideCount
      ? `3) 基于大纲生成 ${slideCount} 个 HTML 页面到 ${slidesDir}（命名 01.html, 02.html...），内容要完整可读。`
      : `3) 基于大纲生成 N 个 HTML 页面到 ${slidesDir}（命名 01.html, 02.html... 到 N.html），内容要完整可读。`,
    "4) 自检：确认 HTML 文件全部存在且非空。",
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
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow",
    "- 任何文字距离底部 >= 0.5 英寸（约 36pt）",
    "- 删除 Notes: 行（不要输出 notes）",
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
    "- 不要在 h1-h6/p/li/ul/ol 上使用 border/background/box-shadow",
    "- 任何文字距离底部 >= 0.5 英寸（约 36pt）",
    "- 删除 Notes: 行（不要输出 notes）",
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
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await validateHtmlSlides(slidesDir);
        await buildDeck(jobId, input, slidesDir, pptxPath);

        setJob(jobId, { pptxPath, thumbnailsPath: undefined });
        pushEvent(jobId, { type: "result", pptxPath, thumbnailsPath: null, ts: now() });
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= 2) {
          throw e;
        }

        log(jobId, `本地构建失败，尝试修复 HTML（第 ${attempt} 次）：${msg}`);
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
    // If it fails, ask LLM to fix once, then re-validate.
    try {
      await validateHtmlSlides(slidesDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(jobId, `HTML 校验失败，尝试修复：${msg}`);
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
      await validateHtmlSlides(slidesDir);
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

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await buildDeck(jobId, input, slidesDir, pptxPath);
        setJob(jobId, { pptxPath, thumbnailsPath: undefined });
        pushEvent(jobId, { type: "result", pptxPath, thumbnailsPath: null, ts: now() });
        setStatus2(jobId, "done");
        log(jobId, "PPTX 生成完成。");
        return;
      } catch (e) {
        if (attempt >= 2) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        log(jobId, `本地构建失败，尝试修复 HTML（第 ${attempt} 次）：${msg}`);
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
