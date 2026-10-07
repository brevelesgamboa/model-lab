# DigiFace decoder

The bundled decoder is `models/digiface/digiface_decoder.onnx`. It accepts a 48-dimensional float32 latent vector and returns [1, 3, 112, 112] RGB values.

It is pretrained: normal users run inference only. They do not need the original image dataset or a training environment. The optional Experiments training flow produces a separate browser-stored model, not this decoder.

## Provenance
`models/digiface/model-info.json` records 144,000 images, 2,000 identities, 60 epochs, and a PyTorch/ROCm training environment. Those training details are author-reported, not independently verified; the original training script, logs, and evaluation results are not included. ChatGPT assistance is recorded as workflow provenance, not as a model-quality or licensing certification.

## Browser inference

The adapter loads ONNX Runtime on demand, tries WebGPU, then falls back to WASM. Its self-check verifies output dimensions and element count before rendering. Inference inputs and outputs are disposed after use.

Latent coordinate controls do not establish that any coordinate corresponds to a specific facial trait. Axis labels describe an exploratory assignment. Skin color mix is a separate post-process; a value of zero preserves decoder colors.

## Replacing the model

Retain the interface above, document checkpoint provenance and conversion, update the hash/size in `tools/model-assets.json`, and run the real ONNX browser regression. The integration does not validate training quality, identity reconstruction, or demographic meaning.

## Distribution

The application code is MIT-licensed. Decoder weights have separate [non-commercial research terms](licenses/digiface-decoder-research.txt); keep those terms and `models/digiface/NOTICE.txt` with redistributed weights. Builds include both automatically. Original dataset images are not distributed.

The [DigiFace-1M agreement](https://github.com/microsoft/DigiFace1M/blob/main/LICENSE) restricts commercial use of Data and Results (§2.1). Trained models qualify as Results only if they contain no more than a de minimis portion of the dataset (§5.5). Its dataset-redistribution conditions should not be presented as automatically applying to Results.

Non-commercial research is not synonymous with every free application. The intended release must fit that scope, and no dataset-memorization evaluation or legal clearance is asserted here. Attribution: Bae et al., _DigiFace-1M: 1 Million Digital Face Images for Face Recognition_, WACV 2023; [official dataset repository](https://github.com/microsoft/DigiFace1M).
