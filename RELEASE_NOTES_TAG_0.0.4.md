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