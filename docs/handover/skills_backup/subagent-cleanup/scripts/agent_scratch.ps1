[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('New', 'Inspect', 'Release', 'Clean')][string]$Action,
    [Parameter(Mandatory = $true)][string]$ScratchRoot,
    [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$Owner,
    [string]$ProjectRoot,
    [string]$AgentId,
    [string]$Id,
    [switch]$WritersStopped,
    [switch]$ResultsPreserved,
    [string]$Evidence
)

# Run in Windows PowerShell 5.1 or PowerShell 7. All recursive deletion is native
# PowerShell and restricted to a newly allocated, recorded slot.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$markerName = '.agent-scratch-slot.json'
$lockStream = $null
$record = $null
$recordPath = $null
$deleting = $false

function Full-Directory([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or
        $Value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or
        $Value.StartsWith('\\?\') -or $Value.StartsWith('\\.\')) {
        throw 'An ordinary absolute filesystem path is required.'
    }
    $full = [IO.Path]::GetFullPath($Value).Replace('/', '\')
    foreach ($part in $full.Substring([IO.Path]::GetPathRoot($full).Length).Split('\')) {
        if ($part.EndsWith('.') -or $part.EndsWith(' ') -or $part.Contains(':')) {
            throw 'Ambiguous Windows path components and alternate data streams are refused.'
        }
    }
    $volume = [IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\') -eq $volume.TrimEnd('\')) { return $volume }
    return $full.TrimEnd('\')
}

function Assert-NoReparse([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse point: $cursor"
            }
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}

function Is-Within([string]$Child, [string]$Parent) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-ProjectBoundary([string]$Root, [string]$Project) {
    if ((Is-Within $Root $Project) -or (Is-Within $Project $Root)) {
        throw 'ScratchRoot and ProjectRoot must not contain or equal one another.'
    }
    Assert-NoReparse $Project
}

function Save-Record($Value, [string]$Path) {
    Assert-NoReparse $Path
    $temp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    }
}

function Read-Json([string]$Path) {
    Assert-NoReparse $Path
    return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Measure-SafeSlot([string]$Slot) {
    Assert-NoReparse $Slot
    [long]$bytes = 0
    [long]$files = 0
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Slot)
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing nested reparse point: $($item.FullName)"
            }
            if ($item.PSIsContainer) { $pending.Push($item.FullName) }
            else {
                if ($item.Name -ieq '.git') {
                    throw "Git worktree/submodule pointer requires Git or Codex worktree tools: $($item.FullName)"
                }
                $bytes += $item.Length
                $files++
            }
        }
    }
    return @{ bytes = $bytes; files = $files }
}

function Assert-SlotMarker($Value, [string]$Slot) {
    $marker = Join-Path $Slot $markerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        # A crash between removing the last marker and removing its empty folder
        # is safe to finish. Never adopt a nonempty directory without its marker.
        if ($Value.state -eq 'cleaning' -and @(Get-ChildItem -LiteralPath $Slot -Force).Count -eq 0) {
            return
        }
        throw 'Slot marker is missing.'
    }
    $identity = Read-Json $marker
    foreach ($key in @('id', 'owner', 'token', 'root', 'project', 'slot')) {
        if ($identity.$key -cne $Value.$key) { throw "Slot marker mismatch: $key" }
    }
}

try {
    $root = Full-Directory $ScratchRoot
    if ($root.TrimEnd('\') -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) {
        throw 'ScratchRoot cannot be a drive or share root.'
    }
    Assert-NoReparse $root
    $slots = Join-Path $root 'slots'
    $records = Join-Path $root 'records'
    $locks = Join-Path $root 'locks'

    if ($Action -eq 'New') {
        if (-not [string]::IsNullOrWhiteSpace($Id)) { throw 'New allocates its own ID.' }
        $project = Full-Directory $ProjectRoot
        Assert-ProjectBoundary $root $project
        if (-not (Test-Path -LiteralPath $project -PathType Container)) { throw 'ProjectRoot must exist.' }
        foreach ($directory in @($root, $slots, $records, $locks)) {
            Assert-NoReparse $directory
            [void][IO.Directory]::CreateDirectory($directory)
        }
        $Id = [guid]::NewGuid().ToString('D')
    }
    else {
        $parsedId = [guid]::Empty
        if (-not [guid]::TryParseExact($Id, 'D', [ref]$parsedId)) { throw 'Id must be a canonical GUID.' }
        $Id = $parsedId.ToString('D')
        foreach ($directory in @($slots, $records, $locks)) {
            Assert-NoReparse $directory
            if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'Scratch registry is missing.' }
        }
    }

    $slot = Join-Path $slots $Id
    $recordPath = Join-Path $records ($Id + '.json')
    $lockPath = Join-Path $locks ($Id + '.lock')
    foreach ($path in @($slot, $recordPath, $lockPath)) { Assert-NoReparse $path }
    $mode = if ($Action -eq 'New') { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Open }
    $lockStream = [IO.File]::Open($lockPath, $mode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)

    if ($Action -eq 'New') {
        if ((Test-Path -LiteralPath $slot) -or (Test-Path -LiteralPath $recordPath)) { throw 'New slot collision.' }
        [void](New-Item -ItemType Directory -Path $slot)
        $record = [pscustomobject]@{
            schema = 1; id = $Id; owner = $Owner; agent_id = $AgentId
            root = $root; project = $project; slot = $slot
            token = [guid]::NewGuid().ToString('D'); state = 'active'
            created_utc = [DateTime]::UtcNow.ToString('o'); evidence = $null
            released_utc = $null; cleaned_utc = $null; estimated_bytes = 0L; last_error = $null
        }
        Save-Record $record (Join-Path $slot $markerName)
        Save-Record $record $recordPath
        @{ ok = $true; action = $Action; id = $Id; owner = $Owner; slot = $slot; state = 'active' } | ConvertTo-Json
    }
    else {
        $record = Read-Json $recordPath
        if ($record.schema -ne 1 -or $record.id -cne $Id -or $record.owner -cne $Owner -or
            $record.root -cne $root -or $record.slot -cne $slot -or
            [string]::IsNullOrWhiteSpace($record.token) -or
            $record.state -notin @('active', 'released', 'cleaning', 'cleaned')) {
            throw 'Registry identity, owner, or state mismatch.'
        }
        $project = Full-Directory $record.project
        Assert-ProjectBoundary $root $project
        $exists = Test-Path -LiteralPath $slot -PathType Container
        if ((Test-Path -LiteralPath $slot) -and -not $exists) { throw 'Slot is not a directory.' }
        if ($record.state -eq 'cleaned' -and $exists) { throw 'A cleaned slot path has been reused; refusing it.' }
        if ($exists) {
            Assert-SlotMarker $record $slot
            $size = Measure-SafeSlot $slot
        }
        else { $size = @{ bytes = 0L; files = 0L } }

        if ($Action -eq 'Inspect') {
            @{ ok = $true; action = $Action; id = $Id; owner = $Owner; slot = $slot
                state = $record.state; exists = $exists; estimated_bytes = $size.bytes
                files = $size.files; candidate = ($record.state -in @('released', 'cleaning'))
                evidence = $record.evidence } | ConvertTo-Json
        }
        elseif ($Action -eq 'Release') {
            if (-not $WritersStopped -or -not $ResultsPreserved -or [string]::IsNullOrWhiteSpace($Evidence)) {
                throw 'Release requires WritersStopped, ResultsPreserved, and nonempty Evidence.'
            }
            if ($record.state -notin @('active', 'released') -or -not $exists) { throw 'Only an existing active/released slot can be released.' }
            $record.state = 'released'
            $record.evidence = $Evidence
            $record.released_utc = [DateTime]::UtcNow.ToString('o')
            Save-Record $record $recordPath
            @{ ok = $true; action = $Action; id = $Id; slot = $slot; state = $record.state; estimated_bytes = $size.bytes } | ConvertTo-Json
        }
        else {
            if ($record.state -notin @('released', 'cleaning', 'cleaned')) { throw 'Active slot cannot be cleaned; release it after preserving results.' }
            if ($record.state -eq 'cleaned') {
                @{ ok = $true; action = $Action; id = $Id; state = 'cleaned'; already_cleaned = $true; estimated_reclaimed_bytes = 0L } | ConvertTo-Json
            }
            else {
                $record.estimated_bytes = [Math]::Max([long]$record.estimated_bytes, [long]$size.bytes)
                $record.state = 'cleaning'
                $record.last_error = $null
                Save-Record $record $recordPath
                $deleting = $true
                if ($exists) {
                    # Recheck the exact target immediately before deletion. Writers
                    # must remain stopped throughout the scan and deletion.
                    Assert-NoReparse $slot
                    Assert-SlotMarker $record $slot
                    [void](Measure-SafeSlot $slot)
                    foreach ($item in @(Get-ChildItem -LiteralPath $slot -Force)) {
                        if ($item.Name -cne $markerName) { Remove-Item -LiteralPath $item.FullName -Recurse -Force }
                    }
                    $marker = Join-Path $slot $markerName
                    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
                    Remove-Item -LiteralPath $slot -Force
                }
                if (Test-Path -LiteralPath $slot) { throw 'Slot still exists after cleanup.' }
                $record.state = 'cleaned'
                $record.cleaned_utc = [DateTime]::UtcNow.ToString('o')
                Save-Record $record $recordPath
                $deleting = $false
                @{ ok = $true; action = $Action; id = $Id; state = 'cleaned'; already_cleaned = $false
                    estimated_reclaimed_bytes = $record.estimated_bytes; record = $recordPath } | ConvertTo-Json
            }
        }
    }
}
catch {
    $message = $_.Exception.Message
    if ($deleting -and $null -ne $record) {
        try { $record.last_error = $message; Save-Record $record $recordPath } catch { }
    }
    @{ ok = $false; action = $Action; id = $Id; error = $message } | ConvertTo-Json
    exit 1
}
finally {
    if ($null -ne $lockStream) { $lockStream.Dispose() }
}
