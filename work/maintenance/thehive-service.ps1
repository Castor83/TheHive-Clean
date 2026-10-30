param([ValidateSet('Start','Work','Status','Stop','InstallAutostart')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$serviceEntry = Join-Path $PSScriptRoot 'thehive-service.cjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$startupPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'TheHive Maintenance.lnk'
if ($Action -eq 'InstallAutostart') {
    $shortcutShell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $startupPath) {
        $existingShortcut = $shortcutShell.CreateShortcut($startupPath)
        if ($existingShortcut.Arguments -notlike ('*' + $PSCommandPath + '*')) { throw 'Existing unrelated startup shortcut preserved.' }
    }
    $startupShortcut = $shortcutShell.CreateShortcut($startupPath)
    $startupShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $startupShortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + $PSCommandPath + '" -Action Start'
    $startupShortcut.WorkingDirectory = 'C:\TheHive'
    $startupShortcut.WindowStyle = 7
    $startupShortcut.Description = 'TheHive: laufende lokale Wartung; Embedding nur bei geaenderten Quellen'
    $startupShortcut.Save()
    [pscustomobject]@{ status='installed'; startup=$startupPath; target=$startupShortcut.TargetPath; arguments=$startupShortcut.Arguments } | ConvertTo-Json
    exit 0
}
if ($Action -eq 'Status') { & $nodePath $serviceEntry --status; exit $LASTEXITCODE }
if ($Action -eq 'Stop') { & $nodePath $serviceEntry --stop; exit $LASTEXITCODE }
if ($Action -eq 'Work') {
    # Stop only our maintenance supervisor at its current stage boundary.
    & $nodePath $serviceEntry --stop
    if ($LASTEXITCODE -ne 0) { throw 'Maintenance stop request failed.' }
    & (Join-Path $PSScriptRoot 'native-index-watch.ps1') -Action Start
    exit $LASTEXITCODE
}
$currentService = (& $nodePath $serviceEntry --status | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw ('Cannot start maintenance with invalid prior state: ' + $currentService.error) }
if ($currentService.owner.alive) { [pscustomobject]@{status='already_running';pid=$currentService.owner.pid} | ConvertTo-Json; exit 0 }
foreach ($requiredFile in @('project-knowledge-sync.ts','note-navigation-sync.ts','service-resume.cjs','semantic-sync.cjs','learning-sync.cjs','sync-text-graph.py')) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot $requiredFile))) { throw ('Required maintenance component missing: ' + $requiredFile) }
}
if (!(Test-Path -LiteralPath 'C:\Users\USER\.bun\bin\bun.exe' -PathType Leaf)) { throw 'Required existing Bun runtime missing: C:\Users\USER\.bun\bin\bun.exe' }
$startStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$serviceProcess = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $serviceEntry + '"'),'--watch') -WorkingDirectory 'C:\TheHive' -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot ($startStamp + '-service.stdout.log')) -RedirectStandardError (Join-Path $PSScriptRoot ($startStamp + '-service.stderr.log')) -PassThru
[pscustomobject]@{status='started';pid=$serviceProcess.Id;startupInstalled=(Test-Path -LiteralPath $startupPath)} | ConvertTo-Json
