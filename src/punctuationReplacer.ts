import * as vscode from "vscode";
import { PunctuationRule } from "./types";
import { matchByFileTypeOrLanguage } from "./config";

type PunctuationMapper = (text: string, map: Record<string, string>) => Promise<string | null>;

// 监听输入并在命中规则时把中文符号替换为英文符号。
export class PunctuationReplacer {
  private static readonly WORKER_MAP_THRESHOLD = 24;
  private busy = false;
  private queued: Array<{ event: vscode.TextDocumentChangeEvent; rules: PunctuationRule[] }> = [];

  private async waitForNextTick(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  private mapText(text: string, map: Record<string, string>): string {
    if (!text) {
      return text;
    }

    const keys = Object.keys(map)
      .filter((key) => key.length > 0)
      .sort((a, b) => b.length - a.length);

    if (!keys.length) {
      return text;
    }

    let i = 0;
    let out = "";
    while (i < text.length) {
      let matched = false;
      for (const key of keys) {
        if (text.startsWith(key, i)) {
          out += map[key] ?? key;
          i += key.length;
          matched = true;
          break;
        }
      }

      if (!matched) {
        out += text[i];
        i += 1;
      }
    }

    return out;
  }

  private async mapTextHybrid(
    text: string,
    map: Record<string, string>,
    mapper?: PunctuationMapper,
  ): Promise<string> {
    if (mapper && text.length >= PunctuationReplacer.WORKER_MAP_THRESHOLD) {
      const byWorker = await mapper(text, map);
      if (typeof byWorker === "string") {
        return byWorker;
      }
    }
    return this.mapText(text, map);
  }

  public async handleChange(
    event: vscode.TextDocumentChangeEvent,
    rules: PunctuationRule[],
    mapper?: PunctuationMapper,
  ): Promise<void> {
    if (this.busy) {
      this.queued.push({ event, rules });
      return;
    }

    this.busy = true;
    try {
      await this.processOne(event, rules, mapper);

      while (this.queued.length > 0) {
        const next = this.queued.shift();
        if (!next) {
          break;
        }
        await this.processOne(next.event, next.rules, mapper);
      }
    } finally {
      this.busy = false;
    }
  }

  private async processOne(
    event: vscode.TextDocumentChangeEvent,
    rules: PunctuationRule[],
    mapper?: PunctuationMapper,
  ): Promise<void> {

    if (!event.contentChanges.length) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
      return;
    }

    const filePath = event.document.fileName;
    const languageId = event.document.languageId;
    const rule = rules.find((item) =>
      matchByFileTypeOrLanguage(filePath, languageId, item.fileTypes, item.languageIds),
    );
    if (!rule) {
      return;
    }

    // 从后往前扫描本次上屏，兼容成对自动补全（如 “” / ‘’ / 【】），但仅处理本次变更片段。
    const candidateChanges = [...event.contentChanges].reverse().filter((change) => {
      if (!change || !change.text || change.text.length > 256) {
        return false;
      }
      if (change.text.includes("\n") || change.text.includes("\r") || change.text.includes("\t")) {
        return false;
      }
      return true;
    });

    const replacements: Array<{ range: vscode.Range; text: string; startOffset: number }> = [];

    for (const change of candidateChanges) {
      const start = change.range.start;
      const startOffset = event.document.offsetAt(start);
      const end = event.document.positionAt(startOffset + change.text.length);
      const replaceRange = new vscode.Range(start, end);

      const current = event.document.getText(replaceRange);
      if (!current) {
        continue;
      }
      const mappedCurrent = await this.mapTextHybrid(current, rule.map, mapper);
      if (!mappedCurrent || mappedCurrent === current) {
        continue;
      }

      replacements.push({
        range: replaceRange,
        text: mappedCurrent,
        startOffset,
      });
    }

    if (!replacements.length) {
      return;
    }

    // 等待一次事件循环，避开输入法合成态上屏时的编辑冲突。
    await this.waitForNextTick();

    const reordered = replacements
      .map((item) => {
        const latest = event.document.getText(item.range);
        return { latest, item };
      })
      .sort((a, b) => b.item.startOffset - a.item.startOffset);

    const valid: Array<{ range: vscode.Range; text: string; startOffset: number }> = [];
    for (const item of reordered) {
      const mappedLatest = await this.mapTextHybrid(item.latest, rule.map, mapper);
      if (!mappedLatest || mappedLatest === item.latest) {
        continue;
      }
      valid.push({
        range: item.item.range,
        text: mappedLatest,
        startOffset: item.item.startOffset,
      });
    }

    if (!valid.length) {
      return;
    }

    // 关闭 undo stop，保持替换行为和一次输入动作合并。
    await editor.edit((builder) => {
      for (const item of valid) {
        builder.replace(item.range, item.text);
      }
    }, { undoStopAfter: false, undoStopBefore: false });
  }
}
