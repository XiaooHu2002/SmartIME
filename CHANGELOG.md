# Changelog

All notable changes to this project will be documented in this file.

## 0.0.3

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
