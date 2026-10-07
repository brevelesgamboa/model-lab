@echo off
cd /d %~dp0
if not exist node_modules\onnxruntime-web goto install_ml
if not exist node_modules\@tensorflow\tfjs\dist\tf.min.js goto install_ml
goto runtimes_ready

:install_ml
echo Installing local browser ML runtimes ^(ONNX Runtime Web + TensorFlow.js^)...
call npm ci
if errorlevel 1 exit /b 1

:runtimes_ready
if not exist models\digiface\digiface_decoder.onnx (
  echo ERROR: models\digiface\digiface_decoder.onnx is missing.
  echo The default DigiFace model is required by this release.
  exit /b 1
)
call npm run build
if errorlevel 1 exit /b 1
call npm start
