<#
    Gives Windows back the disk that virtual machines are no longer using.

        powershell -ExecutionPolicy Bypass -File scripts\vm-reclaim.ps1
        ... -ListOnly                         find and measure, change nothing
        ... -Path 'D:\VMs','E:\Old machines'  look somewhere else too

    Every virtual disk grows to fit what it once held and none of them shrink
    on their own. Docker's took 71 GB while holding 6. Pruning frees space
    inside the disk; compacting is what gives it back to the drive, and one
    without the other does half the job.

    Two parts:

      Docker   prune, then compact its WSL disk. This is the path that took
               C: from 17 GB free to 76.

      Others   find .vhd/.vhdx/.vmdk/.vdi/.qcow2 lying around and measure them.
               vhd and vhdx it compacts with diskpart, which Windows always
               has. The rest need their own hypervisor's tool, so it prints
               the command rather than pretending it can.

    Asks for Administrator itself, except for -ListOnly, which changes nothing
    and so needs nothing.

    ASCII only on purpose: PowerShell 5.1 reads a UTF-8 file as ANSI unless
    told otherwise, and one round trip through Set-Content turns a dash into
    mojibake.
#>

[CmdletBinding()]
param(
    [string[]]$Path,
    [switch]$ListOnly,
    [switch]$KeepCache,
    [switch]$SkipDocker
)

$ErrorActionPreference = 'Stop'

# ---- administrator ----

$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $ListOnly -and -not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Compacting needs Administrator - asking for it.'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
    if ($Path)       { $argv += '-Path'; $argv += ($Path -join ',') }
    if ($KeepCache)  { $argv += '-KeepCache' }
    if ($SkipDocker) { $argv += '-SkipDocker' }
    Start-Process powershell -Verb RunAs -Wait -ArgumentList $argv
    exit
}

$gb = { param($n) '{0:N1} GB' -f ($n / 1GB) }
$freeAtStart = (Get-PSDrive C).Free

function Compact-Vhd {
    param([string]$File)

    $script = Join-Path $env:TEMP ('compact-' + [guid]::NewGuid().ToString('N') + '.txt')
    @(
        "select vdisk file=`"$File`""
        'attach vdisk readonly'
        'compact vdisk'
        'detach vdisk'
        'exit'
    ) | Set-Content $script -Encoding ascii

    $out = & diskpart /s $script
    Remove-Item $script -Force -ErrorAction SilentlyContinue

    if ($out -match 'successfully compacted') { return $true }
    $out | Where-Object { $_ -match 'error|Error|cannot|denied' } |
        Select-Object -First 1 | ForEach-Object { Write-Host ("    {0}" -f $_.Trim()) }
    return $false
}

# ---- Docker ----

if (-not $SkipDocker) {
    Write-Host ''
    Write-Host '== Docker =='

    $vhd = Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'
    if (-not (Test-Path $vhd)) {
        $vhd = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Docker') -Recurse -Filter '*.vhdx' `
            -ErrorAction SilentlyContinue | Sort-Object Length -Descending |
            Select-Object -First 1 -ExpandProperty FullName
    }

    if (-not $vhd -or -not (Test-Path $vhd)) {
        Write-Host '  no Docker WSL disk here - skipping'
    } else {
        $was = (Get-Item $vhd).Length
        Write-Host ("  disk  {0}" -f (& $gb $was))

        if (-not $ListOnly) {
            if (-not $KeepCache -and (Get-Command docker -ErrorAction SilentlyContinue)) {
                Write-Host '  pruning build cache and dangling images...'
                # Tagged images are left alone: those are yours to remove.
                & docker builder prune -f | Select-Object -Last 1 | ForEach-Object { Write-Host ("    {0}" -f $_) }
                & docker image prune -f  | Select-Object -Last 1 | ForEach-Object { Write-Host ("    {0}" -f $_) }
            }

            $app = Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue
            if ($app) {
                Write-Host '  closing Docker Desktop (start it again afterwards)...'
                $app | Stop-Process -Force
                Start-Sleep -Seconds 5
            }
            Write-Host '  shutting WSL down...'
            & wsl --shutdown
            Start-Sleep -Seconds 5

            Write-Host '  compacting...'
            if (Compact-Vhd $vhd) {
                Write-Host ("  {0}  ->  {1}" -f (& $gb $was), (& $gb (Get-Item $vhd).Length))
            } else {
                Write-Host '  could not compact - is Docker Desktop really closed?'
            }
        }
    }
}

# ---- everything else ----

Write-Host ''
Write-Host '== Other virtual disks =='

$roots = @(
    (Join-Path $env:USERPROFILE 'Documents\Virtual Machines')
    (Join-Path $env:USERPROFILE 'VirtualBox VMs')
    (Join-Path $env:USERPROFILE 'VMs')
    'C:\VMs'
    'C:\Virtual Machines'
    'C:\Users\Public\Documents\Hyper-V'
    'C:\ProgramData\Microsoft\Windows\Virtual Hard Disks'
) + $Path | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

if (-not $roots) {
    Write-Host '  none of the usual folders exist. Point at yours with -Path.'
} else {
    $disks = foreach ($r in $roots) {
        Get-ChildItem $r -Recurse -File -ErrorAction SilentlyContinue -Include '*.vhd','*.vhdx','*.vmdk','*.vdi','*.qcow2' |
            Where-Object { $_.Length -gt 100MB }
    }
    $disks = @($disks | Sort-Object Length -Descending)

    if (-not $disks) {
        Write-Host ("  looked in {0} folder(s), found nothing over 100 MB" -f $roots.Count)
    } else {
        Write-Host ("  {0} disk(s), {1} in total" -f $disks.Count, (& $gb (($disks | Measure-Object Length -Sum).Sum)))
        Write-Host ''
        foreach ($d in $disks) {
            Write-Host ("  {0,10}  {1}" -f (& $gb $d.Length), $d.FullName)

            if ($ListOnly) { continue }

            switch ($d.Extension.ToLower()) {
                { $_ -in '.vhd', '.vhdx' } {
                    Write-Host '             compacting...'
                    if (Compact-Vhd $d.FullName) {
                        Write-Host ("             now {0}" -f (& $gb (Get-Item $d.FullName).Length))
                    }
                }
                '.vmdk'  { Write-Host '             VMware: vmware-vdiskmanager.exe -k "<file>"' }
                '.vdi'   { Write-Host '             VirtualBox: VBoxManage modifymedium disk "<file>" --compact' }
                '.qcow2' { Write-Host '             QEMU: qemu-img convert -O qcow2 "<file>" "<file>.new"' }
            }
        }

        if (-not $ListOnly -and ($disks | Where-Object { $_.Extension -notmatch 'vhdx?$' })) {
            Write-Host ''
            Write-Host '  Those needing their own tool were measured, not touched. If the'
            Write-Host '  hypervisor is gone and the machine is not wanted, the disk file is'
            Write-Host '  just a large file - delete it and the space comes back at once.'
        }
    }
}

# ---- what it came to ----

$freeNow = (Get-PSDrive C).Free
Write-Host ''
Write-Host ("C: free {0}  ->  {1}" -f (& $gb $freeAtStart), (& $gb $freeNow))
if ($freeNow -gt $freeAtStart) {
    Write-Host ("reclaimed {0}" -f (& $gb ($freeNow - $freeAtStart)))
}
Write-Host ''
Read-Host 'Press Enter to close'
