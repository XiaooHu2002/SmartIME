package cn.xiaoo.smartime

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * JetBrains 端配置持久化服务。
 *
 * 设计说明：
 * 1. 使用 IDE 官方 PersistentStateComponent，把场景配置保存在 .idea/workspace.xml。
 * 2. 字段对齐 Smart Input Pro 场景：默认/注释/字符串/提交/工具窗口/IdeaVim/自定义事件/自定义规则/离开IDE。
 * 3. 后续如需做配置 UI，可直接绑定此服务。
 */
@Service(Service.Level.PROJECT)
@State(name = "SmartImeSettings", storages = [Storage("smartime.xml")])
class SmartImeSettingsService : PersistentStateComponent<SmartImeSettingsState> {
    private var state = SmartImeSettingsState()

    override fun getState(): SmartImeSettingsState = state

    override fun loadState(state: SmartImeSettingsState) {
        this.state = state
    }
}

/**
 * 场景配置状态。
 */
data class SmartImeSettingsState(
    /** 是否启用自动切换。 */
    var enabled: Boolean = true,
    /** 默认场景目标输入法，通常为英文。 */
    var defaultIme: String = "en",
    /** 注释场景目标输入法，通常为中文。 */
    var commentIme: String = "zh",
    /** 字符串场景默认目标输入法。 */
    var stringIme: String = "en",
    /** Git 提交场景目标输入法。 */
    var commitIme: String = "zh",
    /** SearchEverywhere 场景目标输入法。 */
    var searchEverywhereIme: String = "en",
    /** IdeaVim Normal 模式目标输入法。 */
    var ideaVimNormalIme: String = "en",
    /** 离开 IDE 场景策略：restore/en/zh/none。 */
    var leaveStrategy: String = "restore",
    /** 回到 IDE 的恢复策略：keep/en/zh。 */
    var enterIdeMode: String = "keep",
    /** 工具窗口目标输入法映射。 */
    var toolWindowImeMap: MutableMap<String, String> = mutableMapOf(
        "Project" to "en",
        "Terminal" to "en",
        "Commit" to "zh",
    ),
    /** 自定义事件列表。 */
    var customEvents: MutableList<CustomEventRule> = mutableListOf(),
    /** 自定义正则规则列表。 */
    var customRegexRules: MutableList<CustomRegexRule> = mutableListOf(),
    /** 是否开启自定义事件日志输出（用于发现可监听事件名）。 */
    var enableEventLog: Boolean = false,
    /** 是否显示诊断状态栏。 */
    var enableDiagnosticBar: Boolean = false,
    /** 是否开启输入光标颜色跟随。 */
    var enableCaretColor: Boolean = true,
    /** 中文输入态光标颜色（16 进制）。 */
    var zhCaretColor: String = "#FF4D4F",
    /** 英文输入态光标颜色（16 进制）。 */
    var enCaretColor: String = "#40A9FF",
    /** 手动切换后同一行保持输入态。 */
    var manualShiftSticky: Boolean = true,
    /** 交互时同步系统输入态。 */
    var liveSyncOnActivity: Boolean = true,
    /** 活动同步最小间隔（毫秒）。 */
    var liveSyncMinIntervalMs: Int = 80,
)

data class CustomEventRule(
    var eventName: String = "",
    var ime: String = "zh",
    var enabled: Boolean = true,
)

data class CustomRegexRule(
    var name: String = "",
    var leftRegex: String = "",
    var rightRegex: String = "",
    var ime: String = "zh",
    var enabled: Boolean = true,
)
