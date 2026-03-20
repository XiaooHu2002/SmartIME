package cn.xiaoo.smartime

import com.intellij.openapi.actionSystem.ex.AnActionListener
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiComment
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import java.awt.Color
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * JetBrains 端启动入口。
 *
 * 该类负责完成三件事：
 * 1. 注册核心监听器（编辑器、工具窗口、文件切换、IDE 激活状态）。
 * 2. 在监听回调中调用场景引擎做判定。
 * 3. 将判定结果交给 Go Worker 执行输入法切换。
 *
 * 注意：
 * - JetBrains 平台的 API 生命周期与 VS Code 不同，这里使用 StartupActivity 进行注册。
 * - 当前版本优先落地主干场景，复杂场景（如 SearchEverywhere 的更细分面板）后续可继续补强。
 */
class SmartImeStartupActivity : StartupActivity.DumbAware {

    override fun runActivity(project: Project) {
        val service = project.service<SmartImeService>()
        service.start(project)
    }
}

/**
 * SmartIME 在 JetBrains 侧的聚合服务。
 *
 * 该服务将“场景识别”和“输入法执行”解耦：
 * - 场景识别在 Kotlin 层做 IDE 事件绑定与上下文提取。
 * - 输入法执行统一交给 Go Worker。
 */
@com.intellij.openapi.components.Service(com.intellij.openapi.components.Service.Level.PROJECT)
class SmartImeService {
    private var bridge: GoWorkerBridge? = null
    private var engine: JetBrainsSceneEngine? = null
    private val logger = Logger.getInstance(SmartImeService::class.java)
    private var currentMode: String = "en"
    private var lastProgrammaticSwitchAt = 0L
    private var lastActivitySyncAt = 0L
    private var applyingPunctuation = false

    private data class StickyState(val mode: String, val documentKey: String, val line: Int)
    private var manualSticky: StickyState? = null

    fun start(project: Project) {
        val worker = resolveWorkerPath(project)
        bridge = worker?.let { GoWorkerBridge(it) }
        val settingsService = project.service<SmartImeSettingsService>()
        val settings = settingsService.state
        engine = JetBrainsSceneEngine(settings)

        // 编辑器切换：用于覆盖默认场景与文件类型切换场景。
        project.messageBus.connect().subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    val editor = FileEditorManager.getInstance(project).selectedTextEditor
                    val (left, right) = editor?.let { extractSides(it) } ?: Pair("", "")
                    val req = engine?.buildRequest(
                        JetBrainsSceneContext(
                            zone = editor?.let { detectZoneByPsiAndHighlighter(project, it) } ?: "default",
                            isCommitEditor = isCommitEditorEvent(event),
                            leftText = left,
                            rightText = right,
                        ),
                    ) ?: return
                    handleSceneRequest(project, req, "selection changed")
                }
            },
        )

        // 光标移动：用于注释/字符串/默认区域等高频判定入口。
        EditorFactory.getInstance().addEditorFactoryListener(
            object : com.intellij.openapi.editor.event.EditorFactoryListener {
                override fun editorCreated(event: com.intellij.openapi.editor.event.EditorFactoryEvent) {
                    event.editor.caretModel.addCaretListener(object : CaretListener {
                        override fun caretPositionChanged(event: CaretEvent) {
                            onCaretMoved(project, event.editor)
                        }
                    })
                }
            },
            project,
        )

        EditorFactory.getInstance().eventMulticaster.addDocumentListener(
            object : DocumentListener {
                override fun documentChanged(event: DocumentEvent) {
                    handlePunctuationChange(project, event)
                }
            },
            project,
        )

        // Action 事件：用于 SearchEverywhere、IdeaVim 或自定义事件场景。
        project.messageBus.connect().subscribe(
            AnActionListener.TOPIC,
            object : AnActionListener {
                override fun beforeActionPerformed(
                    action: com.intellij.openapi.actionSystem.AnAction,
                    dataContext: com.intellij.openapi.actionSystem.DataContext,
                    event: com.intellij.openapi.actionSystem.AnActionEvent,
                ) {
                    val actionName = kotlin.runCatching {
                        com.intellij.openapi.actionSystem.ActionManager.getInstance().getId(action)
                    }.getOrNull() ?: action.javaClass.simpleName

                    val context = JetBrainsSceneContext(
                        zone = "default",
                        ideaVimNormal = isIdeaVimNormalAction(actionName),
                        isSearchEverywhere = isSearchEverywhereAction(actionName, action),
                        eventName = actionName,
                    )
                    val req = engine?.buildRequest(context) ?: return
                    handleSceneRequest(project, req, "action=$actionName")
                }
            },
        )

        // 工具窗口场景：当工具窗口焦点变化时可切换到预设输入法。
        project.messageBus.connect().subscribe(
            com.intellij.openapi.wm.ex.ToolWindowManagerListener.TOPIC,
            object : com.intellij.openapi.wm.ex.ToolWindowManagerListener {
                override fun stateChanged(toolWindowManager: ToolWindowManager) {
                    val activeToolWindow = toolWindowManager.activeToolWindowId
                    if (activeToolWindow != null) {
                        val req = engine?.buildRequest(JetBrainsSceneContext(toolWindowId = activeToolWindow)) ?: return
                        handleSceneRequest(project, req, "tool window=$activeToolWindow")
                    }
                }
            },
        )

        // 离开 IDE 场景：IDE 失活时可按策略切换输入法。
        project.messageBus.connect().subscribe(
            ApplicationActivationListener.TOPIC,
            object : ApplicationActivationListener {
                override fun applicationDeactivated(ideFrame: com.intellij.openapi.wm.IdeFrame) {
                    val req = engine?.buildLeaveRequest() ?: return
                    handleSceneRequest(project, req, "application deactivated")
                }

                override fun applicationActivated(ideFrame: com.intellij.openapi.wm.IdeFrame) {
                    val req = engine?.buildEnterRequest() ?: return
                    handleSceneRequest(project, req, "application activated")
                }
            },
        )

        project.publishSmartImeStatus(currentMode.uppercase())
        emitDiagnostic(project, "diag:service started")
    }

    private fun onCaretMoved(project: Project, editor: Editor) {
        val docKey = "${editor.document.hashCode()}"
        val line = editor.caretModel.logicalPosition.line
        val sticky = manualSticky
        if (sticky != null && (sticky.documentKey != docKey || sticky.line != line)) {
            manualSticky = null
        }

        syncModeFromSystemOnActivity(project, editor)

        val (left, right) = extractSides(editor)
        val req = engine?.buildRequest(
            JetBrainsSceneContext(
                zone = detectZoneByPsiAndHighlighter(project, editor),
                leftText = left,
                rightText = right,
            ),
        ) ?: return
        handleSceneRequest(project, req, "caret moved")
    }

    private fun handlePunctuationChange(project: Project, event: DocumentEvent) {
        if (applyingPunctuation) {
            return
        }
        val worker = bridge ?: return
        val inserted = event.newFragment.toString()
        if (inserted.isBlank() || inserted.length > 256 || inserted.contains("\n") || inserted.contains("\r")) {
            return
        }

        val mapped = worker.mapPunctuation(inserted, punctuationMap()) ?: return
        if (mapped == inserted) {
            return
        }

        applyingPunctuation = true
        try {
            WriteCommandAction.runWriteCommandAction(project) {
                val start = event.offset
                val end = event.offset + event.newLength
                if (end <= event.document.textLength) {
                    event.document.replaceString(start, end, mapped)
                }
            }
            emitDiagnostic(project, "diag:punctuation mapped")
        } finally {
            applyingPunctuation = false
        }
    }

    private fun punctuationMap(): Map<String, String> = mapOf(
        "，" to ",",
        "。" to ".",
        "；" to ";",
        "：" to ":",
        "（" to "(",
        "）" to ")",
        "【" to "[",
        "】" to "]",
        "《" to "<",
        "》" to ">",
        "“" to "\"",
        "”" to "\"",
        "‘" to "'",
        "’" to "'",
        "、" to ",",
        "！" to "!",
        "？" to "?",
    )

    private fun syncModeFromSystemOnActivity(project: Project, editor: Editor) {
        val settings = project.service<SmartImeSettingsService>().state
        if (!settings.liveSyncOnActivity) {
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastActivitySyncAt < settings.liveSyncMinIntervalMs) {
            return
        }
        if (now - lastProgrammaticSwitchAt < 300) {
            return
        }
        lastActivitySyncAt = now

        val mode = bridge?.getMode() ?: return
        if (mode == currentMode) {
            return
        }

        currentMode = mode
        val stickyLine = editor.caretModel.logicalPosition.line
        manualSticky = StickyState(mode, "${editor.document.hashCode()}", stickyLine)
        project.publishSmartImeStatus(mode.uppercase())
        emitDiagnostic(project, "diag:manual shift detected -> $mode")
        applyCaretColor(project, mode)
    }

    private fun handleSceneRequest(project: Project, request: SceneRequest, reason: String) {
        val settings = project.service<SmartImeSettingsService>().state
        if (!settings.enabled) {
            project.publishSmartImeStatus("OFF")
            emitDiagnostic(project, "diag:auto switch disabled")
            return
        }

        val currentBridge = bridge ?: return
        val result = currentBridge.decide(request) ?: return

        if (settings.manualShiftSticky && shouldHoldManualSticky(project, result)) {
            emitDiagnostic(project, "diag:manual sticky hold")
            return
        }

        val switched = when (result) {
            "zh" -> currentBridge.switchToZh()
            "en" -> currentBridge.switchToEn()
            else -> true
        }
        if (!switched) {
            emitDiagnostic(project, "diag:switch failed")
            return
        }

        currentMode = result
        lastProgrammaticSwitchAt = System.currentTimeMillis()

        applyCaretColor(project, result)
        project.publishSmartImeStatus(result.uppercase())

        val trace = currentBridge.lastTrace
        val traceText = if (trace != null) {
            "diag:${trace.action}|${if (trace.ok) "ok" else "fail"}|${trace.output ?: trace.error ?: "none"}"
        } else {
            "diag:scene=${request.scene}|mode=$result"
        }
        emitDiagnostic(project, traceText)

        if (settings.enableEventLog) {
            logger.info("SmartIME Decision scene=${request.scene}, ime=$result, reason=$reason, project=${project.name}")
        }
    }

    fun toggleAutoSwitch(project: Project) {
        val settings = project.service<SmartImeSettingsService>().state
        settings.enabled = !settings.enabled
        if (!settings.enabled) {
            project.publishSmartImeStatus("OFF")
            emitDiagnostic(project, "diag:auto switch disabled")
        } else {
            project.publishSmartImeStatus(currentMode.uppercase())
            emitDiagnostic(project, "diag:auto switch enabled")
        }
    }

    fun manualSwitchToZh(project: Project, source: String) {
        manualSwitch(project, "zh", source)
    }

    fun manualSwitchToEn(project: Project, source: String) {
        manualSwitch(project, "en", source)
    }

    private fun manualSwitch(project: Project, target: String, source: String) {
        val currentBridge = bridge ?: return
        val switched = if (target == "zh") currentBridge.switchToZh() else currentBridge.switchToEn()
        if (!switched) {
            emitDiagnostic(project, "diag:manual switch failed")
            return
        }
        currentMode = target
        lastProgrammaticSwitchAt = System.currentTimeMillis()

        val editor = FileEditorManager.getInstance(project).selectedTextEditor
        if (editor != null) {
            val docKey = "${editor.document.hashCode()}"
            val line = editor.caretModel.logicalPosition.line
            manualSticky = StickyState(target, docKey, line)
        }

        applyCaretColor(project, target)
        project.publishSmartImeStatus(target.uppercase())
        emitDiagnostic(project, "diag:manual switch $target by $source")
    }

    private fun shouldHoldManualSticky(project: Project, nextMode: String): Boolean {
        val sticky = manualSticky ?: return false
        if (sticky.mode == nextMode) {
            return false
        }

        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return false
        val docKey = "${editor.document.hashCode()}"
        val line = editor.caretModel.logicalPosition.line
        return if (sticky.documentKey == docKey && sticky.line == line) {
            true
        } else {
            manualSticky = null
            false
        }
    }

    private fun emitDiagnostic(project: Project, text: String) {
        val settings = project.service<SmartImeSettingsService>().state
        if (!settings.enableDiagnosticBar) {
            return
        }
        project.publishSmartImeDiagnostic(text)
    }

    private fun applyCaretColor(project: Project, ime: String) {
        val settings = project.service<SmartImeSettingsService>().state
        if (!settings.enableCaretColor) {
            return
        }

        val hex = when (ime) {
            "zh" -> settings.zhCaretColor
            "en" -> settings.enCaretColor
            else -> return
        }
        val color = parseColor(hex) ?: return
        EditorColorsManager.getInstance().globalScheme.setColor(EditorColors.CARET_COLOR, color)
    }

    private fun parseColor(value: String): Color? {
        return kotlin.runCatching {
            Color.decode(value.trim())
        }.getOrNull()
    }

    private fun isCommitEditorEvent(event: FileEditorManagerEvent): Boolean {
        val name = event.newFile?.name ?: return false
        return name.contains("COMMIT_EDITMSG", ignoreCase = true) ||
            name.contains("MERGE_MSG", ignoreCase = true)
    }

    private fun isSearchEverywhereAction(
        actionName: String,
        action: com.intellij.openapi.actionSystem.AnAction,
    ): Boolean {
        val className = action.javaClass.name.lowercase()
        if (className.contains("searcheverywhere")) {
            return true
        }
        val n = actionName.lowercase()
        return n.contains("searcheverywhere") ||
            n == "gotofile" ||
            n == "gotoclass" ||
            n == "gotosymbol"
    }

    private fun isIdeaVimNormalAction(actionName: String): Boolean {
        val n = actionName.lowercase()
        // IdeaVim 的 action id 通常包含 vim 前缀，Esc 回到 Normal 也会触发相关动作。
        return n.startsWith("vim") || n.contains("ideavim")
    }

    private fun resolveWorkerPath(project: Project): String? {
        // 1) 优先使用插件 zip 内置 worker（用于发布安装场景）
        resolveBundledWorkerPath()?.let { return it }

        // 2) 开发场景回退到项目根目录 tools/ime-worker.exe
        val base = project.basePath ?: return null
        val candidate = File(base, "tools/ime-worker.exe")
        if (candidate.exists()) {
            return candidate.absolutePath
        }

        logger.warn("SmartIME worker not found. Expected bundled resource 'bin/ime-worker.exe' or '$base/tools/ime-worker.exe'")
        return null
    }

    private fun resolveBundledWorkerPath(): String? {
        val resourcePath = "bin/ime-worker.exe"
        val url = SmartImeService::class.java.classLoader.getResource(resourcePath) ?: return null

        return kotlin.runCatching {
            if (url.protocol == "file") {
                File(url.toURI()).absolutePath
            } else {
                val temp = Files.createTempFile("smartime-worker-", ".exe").toFile()
                temp.deleteOnExit()
                SmartImeService::class.java.classLoader.getResourceAsStream(resourcePath).use { input ->
                    if (input == null) {
                        return null
                    }
                    Files.copy(input, temp.toPath(), StandardCopyOption.REPLACE_EXISTING)
                }
                temp.setExecutable(true)
                temp.absolutePath
            }
        }.getOrNull()
    }

    private fun detectZoneByPsiAndHighlighter(project: Project, editor: Editor): String {
        val textLength = editor.document.textLength
        if (textLength <= 0) {
            return "default"
        }

        val offset = normalizeOffset(editor.caretModel.offset, textLength)
        val psiFile = PsiDocumentManager.getInstance(project).getPsiFile(editor.document)
        val element = psiFile?.findElementAt(offset)

        if (isCommentElement(element)) {
            return "comment"
        }
        if (isStringElement(element)) {
            return "string"
        }

        // 对旧平台版本避免使用 Editor 新属性，保留 PSI 主路径判定。

        return "default"
    }

    private fun isCommentElement(element: PsiElement?): Boolean {
        var current = element
        while (current != null) {
            if (current is PsiComment) {
                return true
            }
            val tokenName = current.node?.elementType?.toString()?.uppercase() ?: ""
            if (tokenName.contains("COMMENT")) {
                return true
            }
            current = current.parent
        }
        return false
    }

    private fun isStringElement(element: PsiElement?): Boolean {
        var current = element
        while (current != null) {
            val tokenName = current.node?.elementType?.toString()?.uppercase() ?: ""
            val className = current.javaClass.simpleName.uppercase()
            if (tokenName.contains("STRING") || tokenName.contains("CHARACTER_LITERAL") || tokenName.contains("TEXT_BLOCK")) {
                return true
            }
            if (className.contains("STRING")) {
                return true
            }
            current = current.parent
        }
        return false
    }

    private fun extractSides(editor: Editor): Pair<String, String> {
        val text = editor.document.charsSequence
        val len = text.length
        if (len <= 0) {
            return Pair("", "")
        }

        val offset = normalizeOffset(editor.caretModel.offset, len)
        val leftStart = (offset - 160).coerceAtLeast(0)
        val rightEnd = (offset + 160).coerceAtMost(len)
        val left = text.subSequence(leftStart, offset).toString()
        val right = text.subSequence(offset, rightEnd).toString()
        return Pair(left, right)
    }

    private fun normalizeOffset(offset: Int, textLength: Int): Int {
        if (textLength <= 0) {
            return 0
        }
        return offset.coerceIn(0, textLength - 1)
    }
}
