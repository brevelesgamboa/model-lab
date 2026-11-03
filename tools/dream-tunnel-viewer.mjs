import {
  DreamTunnelJourney,
  TUNNEL_LEVELS,
  tunnelSite,
} from "./dream-tunnel-route.mjs";
import {
  createDreamTunnelRenderer,
  TUNNEL_STYLES,
} from "./dream-tunnel-renderer.mjs";

export async function mountDreamTunnelViewer(data) {
  const $ = (id) => document.getElementById(id),
    canvas = $("view");
  const renderer = createDreamTunnelRenderer(canvas),
    cache = new Map();
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () =>
        reject(new Error("Could not load saved model imagery."));
      image.src = src;
    });
  const stages = await Promise.all(
    data.stages.map(async (s) => ({
      natural: await loadImage(s.natural),
      neon: await loadImage(s.neon),
    })),
  );
  $("photo").value = String(data.photo);
  const isHTTP =
    location.protocol === "http:" || location.protocol === "https:";
  $("live").checked = isHTTP;
  $("live").disabled = !isHTTP;
  $("source-note").textContent = isHTTP
    ? "New image variations are generated locally between places. No upload."
    : "Saved model imagery. Run the local experiment server to enable live generation.";
  let baker = null,
    generatorModules = null,
    progress = "",
    revision = 0,
    generated = 0,
    lastMetrics = null,
    disposed = false;
  const stageFor = (index) =>
    stages[Math.min(6, Math.max(0, Math.floor(index * 0.6)))];
  const imagesFor = (index) => cache.get(index) || stageFor(index);
  const abortError = () =>
    new DOMException("Preparation cancelled.", "AbortError");
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const done = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(done, ms);
      function abort() {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(abortError());
      }
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async function prepare({ index, seed, profile, signal }) {
    if (cache.has(index)) return cache.get(index);
    if (Number($("delay").value) > 0) {
      progress = "Waiting at the loading threshold";
      await delay(Number($("delay").value) * 1000, signal);
    }
    if (!$("live").checked) return null;
    progress = "Loading the local image model";
    generatorModules ??= Promise.all([
      import("/assets/js/models/inception-dream-bake.js"),
      import("/tunnel/progression.mjs"),
    ]);
    const [{ DomeDreamBaker }, { neonPanoramaPixels }] = await generatorModules;
    if (signal.aborted) throw abortError();
    baker ??= new DomeDreamBaker({ persistent: true });
    const input = document.createElement("canvas");
    input.width = 512;
    input.height = 256;
    const ctx = input.getContext("2d");
    ctx.drawImage(stageFor(index).natural, 0, 0, 512, 256);
    const reference = new Uint8ClampedArray(
      ctx.getImageData(0, 0, 512, 256).data,
    );
    const h = data.head,
      photoRect = {
        x: h.x * 0.5,
        y: h.y * 0.5,
        width: h.width * 0.5,
        height: h.height * 0.5,
        feather: Math.max(2, h.feather * 0.5),
      };
    const organic = index > 5 && seed % 3 !== 0,
      layer = organic ? "mixed_6c" : "mixed_6a",
      channel = (organic ? 144 : 42) + (seed % 9);
    const iterations = 2 + Math.min(4, Math.floor(profile.model * 0.7));
    const result = await baker.bake(input, layer, channel, iterations, {
      signal,
      photoRect,
      colorRetention: 1,
      stepSize: 0.008,
      preserveDetail: true,
      onProgress: (percent, message) => {
        progress = `${message || "Generating the next image"} · ${Math.round(percent)}%`;
      },
    });
    if (signal.aborted) throw abortError();
    const natural = document.createElement("canvas");
    natural.width = result.width;
    natural.height = result.height;
    natural
      .getContext("2d")
      .putImageData(
        new ImageData(
          new Uint8ClampedArray(result.rgba),
          result.width,
          result.height,
        ),
        0,
        0,
      );
    const neon = document.createElement("canvas");
    neon.width = result.width;
    neon.height = result.height;
    const display = neonPanoramaPixels(
      new Uint8ClampedArray(result.rgba),
      reference,
      result.width,
      result.height,
      { strength: 0.8, photoRect, saturation: 2.1 },
    );
    neon
      .getContext("2d")
      .putImageData(new ImageData(display, result.width, result.height), 0, 0);
    generated++;
    let changed = 0;
    for (let i = 0; i < reference.length; i += 4)
      for (let c = 0; c < 3; c++)
        changed += Math.abs(result.rgba[i + c] - reference[i + c]);
    lastMetrics = {
      index,
      layer,
      channel,
      iterations,
      width: result.width,
      height: result.height,
      retainedTensors: result.retainedTensors,
      backend: result.backend,
      bakeMs: result.bakeMs,
      scoreStart: result.scoreStart,
      scoreEnd: result.scoreEnd,
      meanChangedByte: changed / (result.width * result.height * 3),
    };
    return { natural, neon, revision: ++revision };
  }
  const journey = new DreamTunnelJourney({
    prepare,
    onReady(index, result) {
      if (result) {
        cache.set(index, result);
        while (cache.size > 6) cache.delete(cache.keys().next().value);
      }
      progress = "";
    },
  });
  const e = {
    renderer,
    journey,
    automation: false,
    auto: false,
    stages,
    cache,
    data,
    get generated() {
      return generated;
    },
    get lastMetrics() {
      return lastMetrics;
    },
    get progress() {
      return progress;
    },
  };
  window.experiment = e;
  let previous = performance.now(),
    clock = 0,
    drag = null,
    mapNode = -1;
  const keys = new Set();
  function bindRange(id, key) {
    $(id).addEventListener("input", () => {
      renderer.settings[key] = Number($(id).value);
    });
  }
  bindRange("walls", "opacity");
  bindRange("floor", "inversion");
  bindRange("corruption", "corruption");
  $("speed").addEventListener("input", () => {
    journey.speed = Number($("speed").value);
  });
  $("arch").innerHTML =
    '<option value="-1">All six · follow the route</option>' +
    TUNNEL_STYLES.map((s, i) => `<option value="${i}">${s}</option>`).join("");
  $("arch").onchange = () => {
    renderer.settings.archStyle = Number($("arch").value);
  };
  $("depth").innerHTML = TUNNEL_LEVELS.map(
    (s, i) => `<option value="${i}">${i + 1} · ${s.name}</option>`,
  ).join("");
  e.seek = (parameter) => {
    journey.seek(parameter);
    renderer.settings.yaw = 0;
    renderer.settings.pitch = 0;
    draw();
  };
  $("depth").onchange = () =>
    e.seek(TUNNEL_LEVELS[Number($("depth").value)].start);
  function setAuto(value) {
    e.auto = value;
    $("walk").textContent = value ? "Pause walk" : "Auto walk";
    $("walk").setAttribute("aria-pressed", String(value));
  }
  $("walk").onclick = () => setAuto(!e.auto);
  $("home").onclick = () => {
    journey.home();
    baker?.dispose();
    baker = null;
    cache.clear();
    setAuto(false);
    keys.clear();
    clock = 0;
    renderer.settings.yaw = 0;
    renderer.settings.pitch = 0;
    draw();
  };
  $("live").onchange = () => {
    journey.cancel();
    journey.prepared = -1;
    baker?.dispose();
    baker = null;
    journey.request(Math.floor(journey.parameter) + 1);
  };
  $("retry").onclick = () => journey.request(Math.floor(journey.parameter) + 1);
  $("cached").onclick = () => {
    $("live").checked = false;
    $("delay").value = "0";
    journey.cancel();
    journey.prepared = -1;
    baker?.dispose();
    baker = null;
    journey.request(Math.floor(journey.parameter) + 1);
  };
  $("photo").onchange = () => {
    location.href =
      Number($("photo").value) === 3
        ? "index.html"
        : `photo-${$("photo").value}.html`;
  };
  $("map-toggle").onchange = () => {
    $("map").hidden = !$("map-toggle").checked;
  };
  window.addEventListener("keydown", (event) => {
    if (["INPUT", "SELECT", "BUTTON"].includes(document.activeElement?.tagName))
      return;
    if (
      [
        "KeyW",
        "KeyS",
        "KeyA",
        "KeyD",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Space",
      ].includes(event.code)
    ) {
      event.preventDefault();
      keys.add(event.code);
      if (event.code === "Space") setAuto(!e.auto);
    }
  });
  window.addEventListener("keyup", (event) => keys.delete(event.code));
  window.addEventListener("blur", () => keys.clear());
  document.addEventListener("visibilitychange", () => {
    previous = performance.now();
    if (document.hidden) {
      keys.clear();
      setAuto(false);
    }
  });
  canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    drag = [event.clientX, event.clientY];
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    renderer.settings.yaw -= (event.clientX - drag[0]) * 0.004;
    renderer.settings.pitch = Math.max(
      -1,
      Math.min(1, renderer.settings.pitch + (event.clientY - drag[1]) * 0.004),
    );
    drag = [event.clientX, event.clientY];
  });
  canvas.addEventListener("pointerup", () => {
    drag = null;
  });
  canvas.addEventListener("pointercancel", () => {
    drag = null;
  });
  $("center").onclick = () => {
    renderer.settings.yaw = 0;
    renderer.settings.pitch = 0;
  };
  for (const [id, key] of [
    ["forward", "KeyW"],
    ["back", "KeyS"],
  ]) {
    const button = $(id);
    button.onpointerdown = (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      keys.add(key);
    };
    button.onpointerup = button.onpointercancel = () => keys.delete(key);
  }
  function map(state) {
    if (mapNode === state.node) return;
    mapNode = state.node;
    const map = $("map"),
      ctx = map.getContext("2d"),
      center = tunnelSite(state.node);
    ctx.clearRect(0, 0, 180, 140);
    ctx.lineWidth = 2;
    const points = [];
    for (let n = Math.max(0, state.node - 8); n < state.node + 20; n++) {
      const p = tunnelSite(n);
      points.push({
        n,
        x: 90 + (p[0] - center[0]) * 0.53,
        y: 72 + (p[1] - center[1]) * 0.53,
      });
    }
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = "#a4eddf";
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(90, 72, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  function draw() {
    const state = journey.snapshot(),
      a = imagesFor(state.node),
      b = imagesFor(state.node + 1);
    renderer.images(
      a,
      b,
      `${state.node}:${a.revision || 0}:${b.revision || 0}`,
    );
    renderer.draw(state, clock);
    $("depth").value = String(state.profile.level);
    $("status").textContent = state.error
      ? `Generation paused: ${state.error}`
      : state.waiting
        ? progress || "Preparing the next place · tunnel remains open"
        : state.pending
          ? progress || "Preparing the next place while you walk"
          : `${state.profile.name} · place ${state.node + 1} · ${TUNNEL_STYLES[(state.node + 1) % 6]}`;
    $("loading").hidden = !state.waiting;
    $("retry").hidden = !state.error;
    $("cached").hidden = !state.error;
    $("readout").textContent =
      `Hex ${Math.round(state.profile.hex * 100)}% · corruption ${Math.round(state.profile.corruption * 100)}% · ${generated} new model images`;
    map(state);
    return state;
  }
  e.draw = (time = clock) => {
    clock = time;
    return draw();
  };
  function loop(now) {
    if (disposed) return;
    const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
    previous = now;
    if (!e.automation && !document.hidden) {
      clock += dt;
      const forward =
        (e.auto || keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
        (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
      const strafe =
        (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
        (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
      journey.update(dt, forward, strafe);
      draw();
    }
    requestAnimationFrame(loop);
  }
  e.dispose = () => {
    disposed = true;
    journey.cancel();
    baker?.dispose();
    renderer.dispose();
    stages.forEach((s) => {
      s.natural.src = "";
      s.neon.src = "";
    });
    cache.clear();
  };
  window.addEventListener("pagehide", e.dispose, { once: true });
  draw();
  window.experimentReady = true;
  requestAnimationFrame(loop);
}
