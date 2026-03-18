import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

type WorkerAction = "get" | "zh" | "en";

interface WorkerRequest {
  id: number;
  action: WorkerAction;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  output?: string;
  error?: string;
}

interface PendingCall {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class ImeWorkerClient {
  private readonly executablePath: string | undefined;
  private process: ChildProcessWithoutNullStreams | undefined;
  private lineReader: readline.Interface | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(extensionPath: string) {
    if (process.platform !== "win32") {
      return;
    }

    const candidates = [
      path.join(extensionPath, "tools", "ime-worker.exe"),
      path.join(extensionPath, "lib", "ime-worker.exe"),
    ];
    this.executablePath = candidates.find((item) => fs.existsSync(item));
  }

  public get available(): boolean {
    return Boolean(this.executablePath);
  }

  public async execute(action: WorkerAction, timeoutMs = 400): Promise<string> {
    if (!this.executablePath) {
      throw new Error("ime worker executable not found");
    }

    this.ensureProcess();

    const id = this.nextId;
    this.nextId += 1;

    const payload: WorkerRequest = { id, action };
    const line = `${JSON.stringify(payload)}\n`;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ime worker timeout for action=${action}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      this.process?.stdin.write(line, (error) => {
        if (!error) {
          return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public dispose(): void {
    this.rejectAllPending(new Error("ime worker disposed"));
    this.lineReader?.close();
    this.lineReader = undefined;
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
    this.process = undefined;
  }

  private ensureProcess(): void {
    if (this.process && !this.process.killed) {
      return;
    }

    if (!this.executablePath) {
      return;
    }

    const child = spawn(this.executablePath, [], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", () => {
      // Worker stderr is ignored by default. Keep channel silent for normal users.
    });

    child.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
      this.dispose();
    });

    child.on("exit", () => {
      this.rejectAllPending(new Error("ime worker exited"));
      this.lineReader?.close();
      this.lineReader = undefined;
      this.process = undefined;
    });
  }

  private handleLine(line: string): void {
    let message: WorkerResponse;
    try {
      message = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(String(message.output || "").trim());
      return;
    }

    pending.reject(new Error(message.error || "ime worker action failed"));
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
