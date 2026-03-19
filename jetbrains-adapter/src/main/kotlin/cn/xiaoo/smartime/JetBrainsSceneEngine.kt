package cn.xiaoo.smartime

/**
 * JetBrains 场景引擎。
 *
 * 设计目标：
 * 1. 把 IDE 事件上下文转换成统一 SceneRequest。
 * 2. 所有高级场景判定链路先在这里串联，决策优先级清晰可维护。
 * 3. 决策最终交给 Go Worker 的 decide 动作，保证 VS Code/JetBrains 走同一套模型。
 */
class JetBrainsSceneEngine(
    private val settings: SmartImeSettingsState,
) {

    /**
     * 事件优先级（高到低）：
     * 1. IdeaVim Normal
     * 2. Commit 场景
     * 3. 工具窗口场景
     * 4. 自定义事件
     * 5. 自定义规则
     * 6. 注释/字符串
     * 7. 默认场景
     */
    fun buildRequest(context: JetBrainsSceneContext): SceneRequest {
        if (context.ideaVimNormal) {
            return SceneRequest(
                scene = "IDEA_VIM_NORMAL",
                vimMode = "normal",
                forcedIme = settings.ideaVimNormalIme,
            )
        }

        // SearchEverywhere 属于高频搜索输入场景，优先固定为英文（可配置）。
        if (context.isSearchEverywhere) {
            return SceneRequest(
                scene = "SEARCH_EVERYWHERE",
                forcedIme = settings.searchEverywhereIme,
            )
        }

        if (context.isCommitEditor) {
            return SceneRequest(
                scene = "COMMIT",
                forcedIme = settings.commitIme,
            )
        }

        if (!context.toolWindowId.isNullOrBlank()) {
            val preferred = settings.toolWindowImeMap[context.toolWindowId] ?: settings.defaultIme
            return SceneRequest(
                scene = "TOOL_WINDOW",
                toolWindow = context.toolWindowId,
                forcedIme = preferred,
            )
        }

        if (!context.eventName.isNullOrBlank()) {
            val matched = settings.customEvents.firstOrNull { it.enabled && it.eventName == context.eventName }
            if (matched != null) {
                return SceneRequest(
                    scene = "CUSTOM_EVENT",
                    eventName = context.eventName,
                    forcedIme = matched.ime,
                )
            }
        }

        val customRegex = settings.customRegexRules.firstOrNull { rule ->
            if (!rule.enabled) {
                return@firstOrNull false
            }
            kotlin.runCatching {
                Regex(rule.leftRegex).containsMatchIn(context.leftText)
                    && Regex(rule.rightRegex).containsMatchIn(context.rightText)
            }.getOrDefault(false)
        }
        if (customRegex != null) {
            return SceneRequest(
                scene = "CUSTOM_REGEX",
                forcedIme = customRegex.ime,
            )
        }

        if (context.zone == "comment") {
            return SceneRequest(
                scene = "COMMENT",
                zone = "comment",
                forcedIme = settings.commentIme,
            )
        }

        if (context.zone == "string") {
            return SceneRequest(
                scene = "STRING",
                zone = "string",
                preferredString = settings.stringIme,
            )
        }

        return SceneRequest(
            scene = "DEFAULT",
            zone = "default",
            forcedIme = settings.defaultIme,
        )
    }

    /**
     * 离开 IDE 场景请求。
     */
    fun buildLeaveRequest(): SceneRequest {
        return SceneRequest(
            scene = "LEAVE_IDE",
            leaveStrategy = settings.leaveStrategy,
        )
    }

    /**
     * 回到 IDE 时的恢复请求。
     *
     * 约定：
     * - keep: 不主动切换
     * - zh/en: 通过 forcedIme 明确目标态
     */
    fun buildEnterRequest(): SceneRequest? {
        return when (settings.enterIdeMode) {
            "keep" -> null
            "zh", "en" -> SceneRequest(
                scene = "DEFAULT",
                forcedIme = settings.enterIdeMode,
            )
            else -> null
        }
    }
}

/**
 * JetBrains 适配层场景上下文。
 */
data class JetBrainsSceneContext(
    val zone: String = "default",
    val ideaVimNormal: Boolean = false,
    val isSearchEverywhere: Boolean = false,
    val isCommitEditor: Boolean = false,
    val toolWindowId: String? = null,
    val eventName: String? = null,
    val leftText: String = "",
    val rightText: String = "",
)
