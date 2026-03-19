param(
    [Parameter(Mandatory = $true)]
    [string]$Tag,
    [switch]$Push,
    [switch]$Force,
    [string]$Remote = "origin"
)

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$changelog = Join-Path $repoRoot "CHANGELOG.md"
if (!(Test-Path $changelog)) {
    throw "CHANGELOG.md not found: $changelog"
}

$lines = Get-Content $changelog
$headerPattern = "^##\s*\[?" + [Regex]::Escape($Tag) + "\]?\s*$"
$start = -1

for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match $headerPattern) {
        $start = $i
        break
    }
}

if ($start -lt 0) {
    throw "Version section not found in CHANGELOG.md: $Tag"
}

$end = $lines.Count
for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^##\s+") {
        $end = $i
        break
    }
}

$sectionLines = $lines[$start..($end - 1)]
$notes = ($sectionLines -join "`n").Trim()
if ([string]::IsNullOrWhiteSpace($notes)) {
    throw "Empty release notes for tag: $Tag"
}

$tagExists = (git tag --list $Tag) -ne ""
if ($tagExists -and -not $Force) {
    throw "Tag already exists locally: $Tag. Use -Force to recreate."
}
if ($tagExists -and $Force) {
    git tag -d $Tag | Out-Null
}

git tag -a $Tag -m $notes

if ($Push) {
    git push $Remote $Tag
}

Write-Output "Tag created from CHANGELOG: $Tag"
if ($Push) {
    Write-Output "Tag pushed to ${Remote}: ${Tag}"
}
