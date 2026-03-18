import * as vscode from "vscode";
import { ContextZone } from "./types";

interface CommentSyntax {
  line: string[];
  block: Array<{ start: string; end: string }>;
}

const DEFAULT_COMMENT: CommentSyntax = {
  line: ["//", "#", "--"],
  block: [
    { start: "/*", end: "*/" },
    { start: "<!--", end: "-->" },
  ],
};

const COMMENT_BY_LANGUAGE: Record<string, CommentSyntax> = {
  javascript: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  typescript: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  javascriptreact: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  typescriptreact: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  java: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  c: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  cpp: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  csharp: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  go: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  rust: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  kotlin: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  swift: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  ruby: { line: ["#"], block: [] },
  shellscript: { line: ["#"], block: [] },
  makefile: { line: ["#"], block: [] },
  php: { line: ["//", "#"], block: [{ start: "/*", end: "*/" }] },
  python: { line: ["#"], block: [] },
  yaml: { line: ["#"], block: [] },
  sql: { line: ["--"], block: [{ start: "/*", end: "*/" }] },
  html: { line: [], block: [{ start: "<!--", end: "-->" }] },
  xml: { line: [], block: [{ start: "<!--", end: "-->" }] },
  vue: { line: ["//"], block: [{ start: "/*", end: "*/" }, { start: "<!--", end: "-->" }] },
  verilog: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  systemverilog: { line: ["//"], block: [{ start: "/*", end: "*/" }] },
  fsharp: { line: ["//"], block: [{ start: "(*", end: "*)" }] },
};

function getCommentSyntax(languageId: string): CommentSyntax {
  return COMMENT_BY_LANGUAGE[languageId] ?? DEFAULT_COMMENT;
}

function matchAnyPrefix(text: string, index: number, prefixes: string[]): string | null {
  for (const p of prefixes) {
    if (p && text.startsWith(p, index)) {
      return p;
    }
  }
  return null;
}

// 使用简化词法状态机扫描“光标之前文本”，避免仅用奇偶计数带来的误判。
function detectContextByScanner(
  languageId: string,
  textBeforeCursor: string,
): ContextZone {
  const syntax = getCommentSyntax(languageId);
  const lineTokens = [...syntax.line].sort((a, b) => b.length - a.length);

  let inLineComment = false;
  let inBlockComment: { end: string; doc: boolean } | null = null;
  let inString: { quote: string; triple: boolean } | null = null;
  let escaped = false;

  for (let i = 0; i < textBeforeCursor.length; i += 1) {
    const ch = textBeforeCursor[i];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (textBeforeCursor.startsWith(inBlockComment.end, i)) {
        i += inBlockComment.end.length - 1;
        inBlockComment = null;
      }
      continue;
    }

    if (inString) {
      if (inString.triple) {
        const triple = inString.quote.repeat(3);
        if (textBeforeCursor.startsWith(triple, i)) {
          i += 2;
          inString = null;
        }
        continue;
      }

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === "\\") {
        escaped = true;
        continue;
      }

      if (ch === inString.quote) {
        inString = null;
      }
      continue;
    }

    const linePrefix = matchAnyPrefix(textBeforeCursor, i, lineTokens);
    if (linePrefix) {
      inLineComment = true;
      i += linePrefix.length - 1;
      continue;
    }

    const blockPair = syntax.block.find((pair) => textBeforeCursor.startsWith(pair.start, i));
    if (blockPair) {
      const doc = blockPair.start === "/*" && textBeforeCursor.startsWith("/**", i);
      inBlockComment = { end: blockPair.end, doc };
      i += blockPair.start.length - 1;
      continue;
    }

    if ((ch === "'" || ch === "\"") && languageId === "python") {
      const triple = ch.repeat(3);
      if (textBeforeCursor.startsWith(triple, i)) {
        inString = { quote: ch, triple: true };
        i += 2;
        continue;
      }
    }

    if (ch === "'" || ch === "\"" || ch === "`") {
      inString = { quote: ch, triple: false };
    }
  }

  if (inString) {
    return "string";
  }
  if (inLineComment) {
    return "lineComment";
  }
  if (inBlockComment) {
    return inBlockComment.doc ? "docComment" : "blockComment";
  }
  return "other";
}

export function detectContextZone(
  document: vscode.TextDocument,
  position: vscode.Position,
  lookbackChars = 8000,
): ContextZone {
  // 只回看最近一段文本，避免大文件光标移动时频繁全量扫描。
  const cursorOffset = document.offsetAt(position);
  const startOffset = Math.max(0, cursorOffset - Math.max(512, lookbackChars));
  const startPos = document.positionAt(startOffset);
  const textBeforeCursor = document.getText(new vscode.Range(startPos, position));
  return detectContextByScanner(document.languageId, textBeforeCursor);
}
