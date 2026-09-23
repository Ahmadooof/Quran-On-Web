@echo off
rem Double-click: give Windows back the disk Docker is not using.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker-reclaim.ps1"
