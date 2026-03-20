package cn.xiaoo.smartime

import com.intellij.openapi.components.service
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.options.SearchableConfigurable
import com.intellij.openapi.project.Project
import java.awt.Color
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

/**
 * SmartIME JetBrains 设置页。
 *
 * 目标：
 * 1. 把场景目标输入法、进入/离开 IDE 策略可视化。
 * 2. 支持工具窗口映射快速编辑（每行 key=value）。
 * 3. 暴露事件日志与光标配色开关，便于高级场景调试。
 */
class SmartImeProjectConfigurable(
    private val project: Project,
) : SearchableConfigurable {

    private val defaultIme = JComboBox(arrayOf("en", "zh"))
    private val commentIme = JComboBox(arrayOf("en", "zh"))
    private val stringIme = JComboBox(arrayOf("en", "zh"))
    private val commitIme = JComboBox(arrayOf("en", "zh"))
    private val searchEverywhereIme = JComboBox(arrayOf("en", "zh"))
    private val ideaVimNormalIme = JComboBox(arrayOf("en", "zh"))

    private val leaveStrategy = JComboBox(arrayOf("restore", "none", "en", "zh"))
    private val enterIdeMode = JComboBox(arrayOf("keep", "en", "zh"))

    private val enabled = JCheckBox("启用自动切换")
    private val enableEventLog = JCheckBox("启用事件日志（idea.log）")
    private val enableDiagnosticBar = JCheckBox("启用诊断状态提示")
    private val manualShiftSticky = JCheckBox("手动切换同一行保持（sticky）")
    private val liveSyncOnActivity = JCheckBox("光标活动时同步系统输入态")
    private val enableCaretColor = JCheckBox("启用输入态光标配色")
    private val zhCaretColor = JTextField()
    private val enCaretColor = JTextField()

    private val toolWindowMap = JTextArea(8, 24)

    private val eventModel = DefaultListModel<CustomEventRule>()
    private val eventList = JList(eventModel)
    private val eventNameField = JTextField()
    private val eventIme = JComboBox(arrayOf("zh", "en"))
    private val eventEnabled = JCheckBox("启用")

    private val regexModel = DefaultListModel<CustomRegexRule>()
    private val regexList = JList(regexModel)
    private val regexNameField = JTextField()
    private val regexLeftField = JTextField()
    private val regexRightField = JTextField()
    private val regexIme = JComboBox(arrayOf("zh", "en"))
    private val regexEnabled = JCheckBox("启用")
    private val regexLeftLabel = JLabel("左侧正则")
    private val regexRightLabel = JLabel("右侧正则")
    private val normalLabelColor = JLabel().foreground
    private val normalFieldColor = JTextField().foreground
    private val invalidColor = Color(0xD32F2F)

    private var root: JPanel? = null

    override fun getId(): String = "cn.xiaoo.smartime.settings"

    override fun getDisplayName(): String = "SmartIME"

    override fun createComponent(): JComponent {
        if (root == null) {
            root = JPanel(GridBagLayout())
            val gc = GridBagConstraints().apply {
                fill = GridBagConstraints.HORIZONTAL
                insets = Insets(4, 8, 4, 8)
                weightx = 1.0
                gridx = 0
                gridy = 0
            }

            addRow(root!!, gc, "默认场景输入法", defaultIme)
            addRow(root!!, gc, "注释场景输入法", commentIme)
            addRow(root!!, gc, "字符串场景输入法", stringIme)
            addRow(root!!, gc, "提交信息输入法", commitIme)
            addRow(root!!, gc, "SearchEverywhere 输入法", searchEverywhereIme)
            addRow(root!!, gc, "IdeaVim Normal 输入法", ideaVimNormalIme)
            addRow(root!!, gc, "离开 IDE 策略", leaveStrategy)
            addRow(root!!, gc, "进入 IDE 策略", enterIdeMode)

            gc.gridx = 0
            gc.gridwidth = 2
            root!!.add(enabled, gc)
            gc.gridy += 1
            root!!.add(enableEventLog, gc)
            gc.gridy += 1
            root!!.add(enableDiagnosticBar, gc)
            gc.gridy += 1
            root!!.add(manualShiftSticky, gc)
            gc.gridy += 1
            root!!.add(liveSyncOnActivity, gc)
            gc.gridy += 1
            root!!.add(enableCaretColor, gc)
            gc.gridy += 1

            gc.gridwidth = 1
            addRow(root!!, gc, "中文光标颜色", zhCaretColor)
            addRow(root!!, gc, "英文光标颜色", enCaretColor)

            val mapLabel = JLabel("工具窗口映射（每行 ToolWindowId=zh/en）")
            gc.gridx = 0
            gc.gridwidth = 2
            root!!.add(mapLabel, gc)
            gc.gridy += 1
            root!!.add(toolWindowMap, gc)
            gc.gridy += 1

            val customEventPanel = createCustomEventPanel()
            val customRegexPanel = createCustomRegexPanel()

            val eventLabel = JLabel("自定义事件规则")
            gc.gridx = 0
            gc.gridwidth = 2
            root!!.add(eventLabel, gc)
            gc.gridy += 1
            root!!.add(customEventPanel, gc)
            gc.gridy += 1

            val regexLabel = JLabel("自定义正则规则")
            gc.gridx = 0
            gc.gridwidth = 2
            root!!.add(regexLabel, gc)
            gc.gridy += 1
            root!!.add(customRegexPanel, gc)
            gc.gridy += 1

            bindRegexValidation()
        }

        reset()
        return root!!
    }

    override fun isModified(): Boolean {
        val state = project.service<SmartImeSettingsService>().state
        if (selected(defaultIme) != state.defaultIme) return true
        if (selected(commentIme) != state.commentIme) return true
        if (selected(stringIme) != state.stringIme) return true
        if (selected(commitIme) != state.commitIme) return true
        if (selected(searchEverywhereIme) != state.searchEverywhereIme) return true
        if (selected(ideaVimNormalIme) != state.ideaVimNormalIme) return true
        if (selected(leaveStrategy) != state.leaveStrategy) return true
        if (selected(enterIdeMode) != state.enterIdeMode) return true

        if (enabled.isSelected != state.enabled) return true
        if (enableEventLog.isSelected != state.enableEventLog) return true
        if (enableDiagnosticBar.isSelected != state.enableDiagnosticBar) return true
        if (manualShiftSticky.isSelected != state.manualShiftSticky) return true
        if (liveSyncOnActivity.isSelected != state.liveSyncOnActivity) return true
        if (enableCaretColor.isSelected != state.enableCaretColor) return true
        if (zhCaretColor.text.trim() != state.zhCaretColor) return true
        if (enCaretColor.text.trim() != state.enCaretColor) return true

        val mapText = buildMapText(state.toolWindowImeMap)
        if (toolWindowMap.text.trim() != mapText.trim()) return true

        if (eventRulesFromModel().toString() != state.customEvents.toString()) return true
        if (regexRulesFromModel().toString() != state.customRegexRules.toString()) return true
        return false
    }

    override fun apply() {
        if (!isRegexSyntaxValid(regexLeftField.text.trim()) || !isRegexSyntaxValid(regexRightField.text.trim())) {
            throw ConfigurationException("自定义正则存在无效表达式，请修复后再保存。")
        }

        val invalidInModel = regexRulesFromModel().firstOrNull {
            !isRegexSyntaxValid(it.leftRegex) || !isRegexSyntaxValid(it.rightRegex)
        }
        if (invalidInModel != null) {
            throw ConfigurationException("规则 [${invalidInModel.name}] 的正则表达式无效，请修复后再保存。")
        }

        val state = project.service<SmartImeSettingsService>().state

        state.defaultIme = selected(defaultIme)
        state.commentIme = selected(commentIme)
        state.stringIme = selected(stringIme)
        state.commitIme = selected(commitIme)
        state.searchEverywhereIme = selected(searchEverywhereIme)
        state.ideaVimNormalIme = selected(ideaVimNormalIme)
        state.leaveStrategy = selected(leaveStrategy)
        state.enterIdeMode = selected(enterIdeMode)

        state.enabled = enabled.isSelected
        state.enableEventLog = enableEventLog.isSelected
        state.enableDiagnosticBar = enableDiagnosticBar.isSelected
        state.manualShiftSticky = manualShiftSticky.isSelected
        state.liveSyncOnActivity = liveSyncOnActivity.isSelected
        state.enableCaretColor = enableCaretColor.isSelected
        state.zhCaretColor = zhCaretColor.text.trim().ifBlank { "#FF4D4F" }
        state.enCaretColor = enCaretColor.text.trim().ifBlank { "#40A9FF" }

        state.toolWindowImeMap = parseMapText(toolWindowMap.text)
        state.customEvents = eventRulesFromModel()
        state.customRegexRules = regexRulesFromModel()
    }

    override fun reset() {
        val state = project.service<SmartImeSettingsService>().state

        defaultIme.selectedItem = state.defaultIme
        commentIme.selectedItem = state.commentIme
        stringIme.selectedItem = state.stringIme
        commitIme.selectedItem = state.commitIme
        searchEverywhereIme.selectedItem = state.searchEverywhereIme
        ideaVimNormalIme.selectedItem = state.ideaVimNormalIme
        leaveStrategy.selectedItem = state.leaveStrategy
        enterIdeMode.selectedItem = state.enterIdeMode

        enabled.isSelected = state.enabled
        enableEventLog.isSelected = state.enableEventLog
        enableDiagnosticBar.isSelected = state.enableDiagnosticBar
        manualShiftSticky.isSelected = state.manualShiftSticky
        liveSyncOnActivity.isSelected = state.liveSyncOnActivity
        enableCaretColor.isSelected = state.enableCaretColor
        zhCaretColor.text = state.zhCaretColor
        enCaretColor.text = state.enCaretColor

        toolWindowMap.text = buildMapText(state.toolWindowImeMap)
        loadEventRules(state.customEvents)
        loadRegexRules(state.customRegexRules)
    }

    private fun selected(combo: JComboBox<String>): String {
        return combo.selectedItem?.toString() ?: "en"
    }

    private fun addRow(panel: JPanel, gc: GridBagConstraints, label: String, component: JComponent) {
        gc.gridx = 0
        gc.gridwidth = 1
        panel.add(JLabel(label), gc)

        gc.gridx = 1
        panel.add(component, gc)
        gc.gridy += 1
    }

    private fun buildMapText(map: MutableMap<String, String>): String {
        return map.entries
            .sortedBy { it.key }
            .joinToString("\n") { "${it.key}=${it.value}" }
    }

    private fun parseMapText(text: String): MutableMap<String, String> {
        val result = mutableMapOf<String, String>()
        text.lineSequence().forEach { raw ->
            val line = raw.trim()
            if (line.isBlank() || line.startsWith("#")) {
                return@forEach
            }
            val idx = line.indexOf('=')
            if (idx <= 0 || idx >= line.length - 1) {
                return@forEach
            }
            val key = line.substring(0, idx).trim()
            val value = line.substring(idx + 1).trim().lowercase()
            if ((value == "zh" || value == "en") && key.isNotBlank()) {
                result[key] = value
            }
        }
        return result
    }

    private fun createCustomEventPanel(): JPanel {
        val panel = JPanel(GridBagLayout())
        val gc = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL
            insets = Insets(2, 2, 2, 2)
            weightx = 1.0
            gridx = 0
            gridy = 0
        }

        val scroll = JScrollPane(eventList)
        scroll.preferredSize = Dimension(360, 120)
        gc.gridwidth = 4
        panel.add(scroll, gc)
        gc.gridy += 1

        gc.gridwidth = 1
        panel.add(JLabel("事件名"), gc)
        gc.gridx = 1
        gc.gridwidth = 3
        panel.add(eventNameField, gc)
        gc.gridy += 1

        gc.gridx = 0
        gc.gridwidth = 1
        panel.add(JLabel("输入法"), gc)
        gc.gridx = 1
        panel.add(eventIme, gc)
        gc.gridx = 2
        panel.add(eventEnabled, gc)
        gc.gridy += 1

        val addBtn = JButton("新增")
        val updateBtn = JButton("更新")
        val removeBtn = JButton("删除")
        val upBtn = JButton("上移")
        val downBtn = JButton("下移")
        gc.gridx = 0
        panel.add(addBtn, gc)
        gc.gridx = 1
        panel.add(updateBtn, gc)
        gc.gridx = 2
        panel.add(removeBtn, gc)
        gc.gridx = 3
        panel.add(upBtn, gc)
        gc.gridy += 1
        gc.gridx = 3
        panel.add(downBtn, gc)

        addBtn.addActionListener {
            val rule = buildEventRuleFromFields() ?: return@addActionListener
            eventModel.addElement(rule)
            eventList.selectedIndex = eventModel.size() - 1
        }
        updateBtn.addActionListener {
            val index = eventList.selectedIndex
            if (index < 0) {
                return@addActionListener
            }
            val rule = buildEventRuleFromFields() ?: return@addActionListener
            eventModel.set(index, rule)
            eventList.selectedIndex = index
        }
        removeBtn.addActionListener {
            val index = eventList.selectedIndex
            if (index >= 0) {
                eventModel.remove(index)
            }
        }
        upBtn.addActionListener {
            moveEventRule(-1)
        }
        downBtn.addActionListener {
            moveEventRule(1)
        }

        eventList.addListSelectionListener {
            val rule = eventList.selectedValue ?: return@addListSelectionListener
            eventNameField.text = rule.eventName
            eventIme.selectedItem = rule.ime
            eventEnabled.isSelected = rule.enabled
        }

        eventList.cellRenderer = object : javax.swing.DefaultListCellRenderer() {
            override fun getListCellRendererComponent(
                list: JList<*>?,
                value: Any?,
                index: Int,
                isSelected: Boolean,
                cellHasFocus: Boolean,
            ): java.awt.Component {
                val c = super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
                val rule = value as? CustomEventRule
                text = if (rule == null) {
                    ""
                } else {
                    val state = if (rule.enabled) "on" else "off"
                    "${index + 1}. [${state}] ${rule.eventName} -> ${rule.ime}"
                }
                return c
            }
        }

        return panel
    }

    private fun createCustomRegexPanel(): JPanel {
        val panel = JPanel(GridBagLayout())
        val gc = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL
            insets = Insets(2, 2, 2, 2)
            weightx = 1.0
            gridx = 0
            gridy = 0
        }

        val scroll = JScrollPane(regexList)
        scroll.preferredSize = Dimension(360, 140)
        gc.gridwidth = 4
        panel.add(scroll, gc)
        gc.gridy += 1

        gc.gridwidth = 1
        panel.add(JLabel("规则名"), gc)
        gc.gridx = 1
        gc.gridwidth = 3
        panel.add(regexNameField, gc)
        gc.gridy += 1

        gc.gridx = 0
        gc.gridwidth = 1
        panel.add(regexLeftLabel, gc)
        gc.gridx = 1
        gc.gridwidth = 3
        panel.add(regexLeftField, gc)
        gc.gridy += 1

        gc.gridx = 0
        gc.gridwidth = 1
        panel.add(regexRightLabel, gc)
        gc.gridx = 1
        gc.gridwidth = 3
        panel.add(regexRightField, gc)
        gc.gridy += 1

        gc.gridx = 0
        gc.gridwidth = 1
        panel.add(JLabel("输入法"), gc)
        gc.gridx = 1
        panel.add(regexIme, gc)
        gc.gridx = 2
        panel.add(regexEnabled, gc)
        gc.gridy += 1

        val addBtn = JButton("新增")
        val updateBtn = JButton("更新")
        val removeBtn = JButton("删除")
        val upBtn = JButton("上移")
        val downBtn = JButton("下移")
        gc.gridx = 0
        panel.add(addBtn, gc)
        gc.gridx = 1
        panel.add(updateBtn, gc)
        gc.gridx = 2
        panel.add(removeBtn, gc)
        gc.gridx = 3
        panel.add(upBtn, gc)
        gc.gridy += 1
        gc.gridx = 3
        panel.add(downBtn, gc)

        addBtn.addActionListener {
            val rule = buildRegexRuleFromFields() ?: return@addActionListener
            regexModel.addElement(rule)
            regexList.selectedIndex = regexModel.size() - 1
        }
        updateBtn.addActionListener {
            val index = regexList.selectedIndex
            if (index < 0) {
                return@addActionListener
            }
            val rule = buildRegexRuleFromFields() ?: return@addActionListener
            regexModel.set(index, rule)
            regexList.selectedIndex = index
        }
        removeBtn.addActionListener {
            val index = regexList.selectedIndex
            if (index >= 0) {
                regexModel.remove(index)
            }
        }
        upBtn.addActionListener {
            moveRegexRule(-1)
        }
        downBtn.addActionListener {
            moveRegexRule(1)
        }

        regexList.addListSelectionListener {
            val rule = regexList.selectedValue ?: return@addListSelectionListener
            regexNameField.text = rule.name
            regexLeftField.text = rule.leftRegex
            regexRightField.text = rule.rightRegex
            regexIme.selectedItem = rule.ime
            regexEnabled.isSelected = rule.enabled
            validateRegexFields()
        }

        regexList.cellRenderer = object : javax.swing.DefaultListCellRenderer() {
            override fun getListCellRendererComponent(
                list: JList<*>?,
                value: Any?,
                index: Int,
                isSelected: Boolean,
                cellHasFocus: Boolean,
            ): java.awt.Component {
                val c = super.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus)
                val rule = value as? CustomRegexRule
                text = if (rule == null) {
                    ""
                } else {
                    val state = if (rule.enabled) "on" else "off"
                    val marker = if (isRegexSyntaxValid(rule.leftRegex) && isRegexSyntaxValid(rule.rightRegex)) "" else " [invalid]"
                    "${index + 1}. [${state}] ${rule.name} -> ${rule.ime}${marker}"
                }
                return c
            }
        }

        return panel
    }

    private fun buildEventRuleFromFields(): CustomEventRule? {
        val eventName = eventNameField.text.trim()
        if (eventName.isBlank()) {
            return null
        }
        return CustomEventRule(
            eventName = eventName,
            ime = eventIme.selectedItem?.toString() ?: "zh",
            enabled = eventEnabled.isSelected,
        )
    }

    private fun buildRegexRuleFromFields(): CustomRegexRule? {
        val name = regexNameField.text.trim()
        val leftRegex = regexLeftField.text.trim()
        val rightRegex = regexRightField.text.trim()
        if (name.isBlank() || leftRegex.isBlank() || rightRegex.isBlank()) {
            return null
        }
        if (!isRegexSyntaxValid(leftRegex) || !isRegexSyntaxValid(rightRegex)) {
            return null
        }
        return CustomRegexRule(
            name = name,
            leftRegex = leftRegex,
            rightRegex = rightRegex,
            ime = regexIme.selectedItem?.toString() ?: "zh",
            enabled = regexEnabled.isSelected,
        )
    }

    private fun loadEventRules(rules: MutableList<CustomEventRule>) {
        eventModel.clear()
        rules.forEach {
            eventModel.addElement(
                CustomEventRule(
                    eventName = it.eventName,
                    ime = it.ime,
                    enabled = it.enabled,
                ),
            )
        }
    }

    private fun loadRegexRules(rules: MutableList<CustomRegexRule>) {
        regexModel.clear()
        rules.forEach {
            regexModel.addElement(
                CustomRegexRule(
                    name = it.name,
                    leftRegex = it.leftRegex,
                    rightRegex = it.rightRegex,
                    ime = it.ime,
                    enabled = it.enabled,
                ),
            )
        }
    }

    private fun eventRulesFromModel(): MutableList<CustomEventRule> {
        val list = mutableListOf<CustomEventRule>()
        for (i in 0 until eventModel.size()) {
            val it = eventModel.get(i)
            list.add(
                CustomEventRule(
                    eventName = it.eventName,
                    ime = it.ime,
                    enabled = it.enabled,
                ),
            )
        }
        return list
    }

    private fun regexRulesFromModel(): MutableList<CustomRegexRule> {
        val list = mutableListOf<CustomRegexRule>()
        for (i in 0 until regexModel.size()) {
            val it = regexModel.get(i)
            list.add(
                CustomRegexRule(
                    name = it.name,
                    leftRegex = it.leftRegex,
                    rightRegex = it.rightRegex,
                    ime = it.ime,
                    enabled = it.enabled,
                ),
            )
        }
        return list
    }

    private fun moveEventRule(delta: Int) {
        val index = eventList.selectedIndex
        if (index < 0) {
            return
        }
        val target = index + delta
        if (target !in 0 until eventModel.size()) {
            return
        }
        val item = eventModel.get(index)
        eventModel.remove(index)
        eventModel.add(target, item)
        eventList.selectedIndex = target
    }

    private fun moveRegexRule(delta: Int) {
        val index = regexList.selectedIndex
        if (index < 0) {
            return
        }
        val target = index + delta
        if (target !in 0 until regexModel.size()) {
            return
        }
        val item = regexModel.get(index)
        regexModel.remove(index)
        regexModel.add(target, item)
        regexList.selectedIndex = target
    }

    private fun bindRegexValidation() {
        val l = object : DocumentListener {
            override fun insertUpdate(e: DocumentEvent?) = validateRegexFields()
            override fun removeUpdate(e: DocumentEvent?) = validateRegexFields()
            override fun changedUpdate(e: DocumentEvent?) = validateRegexFields()
        }
        regexLeftField.document.addDocumentListener(l)
        regexRightField.document.addDocumentListener(l)
        validateRegexFields()
    }

    private fun validateRegexFields() {
        val left = regexLeftField.text.trim()
        val right = regexRightField.text.trim()

        val leftOk = left.isBlank() || isRegexSyntaxValid(left)
        val rightOk = right.isBlank() || isRegexSyntaxValid(right)

        regexLeftField.foreground = if (leftOk) normalFieldColor else invalidColor
        regexRightField.foreground = if (rightOk) normalFieldColor else invalidColor
        regexLeftLabel.foreground = if (leftOk) normalLabelColor else invalidColor
        regexRightLabel.foreground = if (rightOk) normalLabelColor else invalidColor

        regexLeftField.toolTipText = if (leftOk) null else "左侧正则无效"
        regexRightField.toolTipText = if (rightOk) null else "右侧正则无效"

        regexList.repaint()
    }

    private fun isRegexSyntaxValid(pattern: String): Boolean {
        if (pattern.isBlank()) {
            return false
        }
        return kotlin.runCatching { Regex(pattern) }.isSuccess
    }
}
