package cn.xiaoo.smartime

import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.components.service
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep

class SmartImeShowMenuAction : DumbAwareAction("SmartIME 菜单") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        showPopup(project, e.dataContext)
    }

    companion object {
        fun showPopup(project: Project, dataContext: DataContext) {
            val items = listOf("打开设置", "自动切换开关", "切换到中文", "切换到英文")
            val step = object : BaseListPopupStep<String>("SmartIME 菜单", items) {
                override fun onChosen(selectedValue: String?, finalChoice: Boolean): PopupStep<*>? {
                    val service = project.service<SmartImeService>()
                    when (selectedValue) {
                        "打开设置" -> ShowSettingsUtil.getInstance().showSettingsDialog(project, "cn.xiaoo.smartime.settings")
                        "自动切换开关" -> service.toggleAutoSwitch(project)
                        "切换到中文" -> service.manualSwitchToZh(project, "menu")
                        "切换到英文" -> service.manualSwitchToEn(project, "menu")
                    }
                    return PopupStep.FINAL_CHOICE
                }
            }
            JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(dataContext)
        }
    }
}

class SmartImeToggleAutoSwitchAction : DumbAwareAction("SmartIME: 自动切换开关") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        project.service<SmartImeService>().toggleAutoSwitch(project)
    }
}

class SmartImeSwitchToChineseAction : DumbAwareAction("SmartIME: 切换到中文") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        project.service<SmartImeService>().manualSwitchToZh(project, "action")
    }
}

class SmartImeSwitchToEnglishAction : DumbAwareAction("SmartIME: 切换到英文") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        project.service<SmartImeService>().manualSwitchToEn(project, "action")
    }
}
