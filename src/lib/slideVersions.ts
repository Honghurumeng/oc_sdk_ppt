import path from "node:path";
import { promises as fs } from "node:fs";

export type SlideVersionEntry = {
  id: string;
  createdAt: number;
  note?: string;
};

export type SlideVersionsMeta = {
  version: 1;
  slides: Record<
    string,
    {
      active: string;
      versions: SlideVersionEntry[];
    }
  >;
};

const META_FILENAME = "slides.versions.json";

function jobDir(jobId: string) {
  return path.join(process.cwd(), "workspace", "jobs", jobId);
}

function slidesDir(jobId: string) {
  return path.join(jobDir(jobId), "slides");
}

function versionsDir(jobId: string) {
  return path.join(jobDir(jobId), "slides_versions");
}

function metaPath(jobId: string) {
  return path.join(jobDir(jobId), META_FILENAME);
}

function slideKey(name: string) {
  // "01.html" => "01"
  return path.basename(name, ".html");
}

function genVersionId(ts = Date.now()) {
  // short, sortable-ish id
  return `v${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function readMeta(jobId: string): Promise<SlideVersionsMeta | null> {
  try {
    const raw = await fs.readFile(metaPath(jobId), "utf-8");
    const parsed = JSON.parse(raw) as SlideVersionsMeta;
    if (!parsed || parsed.version !== 1 || typeof parsed.slides !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeMeta(jobId: string, meta: SlideVersionsMeta) {
  await fs.mkdir(jobDir(jobId), { recursive: true });
  await fs.writeFile(metaPath(jobId), JSON.stringify(meta, null, 2), "utf-8");
}

async function ensureVersionFile(jobId: string, slideName: string, versionId: string, html: string) {
  const key = slideKey(slideName);
  const dir = path.join(versionsDir(jobId), key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${versionId}.html`), html, "utf-8");
}

async function readSlideHtml(jobId: string, slideName: string) {
  return fs.readFile(path.join(slidesDir(jobId), slideName), "utf-8");
}

async function readVersionHtml(jobId: string, slideName: string, versionId: string) {
  const key = slideKey(slideName);
  const p = path.join(versionsDir(jobId), key, `${versionId}.html`);
  return fs.readFile(p, "utf-8");
}

export async function listHtmlSlides(jobId: string) {
  let files: string[];
  try {
    files = await fs.readdir(slidesDir(jobId));
  } catch {
    files = [];
  }
  const html = files.filter((f) => f.toLowerCase().endsWith(".html"));
  html.sort((a, b) => {
    const na = Number.parseInt(path.basename(a, ".html"), 10);
    const nb = Number.parseInt(path.basename(b, ".html"), 10);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b);
  });
  return html;
}

export async function ensureSlideVersionsInitialized(jobId: string, slideNames: string[]) {
  const existing = (await readMeta(jobId)) ?? ({ version: 1, slides: {} } satisfies SlideVersionsMeta);
  const meta: SlideVersionsMeta = { version: 1, slides: { ...existing.slides } };

  for (const name of slideNames) {
    if (!/\.html$/i.test(name)) continue;
    const entry = meta.slides[name];
    if (entry && Array.isArray(entry.versions) && entry.versions.length > 0 && entry.active) {
      continue;
    }

    let html = "";
    try {
      html = await readSlideHtml(jobId, name);
    } catch {
      html = "";
    }
    if (!html) continue;

    const v1 = "v1";
    await ensureVersionFile(jobId, name, v1, html);
    meta.slides[name] = {
      active: v1,
      versions: [{ id: v1, createdAt: Date.now(), note: "initial" }],
    };
  }

  await writeMeta(jobId, meta);
  return meta;
}

export async function snapshotSlideVersions(
  jobId: string,
  slideNames: string[],
  note?: string
) {
  const slides = await listHtmlSlides(jobId);
  const meta = await ensureSlideVersionsInitialized(jobId, slides);

  const cleanNote = typeof note === "string" ? note.trim().slice(0, 240) : "";
  const ts = Date.now();

  for (const name of slideNames) {
    if (!meta.slides[name]) continue;
    let html = "";
    try {
      html = await readSlideHtml(jobId, name);
    } catch {
      html = "";
    }
    if (!html) continue;

    const id = genVersionId(ts);
    await ensureVersionFile(jobId, name, id, html);

    const cur = meta.slides[name];
    cur.versions.push({ id, createdAt: ts, note: cleanNote || undefined });
    cur.active = id;
  }

  await writeMeta(jobId, meta);
  return meta;
}

export async function activateSlideVersion(jobId: string, slideName: string, versionId: string) {
  const slides = await listHtmlSlides(jobId);
  const meta = await ensureSlideVersionsInitialized(jobId, slides);

  const entry = meta.slides[slideName];
  if (!entry) {
    throw new Error(`slide not found: ${slideName}`);
  }
  if (!entry.versions.some((v) => v.id === versionId)) {
    throw new Error(`version not found: ${versionId}`);
  }

  const html = await readVersionHtml(jobId, slideName, versionId);
  await fs.writeFile(path.join(slidesDir(jobId), slideName), html, "utf-8");
  entry.active = versionId;
  await writeMeta(jobId, meta);
  return meta;
}

export async function getSlideVersionsMeta(jobId: string) {
  const slides = await listHtmlSlides(jobId);
  const meta = await ensureSlideVersionsInitialized(jobId, slides);
  return { slides, meta };
}
