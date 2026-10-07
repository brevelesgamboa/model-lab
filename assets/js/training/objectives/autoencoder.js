function channelPlan(quality) {
  if (quality === "fast") return [12, 20, 28, 36];
  if (quality === "high") return [32, 48, 72, 96];
  return [16, 24, 32, 48];
}

function reconstructionLoss(tf) {
  return (truth, prediction) =>
    tf.tidy(() => {
      const pixelLoss = tf.mean(tf.abs(tf.sub(truth, prediction)), [1, 2, 3]);
      const truthDx = tf.sub(
        truth.slice([0, 0, 1, 0], [-1, -1, -1, -1]),
        truth.slice([0, 0, 0, 0], [-1, -1, truth.shape[2] - 1, -1]),
      );
      const outputDx = tf.sub(
        prediction.slice([0, 0, 1, 0], [-1, -1, -1, -1]),
        prediction.slice([0, 0, 0, 0], [-1, -1, prediction.shape[2] - 1, -1]),
      );
      const truthDy = tf.sub(
        truth.slice([0, 1, 0, 0], [-1, -1, -1, -1]),
        truth.slice([0, 0, 0, 0], [-1, truth.shape[1] - 1, -1, -1]),
      );
      const outputDy = tf.sub(
        prediction.slice([0, 1, 0, 0], [-1, -1, -1, -1]),
        prediction.slice([0, 0, 0, 0], [-1, prediction.shape[1] - 1, -1, -1]),
      );
      const edgeX = tf.mean(tf.abs(tf.sub(truthDx, outputDx)), [1, 2, 3]);
      const edgeY = tf.mean(tf.abs(tf.sub(truthDy, outputDy)), [1, 2, 3]);
      return pixelLoss.add(edgeX.add(edgeY).mul(0.18));
    });
}

export function buildAutoencoder(
  tf,
  { inputSize = 128, latentDim = 64, quality = "high" } = {},
) {
  const channels = channelPlan(quality);
  const imageInput = tf.input({
    shape: [inputSize, inputSize, 3],
    name: "image",
  });
  let encoded = imageInput;
  channels.forEach((filters, index) => {
    encoded = tf.layers
      .conv2d({
        filters,
        kernelSize: 3,
        strides: 2,
        padding: "same",
        activation: "relu",
        name: `encoder_conv_${index + 1}`,
      })
      .apply(encoded);
  });
  encoded = tf.layers.flatten({ name: "encoder_flatten" }).apply(encoded);
  const latent = tf.layers
    .dense({ units: latentDim, activation: "tanh", name: "latent" })
    .apply(encoded);
  const encoder = tf.model({
    inputs: imageInput,
    outputs: latent,
    name: "latent_field_encoder",
  });

  const latentInput = tf.input({ shape: [latentDim], name: "latent_input" });
  const baseSize = inputSize / 16;
  let decoded = tf.layers
    .dense({
      units: baseSize * baseSize * channels[3],
      activation: "relu",
      name: "decoder_dense",
    })
    .apply(latentInput);
  decoded = tf.layers
    .reshape({
      targetShape: [baseSize, baseSize, channels[3]],
      name: "decoder_reshape",
    })
    .apply(decoded);

  [channels[2], channels[1], channels[0]].forEach((filters, index) => {
    decoded = tf.layers
      .conv2dTranspose({
        filters,
        kernelSize: 3,
        strides: 2,
        padding: "same",
        activation: "relu",
        name: `decoder_up_${index + 1}`,
      })
      .apply(decoded);
  });
  decoded = tf.layers
    .conv2dTranspose({
      filters: 3,
      kernelSize: 3,
      strides: 2,
      padding: "same",
      activation: "sigmoid",
      name: "reconstruction",
    })
    .apply(decoded);

  const decoder = tf.model({
    inputs: latentInput,
    outputs: decoded,
    name: "latent_field_decoder",
  });
  const reconstruction = decoder.apply(encoder.apply(imageInput));
  const trainingModel = tf.model({
    inputs: imageInput,
    outputs: reconstruction,
    name: "latent_field_autoencoder",
  });
  trainingModel.compile({
    optimizer: tf.train.adam(0.001),
    loss: reconstructionLoss(tf),
  });

  return {
    objective: "reconstruct",
    trainingModel,
    encoder,
    decoder,
    makeTargets: (images) => images,
    encode: (images) => encoder.predict(images),
    reconstruct: (images) => decoder.predict(encoder.predict(images)),
  };
}
