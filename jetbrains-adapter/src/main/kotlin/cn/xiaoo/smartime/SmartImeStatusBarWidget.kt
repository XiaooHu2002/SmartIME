package cn.xiaoo.smartime

import com.intellij.ide.DataManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import com.intellij.util.messages.Topic
import java.awt.event.MouseEvent

/**
 * 状态栏组件工厂。
 * 负责创建和管理 SmartIME 状态栏右下角的指示器。
 */
class SmartImeStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId(): String = "SmartImeStatusBarWidget"
    
    override fun getDisplayName(): String = "SmartIME Status"
    
    override fun isAvailable(project: Project): Boolean = true
    
    override fun createWidget(project: Project): StatusBarWidget = SmartImeStatusBarWidget(project)
    
    override fun disposeWidget(widget: StatusBarWidget) {
        Disposer.dispose(widget)
    }
    
    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

/**
 * 状态栏组件。
 * 显示当前输入法状态（中/英）的指示器。
 */
class SmartImeStatusBarWidget(val project: Project) : StatusBarWidget {
    private var statusBar: StatusBar? = null
    private var imeStatus: String = "EN"
    private var diagnosticText: String = "diag:idle"
    private val presentation = SmartImeTextPresentation(this)

    private val statusListener = object : SmartImeStatusListener {
        override fun imeStatusChanged(status: String) {
            imeStatus = status
            statusBar?.updateWidget(ID())
        }
    }
    private val diagnosticListener = object : SmartImeDiagnosticListener {
        override fun diagnosticChanged(trace: String) {
            diagnosticText = trace
            statusBar?.updateWidget(ID())
        }
    }
    
    init {
        val messageBus = project.messageBus.connect()
        messageBus.subscribe(SmartImeStatusListener.TOPIC, statusListener)
        messageBus.subscribe(SmartImeDiagnosticListener.TOPIC, diagnosticListener)
    }
    
    override fun ID(): String = "SmartImeStatusBarWidget"

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = presentation
    
    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
    }
    
    override fun dispose() {
        statusBar = null
    }

    fun currentStatus(): String = imeStatus

    fun currentDiagnosticText(): String = diagnosticText
}

/**
 * 文本状态栏展示。
 */
private class SmartImeTextPresentation(
    private val widget: SmartImeStatusBarWidget,
) : StatusBarWidget.TextPresentation {
    override fun getText(): String = "SmartIME:${widget.currentStatus()}"

    override fun getAlignment(): Float = 0.5f

    override fun getTooltipText(): String {
        val ime = widget.currentStatus()
        return "SmartIME 当前输入态：${if (ime == "ZH") "中文" else "英文"}\n${widget.currentDiagnosticText()}\n点击打开 SmartIME 菜单"
    }

    override fun getClickConsumer(): Consumer<MouseEvent>? {
        return Consumer { event ->
            val dataContext = DataManager.getInstance().getDataContext(event.component)
            SmartImeShowMenuAction.showPopup(widget.project, dataContext)
        }
    }
}

/**
 * 状态监听器接口。
 * 用于跨模块通知 SmartIME 状态变化。
 */
interface SmartImeStatusListener {
    fun imeStatusChanged(status: String)

    companion object {
        val TOPIC = Topic(SmartImeStatusListener::class.java, Topic.BroadcastDirection.TO_CHILDREN)
    }
}

interface SmartImeDiagnosticListener {
    fun diagnosticChanged(trace: String)

    companion object {
        val TOPIC = Topic(SmartImeDiagnosticListener::class.java, Topic.BroadcastDirection.TO_CHILDREN)
    }
}

/**
 * 状态发布者。
 */
fun Project.publishSmartImeStatus(status: String) {
    messageBus.syncPublisher(SmartImeStatusListener.TOPIC).imeStatusChanged(status)
}

fun Project.publishSmartImeDiagnostic(trace: String) {
    messageBus.syncPublisher(SmartImeDiagnosticListener.TOPIC).diagnosticChanged(trace)
}
