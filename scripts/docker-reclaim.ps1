<#
    Gives Windows back the disk Docker is no longer using.

        powershell -ExecutionPolicy Bypass -File scripts\docker-reclaim.ps1
        ... -KeepCache    leave the build cache alone

    Two things have to happen, and one without the other does half the job:

      1. Prune, which frees space inside Docker's virtual disk.
      2. Compact, which gives that space back to the C: drive.

    WSL's disk file only ever grows. Building the audio tags pushed it to
    71 GB while it held 6, and pruning alone did not move it an inch.

    Asks for Administrator itself, because compacting needs it. Docker Desktop
    has to be closed - the script closes it and says so.

    ASCII only on purpose: PowerShell 5.1 reads a UTF-8 file as ANSI unless
    told otherwise, and one round trip through Set-Content turns a dash into
    mojibake.
#>

[CmdletBinding()]
param(
    [switch]$KeepCache
)

$ErrorActionPreference = 'Stop'

# A double-clicked window that closes on the error is a window that never
# told you anything. Whatever goes wrong, it gets said and waited on.
trap {
    Write-Host ''
    Write-Host ('Stopped: ' + $_.Exception.Message)
    Write-Host ''
    Read-Host 'Press Enter to close'
    exit 1
}

# ---- administrator ----

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Compacting needs Administrator - asking for it.'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($KeepCache) { $argv += '-KeepCache' }
    Start-Process powershell -Verb RunAs -Wait -ArgumentList $argv
    exit
}

$gb = { param($n) '{0:N1} GB' -f ($n / 1GB) }
$freeAtStart = (Get-PSDrive C).Free

# ---- find the disk ----

$vhd = Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'
if (-not (Test-Path $vhd)) {
    $vhd = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Docker') -Recurse -Filter '*.vhdx' `
        -ErrorAction SilentlyContinue | Sort-Object Length -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $vhd -or -not (Test-Path $vhd)) {
    throw 'No Docker WSL disk found. Is Docker Desktop installed with the WSL backend?'
}

$was = (Get-Item $vhd).Length
Write-Host ''
Write-Host ("disk    {0}" -f $vhd)
Write-Host ("size    {0}" -f (& $gb $was))
Write-Host ("C: free {0}" -f (& $gb $freeAtStart))

# ---- 1. prune, while the engine is still up ----

Write-Host ''

# The CLI existing says nothing about the daemon answering, and a prune against
# a stopped engine prints its connection error twice and reclaims nothing.
#
# The preference goes back to Continue around it on purpose. PowerShell 5.1
# wraps a native command's stderr in an ErrorRecord, and under Stop that is a
# terminating error - so asking whether Docker was up killed the script
# whenever it was not, before it had done anything at all.
$engineUp = $false
if (Get-Command docker -ErrorAction SilentlyContinue) {
    # not $was: that already holds the size this run is measured against
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker info --format '{{.ServerVersion}}' 2>&1 | Out-Null
        $engineUp = $LASTEXITCODE -eq 0
    } catch {
        $engineUp = $false
    } finally {
        $ErrorActionPreference = $prevPref
    }
}

if ($KeepCache) {
    Write-Host 'Leaving the build cache alone.'
} elseif (-not $engineUp) {
    Write-Host 'Docker is not running, so there is nothing to prune.'
    Write-Host 'Start Docker Desktop first if you want the cache cleared too.'
} else {
    Write-Host 'Pruning build cache and dangling images...'
    # Tagged images are left alone: those are yours to remove.
    & docker builder prune -f | Select-Object -Last 1 | ForEach-Object { Write-Host ("  {0}" -f $_) }
    & docker image prune -f  | Select-Object -Last 1 | ForEach-Object { Write-Host ("  {0}" -f $_) }
}

# ---- 2. stop whatever holds the file open ----

Write-Host ''
$app = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if ($app) {
    Write-Host 'Closing Docker Desktop (start it again when this finishes)...'
    $app | Stop-Process -Force
    Start-Sleep -Seconds 5
}
Write-Host 'Shutting WSL down...'
& wsl --shutdown
Start-Sleep -Seconds 5

# ---- 3. compact ----

$script = Join-Path $env:TEMP 'docker-compact.txt'
@(
    "select vdisk file=`"$vhd`""
    'attach vdisk readonly'
    'compact vdisk'
    'detach vdisk'
    'exit'
) | Set-Content $script -Encoding ascii

Write-Host 'Compacting - this takes a few minutes...'
$out = & diskpart /s $script
Remove-Item $script -Force -ErrorAction SilentlyContinue

# -match on an array returns the lines that matched, so an empty result means
# none did. -notmatch would return every other line instead, which is nearly
# all of them, and read as failure on a run that had just succeeded.
if (-not ($out -match 'successfully compacted')) {
    $out | Where-Object { $_ -match 'error|Error|cannot|denied' } |
        Select-Object -First 1 | ForEach-Object { Write-Host ("  {0}" -f $_.Trim()) }
    Write-Host '  could not compact - is Docker Desktop really closed?'
}

# ---- what it came to ----

$now = (Get-Item $vhd).Length
$freeNow = (Get-PSDrive C).Free

Write-Host ''
if ($now -lt $was) {
    Write-Host ("size    {0}  ->  {1}" -f (& $gb $was), (& $gb $now))
    Write-Host ("C: free {0}  ->  {1}" -f (& $gb $freeAtStart), (& $gb $freeNow))
    Write-Host ("reclaimed {0}" -f (& $gb ($freeNow - $freeAtStart)))
} else {
    Write-Host 'Already as small as it goes - nothing to give back.'
}

Write-Host ''
Write-Host 'Your images are untouched. Start Docker Desktop when you like.'
Write-Host ''
Read-Host 'Press Enter to close'
