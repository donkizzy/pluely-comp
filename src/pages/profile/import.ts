import { fetch } from "@tauri-apps/plugin-http";
import type { Profile } from "@/lib/database/knowledge.action";

export async function parseResume(file: File): Promise<string> {
  if (file.size > 15 * 1024 * 1024)
    throw new Error("Choose a resume smaller than 15 MB");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const loading = pdfjs.getDocument({
      data: new Uint8Array(await file.arrayBuffer()),
      useSystemFonts: true,
    });
    try {
      const pdf = await loading.promise;
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(
          joinPdfItems(
            content.items.flatMap((item) => ("str" in item ? [item] : [])),
          ),
        );
      }
      const text = pages.join("\n\n").trim();
      if (!text)
        throw new Error(
          "This PDF has no text layer. Paste text from an OCR tool instead.",
        );
      return text;
    } finally {
      await loading.destroy();
    }
  }
  if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    return (
      await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })
    ).value.trim();
  }
  if (extension === "txt" || extension === "md")
    return (await file.text()).trim();
  throw new Error("Use PDF, DOCX, TXT or Markdown");
}
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
  width: number;
  height: number;
  transform: number[];
}
/**
 * Rebuild lines from positioned PDF text runs. pdf.js splits runs at font
 * changes and ligatures ("Certi" "fi" "ed"), so a space is only inserted where
 * the page actually has a gap, and a new line where the baseline moves.
 */
export function joinPdfItems(items: PdfTextItem[]): string {
  let out = "";
  let prev: PdfTextItem | null = null;
  for (const item of items) {
    if (prev && !prev.hasEOL && out && !out.endsWith("\n")) {
      const size =
        item.height || Math.hypot(item.transform[0], item.transform[1]) || 10;
      const lineMoved =
        Math.abs(item.transform[5] - prev.transform[5]) > size * 0.5;
      const gap = item.transform[4] - (prev.transform[4] + prev.width);
      if (lineMoved) out += "\n";
      else if (gap > size * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str))
        out += " ";
    }
    out += item.str;
    if (item.hasEOL) out += "\n";
    prev = item;
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}

type Bucket =
  | "header"
  | "summary"
  | "experience"
  | "skills"
  | "education"
  | "projects"
  | "other";
const HEADINGS: [Bucket, RegExp][] = [
  [
    "summary",
    /^((professional|career|executive|personal) )?(summary|profile|objective|overview)$|^about( me)?$/,
  ],
  [
    "experience",
    /^((work|professional|relevant|employment|career) )?(experience|history)$|^employment$/,
  ],
  [
    "skills",
    /^((technical|core|key|professional) )?(skills|competencies|technologies|expertise)( and (tools|technologies))?$|^(tools|tech stack|skills and tools)$/,
  ],
  [
    "education",
    /^education( and (certifications?|training))?$|^(certifications?|licenses?( and certifications?)?|courses|training)$/,
  ],
  ["projects", /^((selected|personal|key|side|notable) )?projects$/],
  [
    "other",
    /^(awards|honors|honours|awards and honors|publications|languages|interests|hobbies|volunteer(ing)?( experience)?|references|activities|leadership|achievements|contact( information| details)?)$|salary|compensation|pay expectations?/,
  ],
];
const SENSITIVE = /salary|compensation|pay expectation/i;
function headingOf(line: string): Bucket | null {
  const text = line
    .trim()
    .replace(/[:\s]+$/, "")
    .replace(/\s*&\s*/g, " and ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  if (!text || text.length > 40) return null;
  return HEADINGS.find(([, re]) => re.test(text))?.[0] ?? null;
}
// One entry per line: drop the empty paragraphs PDF/DOCX extraction leaves
// between lines, and normalise tab-separated list bullets.
const tidy = (text: string) =>
  text
    .replace(/^[ \t]*([•▪◦·*-])[ \t]+/gm, "• ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

/**
 * Split resume text into profile fields. Text before the first heading is the
 * contact header (never copied into evidence); unknown sections such as
 * awards are left out of the structured fields, and salary lines are dropped
 * everywhere. The full text stays available in the reviewed source.
 */
export function resumeSections(
  text: string,
): Pick<
  Profile,
  "name" | "summary" | "experience" | "skills" | "education" | "projects"
> {
  const result: Record<Bucket, string> = {
    header: "",
    summary: "",
    experience: "",
    skills: "",
    education: "",
    projects: "",
    other: "",
  };
  let section: Bucket = "header";
  for (const line of text.split(/\r?\n/)) {
    const heading = headingOf(line);
    if (heading) {
      section = heading;
      continue;
    }
    // "Skills: Go, Rust" — a heading with its content on the same line.
    const inline = line.match(/^\s*([^:]{2,40}):\s*(\S.*)$/);
    const inlineHeading = inline && headingOf(inline[1]);
    if (inline && inlineHeading) {
      section = inlineHeading;
      if (!SENSITIVE.test(line)) result[section] += inline[2] + "\n";
      continue;
    }
    if (SENSITIVE.test(line)) continue;
    result[section] += line.trimEnd() + "\n";
  }
  const first = result.header
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  const name =
    first &&
    /^[\p{L}][\p{L}.'\- ]{1,60}$/u.test(first) &&
    first.split(/\s+/).length <= 4
      ? first
      : "";
  return {
    name,
    summary: tidy(result.summary).replace(/\s+/g, " ").slice(0, 600),
    experience: tidy(result.experience),
    skills: tidy(result.skills),
    education: tidy(result.education),
    projects: tidy(result.projects),
  };
}
async function readUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok)
      throw new Error(`Source returned HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > 5_000_000)
      throw new Error("Source is too large; paste an excerpt instead");
    const text = await response.text();
    if (text.length > 2_000_000)
      throw new Error("Source is too large; paste an excerpt instead");
    return text;
  } finally {
    clearTimeout(timer);
  }
}
export async function importUrl(
  raw: string,
): Promise<{ title: string; content: string }> {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) URL without credentials");
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      !parts[0] ||
      parts.length > 2 ||
      !parts.every((p) => /^[\w.-]+$/.test(p))
    )
      throw new Error("Use a GitHub profile or repository URL");
    const owner = encodeURIComponent(parts[0]);
    if (parts[1]) {
      const repo = `${owner}/${encodeURIComponent(parts[1])}`;
      const metadata = JSON.parse(
        await readUrl(`https://api.github.com/repos/${repo}`),
      );
      const readme = JSON.parse(
        await readUrl(`https://api.github.com/repos/${repo}/readme`),
      );
      const bytes = Uint8Array.from(
        atob(String(readme.content).replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      return {
        title: String(metadata.full_name),
        content: [metadata.description, new TextDecoder().decode(bytes)]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
    const repos: {
      name: string;
      description: string | null;
      html_url: string;
      fork: boolean;
    }[] = JSON.parse(
      await readUrl(
        `https://api.github.com/users/${owner}/repos?sort=updated&per_page=30`,
      ),
    );
    return {
      title: `${parts[0]} on GitHub`,
      content: repos
        .filter((r) => !r.fork)
        .map((r) => `${r.name}: ${r.description || ""}\n${r.html_url}`)
        .join("\n\n"),
    };
  }
  const html = await readUrl(url.toString());
  const { portfolioText } = await import("./html");
  return portfolioText(html, url.hostname);
}
