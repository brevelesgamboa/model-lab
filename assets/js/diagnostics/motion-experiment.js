// Opt-in research harness. Nothing here is imported by the normal app.
import { TextureNcaRuntime } from "../models/neural-growth/runtime.js";
import { validateCheckpoint } from "../models/neural-growth/reference.js";
import { InceptionDreamModel } from "../models/inception-dream.js";
import {
  InceptionMotionController,
  motionFeatureScore,
  motionImage,
  warpWithMotion,
} from "../models/neural-growth/inception-motion.js";
import {
  constrainMotionField,
  motionFieldStats,
} from "../models/neural-growth/motion-field.js";

export const MOTION_TARGETS = [
  { layer: "Conv2d_4a_3x3", channel: 0 },
  { layer: "Conv2d_4a_3x3", channel: 47 },
  { layer: "mixed_5b", channel: 120 },
  { layer: "mixed_5b", channel: 200 },
];

export async function initializeExperiment() {
  const owner = new InceptionDreamModel();
  await owner.ensureModel();
  const checkpoints = Object.fromEntries(
    await Promise.all(
      ["membrane-field", "xeno-reef"].map(async (id) => [
        id,
        validateCheckpoint(
          await (
            await fetch(`/models/neural-growth/organic-structures/${id}.json`)
          ).json(),
        ),
      ]),
    ),
  );
  const probe = new TextureNcaRuntime({
    model: checkpoints["membrane-field"],
    size: 256,
    seed: 17,
  });
  const ext = probe.gl.getExtension("WEBGL_debug_renderer_info");
  const environment = {
    renderer: probe.gl.getParameter(
      ext?.UNMASKED_RENDERER_WEBGL || probe.gl.RENDERER,
    ),
    backend: globalThis.tf.getBackend(),
    userAgent: navigator.userAgent,
  };
  probe.dispose();
  return { owner, checkpoints, environment };
}

export function phenotypeStats(runtime) {
  const bytes = runtime.readPhenotypeRgb(runtime.size, runtime.size);
  const n = runtime.size,
    means = [0, 0, 0],
    squares = [0, 0, 0];
  let high = 0,
    clipping = 0;
  const value = (x, y, c) =>
    Math.max(
      0,
      Math.min(
        1,
        ((bytes[(((y + n) % n) * n + ((x + n) % n)) * 4 + c] - 127) * 2) / 255 +
          0.5,
      ),
    );
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      for (let c = 0; c < 3; c++) {
        const v = value(x, y, c);
        means[c] += v;
        squares[c] += v * v;
        clipping += v === 0 || v === 1 ? 1 : 0;
        high +=
          (v -
            (value(x - 1, y, c) +
              value(x + 1, y, c) +
              value(x, y - 1, c) +
              value(x, y + 1, c)) /
              4) **
          2;
      }
  const std = Math.sqrt(
    means.reduce(
      (sum, m, c) =>
        sum + Math.max(0, squares[c] / (n * n) - (m / (n * n)) ** 2),
      0,
    ) / 3,
  );
  return {
    rgbStd: std,
    roughness: Math.sqrt(high / (n * n * 3)) / (std || 1),
    clippedFraction: clipping / (n * n * 3),
  };
}

export function scoreTargets(environment, bytes, size) {
  const tf = globalThis.tf;
  return tf.tidy(() => {
    const image = motionImage(tf, bytes, size, size);
    return MOTION_TARGETS.map(({ layer, channel }) => ({
      layer,
      channel,
      score: motionFeatureScore(
        tf,
        environment.owner.model,
        image,
        layer,
        channel,
      ).dataSync()[0],
    }));
  });
}

export function createCase(environment, config) {
  const {
    pattern,
    seed = 17,
    size = 256,
    condition = "A",
    layer = "Conv2d_4a_3x3",
    channel = 0,
    vortexSpeed = 0.05,
  } = config;
  const runtime = new TextureNcaRuntime({
    model: environment.checkpoints[pattern],
    size,
    seed,
  });
  runtime.step(128);
  runtime.step(128);
  const controller =
    condition === "C"
      ? new InceptionMotionController({
          getInceptionModel: () => environment.owner,
          onReset: () => runtime.clearMotionField(),
          layer,
          channel,
        })
      : null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const updates = [];
  let active = 0,
    disposed = false,
    pending = null;
  const upload = (result) => {
    if (result && !disposed) {
      runtime.setMotionField(result.field);
      const { field: _field, ...stats } = result;
      updates.push({ activeStep: active, ...stats });
    }
  };
  function dispatch() {
    if (!controller || controller.busy || disposed) return null;
    const request = controller.update(
      runtime.readPhenotypeRgb(size, size),
      size,
      size,
      { stateSize: size },
    );
    pending = request.then(upload).finally(() => {
      pending = null;
    });
    return pending;
  }
  const api = {
    runtime,
    controller,
    updates,
    canvas,
    config,
    get activeStep() {
      return active;
    },
    step() {
      runtime.step(1, { dreamStrength: 0 });
      if (condition === "B")
        runtime.advect({ field: "vortex", speed: vortexSpeed });
      if (condition === "C") runtime.advect({ field: "learned" });
      active++;
    },
    async advance(count, synchronized = true) {
      for (let i = 0; i < count; i++) {
        api.step();
        if (active % 16 === 0 && controller && !controller.busy) {
          const inference = dispatch();
          if (synchronized) await inference;
        }
      }
    },
    async settle() {
      if (pending) await pending;
    },
    capture(label, images = true) {
      runtime.draw(canvas, { palette: "native", displayFilter: "smooth" });
      return {
        label,
        activeStep: active,
        state: phenotypeStats(runtime),
        scores: scoreTargets(
          environment,
          runtime.readPhenotypeRgb(size, size),
          size,
        ),
        field: controller ? Array.from(controller.field) : null,
        velocity: controller
          ? motionFieldStats(controller.field)
          : {
              rmsSpeed: condition === "B" ? vortexSpeed / Math.SQRT2 : 0,
              maxSpeed: condition === "B" ? vortexSpeed : 0,
            },
        image: images ? canvas.toDataURL("image/png") : null,
      };
    },
    damage() {
      const state = runtime.readState();
      const center = [Math.round(size * 0.36), Math.round(size * 0.37)];
      const radius = Math.round(size * 0.07);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (Math.hypot(x - center[0], y - center[1]) <= radius)
            state.fill(127, (y * size + x) * 12, (y * size + x + 1) * 12);
      runtime.writeState(state);
    },
    async dispose() {
      disposed = true;
      controller?.dispose();
      if (pending) await pending;
      runtime.dispose();
    },
  };
  return api;
}

export async function runCase(
  environment,
  config,
  { steps = 1024, recovery = 256 } = {},
) {
  const instance = createCase(environment, config);
  const baselineTensors = globalThis.tf.memory().numTensors;
  const frames = [];
  try {
    frames.push(instance.capture("Start", config.seed === 17));
    let previous = 0;
    for (const stage of [128, 512, steps].filter(
      (v, i, a) => v <= steps && a.indexOf(v) === i,
    )) {
      await instance.advance(stage - previous);
      previous = stage;
      frames.push(instance.capture(`Flow +${stage}`, config.seed === 17));
    }
    instance.damage();
    frames.push(instance.capture("Damage", config.seed === 17));
    let previousRecovery = 0;
    for (const stage of [32, 64, 128, recovery].filter(
      (v, i, a) => v <= recovery && a.indexOf(v) === i,
    )) {
      await instance.advance(stage - previousRecovery);
      previousRecovery = stage;
      frames.push(instance.capture(`Recovery +${stage}`, config.seed === 17));
    }
    return {
      ...config,
      steps,
      recovery,
      frames,
      updates: instance.updates,
      glError: instance.runtime.gl.getError(),
      retainedTensors: globalThis.tf.memory().numTensors - baselineTensors,
    };
  } finally {
    await instance.dispose();
  }
}

export async function profileCase(
  environment,
  config,
  { warmup = 512, durationMs = 8000 } = {},
) {
  const instance = createCase(environment, config);
  try {
    await instance.advance(warmup);
    const firstStep = instance.activeStep,
      firstInference = instance.updates.length;
    let frames = 0,
      accumulated = 0,
      last = performance.now();
    const start = last,
      intervals = [];
    await new Promise((resolve) => {
      const tick = async (now) => {
        intervals.push(now - last);
        accumulated += Math.min(100, Math.max(0, now - last));
        last = now;
        const count = Math.min(3, Math.floor((accumulated * 30) / 1000));
        accumulated -= (count * 1000) / 30;
        await instance.advance(count, false);
        instance.runtime.draw(instance.canvas);
        frames++;
        if (now - start < durationMs) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = performance.now() - start;
    const totalSteps = instance.activeStep - firstStep;
    await instance.settle();
    return {
      ...config,
      elapsedMs,
      frames,
      fps: (frames * 1000) / elapsedMs,
      updatesPerSecond: (totalSteps * 1000) / elapsedMs,
      frameIntervals: intervals,
      inferences: instance.updates.slice(firstInference),
      glError: instance.runtime.gl.getError(),
    };
  } finally {
    await instance.dispose();
  }
}

export async function frozenFieldAudit(environment, pattern) {
  const runtime = new TextureNcaRuntime({
    model: environment.checkpoints[pattern],
    size: 256,
    seed: 17,
  });
  runtime.step(128);
  runtime.step(128);
  const snapshot = runtime.readState(),
    bytes = runtime.readPhenotypeRgb(256, 256);
  const before = scoreTargets(environment, bytes, 256);
  const records = [];
  try {
    for (const target of MOTION_TARGETS) {
      const derivative = auditDisplacementGradient(environment, bytes, target);
      const controller = new InceptionMotionController({
        getInceptionModel: () => environment.owner,
        ...target,
      });
      const history = [];
      for (let i = 0; i < 48; i++) {
        const { field: _field, ...stats } = await controller.update(bytes, 256, 256);
        history.push(stats);
      }
      runtime.writeState(snapshot);
      runtime.setMotionField(controller.field);
      for (let i = 0; i < 16; i++) runtime.advect({ field: "learned" });
      const actual = scoreTargets(
        environment,
        runtime.readPhenotypeRgb(256, 256),
        256,
      ).find(
        (v) => v.layer === target.layer && v.channel === target.channel,
      ).score;
      records.push({
        pattern,
        ...target,
        before: before.find(
          (v) => v.layer === target.layer && v.channel === target.channel,
        ).score,
        actualQuantizedWarpScore: actual,
        derivative,
        history,
        field: Array.from(controller.field),
      });
      controller.dispose();
    }
    return records;
  } finally {
    runtime.dispose();
  }
}

// Check the complete real-network derivative away from interpolation knots.
// At zero, also measure both directions: interpolation can reduce a texture's
// activation on either side of a knot, even with a nonzero central subgradient.
function auditDisplacementGradient(environment, bytes, { layer, channel }) {
  const tf = globalThis.tf;
  return tf.tidy(() => {
    const image = motionImage(tf, bytes, 256, 256);
    const loss = (field) =>
      motionFeatureScore(
        tf,
        environment.owner.model,
        warpWithMotion(tf, image, field, { stateSize: 256, horizon: 16 }),
        layer,
        channel,
      );
    const values = constrainMotionField(
      Float32Array.from(
        { length: 512 },
        (_, i) => Math.sin(i * 0.31) * 0.03 + Math.cos(i * 0.17) * 0.02,
      ),
    );
    const check = (field) => {
      const parameters = tf.tensor4d(field, [1, 16, 16, 2]);
      const gradient = tf.grad(loss)(parameters).dataSync();
      const direction = constrainMotionField(gradient);
      const norm = Math.hypot(...direction);
      for (let i = 0; i < direction.length; i++) direction[i] /= norm || 1;
      const analytic = gradient.reduce(
        (sum, value, i) => sum + value * direction[i],
        0,
      );
      const epsilon = 0.0003;
      const evaluate = (sign) =>
        loss(
          tf.tensor4d(
            Float32Array.from(
              field,
              (value, i) => value + sign * epsilon * direction[i],
            ),
            [1, 16, 16, 2],
          ),
        ).dataSync()[0];
      const plus = evaluate(1),
        minus = evaluate(-1);
      return {
        analytic,
        epsilon,
        plus,
        minus,
        numeric: (plus - minus) / (2 * epsilon),
        center: loss(parameters).dataSync()[0],
      };
    };
    return {
      nonzeroField: check(values),
      zeroField: check(new Float32Array(512)),
    };
  });
}

export async function recordComparison(
  environment,
  { pattern, layer, channel },
  { warmup = 512, updates = 240 } = {},
) {
  const cases = ["A", "B", "C"].map((condition) =>
    createCase(environment, {
      pattern,
      condition,
      layer,
      channel,
      seed: 17,
      size: 256,
    }),
  );
  try {
    for (const instance of cases) await instance.advance(warmup);
    document.head.querySelectorAll("style").forEach((style) => style.remove());
    document.body.innerHTML = `<style>body{margin:24px;background:#101218;color:#e4e8ed;font:16px system-ui}main{display:flex;gap:16px}figure{margin:0}canvas{width:310px;height:310px}figcaption{margin-top:8px}p{line-height:1.5}</style><h1>${pattern} · ${layer}:${channel}</h1><p>Matched seed 17 · all 12 channels · maximum neural speed 0.05 cells/update</p><main>${["A · Ordinary NCA", "B · Gentle vortex", "C · Inception motion"].map((label, i) => `<figure><canvas id="motion-${i}" width="310" height="310"></canvas><figcaption>${label}</figcaption></figure>`).join("")}</main><p id="motion-time"></p><p>Shared playback; performance measured separately for each condition.<br>A circular wound is applied to all three fields after 120 playback updates.</p>`;
    let steps = 0,
      accumulated = 0,
      last = performance.now();
    const start = last;
    await new Promise((resolve) => {
      const tick = async (now) => {
        accumulated += Math.min(100, Math.max(0, now - last));
        last = now;
        const count = Math.min(
          3,
          updates - steps,
          Math.floor((accumulated * 30) / 1000),
        );
        accumulated -= (count * 1000) / 30;
        for (let i = 0; i < count; i++) {
          for (const instance of cases) await instance.advance(1, false);
          steps++;
          if (steps === 120) for (const instance of cases) instance.damage();
        }
        cases.forEach((instance, i) =>
          instance.runtime.draw(document.getElementById(`motion-${i}`)),
        );
        document.getElementById("motion-time").textContent =
          `Playback update ${steps}/${updates}${steps >= 120 ? ` · recovery +${steps - 120}` : ""}`;
        if (steps < updates) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const elapsedMs = performance.now() - start;
    for (const instance of cases) await instance.settle();
    return {
      pattern,
      layer,
      channel,
      elapsedMs,
      updates: steps,
      glErrors: cases.map((instance) => instance.runtime.gl.getError()),
      final: cases.map((instance) => instance.capture("Video end", false)),
    };
  } finally {
    for (const instance of cases) await instance.dispose();
  }
}
