import { ContextZone, ImeMode } from "./types";

/**
 * 统一场景协议：该结构会同时用于 VS Code 与 JetBrains 适配层，并发送给 Go Worker 决策。
 */
export interface SceneDecisionRequest {
  scene: "DEFAULT" | "COMMENT" | "STRING" | "COMMIT" | "TOOL_WINDOW" | "IDEA_VIM_NORMAL" | "CUSTOM_EVENT" | "CUSTOM_REGEX" | "LEAVE_IDE" | "SEARCH_EVERYWHERE";
  zone?: "default" | "comment" | "string";
  toolWindow?: string;
  vimMode?: string;
  eventName?: string;
  leaveStrategy?: "restore" | "en" | "zh" | "none";
  preferredString?: "zh" | "en";
  forcedIme?: "zh" | "en";
}

/**
 * 把编辑区上下文映射为统一场景请求。
 */
export function buildSceneRequestByZone(zone: ContextZone, vimNormal: boolean): SceneDecisionRequest {
  if (vimNormal) {
    return {
      scene: "IDEA_VIM_NORMAL",
      vimMode: "normal",
    };
  }

  if (zone === "lineComment" || zone === "blockComment" || zone === "docComment") {
    return {
      scene: "COMMENT",
      zone: "comment",
    };
  }

  if (zone === "string") {
    return {
      scene: "STRING",
      zone: "string",
    };
  }

  return {
    scene: "DEFAULT",
    zone: "default",
  };
}

/**
 * 将 Go Worker 的输出转回扩展内部 ImeMode。
 */
export function parseSceneImeOutput(output: string): ImeMode | null {
  const normalized = String(output || "").trim().toLowerCase();
  if (normalized === "zh") {
    return "chinese";
  }
  if (normalized === "en") {
    return "english";
  }
  return null;
}
