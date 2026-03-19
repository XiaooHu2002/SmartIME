package cn.xiaoo.smartime

import com.intellij.openapi.actionSystem.ex.AnActionListener
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.colors.EditorColors
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.editor.event.CaretEvent
import com.intellij.openapi.editor.event.CaretListener
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.psi.PsiComment
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import java.awt.Color
import java.io.File

/**
 * JetBrains 端启动入口。
 *
 * 该类负责完成三件事：
 * 1. 注册核心监听器（编辑器、工具窗口、文件切换、IDE 激活状态）。
 * 2. 在监听回调中调用场景引擎做判定。
 * 3. 将判定结果交给 Go Worker 执行输入法切换。
 *
 * 注意：
 * - JetBrains 平台的 API 生命周期与 VS Code 不同，这里使用 ProjectActivity 进行注册。
 * - 当前版本优先落地主干场景，复杂场景（如 SearchEverywhere 的更细分面板）后续可继续补强。
 */
class SmartImeStartupActivity : ProjectActivity {

    override suspend fun execute(project: Project) {
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
                            val editor = event.editor
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
                    })
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
    }

    private fun handleSceneRequest(project: Project, request: SceneRequest, reason: String) {
        val currentBridge = bridge ?: return

        val result = currentBridge.decide(request) ?: return

        when (result) {
            "zh" -> currentBridge.switchToZh()
            "en" -> currentBridge.switchToEn()
            else -> {
                // keep
            }
        }

        // 可选光标配色：通过全局 Caret 颜色反馈当前输入态，便于在全屏编码时快速感知状态。
        applyCaretColor(project, result)

        // 将简要诊断输出到 IDE 日志，便于后续做“自定义事件场景”的事件名称采集与排查。
        val settings = project.service<SmartImeSettingsService>().state
        if (settings.enableEventLog) {
            logger.info("SmartIME Decision scene=${request.scene}, ime=$result, reason=$reason, project=${project.name}")
        }
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
        val base = project.basePath ?: return null
        val candidate = File(base, "tools/ime-worker.exe")
        if (candidate.exists()) {
            return candidate.absolutePath
        }
        return null
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

        val tokenName = kotlin.runCatching {
            editor.highlighter.createIterator(offset).tokenType.toString().uppercase()
        }.getOrDefault("")

        if (tokenName.contains("COMMENT")) {
            return "comment"
        }
        if (tokenName.contains("STRING") || tokenName.contains("CHARACTER_LITERAL") || tokenName.contains("TEXT_BLOCK")) {
            return "string"
        }

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
