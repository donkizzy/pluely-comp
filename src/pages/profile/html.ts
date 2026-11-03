import { parse, type DefaultTreeAdapterTypes } from "parse5";
type Node = DefaultTreeAdapterTypes.Node;
const ignored = new Set([
  "script",
  "style",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "iframe",
  "noscript",
  "svg",
  "template",
  "img",
  "video",
  "audio",
  "object",
  "embed",
]);
const blocks = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "div",
  "br",
  "section",
  "article",
  "main",
  "tr",
]);
function find(root: Node, tag: string): Node | undefined {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if ("tagName" in node && node.tagName === tag) return node;
    if ("childNodes" in node) stack.push(...node.childNodes.slice().reverse());
  }
}
function text(root: Node): string {
  const output: string[] = [];
  const stack: (Node | string)[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === "string") {
      output.push(node);
      continue;
    }
    if (node.nodeName === "#text" && "value" in node) {
      output.push(node.value);
      continue;
    }
    if ("tagName" in node && ignored.has(node.tagName)) continue;
    if ("childNodes" in node) {
      if ("tagName" in node && blocks.has(node.tagName)) {
        output.push("\n");
        stack.push("\n");
      }
      stack.push(...node.childNodes.slice().reverse());
    }
  }
  return output
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .trim();
}
/** Pure AST parsing: no browser document, script execution, or resource loads. */
export function portfolioText(
  html: string,
  fallbackTitle: string,
): { title: string; content: string } {
  const doc = parse(html);
  const title = find(doc, "title");
  const root =
    find(doc, "article") || find(doc, "main") || find(doc, "body") || doc;
  return {
    title: title ? text(title) || fallbackTitle : fallbackTitle,
    content: text(root).slice(0, 100000),
  };
}
