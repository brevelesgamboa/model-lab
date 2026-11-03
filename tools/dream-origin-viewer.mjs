import { createOriginRenderer } from "./dream-origin-renderer.mjs";
import {
  OriginSpace,
  ORIGIN_STUDIES,
  originSmooth,
} from "./dream-origin-space.mjs";
import { DomeDreamBaker } from "../assets/js/models/inception-dream-bake.js";

export async function mountOriginStudy() {
  const $ = (id) => document.getElementById(id),
    canvas = $("view"),
    renderer = await createOriginRenderer(canvas),
    space = new OriginSpace(),
    baker = new DomeDreamBaker({ persistent: true });
  const e = {
    renderer,
    space,
    stages: [],
    metrics: [],
    depth: 0,
    automation: false,
    paused: false,
    loading: true,
    warp: null,
    worldImage: null,
    clock: 0,
    sourceId: "demo",
    portalFade: 1,
    fingerprint: "",
    message: "",
    generationRuns: 0,
  };
  window.experiment = e;
  let generation = null,
    epoch = 0,
    disposed = false,
    busy = false,
    previous = performance.now(),
    compare = false,
    drag = null;
  const keys = new Set();
  const sourceIds = ["demo", "photo-1", "photo-2", "photo-3"];
  const image = (src) =>
    new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Could not load study image."));
      im.src = src;
    });
  const copied = (source) => {
    const c = document.createElement("canvas");
    c.width = source.width;
    c.height = source.height;
    c.getContext("2d").drawImage(source, 0, 0);
    return c;
  };
  const digest = async (array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", array))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
  function abort() {
    epoch++;
    generation?.abort();
    generation = null;
    baker.cancel();
    e.warp = null;
    e.message = "";
  }
  function setDepth(value) {
    e.depth = Math.max(0, Math.min(2, value));
    $("depth").value = e.depth;
  }
  async function source(id, file) {
    abort();
    $("source").disabled = true;
    $("upload").disabled = true;
    e.loading = true;
    e.stages = [];
    e.worldImage = null;
    e.metrics = [];
    space.home();
    e.portalFade = 1;
    setDepth(0);
    e.sourceId = id;
    if (sourceIds.includes(id)) $("source").value = id;
    e.message = "Loading the original dome";
    try {
      const decoded = file
        ? await createImageBitmap(file)
        : id === "demo"
          ? null
          : await image(`/origin/source-${id}.png`);
      const seed = await renderer.source(decoded, {
        name: file?.name || id,
        features: true,
      });
      decoded?.close?.();
      e.stages = [copied(seed)];
      e.fingerprint = await digest(
        e.stages[0].getContext("2d").getImageData(0, 0, 1024, 512).data,
      );
      if (sourceIds.includes(id)) {
        const manifest = await (await fetch("/origin/manifest.json")).json(),
          cached = manifest.studies[id];
        if (
          cached?.version === "origin-study-v1" &&
          cached.fingerprint === e.fingerprint
        ) {
          const images = await Promise.all(
            ["light", "deep"].map((stage) =>
              image(`/origin/studies/${id}/${stage}.png`),
            ),
          );
          e.stages.push(...images);
          e.metrics = cached.metrics;
        }
      }
      await comparisons();
      e.message =
        e.stages.length === 3
          ? "Original renderer · saved model studies ready"
          : "Original renderer ready · generate Light and Deep to compare";
    } catch (error) {
      e.message = error.message;
      throw error;
    } finally {
      e.loading = false;
      $("source").disabled = false;
      $("upload").disabled = false;
    }
  }
  async function bake(input, pass, signal) {
    const result = await baker.bake(
      input,
      pass.layer,
      pass.channel,
      pass.iterations,
      {
        signal,
        photoRect: null,
        colorRetention: 1,
        stepSize: pass.stepSize,
        preserveDetail: true,
        onProgress: (percent) => {
          e.message = `Generating ${pass.layer} · ${Math.round(percent)}%`;
        },
      },
    );
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const c = document.createElement("canvas");
    c.width = result.width;
    c.height = result.height;
    const rgba = new Uint8ClampedArray(result.rgba);
    c.getContext("2d").putImageData(
      new ImageData(rgba, result.width, result.height),
      0,
      0,
    );
    const before = document.createElement("canvas");
    before.width = c.width;
    before.height = c.height;
    before.getContext("2d").drawImage(input, 0, 0, c.width, c.height);
    const original = before
      .getContext("2d")
      .getImageData(0, 0, c.width, c.height).data;
    let delta = 0;
    for (let i = 0; i < rgba.length; i++)
      if (i % 4 !== 3) delta += Math.abs(rgba[i] - original[i]);
    e.generationRuns++;
    return {
      canvas: c,
      metrics: {
        ...pass,
        width: c.width,
        height: c.height,
        bakeMs: result.bakeMs,
        scoreStart: result.scoreStart,
        scoreEnd: result.scoreEnd,
        meanChangedByte: delta / (c.width * c.height * 3),
        retainedTensors: result.retainedTensors,
        backend: result.backend,
      },
    };
  }
  async function generateStudies() {
    if (e.loading || generation) return;
    const job = new AbortController(),
      ticket = epoch;
    generation = job;
    e.message = "Preparing stronger model studies";
    try {
      const next = [e.stages[0]],
        metrics = [];
      for (const study of ORIGIN_STUDIES.slice(1)) {
        let input = next.at(-1);
        const passes = [];
        for (const pass of study.passes) {
          const result = await bake(input, pass, job.signal);
          input = result.canvas;
          passes.push(result.metrics);
        }
        if (ticket !== epoch || job.signal.aborted) return;
        next.push(input);
        metrics.push({ name: study.name, passes });
      }
      e.stages = next;
      e.metrics = metrics;
      e.worldImage = null;
      await comparisons();
      e.message =
        "Light and Deep generated from the source · original dome controls preserved";
    } catch (error) {
      if (error.name !== "AbortError") {
        e.message = `Generation paused: ${error.message}`;
        throw error;
      }
    } finally {
      if (generation === job) generation = null;
    }
  }
  async function comparisons() {
    const reference = document.createElement("canvas");
    reference.width = canvas.width;
    reference.height = canvas.height;
    const oldDigital = renderer.settings.digital,
      oldFull = renderer.settings.fullHex;
    renderer.settings.digital = false;
    renderer.settings.fullHex = false;
    try {
      for (let i = 0; i < 3; i++) {
        const target = $("reference-" + i),
          ctx = target.getContext("2d");
        ctx.clearRect(0, 0, target.width, target.height);
        if (!e.stages[i]) continue;
        await renderer.draw({
          base: e.stages[i],
          depth: 0,
          time: 3.25,
          target: reference,
        });
        ctx.drawImage(reference, 0, 0, target.width, target.height);
      }
    } finally {
      renderer.settings.digital = oldDigital;
      renderer.settings.fullHex = oldFull;
    }
  }
  function frameImages() {
    if (e.warp?.phase === "blend")
      return {
        base: e.warp.base,
        next: e.warp.next,
        mix: originSmooth(e.warp.elapsed / 1.3),
      };
    if (e.worldImage) return { base: e.worldImage, next: e.worldImage, mix: 0 };
    const a = Math.floor(e.depth),
      b = Math.min(2, a + 1);
    return {
      base: e.stages[a] || e.stages[0],
      next: e.stages[b] || e.stages[0],
      mix: e.depth - a,
    };
  }
  function visibleDepth() {
    return e.warp?.phase === "blend"
      ? e.warp.fromDepth +
          (e.depth - e.warp.fromDepth) * originSmooth(e.warp.elapsed / 1.3)
      : e.depth;
  }
  function snapshotImage(current) {
    if (current.mix === 0 || current.base === current.next) return current.base;
    const canvas = copied(current.base),
      ctx = canvas.getContext("2d");
    ctx.globalAlpha = current.mix;
    ctx.drawImage(current.next, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  async function draw() {
    if (!e.stages[0]) return;
    const current = compare
      ? { base: e.stages[0], next: e.stages[0], mix: 0 }
      : frameImages();
    const pose = compare
      ? { ...space, enabled: false, parallax: space.parallax }
      : space;
    await renderer.draw({
      ...current,
      space: pose,
      depth: compare ? 0 : visibleDepth(),
      original: compare,
      portalPresence:
        e.warp?.phase === "blend"
          ? 1 - originSmooth(e.warp.elapsed)
          : e.portalFade,
      time: e.clock,
      warp: e.warp
        ? e.warp.phase === "blend"
          ? 1 - originSmooth(e.warp.elapsed / 1.3)
          : 0.8
        : 0,
    });
    $("readout").textContent =
      `${ORIGIN_STUDIES[Math.round(e.depth)].name} · ${space.enabled ? `free position ${space.position.map((n) => n.toFixed(1)).join(", ")}` : "original dome view"} · ${renderer.model.depthMap.kind === "estimated" ? "estimated depth" : "brightness relief"}`;
    $("status").textContent = e.message;
    $("fold").disabled =
      !space.enabled ||
      !renderer.settings.portal ||
      !space.nearPortal ||
      !!e.warp ||
      e.loading ||
      !!generation;
    $("fold-note").textContent = e.warp
      ? "The fold is preparing the next image. Look around, or press Escape to cancel."
      : space.enabled && renderer.settings.portal && space.nearPortal
        ? "Press E to step into the fold. You can also walk around it."
        : space.enabled
          ? "The optional fold is ahead of the entrance. Wander in any direction."
          : "Enable exploration to unfold the floor and optional passage.";
    $("generate").disabled = e.loading || !!generation || !!e.warp;
    $("generate").textContent =
      e.stages.length === 3
        ? "Regenerate Light + Deep"
        : "Generate Light + Deep";
    $("cancel").hidden = !generation && !e.warp;
    for (const button of document.querySelectorAll("[data-depth]"))
      button.disabled =
        e.loading ||
        !!e.warp ||
        (Number(button.dataset.depth) > 0 && e.stages.length < 3);
    $("depth").disabled = e.stages.length < 3 || !!e.warp;
  }
  async function enterFold() {
    if (
      !space.enabled ||
      !renderer.settings.portal ||
      !space.nearPortal ||
      generation ||
      e.warp
    )
      return false;
    const job = new AbortController(),
      ticket = epoch;
    generation = job;
    const current = frameImages();
    const base = snapshotImage(current),
      fromDepth = visibleDepth();
    e.warp = { phase: "preparing", base, next: null, elapsed: 0, fromDepth };
    try {
      const nextDepth = Math.min(
        2,
        Math.floor(Math.max(e.depth, space.frontier)) + 1,
      );
      let next = e.stages[nextDepth];
      if (!next || space.frontier >= 2) {
        const input = e.worldImage || e.stages[2] || e.stages[0];
        const result = await bake(
          input,
          {
            layer: "mixed_6c",
            channel: 144 + (space.frontier % 7),
            iterations: 18,
            stepSize: 0.03,
          },
          job.signal,
        );
        next = result.canvas;
      }
      if (job.signal.aborted || ticket !== epoch) return false;
      e.warp = { phase: "blend", base, next, elapsed: 0, fromDepth };
      setDepth(nextDepth);
      e.message = "Passing through the image fold";
      return true;
    } catch (error) {
      if (error.name !== "AbortError")
        e.message = `Fold paused: ${error.message}`;
      e.warp = null;
      return false;
    } finally {
      if (generation === job) generation = null;
    }
  }
  function advance(seconds, forward = 0, right = 0) {
    const dt = Math.max(0, Math.min(0.1, seconds));
    if (e.warp?.phase === "blend") {
      e.warp.elapsed += dt;
      if (e.warp.elapsed >= 1.3) {
        e.worldImage = e.warp.next;
        e.warp = null;
        space.completeFold();
        e.portalFade = 0;
        e.message = "A new image space · free movement continues";
      }
    } else if (!e.warp) space.move(forward, right, dt);
    e.portalFade = Math.min(1, e.portalFade + dt);
    if (!e.paused) e.clock += dt;
  }
  e.draw = draw;
  e.source = source;
  e.generateStudies = generateStudies;
  e.enterFold = enterFold;
  e.advance = advance;
  e.comparisons = comparisons;
  e.setDepth = setDepth;
  e.cancel = () => {
    if (e.warp) {
      if (e.warp.phase === "blend")
        e.portalFade = 1 - originSmooth(e.warp.elapsed);
      e.worldImage = snapshotImage(frameImages());
      setDepth(visibleDepth());
    }
    abort();
    e.message = "Cancelled · current image preserved";
  };
  e.home = () => {
    abort();
    space.home();
    e.portalFade = 1;
    e.worldImage = null;
    setDepth(0);
    keys.clear();
    e.message = "Back to the original image";
  };
  $("source").onchange = () => {
    busy = true;
    source($("source").value)
      .catch(console.error)
      .finally(() => {
        busy = false;
      });
  };
  $("upload").onchange = () => {
    const file = $("upload").files[0];
    if (file) {
      busy = true;
      source("custom", file)
        .catch(console.error)
        .finally(() => {
          busy = false;
        });
    }
  };
  $("generate").onclick = () => generateStudies().catch(console.error);
  $("cancel").onclick = e.cancel;
  $("home").onclick = e.home;
  $("fold").onclick = () => void enterFold();
  $("explore").onchange = () => {
    space.enabled = $("explore").checked;
    if (!space.enabled) e.cancel();
  };
  $("depth").oninput = () => {
    e.worldImage = null;
    setDepth(Number($("depth").value));
  };
  for (const button of document.querySelectorAll("[data-depth]"))
    button.onclick = () => {
      e.worldImage = null;
      setDepth(Number(button.dataset.depth));
    };
  for (const [id, key] of [
    ["floor", "floor"],
    ["negative", "negative"],
  ])
    $(id).oninput = () => {
      renderer.settings[key] = Number($(id).value);
    };
  $("digital").onchange = () => {
    renderer.settings.digital = $("digital").checked;
  };
  $("hex").onchange = () => {
    renderer.settings.fullHex = $("hex").checked;
  };
  $("portal").onchange = () => {
    renderer.settings.portal = $("portal").checked;
  };
  $("pause").onclick = () => {
    e.paused = !e.paused;
    $("pause").textContent = e.paused ? "Resume waves" : "Pause waves";
  };
  $("hold").onpointerdown = (event) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    compare = true;
  };
  $("hold").onpointerup = $("hold").onpointercancel = () => {
    compare = false;
  };
  for (const key of [
    "gain",
    "depthScale",
    "neuralSwell",
    "edgeCoupling",
    "chromaticDispersion",
  ]) {
    $(key).value = renderer.params[key];
    $(key).oninput = () => {
      renderer.params[key] = Number($(key).value);
    };
  }
  $("waveMode").value = renderer.params.waveMode;
  $("waveMode").onchange = () => {
    renderer.params.waveMode = Number($("waveMode").value);
  };
  $("reset-controls").onclick = () => {
    for (const c of renderer.model.controls) renderer.params[c.key] = c.default;
    for (const key of [
      "gain",
      "depthScale",
      "neuralSwell",
      "edgeCoupling",
      "chromaticDispersion",
      "waveMode",
    ])
      $(key).value = renderer.params[key];
  };
  $("depth-map").onclick = async () => {
    e.message = "Estimating depth with the app’s optional depth model";
    await renderer.model.buildMaps({ depth: true, feature: false });
    e.message = renderer.model.depthStatus;
  };
  canvas.onpointerdown = (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    drag = [event.clientX, event.clientY];
  };
  canvas.onpointermove = (event) => {
    if (!drag) return;
    space.yaw -= (event.clientX - drag[0]) * 0.005;
    space.pitch = Math.max(
      -1.35,
      Math.min(1.35, space.pitch + (event.clientY - drag[1]) * 0.005),
    );
    drag = [event.clientX, event.clientY];
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    drag = null;
  };
  window.addEventListener("keydown", (event) => {
    const focused = document.activeElement;
    if (
      ["SELECT", "TEXTAREA"].includes(focused?.tagName) ||
      (focused?.tagName === "INPUT" &&
        !["checkbox", "radio"].includes(focused.type))
    )
      return;
    if (
      [
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "KeyE",
        "KeyB",
        "Escape",
      ].includes(event.code)
    ) {
      event.preventDefault();
      keys.add(event.code);
      if (event.code === "KeyB") compare = true;
      if (event.code === "KeyE" && !event.repeat) void enterFold();
      if (event.code === "Escape") e.cancel();
    }
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
    if (event.code === "KeyB") compare = false;
  });
  window.addEventListener("blur", () => {
    keys.clear();
    compare = false;
  });
  for (const [id, key] of [
    ["forward", "KeyW"],
    ["back", "KeyS"],
    ["left", "KeyA"],
    ["right", "KeyD"],
  ]) {
    const b = $(id);
    b.onpointerdown = (event) => {
      event.preventDefault();
      b.setPointerCapture(event.pointerId);
      keys.add(key);
    };
    b.onpointerup = b.onpointercancel = () => keys.delete(key);
  }
  e.dispose = () => {
    disposed = true;
    abort();
    baker.dispose();
    renderer.dispose();
  };
  window.addEventListener("pagehide", e.dispose, { once: true });
  await source("demo");
  e.loading = false;
  window.experimentReady = true;
  async function loop(now) {
    if (disposed) return;
    const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
    previous = now;
    try {
      if (!e.automation && !document.hidden && !busy && !e.loading) {
        advance(
          dt,
          (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
            (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0),
          (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
            (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0),
        );
        await draw();
      }
    } catch (error) {
      e.message = error.message;
      console.error(error);
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
mountOriginStudy().catch((error) => {
  document.getElementById("status").textContent = error.message;
  console.error(error);
});
