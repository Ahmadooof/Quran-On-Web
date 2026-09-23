@echo off
rem Double-click: give Windows back the disk Docker and other VMs are not using.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vm-reclaim.ps1"
