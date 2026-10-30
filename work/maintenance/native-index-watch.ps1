param([ValidateSet('Start', 'Status')][string]$Action = 'Start')
$ErrorActionPreference = 'Stop'
$vaultPath = 'C:\TheHive'
$runtimePath = 'C:\Users\USER\.bun\bin\bun.exe'
$entryPath = 'C:\Users\USER\projects\open-second-brain\src\cli\main.ts'
$statePath = Join-Path $PSScriptRoot 'native-index-watch.json'

function Get-CurrentWatcher {
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name='bun.exe'" | Where-Object {
        $_.CommandLine -match [regex]::Escape($entryPath) -and
        $_.CommandLine -match '\bsearch\s+watch\b' -and
        $_.CommandLine -match 'C:[\\/]TheHive(?:\s|"|$)'
    })
    if ($candidates.Count -gt 1) { throw 'Multiple native TheHive watchers exist; preserve and inspect them.' }
    if ($candidates.Count -eq 1) { return $candidates[0] }
    return $null
}

$existingWatcher = Get-CurrentWatcher
if ($existingWatcher) {
    [pscustomobject]@{ status = 'running'; pid = $existingWatcher.ProcessId; vault = $vaultPath; embeddings = $false } | ConvertTo-Json
    exit 0
}
if ($Action -eq 'Status') {
    [pscustomobject]@{ status = 'stopped'; vault = $vaultPath } | ConvertTo-Json
    exit 0
}
if (!(Test-Path -LiteralPath $runtimePath) -or !(Test-Path -LiteralPath $entryPath)) { throw 'Existing native runtime/source is missing.' }

$watchStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$stdoutPath = Join-Path $PSScriptRoot ($watchStamp + '-native-watch.stdout.log')
$stderrPath = Join-Path $PSScriptRoot ($watchStamp + '-native-watch.stderr.log')
# Deliberately omit --embeddings: the existing watcher indexes text only.
$watchArguments = @('run', ('"' + $entryPath + '"'), 'search', 'watch', '--vault', $vaultPath, '--debounce-ms', '1500')
$watchProcess = Start-Process -FilePath $runtimePath -ArgumentList $watchArguments -WorkingDirectory $vaultPath -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
$watchDeadline = [DateTime]::UtcNow.AddSeconds(15)
$ready = $false
while ([DateTime]::UtcNow -lt $watchDeadline) {
    $watchProcess.Refresh()
    if ($watchProcess.HasExited) { throw ('Native watcher exited. Inspect ' + $stderrPath) }
    if ((Test-Path -LiteralPath $stderrPath) -and ((Get-Content -Raw -LiteralPath $stderrPath) -match 'watching C:\\TheHive for \.md changes')) { $ready = $true; break }
    Start-Sleep -Milliseconds 150
}
if (!$ready) { throw ('Watcher readiness unconfirmed; do not start a duplicate. PID ' + $watchProcess.Id + ', log ' + $stderrPath) }

$watchState = [ordered]@{
    status = 'running'
    startedAt = [DateTime]::UtcNow.ToString('o')
    pid = $watchProcess.Id
    vault = $vaultPath
    executable = $runtimePath
    entry = $entryPath
    debounceMs = 1500
    embeddings = $false
    stdout = $stdoutPath
    stderr = $stderrPath
    windowsAutostartInstalled = $false
}
$watchState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
$watchState | ConvertTo-Json
