import * as vscode from "vscode";
import { EditorRule, PunctuationRule, RegexRule, SmartInputConfig } from "./types";

// 兼容设置项为空、类型不匹配等情况。
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// 统一把文件后缀标准化为小写且带点的形式，如 ts -> .ts。
function normalizeFileTypes(fileTypes: string[]): string[] {
  return fileTypes
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => item.length > 0)
    .map((item) => (item.startsWith(".") ? item : `.${item}`));
}

function normalizePatterns(values: string[]): string[] {
  return values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function normalizeLanguageIds(values: string[]): string[] {
  return values
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => item.length > 0);
}

function normalizeImeMode(value: unknown, fallback: "chinese" | "english"): "chinese" | "english" {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "zh" || raw === "chinese") {
    return "chinese";
  }
  if (raw === "en" || raw === "english") {
    return "english";
  }
  return fallback;
}

function normalizeToolWindowMap(value: unknown): Record<string, "zh" | "en"> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, "zh" | "en"> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = String(key || "").trim();
    const mode = String(raw || "").trim().toLowerCase();
    if (!name) {
      continue;
    }
    if (mode === "zh" || mode === "en") {
      result[name] = mode;
    }
  }
  return result;
}

export function getSmartInputConfig(): SmartInputConfig {
  // 读取 smartInput 命名空间下所有配置，并转换成强类型对象。
  const cfg = vscode.workspace.getConfiguration("smartInput");

  const editorRules = asArray<EditorRule>(cfg.get("editorRules", [])).map((rule) => ({
    ...rule,
    fileTypes: normalizeFileTypes(asArray<string>(rule.fileTypes)),
    languageIds: normalizeLanguageIds(asArray<string>(rule.languageIds)),
  }));

  const regexRules = asArray<RegexRule>(cfg.get("regexRules", [])).map((rule) => ({
    ...rule,
    fileTypes: normalizeFileTypes(asArray<string>(rule.fileTypes)),
    languageIds: normalizeLanguageIds(asArray<string>(rule.languageIds)),
  }));

  const punctuationRules = asArray<PunctuationRule>(cfg.get("punctuationRules", [])).map((rule) => ({
    ...rule,
    fileTypes: normalizeFileTypes(asArray<string>(rule.fileTypes)),
    languageIds: normalizeLanguageIds(asArray<string>(rule.languageIds)),
  }));

  return {
    enabled: cfg.get("enabled", true),
    showDetailInStatusBar: cfg.get("showDetailInStatusBar", true),
    vimNormalForceEnglish: cfg.get("vimNormalForceEnglish", true),
    evaluateDebounceMs: Math.max(0, Number(cfg.get("evaluateDebounceMs", 8))),
    contextScanLookbackChars: Math.max(512, Number(cfg.get("contextScanLookbackChars", 8000))),
    diagnostic: {
      enabled: cfg.get("diagnostic.enabled", true),
    },
    cursorDecorator: {
      enabled: cfg.get("cursorDecorator.enabled", true),
      chineseText: cfg.get("cursorDecorator.chineseText", "中"),
      englishText: cfg.get("cursorDecorator.englishText", "英"),
    },
    cursorColor: {
      enabled: cfg.get("cursorColor.enabled", false),
      chinese: cfg.get("cursorColor.chinese", "#ff4d4f"),
      english: cfg.get("cursorColor.english", "#40a9ff"),
    },
    ime: {
      getStateCommand: String(cfg.get("ime.getStateCommand", "")).trim(),
      switchToChineseCommand: String(cfg.get("ime.switchToChineseCommand", "")).trim(),
      switchToEnglishCommand: String(cfg.get("ime.switchToEnglishCommand", "")).trim(),
      chineseStatePatterns: normalizePatterns(
        asArray<string>(cfg.get("ime.chineseStatePatterns", ["zh", "chinese", "cn"])),
      ),
      englishStatePatterns: normalizePatterns(
        asArray<string>(cfg.get("ime.englishStatePatterns", ["en", "english"])),
      ),
      verifyAfterSwitch: cfg.get("ime.verifyAfterSwitch", false),
      pollingIntervalMs: Math.max(0, Number(cfg.get("ime.pollingIntervalMs", 0))),
      liveSyncOnActivity: cfg.get("ime.liveSyncOnActivity", true),
      liveSyncMinIntervalMs: Math.max(20, Number(cfg.get("ime.liveSyncMinIntervalMs", 60))),
      liveSyncDebounceMs: Math.max(0, Number(cfg.get("ime.liveSyncDebounceMs", 50))),
      manualChineseHoldMs: Math.max(0, Number(cfg.get("ime.manualChineseHoldMs", 3000))),
      manualChineseIdleRevertMs: Math.max(300, Number(cfg.get("ime.manualChineseIdleRevertMs", 1500))),
    },
    scene: {
      defaultIme: normalizeImeMode(cfg.get("scene.defaultIme", "en"), "english"),
      commentIme: normalizeImeMode(cfg.get("scene.commentIme", "zh"), "chinese"),
      stringIme: normalizeImeMode(cfg.get("scene.stringIme", "en"), "english"),
      commitIme: normalizeImeMode(cfg.get("scene.commitIme", "zh"), "chinese"),
      searchEverywhereIme: normalizeImeMode(cfg.get("scene.searchEverywhereIme", "en"), "english"),
      ideaVimNormalIme: normalizeImeMode(cfg.get("scene.ideaVimNormalIme", "en"), "english"),
      leaveStrategy: (() => {
        const raw = String(cfg.get("scene.leaveStrategy", "restore") || "").trim().toLowerCase();
        if (raw === "en" || raw === "zh" || raw === "none" || raw === "restore") {
          return raw;
        }
        return "restore";
      })(),
      enterIdeMode: (() => {
        const raw = String(cfg.get("scene.enterIdeMode", "keep") || "").trim().toLowerCase();
        if (raw === "en" || raw === "zh" || raw === "keep") {
          return raw;
        }
        return "keep";
      })(),
      toolWindowImeMap: normalizeToolWindowMap(cfg.get("scene.toolWindowImeMap", {})),
    },
    editorRules,
    regexRules,
    punctuationRules,
  };
}

export function getFileExtension(filePath: string): string {
  const normalized = filePath.toLowerCase();
  const idx = normalized.lastIndexOf(".");
  return idx >= 0 ? normalized.slice(idx) : "";
}

export function matchByFileType(filePath: string, fileTypes: string[]): boolean {
  // 空 fileTypes 代表匹配所有文件。
  if (!fileTypes.length) {
    return true;
  }
  const ext = getFileExtension(filePath);
  return fileTypes.includes(ext);
}

export function matchByFileTypeOrLanguage(
  filePath: string,
  languageId: string,
  fileTypes: string[],
  languageIds: string[] = [],
): boolean {
  const extMatched = fileTypes.length ? matchByFileType(filePath, fileTypes) : false;
  const normalizedLang = String(languageId || "").trim().toLowerCase();
  const langMatched = languageIds.length ? languageIds.includes(normalizedLang) : false;

  if (fileTypes.length === 0 && languageIds.length === 0) {
    return true;
  }
  return extMatched || langMatched;
}
