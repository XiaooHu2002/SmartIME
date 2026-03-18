param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("get", "zh", "en")]
  [string]$Mode
)

$source = @"
using System;
using System.Runtime.InteropServices;

public static class ImeNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct GUITHREADINFO {
    public int cbSize;
    public int flags;
    public IntPtr hwndActive;
    public IntPtr hwndFocus;
    public IntPtr hwndCapture;
    public IntPtr hwndMenuOwner;
    public IntPtr hwndMoveSize;
    public IntPtr hwndCaret;
    public int rcCaretLeft;
    public int rcCaretTop;
    public int rcCaretRight;
    public int rcCaretBottom;
  }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO lpgui);

    [DllImport("imm32.dll")]
    public static extern IntPtr ImmGetContext(IntPtr hWnd);

    [DllImport("imm32.dll")]
    public static extern bool ImmReleaseContext(IntPtr hWnd, IntPtr hIMC);

    [DllImport("imm32.dll")]
    public static extern bool ImmGetConversionStatus(IntPtr hIMC, out uint lpfdwConversion, out uint lpfdwSentence);

    [DllImport("imm32.dll")]
    public static extern bool ImmSetConversionStatus(IntPtr hIMC, uint fdwConversion, uint fdwSentence);

    [DllImport("imm32.dll")]
    public static extern bool ImmGetOpenStatus(IntPtr hIMC);

    [DllImport("imm32.dll")]
    public static extern bool ImmSetOpenStatus(IntPtr hIMC, bool fOpen);

    [DllImport("imm32.dll")]
    public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

if (-not ([System.Management.Automation.PSTypeName]'ImeNative').Type) {
  Add-Type -TypeDefinition $source | Out-Null
}

$IME_CMODE_NATIVE = 0x0001
$WM_IME_CONTROL = 0x0283
$IMC_GETOPENSTATUS = 0x0005
$IMC_SETOPENSTATUS = 0x0006

$foreground = [ImeNative]::GetForegroundWindow()
if ($foreground -eq [IntPtr]::Zero) {
  Write-Output "unknown"
  exit 1
}

$target = $foreground
$tid = [ImeNative]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$gti = New-Object ImeNative+GUITHREADINFO
$gti.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type]"ImeNative+GUITHREADINFO")

if ([ImeNative]::GetGUIThreadInfo($tid, [ref]$gti)) {
  if ($gti.hwndFocus -ne [IntPtr]::Zero) {
    $target = $gti.hwndFocus
  } elseif ($gti.hwndCaret -ne [IntPtr]::Zero) {
    $target = $gti.hwndCaret
  }
}

$himc = [ImeNative]::ImmGetContext($target)

$defaultImeWnd = [ImeNative]::ImmGetDefaultIMEWnd($target)

if ($himc -eq [IntPtr]::Zero -and $defaultImeWnd -eq [IntPtr]::Zero) {
  Write-Output "unknown"
  exit 1
}

function Get-OpenStatusByDefaultIme([IntPtr]$imeWnd) {
  if ($imeWnd -eq [IntPtr]::Zero) {
    return $null
  }
  $ret = [ImeNative]::SendMessage($imeWnd, $WM_IME_CONTROL, [IntPtr]$IMC_GETOPENSTATUS, [IntPtr]::Zero)
  return ($ret -ne [IntPtr]::Zero)
}

function Set-OpenStatusByDefaultIme([IntPtr]$imeWnd, [bool]$open) {
  if ($imeWnd -eq [IntPtr]::Zero) {
    return $false
  }
  $value = 0
  if ($open) {
    $value = 1
  }
  [void][ImeNative]::SendMessage($imeWnd, $WM_IME_CONTROL, [IntPtr]$IMC_SETOPENSTATUS, [IntPtr]$value)
  return $true
}

if ($himc -eq [IntPtr]::Zero) {
  if ($Mode -eq "get") {
    $open2 = Get-OpenStatusByDefaultIme $defaultImeWnd
    if ($null -eq $open2) {
      Write-Output "unknown"
      exit 1
    }
    if ($open2) {
      Write-Output "zh"
    } else {
      Write-Output "en"
    }
    exit 0
  }

  $okSet = Set-OpenStatusByDefaultIme $defaultImeWnd ($Mode -eq "zh")
  if (-not $okSet) {
    Write-Output "unknown"
    exit 1
  }
  if ($Mode -eq "zh") {
    Write-Output "zh"
  } else {
    Write-Output "en"
  }
  exit 0
}

try {
  [uint32]$conv = 0
  [uint32]$sent = 0

  $ok = [ImeNative]::ImmGetConversionStatus($himc, [ref]$conv, [ref]$sent)
  $open = [ImeNative]::ImmGetOpenStatus($himc)

  if ($Mode -eq "get") {
    if ($open) {
      Write-Output "zh"
      exit 0
    }

    $open2 = Get-OpenStatusByDefaultIme $defaultImeWnd
    if ($null -ne $open2 -and $open2) {
      Write-Output "zh"
      exit 0
    }

    if ($ok -and (($conv -band $IME_CMODE_NATIVE) -ne 0)) {
      Write-Output "zh"
    } else {
      Write-Output "en"
    }
    exit 0
  }

  if ($Mode -eq "zh") {
    [void][ImeNative]::ImmSetOpenStatus($himc, $true)
    [void](Set-OpenStatusByDefaultIme $defaultImeWnd $true)
    if ($ok) {
      [uint32]$newConv = $conv -bor $IME_CMODE_NATIVE
      [void][ImeNative]::ImmSetConversionStatus($himc, $newConv, $sent)
    }
    Write-Output "zh"
    exit 0
  }

  if ($Mode -eq "en") {
    if ($ok) {
      [uint32]$newConv = $conv -band 0xFFFFFFFE
      [void][ImeNative]::ImmSetConversionStatus($himc, $newConv, $sent)
    }
    [void][ImeNative]::ImmSetOpenStatus($himc, $false)
    [void](Set-OpenStatusByDefaultIme $defaultImeWnd $false)
    Write-Output "en"
    exit 0
  }
}
finally {
  [void][ImeNative]::ImmReleaseContext($target, $himc)
}
