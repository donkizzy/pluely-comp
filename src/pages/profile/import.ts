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
          content.items
            .map((item) =>
              "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
            )
            .join(""),
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
export function resumeSections(
  text: string,
): Pick<Profile, "experience" | "skills" | "education" | "projects"> {
  const result = { experience: "", skills: "", education: "", projects: "" };
  let section: keyof typeof result = "experience";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.trim().replace(/:$/, "").toLowerCase();
    if (
      /^(work |professional |relevant )?experience$|^employment( history)?$/.test(
        heading,
      )
    )
      section = "experience";
    else if (/^(technical |core )?skills$|^technologies$/.test(heading))
      section = "skills";
    else if (/^education( and certifications)?$/.test(heading))
      section = "education";
    else if (/^(selected |personal )?projects$/.test(heading))
      section = "projects";
    else result[section] += line + "\n";
  }
  return result;
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
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll(
      "script,style,nav,footer,header,aside,form,iframe,noscript,svg",
    )
    .forEach((el) => el.remove());
  const root =
    doc.querySelector("article") || doc.querySelector("main") || doc.body;
  root
    .querySelectorAll("p,li,h1,h2,h3,div,br")
    .forEach((el) => el.append(doc.createTextNode("\n")));
  return {
    title: doc.title || url.hostname,
    content: (root.textContent || "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim()
      .slice(0, 100000),
  };
}
