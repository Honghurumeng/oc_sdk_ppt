import type { PptJobInput } from "@/lib/jobStore";

type OutlineArchetype =
  | "generic"
  | "product"
  | "project"
  | "training"
  | "business";

type VisualArchetype = "business" | "tech" | "education" | "minimal";

function sanitizeOneLine(s: string) {
  return s.replace(/[\r\n\t]+/g, " ").trim();
}

function inferOutlineArchetype(input: PptJobInput): OutlineArchetype {
  const haystack = [
    input.topic,
    input.audience,
    input.tone,
    input.referenceContent,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (
    /产品|product|功能|方案|解决方案|平台|saas|应用|竞品|卖点|路线图|pricing|定价|demo/i.test(
      haystack
    )
  ) {
    return "product";
  }

  if (
    /项目|project|汇报|复盘|里程碑|进展|周报|月报|季度|okr|复审|回顾|status/i.test(
      haystack
    )
  ) {
    return "project";
  }

  if (
    /培训|training|课程|教程|教学|学习|实操|workshop|bootcamp|onboarding/i.test(haystack)
  ) {
    return "training";
  }

  if (
    /商业计划|business plan|融资|pitch|bp|投资人|市场规模|财务预测|商业模式/i.test(
      haystack
    )
  ) {
    return "business";
  }

  return "generic";
}

function archetypeGuidance(archetype: OutlineArchetype) {
  switch (archetype) {
    case "product":
      return [
        "优先采用产品介绍型结构：问题/机会 -> 解决方案 -> 核心功能 -> 差异化优势 -> 场景/案例 -> 落地与行动。",
        "核心页面要写清用户痛点、产品能力、竞争差异、落地场景，不要只列抽象卖点。",
      ].join("\n");
    case "project":
      return [
        "优先采用项目汇报型结构：背景目标 -> 当前进展 -> 关键成果 -> 挑战与应对 -> 下一步计划 -> 资源/风险。",
        "结果页优先给量化成果、里程碑和风险，而不是泛泛总结。",
      ].join("\n");
    case "training":
      return [
        "优先采用培训课程型结构：学习目标 -> 课程地图 -> 知识点/方法 -> 示例/演示 -> 练习/复盘 -> 总结/延伸资源。",
        "要兼顾认知顺序与练习闭环，避免只有理论没有应用。",
      ].join("\n");
    case "business":
      return [
        "优先采用商业计划型结构：市场痛点 -> 解决方案 -> 市场与竞争 -> 商业模式 -> 增长路径 -> 财务/融资诉求。",
        "投资人视角下，必须回答为什么是现在、为什么是你、如何增长、需要什么资源。",
      ].join("\n");
    default:
      return [
        "优先采用通用咨询式结构：SCQA 或三幕式，确保开场建立背景与冲突，主体按 2-4 个核心论点展开，结尾形成明确行动。",
        "如果主题更像问题分析或方案论证，优先 SCQA；如果更像一般演讲或分享，优先三幕式。",
      ].join("\n");
  }
}

function inferVisualArchetype(input: PptJobInput): VisualArchetype {
  const haystack = [
    input.topic,
    input.audience,
    input.tone,
    input.stylePreset,
    input.palette,
    input.referenceContent,
  ]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (/培训|training|课程|教育|教学|学习|课堂|camp/i.test(haystack)) {
    return "education";
  }

  if (/科技|tech|技术|ai|模型|平台|数据|系统|研发|工程/i.test(haystack)) {
    return "tech";
  }

  if (/极简|minimal|swiss|简洁|高管|董事会|投委会|汇报/i.test(haystack)) {
    return "minimal";
  }

  return "business";
}

function visualPaletteGuidance(archetype: VisualArchetype) {
  switch (archetype) {
    case "tech":
      return "推荐科技视觉：主色科技蓝，辅色深灰，强调色可用高亮青绿或紫；背景保持干净，不要花哨堆色。";
    case "education":
      return "推荐教育视觉：主色暖橙或明亮蓝绿，背景偏浅暖，强调学习路径和模块分区，整体更友好。";
    case "minimal":
      return "推荐极简视觉：黑白灰为主，只保留 1 个强调色；版面靠字号、对齐、留白建立层次。";
    default:
      return "推荐商务视觉：海军蓝/石墨灰为主，辅以浅灰和克制强调色；整体稳重、可信、适合汇报。";
  }
}

function visualLayoutGuidance(archetype: VisualArchetype) {
  switch (archetype) {
    case "tech":
      return "优先使用强网格布局、双栏信息区、图表或结构图占位；避免整页密集段落。";
    case "education":
      return "优先使用学习路径、步骤卡片、示例区和练习区布局；每页认知负担要低。";
    case "minimal":
      return "优先使用大标题、少量高密度结论、单图或单图表布局；用留白而不是装饰。";
    default:
      return "优先使用标题条、单双栏模块、结论卡片、图表页等标准商务布局；重要结论放上半屏。";
  }
}

export function buildPptContentOutlineSystemPrompt(input: PptJobInput) {
  const language = sanitizeOneLine(input.language ?? "中文");
  const audience = sanitizeOneLine(input.audience ?? "一般受众");
  const tone = sanitizeOneLine(input.tone ?? "专业、清晰、偏实用");
  const archetype = inferOutlineArchetype(input);

  return [
    "你现在启用了内置的“PPT内容生成”技能，请按内容策划顾问的标准来生成大纲。",
    `输出语言：${language}`,
    `受众：${audience}`,
    `语气：${tone}`,
    "",
    "总原则：",
    "- 大纲必须有明确叙事，不要把页面写成松散的信息堆砌。",
    "- 结论先行，每页都要服务于整场演讲的主线。",
    "- 优先给出可落地、可讲述、可转为页面视觉结构的内容，而不是空泛口号。",
    "- 如引用参考内容中的数据或案例，可压缩改写；不要编造无法自证的精确事实。",
    "",
    "内容组织方法：",
    "- 采用一个主结构骨架：SCQA、三幕式，或更贴合主题的行业模板。",
    "- SCQA：先交代背景，再指出矛盾/挑战，再提出关键问题，最后给出答案与展开。",
    "- 三幕式：开场建立注意力与背景，主体展开核心论点，结尾总结并形成行动。",
    `- 当前建议骨架：${archetypeGuidance(archetype)}`,
    "",
    "页面写作要求：",
    "- Slide 标题要具体、可讲、尽量动词驱动；必要时可用数字、问题句、对比句。",
    "- 每页 3-6 个要点，要点之间有逻辑层次，避免同义重复。",
    "- 主体页优先使用“观点 -> 论据/案例/数据 -> 含义/行动”的展开方式。",
    "- 如果某页适合讲故事，可按 STAR 写法组织：情境、任务、行动、结果。",
    "- 如果某页适合分析问题，可按 5W2H 组织：是什么、为什么、谁相关、何时何地、如何做、投入产出。",
    "",
    "备注（Notes）策略：",
    "- 开场页建议写备注，说明如何抓注意力、建立情境、预告全局。",
    "- 关键内容页在必要时写备注，提示讲解顺序、强调点、案例或互动提问。",
    "- 总结页建议写备注，强调回顾、行动号召和收尾方式。",
    "",
    "质量底线：",
    "- 不要连续多页都只是“标题 + 普通 bullet 列表”的弱结构。",
    "- 不要把整场内容写成平铺直叙的百科式说明。",
    "- 不要出现明显为了凑页数而拆分出的空页。",
  ].join("\n");
}

export function buildPptDesignOutlineSystemPrompt(input: PptJobInput) {
  const language = sanitizeOneLine(input.language ?? "中文");
  const audience = sanitizeOneLine(input.audience ?? "一般受众");
  const stylePreset = sanitizeOneLine(input.stylePreset ?? "Editorial");
  const palette = sanitizeOneLine(input.palette ?? "Sand & Ink");
  const visualArchetype = inferVisualArchetype(input);

  return [
    "你现在启用了内置的“PPT视觉设计”技能，请在大纲阶段就同步完成视觉规划。",
    `输出语言：${language}`,
    `受众：${audience}`,
    `当前风格预设：${stylePreset}`,
    `当前配色偏好：${palette}`,
    "",
    "视觉总原则：",
    "- 不要把视觉设计留到后续实现阶段才考虑；大纲本身就要体现每页的版式与视觉意图。",
    "- 整套 deck 保持统一的设计系统：配色、字体层级、网格、图表风格、留白节奏要一致。",
    "- 配色不宜失控，主色不超过 3 类；强调色只在关键结论、数字和操作点上使用。",
    "- 保持可读性优先：字号层级清晰、留白充足、每页视觉重心明确。",
    "",
    "视觉方向建议：",
    `- ${visualPaletteGuidance(visualArchetype)}`,
    `- ${visualLayoutGuidance(visualArchetype)}`,
    "- 标题页、章节页、内容页、图表页、总结页要有不同骨架，不要全 deck 共用一种 bullet 模板。",
    "- 如果页面适合图表，要在大纲中明确建议图表类型，如柱状图/折线图/时间轴/流程图/金字塔/对比卡片。",
    "",
    "大纲输出要求：",
    "- 在正式 slides 之前，先给一个全局视觉规划区块，写清整体风格、配色、字体层级、版式骨架和图表策略。",
    "- 每个 Slide 除了内容要点外，还要给出一行 Visual: ...，说明本页适合的布局、视觉重心，以及是否需要图表、流程图、对比卡片、坐标示意等原生 HTML/CSS 可实现的结构。",
    "- Visual 描述要简洁但可执行，例如：'左文右结构双栏，右侧放流程图'、'大数字结论 + 下方 3 张卡片'、'整页时间轴'。",
    "",
    "质量底线：",
    "- 不要给出泛泛而谈的审美词，如“高级感”“科技感”而没有可执行说明。",
    "- 不要所有页面都推荐相同布局。",
    "- 不要让每页信息量和视觉承载失衡，避免注定会溢出的页面结构。",
  ].join("\n");
}
