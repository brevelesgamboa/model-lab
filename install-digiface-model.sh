#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ "$#" -ne 1 ]; then
  echo "Usage: ./install-digiface-model.sh /path/to/digiface_decoder.onnx" >&2
  exit 2
fi
mkdir -p models/digiface
cp "$1" models/digiface/digiface_decoder.onnx
echo "Installed models/digiface/digiface_decoder.onnx"
