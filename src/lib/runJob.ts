import { promises as fs } from "node:fs";
import path from "node:path";
import { getOpencodeHandle, unwrapData } from "@/lib/opencode";
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
  const slideCount = Math.max(3, Math.min(20, input.slideCount ?? 8));
  const audience = sanitizeOneLine(input.audience ?? "一般受众");
  const tone = sanitizeOneLine(input.tone ?? "专业、清晰、偏实用");

  // workspace 相对路径：Next 项目根目录下的 web/workspace
  const outDir = `workspace/jobs/${jobId}`;
  const outlinePath = `${outDir}/outline.md`;

  const instruction = [
    "你是一个 PPT 生成助手。你可以使用 shell/文件工具在当前工作区内创建文件。",
    "目标：先生成 PPT 大纲（仅内容结构，不生成 PPTX 文件）。",
    "",
    `主题：${topic}`,
    `语言：${language}`,
    `页数：${slideCount}`,
    `受众：${audience}`,
    `语气/风格：${tone}`,
    "",
    "强制输出路径（必须严格一致）：",
    `- 输出目录：${outDir}`,
    `- 大纲文件：${outlinePath}`,
    "",
    "大纲格式要求：",
    "- 输出为 Markdown，按 slide 分节，使用 ## Slide N: 标题",
    "- 每页给出 3-6 个要点（用 - 列表），必要时加一行讲者备注（Notes: ...）",
    "- 内容密度适配页数，不要出现空洞口号",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    `1) 创建目录：mkdir -p ${outDir}`,
    `2) 写入大纲到 ${outlinePath}`,
    "3) 自检：确认大纲文件存在且内容完整。",
    "",
    "最后只输出：DONE + 大纲路径，不要输出大段解释。",
  ].join("\n");

  return { instruction, outDir, outlinePath };
}

function buildDeckInstruction(jobId: string, input: PptJobInput) {
  const topic = sanitizeOneLine(input.topic);
  const language = sanitizeOneLine(input.language ?? "中文");
  const slideCount = Math.max(3, Math.min(20, input.slideCount ?? 8));

  const outDir = `workspace/jobs/${jobId}`;
  const slidesDir = `${outDir}/slides`;
  const outlinePath = `${outDir}/outline.md`;
  const pptxPath = `${outDir}/deck.pptx`;
  const thumbsPrefix = `${outDir}/thumbnails`;
  const thumbsPath = `${outDir}/thumbnails.jpg`;

  const stylePreset = sanitizeOneLine(input.stylePreset ?? "Editorial");
  const palette = sanitizeOneLine(input.palette ?? "Sand & Ink");

  const instruction = [
    "你是一个 PPT 生成助手。你可以使用 shell/文件工具在当前工作区内创建文件并运行脚本。",
    "目标：基于已存在的大纲文件生成一份 16:9 的 PPTX，并生成缩略图预览。",
    "",
    `主题：${topic}`,
    `语言：${language}`,
    `页数：${slideCount}`,
    `风格预设：${stylePreset}`,
    `配色方案：${palette}`,
    "",
    "强制输入/输出路径（必须严格一致）：",
    `- 大纲输入：${outlinePath}`,
    `- HTML slides 目录：${slidesDir}`,
    `- PPTX 输出：${pptxPath}`,
    `- 缩略图输出：${thumbsPath}`,
    "",
    "工具链约束：",
    "- 使用 `pptx/scripts/html2pptx.js` 将 HTML slides 转为 PPTX（不要手写 OOXML）。",
    "- HTML body 必须设置为 720pt × 405pt（16:9），所有文字必须放在 p/h1-h6/ul/ol 中。",
    "- 禁止 CSS 渐变；需要渐变/图标就先用 sharp 渲染成 PNG 再引用。",
    "",
    "执行步骤（按顺序执行，全部成功后再回复 DONE）：",
    `1) 读取大纲：cat ${outlinePath}（确认 slide 数量与用户要求一致）`,
    `2) 创建目录：mkdir -p ${slidesDir}`,
    `3) 基于大纲生成 ${slideCount} 个 HTML 页面到 ${slidesDir}（命名 01.html, 02.html...），内容要完整可读。`,
    `4) 生成一个 Node 脚本 ${outDir}/build.cjs：依次将每个 HTML 转成 slide，最后写出 ${pptxPath}。`,
    `   - Node 脚本里引用: const html2pptx = require("../../../pptx/scripts/html2pptx.js")（注意相对路径）`,
    "5) 运行：node " + `${outDir}/build.cjs`,
    `6) 生成缩略图：python pptx/scripts/thumbnail.py ${pptxPath} ${thumbsPrefix} --cols 4`,
    "7) 自检：确认上述两个文件存在且非空。",
    "",
    "最后只输出：DONE + 两个路径（pptx 和 thumbnails），不要输出大段解释。",
  ].join("\n");

  return { instruction, outDir, pptxPath, thumbsPath, outlinePath };
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
    if (!job.sessionId) {
      throw new Error("缺少 sessionId：请先生成大纲");
    }

    const { client } = await getOpencodeHandle();
    const { instruction, pptxPath, thumbsPath, outlinePath } = buildDeckInstruction(
      jobId,
      input
    );

    const absOutline = path.join(process.cwd(), outlinePath);
    const outlineMarkdown = await readTextIfExists(absOutline);
    if (!outlineMarkdown || outlineMarkdown.trim().length < 50) {
      throw new Error("outline.md 不存在或内容过短");
    }

    log(jobId, "向 LLM 发送生成 PPTX 指令…");
    await client.session.prompt({
      path: { id: job.sessionId },
      body: {
        parts: [{ type: "text", text: instruction }],
        model: getModelOverride(input),
      },
    });

    const absPptx = path.join(process.cwd(), pptxPath);
    const absThumbs = path.join(process.cwd(), thumbsPath);
    const [pptxStat, thumbsStat] = await Promise.all([
      fs.stat(absPptx),
      fs.stat(absThumbs),
    ]);
    if (pptxStat.size <= 0 || thumbsStat.size <= 0) {
      throw new Error("生成完成但输出文件为空，请查看 session 日志");
    }

    setJob(jobId, { pptxPath, thumbnailsPath: thumbsPath });
    pushEvent(jobId, {
      type: "result",
      pptxPath,
      thumbnailsPath: thumbsPath,
      ts: now(),
    });
    setStatus2(jobId, "done");
    log(jobId, "PPTX 生成完成。");
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
