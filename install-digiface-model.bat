@echo off
cd /d %~dp0
if "%~1"=="" (
  echo Usage: install-digiface-model.bat C:\path\to\digiface_decoder.onnx
  exit /b 2
)
if not exist models\digiface mkdir models\digiface
copy /Y "%~1" models\digiface\digiface_decoder.onnx >nul
if errorlevel 1 exit /b 1
echo Installed models\digiface\digiface_decoder.onnx
