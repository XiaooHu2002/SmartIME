package cn.xiaoo.smartime

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger

/**
 * Go Worker 桥接层。
 *
 * 设计目标：
 * 1. 复用仓库中的 Go 输入法 worker 能力，避免在 JetBrains 侧重复实现系统 API 调用。
 * 2. 使用长连接子进程降低频繁切换时的启动开销。
 * 3. 通过简单 JSON 行协议实现 get/zh/en 三种操作。
 */
class GoWorkerBridge(
    private val workerPath: String,
) {
    private data class Req(val id: Int, val action: String)
    private data class Resp(val id: Int, val ok: Boolean, val output: String?, val error: String?)

    private var process: Process? = null
    private var writer: OutputStreamWriter? = null
    private var reader: BufferedReader? = null
    private val nextId = AtomicInteger(1)

    /**
     * 查询当前输入法状态。
     *
     * 返回值说明：
     * - zh: 中文输入态
     * - en: 英文输入态
     * - null: 未知或失败
     */
    fun getMode(): String? = call("get")

    /**
     * 切换到中文输入态。
     */
    fun switchToZh(): Boolean = call("zh") != null

    /**
     * 切换到英文输入态。
     */
    fun switchToEn(): Boolean = call("en") != null

    /**
     * 使用统一场景模型在 Go Worker 中做决策。
     *
     * @param request 场景判定请求
     * @return zh/en 或 null
     */
    fun decide(request: SceneRequest): String? {
        val payload = mutableMapOf<String, Any>(
            "scene" to request.scene,
        )
        request.zone?.let { payload["zone"] = it }
        request.toolWindow?.let { payload["toolWindow"] = it }
        request.vimMode?.let { payload["vimMode"] = it }
        request.eventName?.let { payload["eventName"] = it }
        request.leaveStrategy?.let { payload["leaveStrategy"] = it }
        request.preferredString?.let { payload["preferredString"] = it }
        request.forcedIme?.let { payload["forcedIme"] = it }
        return call("decide", payload)
    }

    /**
     * 释放资源，避免 IDE 退出时残留子进程。
     */
    fun dispose() {
        kotlin.runCatching { writer?.close() }
        kotlin.runCatching { reader?.close() }
        kotlin.runCatching { process?.destroy() }
        writer = null
        reader = null
        process = null
    }

    private fun ensureStarted(): Boolean {
        if (process?.isAlive == true && writer != null && reader != null) {
            return true
        }

        val file = File(workerPath)
        if (!file.exists()) {
            return false
        }

        return kotlin.runCatching {
            process = ProcessBuilder(workerPath)
                .redirectErrorStream(true)
                .start()
            writer = OutputStreamWriter(process!!.outputStream, StandardCharsets.UTF_8)
            reader = BufferedReader(InputStreamReader(process!!.inputStream, StandardCharsets.UTF_8))
            true
        }.getOrDefault(false)
    }

    private fun call(action: String, payload: Map<String, Any> = emptyMap()): String? {
        if (!ensureStarted()) {
            return null
        }

        val id = nextId.getAndIncrement()
        val body = buildString {
            append("{\"id\":")
            append(id)
            append(",\"action\":\"")
            append(action)
            append("\"")
            payload.forEach { (k, v) ->
                append(",\"")
                append(k)
                append("\":\"")
                append(v.toString().replace("\"", "\\\""))
                append("\"")
            }
            append("}")
        }

        return kotlin.runCatching {
            writer!!.write(body)
            writer!!.write("\n")
            writer!!.flush()

            val line = reader!!.readLine() ?: return null
            val ok = line.contains("\"ok\":true")
            if (!ok) {
                return null
            }

            when {
                line.contains("\"output\":\"zh\"") -> "zh"
                line.contains("\"output\":\"en\"") -> "en"
                else -> "ok"
            }
        }.getOrNull()
    }
}
