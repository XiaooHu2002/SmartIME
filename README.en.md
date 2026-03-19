# SmartIME

A VS Code extension that helps Chinese-native developers auto-switch IME by editor context.

中文 README: [README.md](README.md)

## Features

- Auto-switch IME by cursor context.
- Detect string, line comment, block comment, doc comment, and other code zones.
- Windows fast path via persistent Go IME worker (with automatic script fallback).
- Cursor decoration to display current IME state.
- Status bar detail shows why mode changed (with faster UI updates during switching).
- Regex-based matching rules around cursor.
- Chinese punctuation auto replacement for selected file types.
- Optional force English in Vim NORMAL mode (best effort).

## Release Artifacts

This repository now publishes two artifact types via CNB remote build:

- VS Code extension package: `dist/*.vsix`
- JetBrains plugin package: `dist/*.zip` (built from `jetbrains-adapter`)

Notes:

- `.cnb.yml` runs both packaging stages in the same tag release pipeline.
- The release step uploads both artifact types as attachments.

## Current Switching Strategy

- Chinese contexts (comment/string): auto switch to Chinese.
- English code contexts: auto switch to English.
- After you manually switch to Chinese in code (for example by pressing Shift):
	- No timer-based auto revert.
	- You can switch back manually with Shift.
	- Or move the cursor to an English code position, then SmartIME auto switches back to English.
- Status bar and cursor decoration try to follow manual Shift changes quickly.
- Detection runs only when VS Code is focused and you are actively interacting in the code editor (cursor move or typing).
- Detection is paused when focus moves to Typora, chat panel, sidebar, or other non-editor UI, and resumes quickly after returning to code.

This behavior is designed to avoid interrupting Chinese input while keeping code-writing flow natural.

## Important Note

A VS Code extension cannot directly control every IME implementation in a universal way.
This project integrates with your local IME toolchain via shell commands.

Please configure:

- smartInput.ime.getStateCommand
- smartInput.ime.switchToChineseCommand
- smartInput.ime.switchToEnglishCommand

If commands are empty, indicators can still update, but real OS IME switching may not happen.

Windows notes:

- By default SmartIME uses the bundled script to switch IME state inside the same IME.
- If `tools/ime-worker.exe` exists, SmartIME prefers the persistent Go worker path for lower latency.
- If Go worker is unavailable, SmartIME automatically falls back to script commands.
- Built-in command style is `get / zh / en`.
- Status bar is shown as `SmartIME 中/英` by default.

Common performance and realtime settings:

- `smartInput.evaluateDebounceMs`
- `smartInput.ime.pollingIntervalMs`
- `smartInput.ime.liveSyncOnActivity`
- `smartInput.ime.liveSyncMinIntervalMs`
- `smartInput.ime.liveSyncDebounceMs`

## Quick Start

1. Open this project in VS Code.
2. Run `npm install`.
3. Run `npm run compile`.
4. Press `F5` to launch Extension Development Host.
5. Run `Show Smart Input Pro Menu` from command palette.

You can also run the Chinese command: `显示 SmartIME 菜单`.

If you changed the Go worker source, rebuild it with:

- `npm run build:ime-worker`

## Installation

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

## Windows Command Examples (Optional)

Current default (recommended): Go worker fast path first; script commands are fallback with `get / zh / en`:

- getStateCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 get`
- switchToChineseCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 zh`
- switchToEnglishCommand: `powershell -NoProfile -NoLogo -NonInteractive -ExecutionPolicy Bypass -File <extensionPath>/tools/ime-mode.ps1 en`
