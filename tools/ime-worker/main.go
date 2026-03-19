package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const (
	imeCModeNative  = 0x0001
	wmIMEControl    = 0x0283
	imcGetOpenState = 0x0005
	imcSetOpenState = 0x0006
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	imm32  = syscall.NewLazyDLL("imm32.dll")

	procGetForegroundWindow    = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcess = user32.NewProc("GetWindowThreadProcessId")
	procGetGUIThreadInfo       = user32.NewProc("GetGUIThreadInfo")
	procSendMessageW           = user32.NewProc("SendMessageW")

	procImmGetContext          = imm32.NewProc("ImmGetContext")
	procImmReleaseContext      = imm32.NewProc("ImmReleaseContext")
	procImmGetOpenStatus       = imm32.NewProc("ImmGetOpenStatus")
	procImmSetOpenStatus       = imm32.NewProc("ImmSetOpenStatus")
	procImmGetConversionStatus = imm32.NewProc("ImmGetConversionStatus")
	procImmSetConversionStatus = imm32.NewProc("ImmSetConversionStatus")
	procImmGetDefaultIMEWnd    = imm32.NewProc("ImmGetDefaultIMEWnd")
	lastStableMode             = "en"
)

type guiThreadInfo struct {
	CbSize        uint32
	Flags         uint32
	HwndActive    uintptr
	HwndFocus     uintptr
	HwndCapture   uintptr
	HwndMenuOwn   uintptr
	HwndMoveSz    uintptr
	HwndCaret     uintptr
	RcCaretLeft   int32
	RcCaretTop    int32
	RcCaretRight  int32
	RcCaretBottom int32
}

type request struct {
	ID              int               `json:"id"`
	Action          string            `json:"action"`
	Scene           string            `json:"scene,omitempty"`
	Zone            string            `json:"zone,omitempty"`
	ToolWindow      string            `json:"toolWindow,omitempty"`
	VimMode         string            `json:"vimMode,omitempty"`
	EventName       string            `json:"eventName,omitempty"`
	LeaveStrategy   string            `json:"leaveStrategy,omitempty"`
	PreferredString string            `json:"preferredString,omitempty"`
	ForcedIme       string            `json:"forcedIme,omitempty"`
	Text            string            `json:"text,omitempty"`
	Map             map[string]string `json:"map,omitempty"`
}

type response struct {
	ID     int    `json:"id"`
	OK     bool   `json:"ok"`
	Output string `json:"output,omitempty"`
	Error  string `json:"error,omitempty"`
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	writer := bufio.NewWriter(os.Stdout)
	defer writer.Flush()

	for scanner.Scan() {
		line := scanner.Bytes()
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			writeResponse(writer, response{ID: 0, OK: false, Error: "invalid json"})
			continue
		}

		var (
			out string
			err error
		)
		if req.Action == "decide" {
			out, err = decideByScene(req)
		} else if req.Action == "mapPunctuation" {
			out, err = mapPunctuation(req.Text, req.Map)
		} else {
			out, err = handleAction(req.Action)
		}
		if err != nil {
			writeResponse(writer, response{ID: req.ID, OK: false, Error: err.Error()})
			continue
		}
		writeResponse(writer, response{ID: req.ID, OK: true, Output: out})
	}
}

type punctuationKey struct {
	text    string
	repl    string
	runes   []rune
	runeLen int
}

func mapPunctuation(text string, mapper map[string]string) (string, error) {
	if text == "" || len(mapper) == 0 {
		return text, nil
	}

	keys := make([]punctuationKey, 0, len(mapper))
	for k, v := range mapper {
		if k == "" {
			continue
		}
		r := []rune(k)
		keys = append(keys, punctuationKey{
			text:    k,
			repl:    v,
			runes:   r,
			runeLen: len(r),
		})
	}

	if len(keys) == 0 {
		return text, nil
	}

	sort.Slice(keys, func(i, j int) bool {
		if keys[i].runeLen == keys[j].runeLen {
			return keys[i].text < keys[j].text
		}
		return keys[i].runeLen > keys[j].runeLen
	})

	src := []rune(text)
	if len(src) == 0 {
		return text, nil
	}

	var out strings.Builder
	i := 0
	for i < len(src) {
		matched := false
		for _, key := range keys {
			if i+key.runeLen > len(src) {
				continue
			}

			eq := true
			for idx := 0; idx < key.runeLen; idx++ {
				if src[i+idx] != key.runes[idx] {
					eq = false
					break
				}
			}
			if !eq {
				continue
			}

			out.WriteString(key.repl)
			i += key.runeLen
			matched = true
			break
		}

		if matched {
			continue
		}

		out.WriteRune(src[i])
		i += 1
	}

	return out.String(), nil
}

func writeResponse(writer *bufio.Writer, resp response) {
	data, _ := json.Marshal(resp)
	_, _ = writer.Write(data)
	_, _ = writer.WriteString("\n")
	_ = writer.Flush()
}

func handleAction(action string) (string, error) {
	switch action {
	case "get":
		return getMode()
	case "zh":
		if err := setMode(true); err != nil {
			return "", err
		}
		return "zh", nil
	case "en":
		if err := setMode(false); err != nil {
			return "", err
		}
		return "en", nil
	case "decide":
		return "", fmt.Errorf("decide requires request context")
	default:
		return "", fmt.Errorf("unknown action: %s", action)
	}
}

func decideByScene(req request) (string, error) {
	scene := req.Scene
	if scene == "" {
		scene = "DEFAULT"
	}

	if req.ForcedIme == "zh" || req.ForcedIme == "en" {
		return req.ForcedIme, nil
	}

	switch scene {
	case "IDEA_VIM_NORMAL":
		return "en", nil
	case "COMMIT":
		return "zh", nil
	case "COMMENT":
		return "zh", nil
	case "STRING":
		if req.PreferredString == "zh" || req.PreferredString == "en" {
			return req.PreferredString, nil
		}
		return "en", nil
	case "TOOL_WINDOW":
		if req.ToolWindow == "Project" || req.ToolWindow == "Terminal" || req.ToolWindow == "SearchEverywhere" {
			return "en", nil
		}
		return "zh", nil
	case "SEARCH_EVERYWHERE":
		return "en", nil
	case "CUSTOM_EVENT":
		return lastStableMode, nil
	case "CUSTOM_REGEX":
		return lastStableMode, nil
	case "LEAVE_IDE":
		switch req.LeaveStrategy {
		case "en":
			return "en", nil
		case "zh":
			return "zh", nil
		case "none":
			return lastStableMode, nil
		default:
			return lastStableMode, nil
		}
	default:
		if req.Zone == "comment" {
			return "zh", nil
		}
		if req.Zone == "string" {
			if req.PreferredString == "zh" || req.PreferredString == "en" {
				return req.PreferredString, nil
			}
			return "en", nil
		}
		return "en", nil
	}
}

func getForegroundWindow() uintptr {
	hwnd, _, _ := procGetForegroundWindow.Call()
	return hwnd
}

func getWindowThreadProcessId(hwnd uintptr) uint32 {
	tid, _, _ := procGetWindowThreadProcess.Call(hwnd, 0)
	return uint32(tid)
}

func getGUIThreadInfo(threadID uint32, info *guiThreadInfo) bool {
	ret, _, _ := procGetGUIThreadInfo.Call(uintptr(threadID), uintptr(unsafe.Pointer(info)))
	return ret != 0
}

func immGetContext(hwnd uintptr) uintptr {
	himc, _, _ := procImmGetContext.Call(hwnd)
	return himc
}

func immReleaseContext(hwnd uintptr, himc uintptr) {
	_, _, _ = procImmReleaseContext.Call(hwnd, himc)
}

func immGetOpenStatus(himc uintptr) bool {
	ret, _, _ := procImmGetOpenStatus.Call(himc)
	return ret != 0
}

func immSetOpenStatus(himc uintptr, open bool) {
	flag := uintptr(0)
	if open {
		flag = 1
	}
	_, _, _ = procImmSetOpenStatus.Call(himc, flag)
}

func immGetConversionStatus(himc uintptr) (uint32, uint32, bool) {
	var conv uint32
	var sent uint32
	ret, _, _ := procImmGetConversionStatus.Call(himc, uintptr(unsafe.Pointer(&conv)), uintptr(unsafe.Pointer(&sent)))
	return conv, sent, ret != 0
}

func immSetConversionStatus(himc uintptr, conv uint32, sent uint32) {
	_, _, _ = procImmSetConversionStatus.Call(himc, uintptr(conv), uintptr(sent))
}

func immGetDefaultIMEWnd(hwnd uintptr) uintptr {
	ret, _, _ := procImmGetDefaultIMEWnd.Call(hwnd)
	return ret
}

func sendMessage(hwnd, msg, wParam, lParam uintptr) uintptr {
	ret, _, _ := procSendMessageW.Call(hwnd, msg, wParam, lParam)
	return ret
}

func getTargetWindow() uintptr {
	foreground := getForegroundWindow()
	if foreground == 0 {
		return 0
	}

	target := foreground
	tid := getWindowThreadProcessId(foreground)
	info := guiThreadInfo{CbSize: uint32(unsafe.Sizeof(guiThreadInfo{}))}
	if getGUIThreadInfo(tid, &info) {
		if info.HwndFocus != 0 {
			target = info.HwndFocus
		} else if info.HwndCaret != 0 {
			target = info.HwndCaret
		}
	}
	return target
}

func getMode() (string, error) {
	target := getTargetWindow()
	if target == 0 {
		return lastStableMode, nil
	}

	himc := immGetContext(target)
	defaultIME := immGetDefaultIMEWnd(target)
	if himc == 0 && defaultIME == 0 {
		return lastStableMode, nil
	}

	if himc == 0 {
		ret := sendMessage(defaultIME, wmIMEControl, imcGetOpenState, 0)
		if ret != 0 {
			lastStableMode = "zh"
			return "zh", nil
		}
		lastStableMode = "en"
		return "en", nil
	}
	defer immReleaseContext(target, himc)

	if immGetOpenStatus(himc) {
		lastStableMode = "zh"
		return "zh", nil
	}
	if defaultIME != 0 {
		ret := sendMessage(defaultIME, wmIMEControl, imcGetOpenState, 0)
		if ret != 0 {
			lastStableMode = "zh"
			return "zh", nil
		}
	}

	conv, _, ok := immGetConversionStatus(himc)
	if ok && (conv&imeCModeNative) != 0 {
		lastStableMode = "zh"
		return "zh", nil
	}
	lastStableMode = "en"
	return "en", nil
}

func setMode(chinese bool) error {
	target := getTargetWindow()
	if target == 0 {
		if chinese {
			lastStableMode = "zh"
		} else {
			lastStableMode = "en"
		}
		return nil
	}

	himc := immGetContext(target)
	defaultIME := immGetDefaultIMEWnd(target)
	if himc == 0 && defaultIME == 0 {
		if chinese {
			lastStableMode = "zh"
		} else {
			lastStableMode = "en"
		}
		return nil
	}

	if himc == 0 {
		value := uintptr(0)
		if chinese {
			value = 1
		}
		sendMessage(defaultIME, wmIMEControl, imcSetOpenState, value)
		if chinese {
			lastStableMode = "zh"
		} else {
			lastStableMode = "en"
		}
		return nil
	}
	defer immReleaseContext(target, himc)

	conv, sent, ok := immGetConversionStatus(himc)
	if chinese {
		immSetOpenStatus(himc, true)
		if defaultIME != 0 {
			sendMessage(defaultIME, wmIMEControl, imcSetOpenState, 1)
		}
		if ok {
			immSetConversionStatus(himc, conv|imeCModeNative, sent)
		}
		lastStableMode = "zh"
		return nil
	}

	if ok {
		immSetConversionStatus(himc, conv&0xFFFFFFFE, sent)
	}
	immSetOpenStatus(himc, false)
	if defaultIME != 0 {
		sendMessage(defaultIME, wmIMEControl, imcSetOpenState, 0)
	}
	lastStableMode = "en"
	return nil
}
