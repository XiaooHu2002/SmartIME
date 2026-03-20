# SmartIME

> This project is entirely implemented using AI. I'm not sure if there are any bugs. I'm a novice and don't know how to program. I wrote this plugin to break the paid mechanism of a certain plugin. After testing, it seems to be able to achieve the basic functions and it's fast!

A smart IME auto-switch extension for developers, focused on reducing interruption while coding.

中文 README: [README.md](README.md)

## ✨ What It Is

SmartIME decides Chinese/English input mode based on your current editing context:

- Chinese-friendly in comments and documentation text.
- English-friendly in code, identifiers, and command input.
- Respects manual switching as much as possible to avoid aggressive auto revert.

## 🧠 Features

- Auto-switch IME by cursor context.
- Detect string, line comment, block comment, doc comment, and other code zones.
- Windows fast path via persistent Go IME worker (with automatic script fallback).
- Cursor decoration to display current IME state.
- Status bar detail shows why mode changed (with faster UI updates during switching).
- Regex-based matching rules around cursor.
- Chinese punctuation auto replacement for selected file types.
- Optional force English in Vim NORMAL mode (best effort).

## 📦 Installation

### VS Code

Install from VSIX via Extensions view menu: `...` -> `Install from VSIX...`

![VSIX install](./README.assets/image-20260318162132151.png)

### JetBrains (IntelliJ IDEA / PyCharm / WebStorm)

1. Download the JetBrains plugin package `smartime-*.zip` from release assets.
2. Open your JetBrains IDE and go to `Settings/Preferences -> Plugins`.
3. Click the gear icon and select `Install Plugin from Disk...`.
4. Select `smartime-*.zip` and confirm installation.
5. Restart the IDE.

Notes:

- The JetBrains installer package is published as `dist/*.zip` in release artifacts.

### Source Debug Run (for developers)

1. Clone this repository and open it in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to start Extension Development Host.

## 🚀 Usage

1. Open command palette and run `Show Smart Input Pro Menu` (or `显示 SmartIME 菜单`).
2. Ensure auto-switch is enabled.
3. Move across comment/code zones and check status bar `SmartIME 中/英`.
4. If needed, configure custom IME commands:
	- `smartInput.ime.getStateCommand`
	- `smartInput.ime.switchToChineseCommand`
	- `smartInput.ime.switchToEnglishCommand`

## ⚙️ Common Settings

- `smartInput.evaluateDebounceMs`
- `smartInput.ime.pollingIntervalMs`
- `smartInput.ime.liveSyncOnActivity`
- `smartInput.ime.liveSyncMinIntervalMs`
- `smartInput.ime.liveSyncDebounceMs`

## 🛠️ Development Guide

### Core Project Structure

- `src/extension.ts`: VS Code event orchestration and scene switching.
- `src/contextDetector.ts`: editor context detection.
- `src/imeController.ts`: IME query/switch controller.
- `tools/ime-worker/main.go`: Go worker for Windows.
- `jetbrains-adapter/`: JetBrains adapter subproject.

### Daily Workflow

1. Update `package.json` first when adding/changing settings.
2. Run `npm run compile` after code changes.
3. Press `F5` to validate behavior in dev host.
4. Verify key interactions before commit (comment/string/code switching).

### Go Worker Development

- Rebuild worker: `npm run build:ime-worker`
- Output path: `tools/ime-worker.exe`
- Build JetBrains plugin locally (Go first, then JetBrains): `npm run build:jetbrains:local`

## 🏗️ Build And Release

This repository publishes two artifact types through CNB remote build:

- VS Code extension package: `dist/*.vsix`
- JetBrains plugin package: `dist/*.zip`

The release pipeline is defined in `.cnb.yml`, and tag push will build/upload both artifacts automatically.

## Windows Command Examples (Optional)

Current default (recommended): Go worker fast path first; script commands are fallback with `get / zh / en`:

- getStateCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 get`
- switchToChineseCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 zh`
- switchToEnglishCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 en`
