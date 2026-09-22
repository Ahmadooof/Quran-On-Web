<#
    Gives Windows back the disk Docker is no longer using.

        powershell -ExecutionPolicy Bypass -File scripts\docker-reclaim.ps1

    Two things have to happen, and one without the other does half the job:

      1. Prune, which frees space *inside* Docker's virtual disk.
      2. Compact, which gives that space back to the C: drive.

    WSL's disk file only ever grows. Building the audio tags pushed it to 71 GB
    while holding 6 GB, and pruning alone did not move it an inch.

    Asks for Administrator itself, because compacting needs it. Docker Desktop
    has to be closed — the script closes it and says so.
#>

[CmdletBinding()]
param(
    # Leave the build cache alone; compact around it. Slower next release
    # without it, but the cache is most of what grows the disk.
    [switch]$KeepCache
)

$ErrorActionPreference = 'Stop'

# ---- administrator ----

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Compacting needs Administrator — asking for it.'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($KeepCache) { $argv += '-KeepCache' }
    Start-Process powershell -Verb RunAs -Wait -ArgumentList $argv
    exit
}

# ---- the disk ----

$vhd = Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'
if (-not (Test-Path $vhd)) {
    $vhd = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Docker') -Recurse -Filter '*.vhdx' `
        -ErrorAction SilentlyContinue | Sort-Object Length -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $vhd -or -not (Test-Path $vhd)) {
    throw 'No Docker WSL disk found. Is Docker Desktop installed with the WSL backend?'
}

$gb = { param($n) '{0:N1} GB' -f ($n / 1GB) }
$before = (Get-Item $vhd).Length
$freeBefore = (Get-PSDrive C).Free

Write-Host ''
Write-Host ("disk    {0}" -f $vhd)
Write-Host ("size    {0}" -f (& $gb $before))
Write-Host ("C: free {0}" -f (& $gb $freeBefore))

# ---- 1. prune, while Docker is still up ----

if (-not $KeepCache) {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Write-Host ''
        Write-Host 'Pruning build cache and dangling images…'
        # Images still tagged are left alone: those are yours to remove.
        & docker builder prune -f | Select-Object -Last 1
        & docker image prune -f | Select-Object -Last 1
    } else {
        Write-Host 'docker command not found — skipping the prune.'
    }
}

# ---- 2. stop everything that holds the file open ----

Write-Host ''
$running = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'Closing Docker Desktop (start it again when this finishes)…'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 5
}

Write-Host 'Shutting WSL down…'
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

Write-Host 'Compacting — this takes a few minutes…'
$out = & diskpart /s $script
Remove-Item $script -Force -ErrorAction SilentlyContinue

# diskpart reports progress a percent at a time; only the verdicts matter
$out | Where-Object { $_ -match 'DiskPart successfully|error|Error' } | ForEach-Object {
    Write-Host ("  {0}" -f $_.Trim())
}

# ---- what it came to ----

$after = (Get-Item $vhd).Length
$freeAfter = (Get-PSDrive C).Free

Write-Host ''
Write-Host ("size    {0}  ->  {1}" -f (& $gb $before), (& $gb $after))
Write-Host ("C: free {0}  ->  {1}" -f (& $gb $freeBefore), (& $gb $freeAfter))
Write-Host ("reclaimed {0}" -f (& $gb ($freeAfter - $freeBefore)))
Write-Host ''
Write-Host 'Your images are untouched. Start Docker Desktop when you like.'
Write-Host ''
Read-Host 'Press Enter to close'
