DIGIFACE_LATENT_VAE_01 deployment model

This directory contains the default browser decoder used by LATENT FIELD:

    digiface_decoder.onnx

The project author trained it from scratch with a ChatGPT-assisted workflow
on a DigiFace-1M subset, not by fine-tuning another pretrained checkpoint.
This is a project-trained decoder, not a Microsoft-provided model.

Expected model contract:
- input: first float32 tensor, shape [batch, 48]
- output: first float32 tensor, shape [batch, 3, 112, 112]
- output range: approximately 0..1
- architecture: beta-VAE decoder
- inference: ONNX Runtime Web through WASM or WebGPU

The file is bundled so a normal user only needs to install dependencies,
build, and start the local server. The build script fails if the model is
missing.
Users do not need to train the decoder or download the DigiFace image dataset.

These weights are supplied for non-commercial research under
licenses/digiface-decoder-research.txt (relative to project root), separately
from the application code's MIT license. Retain those terms and NOTICE.txt
when redistributing. See DIGIFACE_INTEGRATION.md in the source repository for
provenance, limitations, and the upstream dataset agreement.
