import { exec } from "child_process";
import * as vscode from "vscode";
import { ImeMode } from "./types";
import { ImeWorkerClient } from "./imeWorkerClient";
import { parseSceneImeOutput, SceneDecisionRequest } from "./sceneProtocol";

export interface ImeDiagnosticTrace {
  phase: "refresh" | "switch";
  success: boolean;
  mode: ImeMode | "unknown";
  command: string;
  output: string;
  message: string;
  timestamp: number;
}

// 统一封装命令执行，避免上层重复处理 stdout/stderr。
function runShell(command: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve({
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

function parseModeFromOutput(text: string, chinesePatterns: string[], englishPatterns: string[]): ImeMode | null {
  const normalized = text.toLowerCase().trim();
  if (!normalized) {
    return null;
  }

  if (chinesePatterns.some((pattern) => normalized === pattern || normalized.includes(pattern))) {
    return "chinese";
  }
  if (englishPatterns.some((pattern) => normalized === pattern || normalized.includes(pattern))) {
    return "english";
  }
  return null;
}

export class ImeController implements vscode.Disposable {
  private currentMode: ImeMode = "english";
  private readonly modeEmitter = new vscode.EventEmitter<ImeMode>();
  private readonly diagnosticEmitter = new vscode.EventEmitter<ImeDiagnosticTrace>();
  private readonly output = vscode.window.createOutputChannel("SmartIME");
  private readonly workerClient: ImeWorkerClient | undefined;

  constructor(extensionPath?: string) {
    this.workerClient = extensionPath ? new ImeWorkerClient(extensionPath) : undefined;
  }

  public readonly onDidChangeMode = this.modeEmitter.event;
  public readonly onDidDiagnostic = this.diagnosticEmitter.event;

  public get mode(): ImeMode {
    return this.currentMode;
  }

  public get hasWorker(): boolean {
    return Boolean(this.workerClient?.available);
  }

  public async refreshFromSystem(
    getStateCommand: string,
    chinesePatterns: string[],
    englishPatterns: string[],
  ): Promise<ImeMode | null> {
    if (this.shouldUseWorker(getStateCommand)) {
      try {
        const output = await this.workerClient!.execute("get");
        const parsed = parseModeFromOutput(output, chinesePatterns, englishPatterns);
        if (parsed) {
          this.updateMode(parsed);
        }
        this.emitDiagnostic({
          phase: "refresh",
          success: parsed !== null,
          mode: parsed ?? "unknown",
          command: "ime-worker:get",
          output,
          message: parsed ? "state parsed by worker" : "state unknown",
        });
        return parsed;
      } catch (error) {
        this.output.appendLine(`[refreshFromSystem:worker] ${String(error)}`);
      }
    }

    if (!getStateCommand) {
      return null;
    }

    try {
      const result = await runShell(getStateCommand);
      // 按关键字（如 zh/en）解析输入态。
      const parsed = parseModeFromOutput(result.stdout, chinesePatterns, englishPatterns);
      if (parsed) {
        this.updateMode(parsed);
      }

      this.emitDiagnostic({
        phase: "refresh",
        success: parsed !== null,
        mode: parsed ?? "unknown",
        command: getStateCommand,
        output: result.stdout || result.stderr,
        message: parsed ? "state parsed" : "state unknown",
      });

      return parsed;
    } catch (error) {
      this.output.appendLine(`[refreshFromSystem] ${String(error)}`);
      this.emitDiagnostic({
        phase: "refresh",
        success: false,
        mode: "unknown",
        command: getStateCommand,
        output: "",
        message: `refresh error: ${String(error)}`,
      });
      return null;
    }
  }

  public async decideByScene(request: SceneDecisionRequest): Promise<{ mode: ImeMode; detail: string } | null> {
    if (!this.workerClient?.available) {
      return null;
    }

    try {
      const payload: Record<string, unknown> = { ...request };
      const output = await this.workerClient.executeWithPayload("decide", payload, 300);
      const mode = parseSceneImeOutput(output);
      if (!mode) {
        return null;
      }
      return {
        mode,
        detail: `go-scene:${request.scene}`,
      };
    } catch {
      return null;
    }
  }

  public async switchTo(
    mode: ImeMode,
    switchCommand: string,
    reason: string,
    getStateCommand: string,
    chinesePatterns: string[],
    englishPatterns: string[],
    verifyAfterSwitch: boolean,
    forceWhenLocalSame = false,
  ): Promise<boolean> {
    const previousMode = this.currentMode;

    if (this.currentMode === mode && !forceWhenLocalSame) {
      this.emitDiagnostic({
        phase: "switch",
        success: true,
        mode,
        command: "",
        output: "",
        message: "skip: same mode",
      });
      return true;
    }

    if (this.currentMode === mode && forceWhenLocalSame && getStateCommand) {
      const actual = await this.refreshFromSystem(getStateCommand, chinesePatterns, englishPatterns);
      if (actual === mode) {
        this.emitDiagnostic({
          phase: "switch",
          success: true,
          mode,
          command: getStateCommand,
          output: String(actual),
          message: "skip: same mode after sync",
        });
        return true;
      }
    }

    // 先更新本地状态，降低注释/代码快速切换时的可见延迟；失败再回滚。
    this.updateMode(mode);

    if (switchCommand && this.shouldUseWorker(switchCommand)) {
      try {
        const action = mode === "chinese" ? "zh" : "en";
        const output = await this.workerClient!.execute(action);
        this.emitDiagnostic({
          phase: "switch",
          success: true,
          mode,
          command: `ime-worker:${action}`,
          output,
          message: "switch by worker",
        });
      } catch (error) {
        this.output.appendLine(`[switchTo:${mode}:worker] failed, reason=${reason}, error=${String(error)}`);
        this.updateMode(previousMode);
        this.emitDiagnostic({
          phase: "switch",
          success: false,
          mode,
          command: "ime-worker",
          output: "",
          message: `worker switch error: ${String(error)}`,
        });
        return false;
      }
    } else if (switchCommand) {
      try {
        const result = await runShell(switchCommand);
        this.emitDiagnostic({
          phase: "switch",
          success: true,
          mode,
          command: switchCommand,
          output: result.stdout || result.stderr,
          message: "switch command executed",
        });
      } catch (error) {
        this.output.appendLine(`[switchTo:${mode}] failed, reason=${reason}, error=${String(error)}`);
        this.updateMode(previousMode);
        this.emitDiagnostic({
          phase: "switch",
          success: false,
          mode,
          command: switchCommand,
          output: "",
          message: `switch error: ${String(error)}`,
        });
        return false;
      }
    } else {
      this.emitDiagnostic({
        phase: "switch",
        success: true,
        mode,
        command: "",
        output: "",
        message: "no switch command, local fallback",
      });
    }

    if (verifyAfterSwitch && getStateCommand) {
      const actual = await this.refreshFromSystem(getStateCommand, chinesePatterns, englishPatterns);
      if (actual === mode) {
        return true;
      }
      this.updateMode(previousMode);
      this.output.appendLine(
        `[switchTo:${mode}] verification mismatch, reason=${reason}, actual=${String(actual ?? "unknown")}`,
      );
      this.emitDiagnostic({
        phase: "switch",
        success: false,
        mode,
        command: getStateCommand,
        output: String(actual ?? "unknown"),
        message: "verification mismatch",
      });
      return false;
    }

    // 关闭校验时已提前更新本地状态。
    return true;
  }

  private shouldUseWorker(command: string): boolean {
    if (!command || !this.workerClient?.available) {
      return false;
    }
    return command.toLowerCase().includes("ime-mode.ps1");
  }

  private emitDiagnostic(trace: Omit<ImeDiagnosticTrace, "timestamp">): void {
    this.diagnosticEmitter.fire({
      ...trace,
      timestamp: Date.now(),
    });
  }

  public setLocalMode(mode: ImeMode): void {
    this.updateMode(mode);
  }

  private updateMode(mode: ImeMode): void {
    if (this.currentMode === mode) {
      return;
    }
    this.currentMode = mode;
    this.modeEmitter.fire(mode);
  }

  public dispose(): void {
    this.workerClient?.dispose();
    this.modeEmitter.dispose();
    this.diagnosticEmitter.dispose();
    this.output.dispose();
  }
}
