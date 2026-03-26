# Changelog

All notable changes to this project will be documented in this file.

## 0.0.6

### VSIX (VS Code 扩展)
- **修复自动切换误触发场景**：自动切换仅在“编辑区最近有真实交互”时生效，避免在侧边栏、聊天面板等非编辑区焦点下继续切换输入法。
- **修复 Ctrl+F 查找输入被干扰**：忽略命令驱动的选区变化（`TextEditorSelectionChangeKind.Command`），防止查找框输入拼音首字母时被代码区场景抢切到英文。
- **修复终端焦点切换干扰**：激活终端时不再强制触发输入法场景切换，避免命令行输入被自动策略影响。

### JetBrains 适配层（IntelliJ IDEA 2021.1+）
- 无新增功能变更；与 VSIX 行为一致性持续对齐。

### 工程化
- 调试链路稳定性增强，减少“重启扩展主机”期间的场景抖动影响。

## 0.0.5

### VSIX (VS Code 扩展)
- 无新增功能变更。功能基准持续同步至 JetBrains 适配层。

### JetBrains 适配层（IntelliJ IDEA 2021.1+）
- **标点替换链路对齐**：集成 Go worker `mapPunctuation` 动作，支持文档变更监听与原子替换（WriteCommandAction）。
- **诊断信息展示**：新增 `SmartImeDiagnosticListener` 事件通道，状态栏实时展示诊断文本与 worker 执行轨迹。
- **菜单命令交互**：新增 4 个菜单动作（Tools 菜单）：打开设置、自动切换开关、切换到中文、切换到英文。
- **手动 Shift 粘性**：同一行内手动切换输入态后，光标左右移动或点击不触发自动重算；跨行或新建行恢复自动决策。
- **Live同步策略**：后台轮询系统输入态（`worker.get()`），尊重 80ms 最小间隔与 300ms 切换后冷却期。
- **设置页拓展**：新增 5 个配置开关（启用/诊断栏/手动粘性/活跃同步/同步间隔 ms）；所有配置项目级持久化。
- **构建验证**：gradle buildPlugin 完整通过，plugin.xml 兼容 2021.1 schema，jar 包含所有 4 个新动作类与 Go worker 二进制。

### 工程化
- 更新 `.gitignore` 忽略 `.vscode/` 工作区配置。
- CNB CI/CD 流程已支持 VSIX 与 JetBrains 插件双产物构建与推送。

## 0.0.4

### VSIX (VS Code 扩展)
- 无新增功能变更。功能基准持续同步至 JetBrains 适配层。

### JetBrains 适配层（IntelliJ IDEA 2021.1+）
- **标点替换链路对齐**：集成 Go worker `mapPunctuation` 动作，支持文档变更监听与原子替换（WriteCommandAction）。
- **诊断信息展示**：新增 `SmartImeDiagnosticListener` 事件通道，状态栏实时展示诊断文本与 worker 执行轨迹。
- **菜单命令交互**：新增 4 个菜单动作（Tools 菜单）：打开设置、自动切换开关、切换到中文、切换到英文。
- **手动 Shift 粘性**：同一行内手动切换输入态后，光标左右移动或点击不触发自动重算；跨行或新建行恢复自动决策。
- **Live同步策略**：后台轮询系统输入态（`worker.get()`），尊重 80ms 最小间隔与 300ms 切换后冷却期。
- **设置页拓展**：新增 5 个配置开关（启用/诊断栏/手动粘性/活跃同步/同步间隔 ms）；所有配置项目级持久化。
- **构建验证**：gradle buildPlugin 完整通过，plugin.xml 兼容 2021.1 schema，jar 包含所有 4 个新动作类与 Go worker 二进制。

### 工程化
- 更新 `.gitignore` 忽略 `.vscode/` 工作区配置。
- CNB CI/CD 流程已支持 VSIX 与 JetBrains 插件双产物构建与推送。

## 0.0.3

- VS Code 自动切换触发链路增强：支持键盘跨行、鼠标跨行、跨文件切换立即重算；同一行点击/左右移动不触发自动重算。
- 手动 Shift 粘性策略优化：同一行内点击/左右移动保持手动态，跨行或切换编辑器后恢复自动判定。
- SmartIME 默认启用兜底：首次未显式配置时自动写入 `smartInput.enabled=true`，并在关闭时状态栏显示 `SmartIME OFF` + 点击一键启用。
- 输入态同步提速：`liveSyncMinIntervalMs` 默认改为 60ms，`liveSyncDebounceMs` 默认改为 50ms，worker 模式轮询兜底改为 100ms。
- 场景决策稳定性增强：当场景请求携带 `forcedIme` 时优先本地决策，避免 worker 版本差异导致误判。
- 中文符号自动替换增强：补齐成对与变体符号映射（如 `“”`、`‘’`、`【】`、`「」`、`『』`、`《》`、`〈〉`、`——`、`……` 等）。
- 中文输入法适配增强：针对微信输入法等“自动补右符号并将光标移到中间”的上屏行为优化替换时机与范围，减少只替换第一个符号的问题。
- 符号替换稳定性增强：替换器引入 FIFO 事件队列与高频输入保护，快速连续输入下减少漏替与串改。
- 符号替换分流增强：入口保留 TS，新增 Go worker `mapPunctuation` 动作用于大文本映射分流，并保留本地回退。
- JetBrains 适配校验：配置目标平台为 IntelliJ IDEA 2024.1（sinceBuild 241）；本地验证时需使用 JDK 17 + Gradle 8.x，Gradle 9.x 会与 `org.jetbrains.intellij` 1.17.4 不兼容。

- 新增 JetBrains 适配层场景链路：支持默认/注释/字符串/提交/SearchEverywhere/IdeaVim/离开与回到 IDE 策略。
- JetBrains 设置页新增自定义事件与自定义正则规则列表（增删改、上移下移优先级）。
- JetBrains 设置页新增正则实时语法校验与无效规则标记，保存时会阻止无效规则落盘。
- VS Code 侧补齐统一场景配置：`scene.defaultIme/commentIme/stringIme/commitIme/searchEverywhereIme/ideaVimNormalIme/leaveStrategy/enterIdeMode/toolWindowImeMap`。
- CNB 发布流程支持双产物远端构建与上传：`dist/*.vsix` 与 `dist/*.zip`（JetBrains 插件包）。

## 0.0.2

- 重构输入法执行链路：引入 Go 常驻 worker（`tools/ime-worker.exe`）处理 `get/zh/en`，降低切换延迟。
- `src` 中删除已被 Go 方案替代的 PowerShell 快速执行分支，保留通用命令回退路径。
- 扩展在启动和失焦场景下优化状态栏展示，默认显示 `SmartIME 中/英` 并在初始化后切为实时状态。
- 增加 `npm run build:ime-worker` 脚本，便于本地重新编译 worker。

## 0.0.1

- 初始版本发布。
- 实现按代码上下文自动切换中英文输入态。
- 提供状态栏显示、光标装饰与中文标点替换能力。
- 支持通过命令或脚本接入系统输入法状态查询与切换。
- 修复构建发布兼容性：将 VS Code 引擎版本约束与依赖声明对齐，避免 VSIX 打包时报版本冲突。
