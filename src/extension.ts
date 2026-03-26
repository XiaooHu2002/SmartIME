import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { detectContextZone } from "./contextDetector";
import { getSmartInputConfig, matchByFileTypeOrLanguage } from "./config";
import { ImeController, ImeDiagnosticTrace } from "./imeController";
import { PunctuationReplacer } from "./punctuationReplacer";
import { buildSceneRequestByZone } from "./sceneProtocol";
import { ContextZone, EditorRule, ImeMode, RegexRule, SmartInputConfig } from "./types";

// 统一编排：监听编辑器事件 -> 计算目标输入态 -> 调用输入法控制层。
class SmartInputService implements vscode.Disposable {
  private static readonly EDITOR_INTERACTION_HOLD_MS = 800;

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
  private lastCursorAnchor:
    | {
      uri: string;
      line: number;
      character: number;
    }
    | undefined;
  private manualShiftSticky:
    | {
      mode: ImeMode;
      uri: string;
      line: number;
      character: number;
    }
    | undefined;
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
  private get workspacePath(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    this.imeController = new ImeController(this.context.extensionPath);
    void this.ensureEnabledDefaultSetting();

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
          this.lastCursorAnchor = {
            uri: editor.document.uri.toString(),
            line: editor.selection.active.line,
            character: editor.selection.active.character,
          };
          this.armEditorInteraction();
          this.scheduleEvaluate("active editor changed", true);
          return;
        }
        this.lastCursorAnchor = undefined;
        this.disarmEditorInteraction();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.kind === vscode.TextEditorSelectionChangeKind.Command) {
          return;
        }

        this.armEditorInteraction();
        this.renderDecoratorAtLineEnd(this.imeController.mode);
        this.scheduleActivitySync();

        const current = event.selections[0]?.active;
        if (!current) {
          return;
        }

        const uri = event.textEditor.document.uri.toString();
        const prevAnchor = this.lastCursorAnchor;
        const lineChanged =
          !prevAnchor
          || prevAnchor.uri !== uri
          || prevAnchor.line !== current.line;

        this.lastCursorAnchor = {
          uri,
          line: current.line,
          character: current.character,
        };

        // 只在“跨行（或跨文件）移动”时重算，避免同一行内频繁抖动。
        // 这里不区分鼠标/键盘，确保全文件类型一致生效。
        if (lineChanged) {
          this.scheduleEvaluate("cursor line changed", true);
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document !== event.document) {
          return;
        }

        this.armEditorInteraction();
        this.punctuationReplacer
          .handleChange(
            event,
            getSmartInputConfig().punctuationRules,
            (text, map) => this.imeController.mapPunctuation(text, map),
          )
          .catch((error) => console.error(error));
        // 输入文本本身不触发场景重算，避免手动切中文后被立刻抢回英文。
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (!state.focused) {
          void this.applyLeaveIdeStrategy();
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
        void this.applyEnterIdeMode();
        if (vscode.window.activeTextEditor) {
          this.armEditorInteraction();
          this.scheduleActivitySync();
          this.scheduleEvaluate("window focused");
        }
      }),
      vscode.window.onDidChangeActiveTerminal((terminal) => {
        if (!terminal) {
          return;
        }
        this.disarmEditorInteraction();
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
      vscode.commands.registerCommand("smartInput.enableAutoSwitch", () => this.enableAutoSwitch()),
      vscode.commands.registerCommand("smartInput.switchToChinese", () => this.forceSwitch("chinese", "manual command")),
      vscode.commands.registerCommand("smartInput.switchToEnglish", () => this.forceSwitch("english", "manual command")),
      vscode.commands.registerCommand("smartInput.openSettings", () => {
        void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:xiaoohu.smartime smartInput");
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

  private async ensureEnabledDefaultSetting(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("smartInput");
    const inspected = cfg.inspect<boolean>("enabled");
    const hasExplicit = Boolean(
      inspected?.globalValue !== undefined
      || inspected?.workspaceValue !== undefined
      || inspected?.workspaceFolderValue !== undefined,
    );

    if (hasExplicit) {
      return;
    }

    await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
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

  private setManualShiftSticky(mode: ImeMode, editor: vscode.TextEditor): void {
    const position = editor.selection.active;
    this.manualShiftSticky = {
      mode,
      uri: editor.document.uri.toString(),
      line: position.line,
      character: position.character,
    };
  }

  private shouldHoldManualShiftSticky(
    reason: string,
    editor: vscode.TextEditor,
    desiredMode: ImeMode,
  ): boolean {
    if (!this.manualShiftSticky) {
      return false;
    }

    // 若当前状态已经不再是手动粘性时的模式，则清理粘性标记。
    if (this.imeController.mode !== this.manualShiftSticky.mode) {
      this.manualShiftSticky = undefined;
      return false;
    }

    if (desiredMode === this.imeController.mode) {
      return false;
    }

    const isNavigationReason = reason === "cursor line changed" || reason === "active editor changed";
    if (!isNavigationReason) {
      return true;
    }

    const position = editor.selection.active;
    const sameLine =
      editor.document.uri.toString() === this.manualShiftSticky.uri
      && position.line === this.manualShiftSticky.line;

    // 手动 Shift 后，在同一行内点击/移动不自动改回；跨行后再恢复自动切换。
    if (sameLine) {
      return true;
    }

    this.manualShiftSticky = undefined;
    return false;
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
    const intervalMs = cfg.ime.pollingIntervalMs > 0
      ? cfg.ime.pollingIntervalMs
      : (this.imeController.hasWorker ? 100 : 0);

    if (!imeCmd.getStateCommand || intervalMs <= 0) {
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
      }, intervalMs);
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

    // 只要识别到系统输入态被手动改变（且非程序触发的短窗口），
    // 就冻结自动回切，直到光标真正移动到新位置。
    this.setManualShiftSticky(actual, editor);
    this.updateStatusBar(actual, "manual shift detected");
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

    const desired = await this.resolveDesiredMode(editor, cfg);
    if (!desired) {
      this.updateStatusBar(this.imeController.mode, "no matching rule");
      return;
    }

    if (this.shouldHoldManualShiftSticky(reason, editor, desired.mode)) {
      this.updateStatusBar(this.imeController.mode, "manual shift sticky");
      return;
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

    this.manualShiftSticky = undefined;

    this.updateStatusBar(desired.mode, `${desired.detail}, ${reason}`);
  }

  private async resolveDesiredMode(
    editor: vscode.TextEditor,
    cfg: SmartInputConfig,
  ): Promise<{ mode: ImeMode; detail: string } | null> {
    const position = editor.selection.active;
    const document = editor.document;
    const filePath = document.fileName;
    const vimNormalForceEnglish = cfg.vimNormalForceEnglish;
    const vimNormal = vimNormalForceEnglish ? await this.getVimNormalModeCached() : false;

    if (this.isSearchEverywhereDocument(document)) {
      const goDecision = await this.imeController.decideByScene({
        scene: "SEARCH_EVERYWHERE",
        forcedIme: this.toSceneIme(cfg.scene.searchEverywhereIme),
      });
      const result = goDecision ?? {
        mode: cfg.scene.searchEverywhereIme,
        detail: "search everywhere",
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

    if (document.languageId === "scminput") {
      const goDecision = await this.imeController.decideByScene({
        scene: "COMMIT",
        forcedIme: this.toSceneIme(cfg.scene.commitIme),
      });
      const result = goDecision ?? { mode: cfg.scene.commitIme, detail: "scm commit input" };
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
      const goDecision = await this.imeController.decideByScene({
        scene: "IDEA_VIM_NORMAL",
        vimMode: "normal",
        forcedIme: this.toSceneIme(cfg.scene.ideaVimNormalIme),
      });
      const result = goDecision ?? { mode: cfg.scene.ideaVimNormalIme, detail: "vim normal mode" };
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
      const goDecision = await this.imeController.decideByScene({
        scene: "CUSTOM_REGEX",
        forcedIme: byRegex.mode === "chinese" ? "zh" : "en",
      });
      const result = goDecision ?? byRegex;
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

    const editorRule = this.matchEditorRule(filePath);

    // 未命中正则时，回退到“文件类型 + 上下文区域”规则。
    const zone = detectContextZone(document, position, getSmartInputConfig().contextScanLookbackChars);

    const sceneReq = buildSceneRequestByZone(zone, vimNormal);
    if (sceneReq.scene === "COMMENT") {
      sceneReq.forcedIme = this.toSceneIme(cfg.scene.commentIme);
    } else if (sceneReq.scene === "STRING") {
      sceneReq.preferredString = this.toSceneIme(cfg.scene.stringIme);
      sceneReq.forcedIme = this.toSceneIme(cfg.scene.stringIme);
    } else if (sceneReq.scene === "DEFAULT") {
      sceneReq.forcedIme = this.toSceneIme(cfg.scene.defaultIme);
    } else if (sceneReq.scene === "IDEA_VIM_NORMAL") {
      sceneReq.forcedIme = this.toSceneIme(cfg.scene.ideaVimNormalIme);
    }

    const goDecision = await this.imeController.decideByScene(sceneReq);
    if (goDecision) {
      this.lastDesiredCache = {
        uri: document.uri.toString(),
        version: document.version,
        line: position.line,
        character: position.character,
        configEpoch: this.configEpoch,
        vimNormalForceEnglish,
        vimNormal,
        result: goDecision,
      };
      return goDecision;
    }

    const mode = editorRule
      ? this.resolveModeByZone(editorRule, zone, cfg)
      : this.resolveModeBySceneDefaults(zone, cfg);
    const result = {
      mode,
      detail: editorRule ? `${editorRule.name} -> ${zone}` : `scene-default -> ${zone}`,
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

  private resolveModeByZone(rule: EditorRule, zone: ContextZone, cfg: SmartInputConfig): ImeMode {
    switch (zone) {
      case "string":
        return rule.string ?? cfg.scene.stringIme;
      case "lineComment":
        return rule.lineComment ?? cfg.scene.commentIme;
      case "blockComment":
        return rule.blockComment ?? cfg.scene.commentIme;
      case "docComment":
        return rule.docComment ?? rule.blockComment ?? cfg.scene.commentIme;
      case "other":
      default:
        return rule.other ?? cfg.scene.defaultIme;
    }
  }

  private resolveModeBySceneDefaults(zone: ContextZone, cfg: SmartInputConfig): ImeMode {
    switch (zone) {
      case "string":
        return cfg.scene.stringIme;
      case "lineComment":
      case "blockComment":
      case "docComment":
        return cfg.scene.commentIme;
      case "other":
      default:
        return cfg.scene.defaultIme;
    }
  }

  private toSceneIme(mode: ImeMode): "zh" | "en" {
    return mode === "chinese" ? "zh" : "en";
  }

  private fromSceneIme(mode: "zh" | "en"): ImeMode {
    return mode === "zh" ? "chinese" : "english";
  }

  private isSearchEverywhereDocument(document: vscode.TextDocument): boolean {
    const languageId = String(document.languageId || "").toLowerCase();
    const scheme = String(document.uri.scheme || "").toLowerCase();
    if (languageId === "search-result" || scheme === "search-editor") {
      return true;
    }
    return false;
  }

  private async applyLeaveIdeStrategy(): Promise<void> {
    const cfg = getSmartInputConfig();
    const strategy = cfg.scene.leaveStrategy;
    if (strategy === "none") {
      return;
    }

    const goDecision = await this.imeController.decideByScene({
      scene: "LEAVE_IDE",
      leaveStrategy: strategy,
    });
    if (goDecision) {
      await this.applyDirectMode(goDecision.mode, `leave ide (${strategy})`);
      return;
    }

    if (strategy === "en" || strategy === "zh") {
      await this.applyDirectMode(this.fromSceneIme(strategy), `leave ide (${strategy})`);
    }
  }

  private async applyEnterIdeMode(): Promise<void> {
    const cfg = getSmartInputConfig();
    if (cfg.scene.enterIdeMode === "keep") {
      return;
    }

    const forcedIme = cfg.scene.enterIdeMode;
    const goDecision = await this.imeController.decideByScene({
      scene: "DEFAULT",
      forcedIme,
    });
    if (goDecision) {
      await this.applyDirectMode(goDecision.mode, `enter ide (${forcedIme})`);
      return;
    }

    await this.applyDirectMode(this.fromSceneIme(forcedIme), `enter ide (${forcedIme})`);
  }

  private async applyToolWindowScene(toolWindow: string): Promise<void> {
    const cfg = getSmartInputConfig();
    const forcedIme = cfg.scene.toolWindowImeMap[toolWindow];
    if (!forcedIme) {
      return;
    }

    const goDecision = await this.imeController.decideByScene({
      scene: "TOOL_WINDOW",
      toolWindow,
      forcedIme,
    });
    if (goDecision) {
      await this.applyDirectMode(goDecision.mode, `tool window (${toolWindow})`);
      return;
    }

    await this.applyDirectMode(this.fromSceneIme(forcedIme), `tool window (${toolWindow})`);
  }

  private async applyDirectMode(mode: ImeMode, reason: string): Promise<void> {
    if (this.imeController.mode === mode) {
      this.updateStatusBar(mode, reason);
      return;
    }

    const cfg = getSmartInputConfig();
    const imeCmd = this.resolveImeCommands();
    const switchCommand = mode === "chinese" ? imeCmd.switchToChineseCommand : imeCmd.switchToEnglishCommand;

    const switched = await this.imeController.switchTo(
      mode,
      switchCommand,
      reason,
      imeCmd.getStateCommand,
      cfg.ime.chineseStatePatterns,
      cfg.ime.englishStatePatterns,
      cfg.ime.verifyAfterSwitch,
    );

    this.lastProgrammaticSwitchAt = Date.now();
    this.updateStatusBar(switched ? mode : this.imeController.mode, switched ? reason : `${reason}, switch verify failed`);
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

    const offset = document.offsetAt(position);
    const windowChars = Math.max(2048, getSmartInputConfig().contextScanLookbackChars);
    const docEndOffset = document.offsetAt(document.lineAt(document.lineCount - 1).range.end);
    const leftStartOffset = Math.max(0, offset - windowChars);
    const rightEndOffset = Math.min(docEndOffset, offset + windowChars);

    const left = document.getText(new vscode.Range(document.positionAt(leftStartOffset), position));
    const right = document.getText(new vscode.Range(position, document.positionAt(rightEndOffset)));

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
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      this.setManualShiftSticky(mode, activeEditor);
    }
    this.updateStatusBar(switched ? mode : this.imeController.mode, switched ? reason : `${reason}, switch verify failed`);
  }

  private async toggleAutoSwitch(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("smartInput");
    const current = cfg.get<boolean>("enabled", true);
    await cfg.update("enabled", !current, vscode.ConfigurationTarget.Global);
    this.updateStatusBar(this.imeController.mode, !current ? "auto switch enabled" : "auto switch disabled");
  }

  private async enableAutoSwitch(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("smartInput");
    const current = cfg.get<boolean>("enabled", true);
    if (!current) {
      await cfg.update("enabled", true, vscode.ConfigurationTarget.Global);
    }
    this.updateStatusBar(this.imeController.mode, "auto switch enabled");
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

    if (!cfg.enabled) {
      this.statusBar.command = "smartInput.enableAutoSwitch";
      this.statusBar.text = "SmartIME OFF";
      this.statusBar.tooltip = "自动切换已关闭，点击一键启用";
      return;
    }

    this.statusBar.command = "smartInput.showMenu";
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
