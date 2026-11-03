import React from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import "katex/dist/katex.min.css";
import { openUrl } from "@tauri-apps/plugin-opener";

const plugins = { code, math, mermaid: createMermaidPlugin({ config: { securityLevel: "strict" } }) };

interface MarkdownRendererProps {
  children: string;
  isStreaming?: boolean;
}

export function Markdown({
  children,
  isStreaming = false,
}: MarkdownRendererProps) {
  return (
    <Streamdown
      plugins={plugins}
      isAnimating={isStreaming}
      shikiTheme={["github-light", "github-dark"]}
      components={COMPONENTS as any}
      controls={{
        table: true,
        code: true,
        mermaid: {
          download: true,
          copy: true,
          fullscreen: false,
          panZoom: false,
        },
      }}
    >
      {children}
    </Streamdown>
  );
}

const COMPONENTS = {
  a: ({ children, href, ...props }: any) => {
    const safeHref = typeof href === "string" && /^https?:\/\//i.test(href) ? href : undefined;
    const handleClick = async (e: React.MouseEvent) => {
      e.preventDefault();
      // AI-generated links must never launch local files or custom URI handlers.
      if (safeHref) {
        try {
          await openUrl(safeHref);
        } catch (error) {
          console.error("Failed to open URL:", error);
        }
      }
    };

    return (
      <a
        {...props}
        href={safeHref}
        className="text-gray-600 underline underline-offset-2 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer"
        onClick={handleClick}
      >
        {children}
      </a>
    );
  },
};
