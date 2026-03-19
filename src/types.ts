export type ImeMode = "chinese" | "english";

export type ContextZone =
  | "string"
  | "lineComment"
  | "blockComment"
  | "docComment"
  | "other";

export interface EditorRule {
  name: string;
  fileTypes: string[];
  languageIds?: string[];
  string?: ImeMode;
  lineComment?: ImeMode;
  blockComment?: ImeMode;
  docComment?: ImeMode;
  other: ImeMode;
}

export interface RegexRule {
  name: string;
  fileTypes: string[];
  languageIds?: string[];
  leftRegex: string;
  rightRegex: string;
  ime: ImeMode;
}

export interface PunctuationRule {
  name: string;
  fileTypes: string[];
  languageIds?: string[];
  map: Record<string, string>;
}

export interface SmartInputConfig {
  enabled: boolean;
  showDetailInStatusBar: boolean;
  vimNormalForceEnglish: boolean;
  evaluateDebounceMs: number;
  contextScanLookbackChars: number;
  diagnostic: {
    enabled: boolean;
  };
  cursorDecorator: {
    enabled: boolean;
    chineseText: string;
    englishText: string;
  };
  cursorColor: {
    enabled: boolean;
    chinese: string;
    english: string;
  };
  ime: {
    getStateCommand: string;
    switchToChineseCommand: string;
    switchToEnglishCommand: string;
    chineseStatePatterns: string[];
    englishStatePatterns: string[];
    verifyAfterSwitch: boolean;
    pollingIntervalMs: number;
    liveSyncOnActivity: boolean;
    liveSyncMinIntervalMs: number;
    liveSyncDebounceMs: number;
    manualChineseHoldMs: number;
    manualChineseIdleRevertMs: number;
  };
  scene: {
    defaultIme: ImeMode;
    commentIme: ImeMode;
    stringIme: ImeMode;
    commitIme: ImeMode;
    searchEverywhereIme: ImeMode;
    ideaVimNormalIme: ImeMode;
    leaveStrategy: "restore" | "en" | "zh" | "none";
    enterIdeMode: "keep" | "en" | "zh";
    toolWindowImeMap: Record<string, "zh" | "en">;
  };
  editorRules: EditorRule[];
  regexRules: RegexRule[];
  punctuationRules: PunctuationRule[];
}
