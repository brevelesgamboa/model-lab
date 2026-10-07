#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -d node_modules/onnxruntime-web ] || [ ! -f node_modules/@tensorflow/tfjs/dist/tf.min.js ]; then
  echo "Installing local browser ML runtimes (ONNX Runtime Web + TensorFlow.js)..."
  npm ci
fi
if [ ! -f models/digiface/digiface_decoder.onnx ]; then
  echo "ERROR: models/digiface/digiface_decoder.onnx is missing."
  echo "The default DigiFace model is required by this release."
  exit 1
fi
npm run build
npm start
