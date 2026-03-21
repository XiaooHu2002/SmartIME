package cn.xiaoo.smartime

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicInteger

/**
 * Go Worker 桥接层。
 */
class GoWorkerBridge(
    private val workerPath: String,
) {
    data class WorkerTrace(
        val action: String,
        val request: String,
        val response: String,
        val ok: Boolean,
        val output: String?,
        val error: String?,
    )

    private var process: Process? = null
    private var writer: OutputStreamWriter? = null
    private var reader: BufferedReader? = null
    private val nextId = AtomicInteger(1)

    @Volatile
    var lastTrace: WorkerTrace? = null
        private set

    fun getMode(): String? = call("get")

    fun switchToZh(): Boolean = call("zh") == "zh"

    fun switchToEn(): Boolean = call("en") == "en"

    fun decide(request: SceneRequest): String? {
        val payload = mutableMapOf<String, Any>("scene" to request.scene)
        request.zone?.let { payload["zone"] = it }
        request.toolWindow?.let { payload["toolWindow"] = it }
        request.vimMode?.let { payload["vimMode"] = it }
        request.eventName?.let { payload["eventName"] = it }
        request.leaveStrategy?.let { payload["leaveStrategy"] = it }
        request.preferredString?.let { payload["preferredString"] = it }
        request.forcedIme?.let { payload["forcedIme"] = it }
        return call("decide", payload)
    }

    fun mapPunctuation(text: String, mapper: Map<String, String>): String? {
        if (text.isBlank() || mapper.isEmpty()) {
            return text
        }
        return call("mapPunctuation", mapOf("text" to text, "map" to mapper))
    }

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
        val full = LinkedHashMap<String, Any>()
        full["id"] = id
        full["action"] = action
        payload.forEach { (k, v) -> full[k] = v }
        val body = buildJsonObject(full)

        return kotlin.runCatching {
            writer!!.write(body)
            writer!!.write("\n")
            writer!!.flush()

            val line = reader!!.readLine() ?: return null
            val ok = line.contains("\"ok\":true")
            val output = extractJsonString(line, "output")
            val err = extractJsonString(line, "error")
            lastTrace = WorkerTrace(action, body, line, ok, output, err)
            if (!ok) {
                return null
            }
            output
        }.getOrNull()
    }

    private fun buildJsonObject(map: Map<String, Any>): String {
        return map.entries.joinToString(prefix = "{", postfix = "}", separator = ",") { (k, v) ->
            "\"${escapeJson(k)}\":${toJsonValue(v)}"
        }
    }

    private fun toJsonValue(value: Any?): String {
        return when (value) {
            null -> "null"
            is String -> "\"${escapeJson(value)}\""
            is Number, is Boolean -> value.toString()
            is Map<*, *> -> {
                val normalized = LinkedHashMap<String, Any>()
                value.forEach { (k, v) ->
                    if (k != null && v != null) {
                        normalized[k.toString()] = v
                    }
                }
                buildJsonObject(normalized)
            }
            else -> "\"${escapeJson(value.toString())}\""
        }
    }

    private fun escapeJson(text: String): String {
        val sb = StringBuilder(text.length + 8)
        text.forEach { ch ->
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> sb.append(ch)
            }
        }
        return sb.toString()
    }

    private fun extractJsonString(json: String, key: String): String? {
        val marker = "\"$key\":\""
        val start = json.indexOf(marker)
        if (start < 0) {
            return null
        }
        var i = start + marker.length
        val out = StringBuilder()
        var escaped = false
        while (i < json.length) {
            val ch = json[i]
            if (escaped) {
                when (ch) {
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'b' -> out.append('\b')
                    'f' -> out.append('\u000C')
                    '"' -> out.append('"')
                    '\\' -> out.append('\\')
                    '/' -> out.append('/')
                    'u' -> {
                        if (i + 4 < json.length) {
                            val hex = json.substring(i + 1, i + 5)
                            val code = hex.toIntOrNull(16)
                            if (code != null) {
                                out.append(code.toChar())
                                i += 4
                            } else {
                                out.append('u')
                            }
                        } else {
                            out.append('u')
                        }
                    }
                    else -> out.append(ch)
                }
                escaped = false
            } else if (ch == '\\') {
                escaped = true
            } else if (ch == '"') {
                break
            } else {
                out.append(ch)
            }
            i += 1
        }
        return out.toString()
    }
}
