# Cline: require strict validation for the existing TheHive note tool.
$ErrorActionPreference = 'Stop'
try {
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $extensionEnvelope = $null -ne $data.preToolUse
    if ($extensionEnvelope) {
        $name = $data.preToolUse.toolName
        $argsObject = $data.preToolUse.parameters
    } elseif ($null -ne $data.tool_call) {
        $name = $data.tool_call.name
        $argsObject = $data.tool_call.input
    } else { throw 'Missing PreToolUse envelope' }
    if ($name -isnot [string] -or [string]::IsNullOrWhiteSpace($name)) { throw 'Missing tool name' }
    if ($argsObject -is [string]) { $argsObject = $argsObject | ConvertFrom-Json -ErrorAction Stop }
    # Extension protobuf parameters may contain individually JSON-encoded values.
    if ($extensionEnvelope -and $null -ne $argsObject) {
        foreach ($property in @($argsObject.PSObject.Properties)) {
            if ($property.Value -is [string]) {
                try { $property.Value = ConvertFrom-Json -InputObject $property.Value -ErrorAction Stop } catch { }
            }
        }
    }
    # SDK hook contexts escape literal underscores in MCP tool names.
    $observedName = $name
    if ($name -eq 'thehive-memory____brain__create__note') { $name = 'thehive-memory__brain_create_note' }
    if ($name -eq 'use__mcp__tool') { $name = 'use_mcp_tool' }
    try {
        $receiptDir = Join-Path $env:USERPROFILE '.cline\data\logs'
        [IO.Directory]::CreateDirectory($receiptDir) | Out-Null
        $receipt = @{event='PreToolUse'; task_id=$data.taskId; ts_utc=[DateTime]::UtcNow.ToString('o'); tool_name=$observedName; strict_guard_version=2} | ConvertTo-Json -Compress
        [IO.File]::AppendAllText((Join-Path $receiptDir 'thehive-learning-hooks.jsonl'), $receipt + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } catch { } # Diagnosebeleg darf die Strict-Entscheidung nicht ersetzen.
    $target = $name -eq 'thehive-memory__brain_create_note'
    if ($name -eq 'use_mcp_tool' -and $argsObject.server_name -eq 'thehive-memory' -and $argsObject.tool_name -eq 'brain_create_note') {
        $target = $true
        $argsObject = $argsObject.arguments
        if ($argsObject -is [string]) { $argsObject = $argsObject | ConvertFrom-Json -ErrorAction Stop }
    }
    if ($target -and ($argsObject.strict -isnot [bool] -or $argsObject.strict -ne $true)) {
        @{cancel=$true; errorMessage='TheHive: brain_create_note requires explicit strict:true. Nothing was submitted.'; contextModification='Use brain_create_note with strict:true. Do not switch to an editor, terminal or another write path.'} | ConvertTo-Json -Compress
    } else { @{cancel=$false} | ConvertTo-Json -Compress }
} catch {
    @{cancel=$true; errorMessage='TheHive PreToolUse: invalid hook input; execution blocked.'} | ConvertTo-Json -Compress
}
