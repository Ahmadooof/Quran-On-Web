@echo off
rem Double-click this to give Windows back the disk Docker is not using.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0docker-reclaim.ps1"
