// TensorFlow Slim InceptionV3 endpoint depths (depth_multiplier = 1).
// https://github.com/tensorflow/models/blob/master/research/slim/nets/inception_v3.py
export const INCEPTION_LAYER_CHANNELS = Object.freeze({
  Conv2d_2b_3x3: 64,
  Conv2d_3b_1x1: 80,
  Conv2d_4a_3x3: 192,
  mixed_5b: 256,
  mixed_5c: 288,
  mixed_5d: 288,
  mixed_6a: 768,
  mixed_6b: 768,
  mixed_6c: 768,
  mixed_6d: 768,
  mixed_6e: 768,
  mixed_7a: 1280,
  mixed_7b: 2048,
  mixed_7c: 2048,
});

export function getInceptionLayerChannels(layer) {
  return Object.hasOwn(INCEPTION_LAYER_CHANNELS, layer)
    ? INCEPTION_LAYER_CHANNELS[layer]
    : INCEPTION_LAYER_CHANNELS.mixed_6c;
}

export function clampDreamChannel(channel, layer = "mixed_6c") {
  const value = Math.round(Number(channel));
  const channels = getInceptionLayerChannels(layer);
  return Number.isFinite(value)
    ? Math.max(-1, Math.min(value, channels - 1))
    : -1;
}

export const INCEPTION_LAYERS = Object.freeze({
  Conv2d_2b_3x3:
    "module_apply_default/InceptionV3/InceptionV3/Conv2d_2b_3x3/Relu",
  Conv2d_3b_1x1:
    "module_apply_default/InceptionV3/InceptionV3/Conv2d_3b_1x1/Relu",
  Conv2d_4a_3x3:
    "module_apply_default/InceptionV3/InceptionV3/Conv2d_4a_3x3/Relu",
  mixed_5b: "module_apply_default/InceptionV3/InceptionV3/Mixed_5b/concat",
  mixed_5c: "module_apply_default/InceptionV3/InceptionV3/Mixed_5c/concat",
  mixed_5d: "module_apply_default/InceptionV3/InceptionV3/Mixed_5d/concat",
  mixed_6a: "module_apply_default/InceptionV3/InceptionV3/Mixed_6a/concat",
  mixed_6b: "module_apply_default/InceptionV3/InceptionV3/Mixed_6b/concat",
  mixed_6c: "module_apply_default/InceptionV3/InceptionV3/Mixed_6c/concat",
  mixed_6d: "module_apply_default/InceptionV3/InceptionV3/Mixed_6d/concat",
  mixed_6e: "module_apply_default/InceptionV3/InceptionV3/Mixed_6e/concat",
  mixed_7a: "module_apply_default/InceptionV3/InceptionV3/Mixed_7a/concat",
  mixed_7b: "module_apply_default/InceptionV3/InceptionV3/Mixed_7b/concat",
  mixed_7c: "module_apply_default/InceptionV3/InceptionV3/Mixed_7c/concat",
});
