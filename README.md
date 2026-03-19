# SmartIME

> 本项目全部用ai实现，不知道是不是有bug，本人小白，不会编程，写这个插件是为了实现打破某插件的付费机制，亲测应该是可以实现基本功能，还快！

面向中文开发者的智能输入法切换扩展，专注「写代码时少打断」。

English README: [README.en.md](README.en.md)

## ✨ 这是什么

SmartIME 会根据你正在编辑的位置自动决定中英文输入态：

- 在注释、文档说明等中文语境中更偏向中文。
- 在代码、标识符、命令输入等语境中更偏向英文。
- 手动切换后会尽量尊重你的即时操作，减少“被抢回去”的感觉。

## 🧠 功能介绍

- 自动识别上下文：字符串、单行注释、多行注释、文档注释、普通代码区。
- 支持正则规则：按光标左/右文本匹配场景。
- 支持中文符号自动替换（可按文件类型与语言配置）。
- 支持 Vim NORMAL 模式优先英文（best effort）。
- 状态栏和光标装饰实时显示当前输入态。
- Windows 支持 Go 常驻 IME Worker，加速状态查询与切换。

## 📦 安装教程

### 从 VSIX 安装（推荐普通用户）

1. 打开 VS Code 扩展面板。
2. 右上角点击 `...`。
3. 选择 `从 VSIX 安装...`。
4. 选择 release 下载的 `smartime-*.vsix`。

![VSIX 安装示意](./README.assets/image-20260318162132151.png)

### 源码调试运行（推荐开发者）

1. 克隆仓库并在 VS Code 打开。
2. 执行 `npm install`。
3. 执行 `npm run compile`。
4. 按 `F5` 启动 Extension Development Host。

### JetBrains 安装（IntelliJ IDEA / PyCharm / WebStorm 等）

1. 从 release 下载 JetBrains 插件包 `smartime-*.zip`。
2. 打开 JetBrains IDE，进入 `Settings/Preferences -> Plugins`。
3. 点击右上角齿轮按钮，选择 `Install Plugin from Disk...`。
4. 选择下载好的 `smartime-*.zip` 并确认安装。
5. 重启 IDE 后生效。

说明：

- JetBrains 安装包来自仓库发布附件中的 `dist/*.zip`。

## 🚀 使用教程

1. 安装后打开命令面板，执行 `显示 SmartIME 菜单`。
2. 确认自动切换已启用。
3. 在注释和代码区移动光标，观察状态栏 `SmartIME 中/英` 切换。
4. 如需接入自定义输入法命令，在设置中配置：
   - `smartInput.ime.getStateCommand`
   - `smartInput.ime.switchToChineseCommand`
   - `smartInput.ime.switchToEnglishCommand`

## ⚙️ 常用配置

- `smartInput.evaluateDebounceMs`：自动切换判定防抖。
- `smartInput.ime.pollingIntervalMs`：系统输入态轮询间隔。
- `smartInput.ime.liveSyncOnActivity`：光标活动时快速同步系统输入态。
- `smartInput.ime.liveSyncMinIntervalMs`：活动同步最小间隔。
- `smartInput.ime.liveSyncDebounceMs`：活动同步防抖。

## 🛠️ 开发教程

### 项目结构（核心）

- `src/extension.ts`：VS Code 事件编排与场景切换入口。
- `src/contextDetector.ts`：编辑区上下文识别。
- `src/imeController.ts`：输入法状态查询与切换封装。
- `tools/ime-worker/main.go`：Windows 下 Go worker。
- `jetbrains-adapter/`：JetBrains 适配子工程。

### 日常开发步骤

1. 修改配置项时先更新 `package.json`。
2. 编写或调整逻辑后执行 `npm run compile`。
3. 按 `F5` 在扩展调试窗口验证。
4. 提交前检查关键交互：注释/字符串/代码区切换是否符合预期。

### Go Worker 开发

- 重新构建 worker：`npm run build:ime-worker`
- 产物路径：`tools/ime-worker.exe`

## 🏗️ 构建与发布

仓库当前通过 CNB 远端构建并发布两个安装包：

- VS Code 扩展包：`dist/*.vsix`
- JetBrains 插件包：`dist/*.zip`

发布流水线定义在 `.cnb.yml`，tag 发布时会自动构建并上传这两类附件。

## 🪟 Windows 命令示例（可选）

默认优先 Go worker，脚本命令用于回退（`get / zh / en`）：

- `getStateCommand`: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <扩展目录>/tools/ime-mode.ps1 get`
- `switchToChineseCommand`: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <扩展目录>/tools/ime-mode.ps1 zh`
- `switchToEnglishCommand`: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <扩展目录>/tools/ime-mode.ps1 en`

## ❤️ 反馈

如果你在使用中遇到误切换、延迟或场景识别问题，欢迎带上复现步骤和文件类型反馈。

