import * as vscode from "vscode";
import { PunctuationRule } from "./types";
import { matchByFileTypeOrLanguage } from "./config";

// 监听输入并在命中规则时把中文符号替换为英文符号。
export class PunctuationReplacer {
  private busy = false;

  public async handleChange(
    event: vscode.TextDocumentChangeEvent,
    rules: PunctuationRule[],
  ): Promise<void> {
    if (this.busy || !event.contentChanges.length) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
      return;
    }

    const change = event.contentChanges[0];
    // 只处理“单字符插入”场景，避免影响粘贴、多光标替换等操作。
    if (!change || change.text.length !== 1 || change.rangeLength !== 0) {
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

    const replacement = rule.map[change.text];
    if (!replacement || replacement === change.text) {
      return;
    }

    const start = change.range.start;
    const end = start.translate(0, 1);

    this.busy = true;
    try {
      // 关闭 undo stop，保持替换行为和一次输入动作合并。
      await editor.edit((builder) => {
        builder.replace(new vscode.Range(start, end), replacement);
      }, { undoStopAfter: false, undoStopBefore: false });
    } finally {
      this.busy = false;
    }
  }
}
