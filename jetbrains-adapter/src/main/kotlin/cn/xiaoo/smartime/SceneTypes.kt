package cn.xiaoo.smartime

/**
 * 统一场景类型定义。
 *
 * 设计目的：
 * 1. 让 JetBrains 适配层与 VS Code 适配层使用相同的场景语义。
 * 2. 后续可把该枚举映射到 Go 核心引擎协议，避免两个适配层各自维护一套判定逻辑。
 */
enum class SceneType {
    DEFAULT,
    COMMENT,
    STRING,
    COMMIT,
    TOOL_WINDOW,
    IDEA_VIM_NORMAL,
    CUSTOM_EVENT,
    CUSTOM_REGEX,
    LEAVE_IDE,
    SEARCH_EVERYWHERE,
}

/**
 * 输入法目标状态。
 */
enum class TargetIme {
    ZH,
    EN,
}

/**
 * 场景判定结果。
 *
 * @property scene 命中的场景类型
 * @property targetIme 目标输入法状态
 * @property reason 人类可读的判定原因，用于日志与问题排查
 */
data class SceneDecision(
    val scene: SceneType,
    val targetIme: TargetIme,
    val reason: String,
)

/**
 * 统一场景请求，字段与 Go Worker 的 request 结构保持一致。
 */
data class SceneRequest(
    val scene: String,
    val zone: String? = null,
    val toolWindow: String? = null,
    val vimMode: String? = null,
    val eventName: String? = null,
    val leaveStrategy: String? = null,
    val preferredString: String? = null,
    val forcedIme: String? = null,
)
