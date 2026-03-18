import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { detectContextZone } from "./contextDetector";
import { getSmartInputConfig, matchByFileTypeOrLanguage } from "./config";
import { ImeController, ImeDiagnosticTrace } from "./imeController";
import { PunctuationReplacer } from "./punctuationReplacer";
import { ContextZone, EditorRule, ImeMode, RegexRule } from "./types";

// 统一编排：监听编辑器事件 -> 计算目标输入态 -> 调用输入法控制层。
class SmartInputService implements vscode.Disposable {
  private readonly imeController: ImeController;
  private readonly punctuationReplacer = new PunctuationReplacer();
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly diagnosticStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  private decorationType: vscode.TextEditorDecorationType | undefined;
  private lastDecoratorKey = "";
  private evaluateTimer: NodeJS.Timeout | undefined;
  private evaluateInFlight = false;
  private queuedEvaluateReason: string | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private activitySyncTimer: NodeJS.Timeout | undefined;
  private editorInteractionTimer: NodeJS.Timeout | undefined;
  private editorInteractionArmed = false;
  private lastActivitySyncAt = 0;
  private lastProgrammaticSwitchAt = 0;
  private manualChineseSticky = false;
  private configEpoch = 0;
  private lastVimModeCheckAt = 0;
  private lastVimModeValue = false;
  private imeCommandCache:
    | {
      configEpoch: number;
      workspacePath: string;
      commands: {
        getStateCommand: string;
        switchToChineseCommand: string;
        switchToEnglishCommand: string;
        source: "configured" | "bundled-internal";
      };
    }
    | undefined;
  private compiledRegexEpoch = -1;
  private compiledRegexRules: Array<{ rule: RegexRule; leftReg: RegExp | null; rightReg: RegExp | null }> = [];
  private lastRegexCandidateCache:
    | {
      key: string;
      rules: Array<{ rule: RegexRule; leftReg: RegExp | null; rightReg: RegExp | null }>;
    }
    | undefined;
  private lastDesiredCache:
    | {
      uri: string;
      version: number;
      line: number;
      character: number;
      configEpoch: number;
      vimNormalForceEnglish: boolean;
      vimNormal: boolean;
      result: { mode: ImeMode; detail: string } | null;
    }
    | undefined;
  private static readonly EDITOR_INTERACTION_HOLD_MS = 800;

  private get workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.imeController = new ImeController(this.context.extensionPath);

    // 状态栏入口：点击可打开插件菜单。
    this.statusBar.command = "smartInput.showMenu";
    this.statusBar.text = "SmartIME 中/英";
    this.statusBar.tooltip = "SmartIME 正在初始化";
    this.statusBar.show();
    this.diagnosticStatusBar.command = "smartInput.showMenu";

    this.context.subscriptions.push(this.imeController);
    this.context.subscriptions.push(this.statusBar);
    this.context.subscriptions.push(this.diagnosticStatusBar);

    this.imeController.onDidChangeMode((mode) => {
      // 输入态变化后同步刷新 UI 指示。
      this.updateStatusBar(mode, "mode changed");
      this.updateCursorDecorator(mode);
      this.updateCursorColor(mode);
    });

    this.imeController.onDidDiagnostic((trace) => this.updateDiagnosticBar(trace));

    this.context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.armEditorInteraction();
          this.scheduleEvaluate("active editor changed");
          return;
        }
        this.disarmEditorInteraction();
      }),
      vscode.window.onDidChangeTextEditorSelection(() => {
        this.armEditorInteraction();
        this.renderDecoratorAtLineEnd(this.imeController.mode);
        this.scheduleEvaluate("cursor moved", true);
        this.scheduleActivitySync();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document !== event.document) {
          return;
        }

        this.armEditorInteraction();
        this.punctuationReplacer
          .handleChange(event, getSmartInputConfig().punctuationRules)
          .catch((error) => console.error(error));
        this.scheduleEvaluate("text changed", true);
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) {
          this.disarmEditorInteraction();
          if (this.evaluateTimer) {
            clearTimeout(this.evaluateTimer);
            this.evaluateTimer = undefined;
          }
          if (this.activitySyncTimer) {
            clearTimeout(this.activitySyncTimer);
            this.activitySyncTimer = undefined;
          }
          this.updateStatusBar(this.imeController.mode, "paused: window not focused");
          return;
        }
        if (vscode.window.activeTextEditor) {
          this.armEditorInteraction();
          this.scheduleActivitySync();
          this.scheduleEvaluate("window focused");
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("smartInput")) {
          this.configEpoch += 1;
          this.lastDesiredCache = undefined;
          this.imeCommandCache = undefined;
          this.compiledRegexEpoch = -1;
          this.compiledRegexRules = [];
          this.lastRegexCandidateCache = undefined;
          this.scheduleEvaluate("config changed");
          this.restartPolling();
          this.refreshDiagnosticBarByConfig();
        }
      }),
      vscode.commands.registerCommand("smartInput.showMenu", () => this.showMenu()),
      vscode.commands.registerCommand("smartInput.showMenuCompat", () => this.showMenu()),
      vscode.commands.registerCommand("smartInput.toggleAutoSwitch", () => this.toggleAutoSwitch()),
      vscode.commands.registerCommand("smartInput.switchToChinese", () => this.forceSwitch("chinese", "manual command")),
      vscode.commands.registerCommand("smartInput.switchToEnglish", () => this.forceSwitch("english", "manual command")),
      vscode.commands.registerCommand("smartInput.openSettings", () => {
        void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:xiaoo.smartime smartInput");
      }),
    );

    this.restartPolling();
    this.refreshDiagnosticBarByConfig();
    if (vscode.window.state.focused && vscode.window.activeTextEditor) {
      this.armEditorInteraction();
    }
    setTimeout(() => {
      void this.evaluateAndSwitch("startup").catch((error) => {
        console.error("[SmartIME] startup evaluate failed", error);
      });
    }, 0);
  }

  public dispose(): void {
    if (this.evaluateTimer) {
      clearTimeout(this.evaluateTimer);
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    if (this.activitySyncTimer) {
      clearTimeout(this.activitySyncTimer);
    }
    if (this.editorInteractionTimer) {
      clearTimeout(this.editorInteractionTimer);
    }
    this.decorationType?.dispose();
  }

  private armEditorInteraction(): void {
    this.editorInteractionArmed = true;
    if (this.editorInteractionTimer) {
      clearTimeout(this.editorInteractionTimer);
    }
    // 仅在最近一次编辑区交互后的一段时间内进行检测，避免在聊天/侧边栏停留时持续调用。
    this.editorInteractionTimer = setTimeout(() => {
      this.editorInteractionArmed = false;
      this.updateStatusBar(this.imeController.mode, "paused: editor not focused");
    }, SmartInputService.EDITOR_INTERACTION_HOLD_MS);
  }

  private disarmEditorInteraction(): void {
    this.editorInteractionArmed = false;
    if (this.editorInteractionTimer) {
      clearTimeout(this.editorInteractionTimer);
      this.editorInteractionTimer = undefined;
    }
  }

  private getPauseReason(): string | undefined {
    if (!vscode.window.state.focused) {
      return "window not focused";
    }
    if (!vscode.window.activeTextEditor) {
      return "no active editor";
    }
    if (!this.editorInteractionArmed) {
      return "editor not focused";
    }
    return undefined;
  }

  private restartPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    const imeCmd = this.resolveImeCommands();
    const cfg = getSmartInputConfig();
    if (!imeCmd.getStateCommand || cfg.ime.pollingIntervalMs <= 0) {
      return;
    }

    // 轮询系统输入态，兼容用户手动切换输入法的场景。
    this.pollTimer = setInterval(() => {
      if (this.getPauseReason()) {
        return;
      }
      this.imeController
        .refreshFromSystem(
          imeCmd.getStateCommand,
          cfg.ime.chineseStatePatterns,
          cfg.ime.englishStatePatterns,
        )
        .catch(() => undefined);
    }, cfg.ime.pollingIntervalMs);
  }

  private resolveImeCommands(): {
    getStateCommand: string;
    switchToChineseCommand: string;
    switchToEnglishCommand: string;
    source: "configured" | "bundled-internal";
  } {
    if (
      this.imeCommandCache
      && this.imeCommandCache.configEpoch === this.configEpoch
      && this.imeCommandCache.workspacePath === this.workspacePath
    ) {
      return this.imeCommandCache.commands;
    }

    const cfg = getSmartInputConfig();

    // 仅保留一个策略：Windows 下固定使用插件内置脚本在同一输入法中切中英。
    if (process.platform === "win32") {
      const bundledScript = path.join(this.context.extensionPath, "tools", "ime-mode.ps1");
      if (fs.existsSync(bundledScript)) {
        const quotedScript = `\"${bundledScript}\"`;
        const prefix = `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File ${quotedScript}`;
        return {
          getStateCommand: `${prefix} get`,
          switchToChineseCommand: `${prefix} zh`,
          switchToEnglishCommand: `${prefix} en`,
          source: "bundled-internal",
        };
      }
    }

    const resolvedGet = this.expandCommand(cfg.ime.getStateCommand);
    const resolvedZh = this.expandCommand(cfg.ime.switchToChineseCommand);
    const resolvedEn = this.expandCommand(cfg.ime.switchToEnglishCommand);

    const hasAnyConfigured = Boolean(resolvedGet || resolvedZh || resolvedEn);
    if (hasAnyConfigured) {
      const commands: {
        getStateCommand: string;
        switchToChineseCommand: string;
        switchToEnglishCommand: string;
        source: "configured" | "bundled-internal";
      } = {
        getStateCommand: resolvedGet,
        switchToChineseCommand: resolvedZh,
        switchToEnglishCommand: resolvedEn,
        source: "configured",
      };
      this.imeCommandCache = {
        configEpoch: this.configEpoch,
        workspacePath: this.workspacePath,
        commands,
      };
      return commands;
    }

    const commands: {
      getStateCommand: string;
      switchToChineseCommand: string;
      switchToEnglishCommand: string;
      source: "configured" | "bundled-internal";
    } = {
      getStateCommand: "",
      switchToChineseCommand: "",
      switchToEnglishCommand: "",
      source: "configured",
    };
    this.imeCommandCache = {
      configEpoch: this.configEpoch,
      workspacePath: this.workspacePath,
      commands,
    };
    return commands;
  }

  private expandCommand(command: string): string {
    if (!command) {
      return "";
    }

    return command
      .replace(/\$\{extensionPath\}/g, this.context.extensionPath)
      .replace(/\$\{workspaceFolder\}/g, this.workspacePath)
      .trim();
  }

  private refreshDiagnosticBarByConfig(): void {
    const cfg = getSmartInputConfig();
    if (!cfg.diagnostic.enabled) {
      this.diagnosticStatusBar.hide();
      return;
    }

    const imeCmd = this.resolveImeCommands();
    const getCmd = imeCmd.getStateCommand || "(empty)";
    const zhCmd = imeCmd.switchToChineseCommand || "(empty)";
    const enCmd = imeCmd.switchToEnglishCommand || "(empty)";
    this.diagnosticStatusBar.show();
    this.diagnosticStatusBar.text = "SmartIME 诊断 | 等待";
    this.diagnosticStatusBar.tooltip = [
      "SmartIME 实时诊断",
      `source: ${imeCmd.source}`,
      `getStateCommand: ${getCmd}`,
      `switchToChineseCommand: ${zhCmd}`,
      `switchToEnglishCommand: ${enCmd}`,
    ].join("\n");
  }

  private updateDiagnosticBar(trace: ImeDiagnosticTrace): void {
    const cfg = getSmartInputConfig();
    if (!cfg.diagnostic.enabled) {
      this.diagnosticStatusBar.hide();
      return;
    }

    const phase = trace.phase === "refresh" ? "refresh" : "switch";
    const flag = trace.success ? "ok" : "fail";
    const output = trace.output ? trace.output : "(no output)";
    const cmd = trace.command ? trace.command : "(no command)";

    this.diagnosticStatusBar.show();
    this.diagnosticStatusBar.text = `SmartIME 诊断 ${flag} | ${phase} | ${trace.mode}`;
    this.diagnosticStatusBar.tooltip = [
      "SmartIME 实时诊断",
      `message: ${trace.message}`,
      `command: ${cmd}`,
      `output: ${output}`,
      `time: ${new Date(trace.timestamp).toLocaleTimeString()}`,
    ].join("\n");
  }

  private scheduleEvaluate(reason: string, immediate = false): void {
    if (this.getPauseReason()) {
      return;
    }

    if (this.evaluateTimer) {
      clearTimeout(this.evaluateTimer);
      this.evaluateTimer = undefined;
    }

    if (immediate) {
      void this.runEvaluate(reason);
      return;
    }

    const cfg = getSmartInputConfig();
    // 简单防抖，减少光标高频移动时的重复计算。
    this.evaluateTimer = setTimeout(() => {
      void this.runEvaluate(reason);
    }, cfg.evaluateDebounceMs);
  }

  private async runEvaluate(reason: string): Promise<void> {
    if (this.getPauseReason()) {
      return;
    }

    if (this.evaluateInFlight) {
      this.queuedEvaluateReason = reason;
      return;
    }

    this.evaluateInFlight = true;
    try {
      await this.evaluateAndSwitch(reason);
    } finally {
      this.evaluateInFlight = false;
      const queued = this.queuedEvaluateReason;
      this.queuedEvaluateReason = undefined;
      if (queued) {
        void this.runEvaluate(queued);
      }
    }
  }

  private scheduleActivitySync(): void {
    const cfg = getSmartInputConfig();
    if (!cfg.ime.liveSyncOnActivity) {
      return;
    }
    if (this.getPauseReason()) {
      return;
    }

    // 切换判定/执行进行中时，优先保证自动切换不被状态查询抢占。
    if (this.evaluateInFlight) {
      return;
    }
    if (Date.now() - this.lastProgrammaticSwitchAt < 300) {
      return;
    }

    if (this.activitySyncTimer) {
      clearTimeout(this.activitySyncTimer);
    }

    this.activitySyncTimer = setTimeout(() => {
      void this.runActivitySync();
    }, cfg.ime.liveSyncDebounceMs);
  }

  private async runActivitySync(): Promise<void> {
    if (this.getPauseReason()) {
      return;
    }

    const cfg = getSmartInputConfig();
    const now = Date.now();
    if (now - this.lastActivitySyncAt < cfg.ime.liveSyncMinIntervalMs) {
      return;
    }
    this.lastActivitySyncAt = now;

    const imeCmd = this.resolveImeCommands();
    if (!imeCmd.getStateCommand) {
      return;
    }

    const before = this.imeController.mode;
    const actual = await this.imeController.refreshFromSystem(
      imeCmd.getStateCommand,
      cfg.ime.chineseStatePatterns,
      cfg.ime.englishStatePatterns,
    );

    if (!actual || actual === before) {
      return;
    }

    if (Date.now() - this.lastProgrammaticSwitchAt < 500) {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const desired = await this.resolveDesiredMode(editor, cfg.vimNormalForceEnglish);
    if (!desired) {
      return;
    }

    // 用户手动切到中文且当前处于英文代码目标场景时，进入“中文粘性”模式：
    // 不按时间自动回切，仅在后续光标移动到英文代码位置时回切。
    if (actual === "chinese" && desired.mode === "english") {
      this.manualChineseSticky = true;
    }

    if (actual === "english") {
      this.manualChineseSticky = false;
    }
  }

  private async evaluateAndSwitch(reason: string): Promise<void> {
    const pauseReason = this.getPauseReason();
    if (pauseReason) {
      this.updateStatusBar(this.imeController.mode, `paused: ${pauseReason}`);
      return;
    }

    const editor = vscode.window.activeTextEditor;
    const cfg = getSmartInputConfig();

    if (!editor) {
      this.updateStatusBar(this.imeController.mode, "no active editor");
      return;
    }

    if (!cfg.enabled) {
      this.updateStatusBar(this.imeController.mode, "auto switch disabled");
      return;
    }

    const desired = await this.resolveDesiredMode(editor, cfg.vimNormalForceEnglish);
    if (!desired) {
      this.updateStatusBar(this.imeController.mode, "no matching rule");
      return;
    }

    // 符合程序员手感：代码区手动切中文后，不按时间自动回切；
    // 仅当后续光标移动到英文代码位置时，才恢复自动回英文。
    if (desired.mode === "english" && this.imeController.mode === "chinese" && this.manualChineseSticky) {
      const isCursorDrivenReason =
        reason === "cursor moved"
        || reason === "active editor changed"
        || reason === "window focused";
      if (!isCursorDrivenReason) {
        this.updateStatusBar(this.imeController.mode, "manual chinese sticky");
        return;
      }
      this.manualChineseSticky = false;
    }

    // 目标态和当前本地态一致时直接返回，避免重复执行外部命令。
    if (this.imeController.mode === desired.mode) {
      this.updateStatusBar(desired.mode, `${desired.detail}, ${reason}`);
      return;
    }

    const imeCmd = this.resolveImeCommands();
    const switchCommand =
      desired.mode === "chinese" ? imeCmd.switchToChineseCommand : imeCmd.switchToEnglishCommand;

    // 真正执行切换；若命令为空则仅更新内部状态。
    const switched = await this.imeController.switchTo(
      desired.mode,
      switchCommand,
      desired.detail,
      imeCmd.getStateCommand,
      cfg.ime.chineseStatePatterns,
      cfg.ime.englishStatePatterns,
      cfg.ime.verifyAfterSwitch,
    );

    this.lastProgrammaticSwitchAt = Date.now();

    if (!switched) {
      this.updateStatusBar(this.imeController.mode, `${desired.detail}, ${reason}, switch verify failed`);
      return;
    }

    if (desired.mode === "english") {
      this.manualChineseSticky = false;
    }

    this.updateStatusBar(desired.mode, `${desired.detail}, ${reason}`);
  }

  private async resolveDesiredMode(
    editor: vscode.TextEditor,
    vimNormalForceEnglish: boolean,
  ): Promise<{ mode: ImeMode; detail: string } | null> {
    const position = editor.selection.active;
    const document = editor.document;
    const filePath = document.fileName;
    const vimNormal = vimNormalForceEnglish ? await this.getVimNormalModeCached() : false;

    const cached = this.lastDesiredCache;
    if (
      cached
      && cached.uri === document.uri.toString()
      && cached.version === document.version
      && cached.line === position.line
      && cached.character === position.character
      && cached.configEpoch === this.configEpoch
      && cached.vimNormalForceEnglish === vimNormalForceEnglish
      && cached.vimNormal === vimNormal
    ) {
      return cached.result;
    }

    if (vimNormal) {
      const result = { mode: "english" as ImeMode, detail: "vim normal mode" };
      this.lastDesiredCache = {
        uri: document.uri.toString(),
        version: document.version,
        line: position.line,
        character: position.character,
        configEpoch: this.configEpoch,
        vimNormalForceEnglish,
        vimNormal,
        result,
      };
      return result;
    }

    const byRegex = this.matchRegexRules(filePath, document, position);
    if (byRegex) {
      this.lastDesiredCache = {
        uri: document.uri.toString(),
        version: document.version,
        line: position.line,
        character: position.character,
        configEpoch: this.configEpoch,
        vimNormalForceEnglish,
        vimNormal,
        result: byRegex,
      };
      return byRegex;
    }

    const editorRule = this.matchEditorRule(filePath);
    if (!editorRule) {
      this.lastDesiredCache = {
        uri: document.uri.toString(),
        version: document.version,
        line: position.line,
        character: position.character,
        configEpoch: this.configEpoch,
        vimNormalForceEnglish,
        vimNormal,
        result: null,
      };
      return null;
    }

    // 未命中正则时，回退到“文件类型 + 上下文区域”规则。
    const zone = detectContextZone(document, position, getSmartInputConfig().contextScanLookbackChars);

    const mode = this.resolveModeByZone(editorRule, zone);
    const result = {
      mode,
      detail: `${editorRule.name} -> ${zone}`,
    };
    this.lastDesiredCache = {
      uri: document.uri.toString(),
      version: document.version,
      line: position.line,
      character: position.character,
      configEpoch: this.configEpoch,
      vimNormalForceEnglish,
      vimNormal,
      result,
    };
    return result;
  }

  private async getVimNormalModeCached(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastVimModeCheckAt <= 120) {
      return this.lastVimModeValue;
    }

    this.lastVimModeCheckAt = now;
    this.lastVimModeValue = await this.isVimNormalMode();
    return this.lastVimModeValue;
  }

  private matchEditorRule(filePath: string): EditorRule | undefined {
    const languageId = vscode.window.activeTextEditor?.document.languageId ?? "";
    return getSmartInputConfig().editorRules.find((rule) =>
      matchByFileTypeOrLanguage(filePath, languageId, rule.fileTypes, rule.languageIds),
    );
  }

  private resolveModeByZone(rule: EditorRule, zone: ContextZone): ImeMode {
    switch (zone) {
      case "string":
        return rule.string ?? rule.other;
      case "lineComment":
        return rule.lineComment ?? rule.other;
      case "blockComment":
        return rule.blockComment ?? rule.other;
      case "docComment":
        return rule.docComment ?? rule.blockComment ?? rule.other;
      case "other":
      default:
        return rule.other;
    }
  }

  private matchRegexRules(
    filePath: string,
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { mode: ImeMode; detail: string } | null {
    const candidates = this.getRegexCandidates(filePath, document.languageId);
    if (!candidates.length) {
      return null;
    }

    const text = document.getText();
    const offset = document.offsetAt(position);
    const left = text.slice(0, offset);
    const right = text.slice(offset);

    for (const item of candidates) {
      if (!item.leftReg || !item.rightReg) {
        continue;
      }
      if (!item.leftReg.test(left) || !item.rightReg.test(right)) {
        continue;
      }
      return { mode: item.rule.ime, detail: `regex:${item.rule.name}` };
    }

    return null;
  }

  private getRegexCandidates(
    filePath: string,
    languageId: string,
  ): Array<{ rule: RegexRule; leftReg: RegExp | null; rightReg: RegExp | null }> {
    const key = `${this.configEpoch}|${filePath.toLowerCase()}|${languageId.toLowerCase()}`;
    if (this.lastRegexCandidateCache && this.lastRegexCandidateCache.key === key) {
      return this.lastRegexCandidateCache.rules;
    }

    const candidates = this.getCompiledRegexRules().filter((item) =>
      matchByFileTypeOrLanguage(filePath, languageId, item.rule.fileTypes, item.rule.languageIds),
    );

    this.lastRegexCandidateCache = {
      key,
      rules: candidates,
    };
    return candidates;
  }

  private getCompiledRegexRules(): Array<{ rule: RegexRule; leftReg: RegExp | null; rightReg: RegExp | null }> {
    if (this.compiledRegexEpoch === this.configEpoch) {
      return this.compiledRegexRules;
    }

    const rules = getSmartInputConfig().regexRules;
    this.compiledRegexRules = rules.map((rule) => {
      try {
        return {
          rule,
          leftReg: new RegExp(rule.leftRegex),
          rightReg: new RegExp(rule.rightRegex),
        };
      } catch {
        return {
          rule,
          leftReg: null,
          rightReg: null,
        };
      }
    });
    this.compiledRegexEpoch = this.configEpoch;
    return this.compiledRegexRules;
  }

  private isRegexMatched(rule: RegexRule, left: string, right: string): boolean {
    try {
      const leftReg = new RegExp(rule.leftRegex);
      const rightReg = new RegExp(rule.rightRegex);
      return leftReg.test(left) && rightReg.test(right);
    } catch {
      return false;
    }
  }

  private async isVimNormalMode(): Promise<boolean> {
    try {
      const result = await vscode.commands.executeCommand<unknown>("vim.getCurrentMode");
      if (typeof result === "string") {
        return result.toLowerCase().includes("normal");
      }
      if (result && typeof result === "object" && "mode" in result) {
        const mode = String((result as { mode: string }).mode || "").toLowerCase();
        return mode.includes("normal");
      }
      return false;
    } catch {
      return false;
    }
  }

  private async forceSwitch(mode: ImeMode, reason: string): Promise<void> {
    const cfg = getSmartInputConfig();
    const imeCmd = this.resolveImeCommands();
    const cmd = mode === "chinese" ? imeCmd.switchToChineseCommand : imeCmd.switchToEnglishCommand;
    const switched = await this.imeController.switchTo(
      mode,
      cmd,
      reason,
      imeCmd.getStateCommand,
      cfg.ime.chineseStatePatterns,
      cfg.ime.englishStatePatterns,
      cfg.ime.verifyAfterSwitch,
      true,
    );
    this.lastProgrammaticSwitchAt = Date.now();
    this.manualChineseSticky = mode === "chinese";
    this.updateStatusBar(switched ? mode : this.imeController.mode, switched ? reason : `${reason}, switch verify failed`);
  }

  private async toggleAutoSwitch(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("smartInput");
    const current = cfg.get<boolean>("enabled", true);
    await cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
    this.updateStatusBar(this.imeController.mode, !current ? "auto switch enabled" : "auto switch disabled");
  }

  private async showMenu(): Promise<void> {
    const items: vscode.QuickPickItem[] = [
      { label: "$(gear) 打开设置", description: "配置 SmartIME" },
      { label: "$(sync) 自动切换开关", description: "启用或关闭自动切换" },
      { label: "$(comment-discussion) 切换到中文", description: "手动切换到中文输入态" },
      { label: "$(code) 切换到英文", description: "手动切换到英文输入态" },
    ];

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: "SmartIME 菜单",
      ignoreFocusOut: true,
    });

    if (!selected) {
      return;
    }

    if (selected.label.includes("打开设置")) {
      await vscode.commands.executeCommand("smartInput.openSettings");
      return;
    }

    if (selected.label.includes("自动切换开关")) {
      await this.toggleAutoSwitch();
      return;
    }

    if (selected.label.includes("切换到中文")) {
      await this.forceSwitch("chinese", "manual menu");
      return;
    }

    if (selected.label.includes("切换到英文")) {
      await this.forceSwitch("english", "manual menu");
    }
  }

  private updateStatusBar(mode: ImeMode, detail: string): void {
    const cfg = getSmartInputConfig();
    const modeText = mode === "chinese" ? "中" : "英";
    this.statusBar.text = `SmartIME ${modeText}`;
    if (!cfg.showDetailInStatusBar) {
      this.statusBar.tooltip = "点击打开 SmartIME 菜单";
      return;
    }

    const lower = detail.toLowerCase();
    const isBackgroundNoise = lower.includes("mode changed") || lower.includes("window focused");
    if (isBackgroundNoise && this.statusBar.tooltip) {
      return;
    }

    this.statusBar.tooltip = detail;
  }

  private updateCursorDecorator(mode: ImeMode): void {
    this.renderDecoratorAtLineEnd(mode);
  }

  private renderDecoratorAtLineEnd(mode: ImeMode): void {
    const editor = vscode.window.activeTextEditor;
    const cfg = getSmartInputConfig();

    if (!editor || !cfg.cursorDecorator.enabled) {
      this.decorationType?.dispose();
      this.decorationType = undefined;
      return;
    }

    this.decorationType?.dispose();

    const text = mode === "chinese" ? cfg.cursorDecorator.chineseText : cfg.cursorDecorator.englishText;
    const color = mode === "chinese" ? cfg.cursorColor.chinese : cfg.cursorColor.english;
    const activeLine = editor.selection.active.line;
    const key = `${editor.document.uri.toString()}#${activeLine}#${mode}#${text}#${color}`;
    if (key === this.lastDecoratorKey && this.decorationType) {
      return;
    }
    this.lastDecoratorKey = key;

    this.decorationType = vscode.window.createTextEditorDecorationType({
      after: {
        margin: "0 0 0 6px",
        color,
        contentText: text,
        fontWeight: "bold",
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    const endOfLine = editor.document.lineAt(activeLine).range.end;
    editor.setDecorations(this.decorationType, [new vscode.Range(endOfLine, endOfLine)]);
  }

  private updateCursorColor(mode: ImeMode): void {
    const cfg = getSmartInputConfig();
    if (!cfg.cursorColor.enabled) {
      return;
    }

    const workbenchCfg = vscode.workspace.getConfiguration("workbench");
    const current = workbenchCfg.get<Record<string, unknown>>("colorCustomizations", {});
    const next = {
      ...current,
      "editorCursor.foreground": mode === "chinese" ? cfg.cursorColor.chinese : cfg.cursorColor.english,
    };

    void workbenchCfg.update("colorCustomizations", next, vscode.ConfigurationTarget.Global);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const service = new SmartInputService(context);
  context.subscriptions.push(service);
}

export function deactivate(): void {
  // no-op
}
