import { createOriginRenderer } from "./dream-origin-renderer.mjs";
import { OriginSpace, originSmooth } from "./dream-origin-space.mjs";
import {
  DreamWorldMap,
  WORLD_AREAS,
  WORLD_VERSION,
  worldArea,
  worldGates,
  worldAppearance,
} from "./dream-world-map.mjs";
import {
  DreamWorldContent,
  copyWorldImage,
  imageFingerprint,
  loadWorldImage,
} from "./dream-world-content.mjs";
import {
  WorldImageStore,
  readWorldProgress,
  saveWorldProgress,
} from "./dream-world-storage.mjs";
import {
  createWorldPreset,
  loadWorldPresets,
  storeWorldPreset,
} from "./dream-world-presets.mjs";

export async function mountDreamWorld() {
  const $ = (id) => document.getElementById(id),
    canvas = $("view"),
    renderer = await createOriginRenderer(canvas, { worldMode: true }),
    space = new OriginSpace(),
    store = new WorldImageStore();
  space.enabled = true;
  let storage = null;
  try {
    storage = localStorage;
  } catch {}
  const e = {
    renderer,
    space,
    store,
    world: new DreamWorldMap(),
    content: null,
    image: null,
    sourceId: "photo-3",
    key: "",
    clock: 0,
    paused: false,
    loading: true,
    automation: false,
    warp: null,
    message: "",
    activity: "",
    gateFade: 1,
    travel: null,
  };
  window.worldDemo = e;
  let disposed = false,
    busy = false,
    previous = performance.now(),
    compare = false,
    drag = null,
    epoch = 0,
    transitionEpoch = 0,
    active = null,
    saveClock = 0;
  const keys = new Set(),
    jobs = new Map(),
    queue = [],
    labels = new Map();
  let shownArea = "",
    shownExitSignature = "";
  const pose = (position = space.position) => ({
    enabled: true,
    position,
    yaw: space.yaw,
    pitch: space.pitch,
    parallax: [
      Math.tanh(position[0] / 14) * 0.48,
      0,
      Math.tanh(position[1] / 14) * 0.48,
    ],
  });
  function saveProgress() {
    if (e.key)
      saveWorldProgress(
        storage,
        `dream-world:progress:${e.key}`,
        e.world.serialize(space.position, space.yaw, space.pitch),
      );
  }
  function cancelJobs() {
    epoch++;
    for (const job of jobs.values())
      if (job.status === "queued" || job.status === "preparing") {
        job.abort.abort();
        job.reject(new DOMException("Cancelled", "AbortError"));
      }
    queue.length = 0;
    jobs.clear();
    e.content?.baker.cancel();
    e.activity = "";
  }
  async function pump() {
    if (active || !queue.length || !e.content) return;
    const job = queue.shift(),
      ticket = epoch,
      content = e.content;
    active = job;
    job.status = "preparing";
    try {
      const image = await content.prepare(job.id, { signal: job.abort.signal });
      if (ticket !== epoch || job.abort.signal.aborted) return;
      job.status = "ready";
      job.resolve(image);
    } catch (error) {
      job.status = "error";
      job.error = error;
      if (ticket === epoch && !job.abort.signal.aborted) {
        e.activity = `${worldArea(job.id).name} could not form. Approach its fold to retry.`;
      }
      job.reject(error);
    } finally {
      if (active === job) active = null;
      if (ticket === epoch) e.activity = "";
      void pump();
    }
  }
  function requestPlace(id, priority = false) {
    if (e.content.images.has(id))
      return Promise.resolve(e.content.images.get(id));
    const existing = jobs.get(id);
    if (
      existing &&
      (existing.status === "queued" || existing.status === "preparing")
    ) {
      if (priority && existing.status === "queued") {
        const i = queue.indexOf(existing);
        if (i >= 0) {
          queue.splice(i, 1);
          queue.unshift(existing);
        }
      }
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    promise.catch(() => {});
    const job = {
      id,
      promise,
      resolve,
      reject,
      status: "queued",
      abort: new AbortController(),
    };
    jobs.set(id, job);
    if (priority) queue.unshift(job);
    else queue.push(job);
    void pump();
    return promise;
  }
  function prefetch() {
    if (!e.content || e.loading) return;
    for (const gate of e.world
      .gates(space.position)
      .filter((g) => g.open && g.known))
      void requestPlace(gate.target).catch(() => {});
  }
  function cancelTravel() {
    transitionEpoch++;
    if (e.warp?.phase === "loading") {
      const job = jobs.get(e.warp.target);
      job?.abort.abort();
      if (job?.status === "queued") {
        const n = queue.indexOf(job);
        if (n >= 0) queue.splice(n, 1);
        job.status = "error";
        job.reject(new DOMException("Cancelled", "AbortError"));
      }
    }
    e.warp = null;
    e.gateFade = 1;
    e.message = "Transition cancelled. Your current place is still here.";
  }
  async function source(id, file = null) {
    transitionEpoch++;
    cancelJobs();
    e.content?.dispose();
    e.warp = null;
    e.loading = true;
    busy = true;
    $("source").disabled = true;
    $("upload").disabled = true;
    e.message = "Preparing the original dome";
    try {
      const decoded = file
        ? await createImageBitmap(file)
        : id === "demo"
          ? null
          : await loadWorldImage(`/origin/source-${id}.png`);
      const seed = await renderer.source(decoded, {
        name: file?.name || id,
        features: true,
      });
      decoded?.close?.();
      const stages = [copyWorldImage(seed)],
        fingerprint = await imageFingerprint(stages[0]);
      if (id !== "custom") {
        const manifest = await (await fetch("/origin/manifest.json")).json(),
          cached = manifest.studies[id];
        if (
          cached?.version === "origin-study-v1" &&
          cached.fingerprint === fingerprint
        )
          stages.push(
            ...(await Promise.all(
              ["light", "deep"].map((s) =>
                loadWorldImage(`/origin/studies/${id}/${s}.png`),
              ),
            )),
          );
      }
      e.key = `${WORLD_VERSION}:${fingerprint}:417`;
      e.sourceId = id;
      e.world = new DreamWorldMap();
      space.home();
      space.enabled = true;
      const restored = e.world.restore(
        readWorldProgress(storage, `dream-world:progress:${e.key}`),
      );
      if (restored) Object.assign(space, restored);
      e.content = new DreamWorldContent({
        stages,
        key: e.key,
        store,
        seed: e.world.seed,
        onProgress: (id, message) => {
          e.activity = `${worldArea(id).name} · ${message}`;
        },
      });
      e.image = await requestPlace(e.world.current, true);
      e.clock = 0;
      e.gateFade = 1;
      shownArea = "";
      shownExitSignature = "";
      keys.clear();
      e.message = restored
        ? `Welcome back to ${e.world.area.name}.`
        : e.world.area.description;
      if (id !== "custom") {
        try {
          storage?.setItem("dream-world:last-source", id);
        } catch {}
        $("source").value = id;
      }
      saveProgress();
    } catch (error) {
      e.message = `This image could not open: ${error.message}`;
      throw error;
    } finally {
      e.loading = false;
      busy = false;
      $("source").disabled = false;
      $("upload").disabled = false;
    }
    prefetch();
  }
  function home() {
    transitionEpoch++;
    cancelJobs();
    e.warp = null;
    space.position = e.world.home();
    space.yaw = 0;
    space.pitch = 0;
    space.trace = [];
    e.image = e.content.images.get("clearing") || e.content.stages[0];
    e.gateFade = 1;
    e.message = "Back in the Photo Clearing. Discovered places are remembered.";
    keys.clear();
    saveProgress();
  }
  async function enterGate(target = null) {
    if (e.loading || e.warp || !renderer.settings.portal) return false;
    const gate = target
      ? e.world.gates(space.position).find((g) => g.target === target && g.open)
      : e.world.nearest(space.position);
    if (!gate || gate.distance > 3.3) return false;
    const ticket = ++transitionEpoch,
      from = [...space.position],
      arrival = e.world.arrival(gate.target),
      floor = space.position.map((v, i) => v + e.world.floorOffset[i]);
    e.warp = {
      phase: "loading",
      target: gate.target,
      base: e.image,
      from,
      arrival,
      floor,
      shift: e.world.floorShift(gate.target, from),
      depth: e.world.area.depth,
      elapsed: 0,
    };
    e.message = `${worldArea(gate.target).name} is forming. You can still look around.`;
    try {
      const image = await requestPlace(gate.target, true);
      if (ticket !== transitionEpoch) return false;
      e.warp = { ...e.warp, phase: "blend", next: image, elapsed: 0 };
      e.message = `Passing into ${worldArea(gate.target).name}`;
      return true;
    } catch (error) {
      if (ticket !== transitionEpoch) return false;
      if (error.name === "AbortError") {
        e.warp = null;
        return false;
      }
      e.warp.phase = "error";
      e.message =
        "The next place could not form. Retry the fold or return to the clearing.";
      return false;
    }
  }
  function advance(seconds, forward = 0, right = 0) {
    const dt = Math.max(0, Math.min(0.1, seconds));
    if (e.warp?.phase === "blend") {
      e.warp.elapsed += dt;
      if (e.warp.elapsed >= 1.5) {
        const warp = e.warp;
        space.position = e.world.commit(warp.target, warp.from);
        e.image = warp.next;
        e.warp = null;
        e.gateFade = 1;
        space.trace = [];
        e.message = e.world.area.description;
        saveProgress();
        prefetch();
      }
    } else if (!e.warp && !e.loading) {
      const before = [...space.position];
      space.move(forward, right, dt);
      if (e.world.discoverAt(space.position)) {
        e.message = "A quiet ripple resolves into Hidden Resonance.";
        saveProgress();
        prefetch();
      }
      const crossed = e.world.crossed(before, space.position);
      if (crossed) {
        e.travel = enterGate(crossed.target);
      }
      if (Math.hypot(...space.position) > 1 && queue.length === 0 && !active)
        prefetch();
    }
    if (!e.paused) e.clock += dt;
    saveClock += dt;
    if (saveClock > 2 && !e.loading && !e.warp) {
      saveProgress();
      saveClock = 0;
    }
  }
  function frame() {
    if (!e.warp || e.warp.phase !== "blend")
      return {
        position: space.position,
        area: e.world.area,
        image: e.image,
        next: e.image,
        mix: 0,
        appearance: worldAppearance(e.world.area.depth),
        floorOffset: e.world.floorOffset,
        presence: e.gateFade,
      };
    const w = e.warp,
      t = originSmooth(w.elapsed / 1.5),
      position = w.from.map((v, i) => v + (w.arrival[i] - v) * t),
      area = t < 0.5 ? e.world.area : worldArea(w.target);
    return {
      position,
      area,
      image: w.base,
      next: w.next,
      mix: t,
      appearance: worldAppearance(
        w.depth + (worldArea(w.target).depth - w.depth) * t,
      ),
      floorOffset: w.floor.map((v, i) => v + w.shift[i] * t - position[i]),
      presence: t < 0.5 ? 1 - originSmooth(t * 2) : originSmooth((t - 0.5) * 2),
    };
  }
  function gatesAt(area, position, presence) {
    return worldGates(area.id)
      .map((g) => ({
        ...g,
        known: !g.hidden || e.world.discovered.has("pocket"),
        open: e.world.available(g),
        distance: Math.hypot(
          position[0] - g.position[0],
          position[1] - g.position[1],
        ),
        presence:
          presence *
          (g.shortcut && !e.world.shortcutOpen
            ? 0.1
            : g.hidden && !e.world.discovered.has("pocket")
              ? 0.1
              : 1),
      }))
      .sort((a, b) => b.distance - a.distance);
  }
  function projected(point, position) {
    const x = point[0] - position[0],
      z = point[1] - position[1],
      sy = Math.sin(space.yaw),
      cy = Math.cos(space.yaw),
      sp = Math.sin(space.pitch),
      cp = Math.cos(space.pitch),
      y = 2.45;
    const forward = x * sy * cp + y * sp - z * cy * cp;
    if (forward < 0.2) return null;
    const right = x * cy + z * sy,
      up = -x * sy * sp + y * cp + z * cy * sp,
      f = 1 / Math.tan((85 * Math.PI) / 360),
      aspect = canvas.width / canvas.height;
    const px = 0.5 + (right * f) / (2 * forward * aspect),
      py = 0.5 - (up * f) / (2 * forward);
    return px > -0.05 && px < 1.05 && py > -0.05 && py < 1.05
      ? [px * 100, py * 100]
      : null;
  }
  function updateLabels(gates, position) {
    for (const element of labels.values()) element.hidden = true;
    for (const gate of gates) {
      if (!gate.known || !gate.open || gate.presence < 0.3) continue;
      const point = projected(gate.position, position);
      if (!point) continue;
      let label = labels.get(gate.id);
      if (!label) {
        label = document.createElement("span");
        label.className = "gate-label";
        $("labels").append(label);
        labels.set(gate.id, label);
      }
      label.textContent = worldArea(gate.target).name;
      label.style.left = point[0] + "%";
      label.style.top = point[1] + "%";
      label.hidden = false;
    }
  }
  function faceGate(id) {
    const gate = e.world.gates(space.position).find((g) => g.target === id);
    if (!gate) return;
    space.yaw = Math.atan2(
      gate.position[0] - space.position[0],
      -(gate.position[1] - space.position[1]),
    );
    space.pitch = 0.05;
    canvas.focus();
  }
  function updateExits() {
    const gates = e.world
        .gates(space.position)
        .filter((g) => g.known && g.open),
      signature = e.world.current + gates.map((g) => g.target).join(":");
    if (signature === shownExitSignature) return;
    shownExitSignature = signature;
    $("exits").replaceChildren();
    for (const gate of gates) {
      const button = document.createElement("button");
      button.textContent = "Face " + worldArea(gate.target).name;
      button.onclick = () => faceGate(gate.target);
      $("exits").append(button);
    }
  }
  function drawMap() {
    const map = $("map"),
      ctx = map.getContext("2d");
    ctx.clearRect(0, 0, 220, 190);
    const xy = (site) => [110 + site[0] * 1.05, 168 + site[1] * 1.05];
    ctx.lineWidth = 1.5;
    for (const area of WORLD_AREAS) {
      if (!e.world.discovered.has(area.id)) continue;
      for (const gate of worldGates(area.id)) {
        if (
          !e.world.discovered.has(gate.target) ||
          !e.world.available(gate) ||
          area.id > gate.target
        )
          continue;
        const a = xy(area.site),
          b = xy(worldArea(gate.target).site);
        ctx.strokeStyle = gate.shortcut ? "#f2cd9f" : "#91c8c7";
        ctx.setLineDash(gate.shortcut ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(...a);
        ctx.lineTo(...b);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const area of WORLD_AREAS) {
      if (!e.world.discovered.has(area.id)) continue;
      const p = xy(area.site);
      ctx.fillStyle =
        area.id === e.world.current
          ? "#fff"
          : e.world.visited.has(area.id)
            ? "#9cddd3"
            : "#69818d";
      ctx.beginPath();
      ctx.arc(...p, area.id === e.world.current ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const site = e.world.area.site,
      p = xy([
        site[0] + space.position[0] * 0.38,
        site[1] + space.position[1] * 0.38,
      ]);
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.moveTo(p[0] + Math.sin(space.yaw) * 6, p[1] - Math.cos(space.yaw) * 6);
    ctx.lineTo(
      p[0] + Math.sin(space.yaw + 2.5) * 4,
      p[1] - Math.cos(space.yaw + 2.5) * 4,
    );
    ctx.lineTo(
      p[0] + Math.sin(space.yaw - 2.5) * 4,
      p[1] - Math.cos(space.yaw - 2.5) * 4,
    );
    ctx.closePath();
    ctx.fill();
  }
  async function draw() {
    if (!e.image || e.loading) return;
    const f = frame(),
      gates = gatesAt(f.area, f.position, f.presence),
      p = pose(f.position);
    await renderer.draw({
      space: compare ? { ...p, enabled: false } : p,
      base: compare ? e.content.stages[0] : f.image,
      next: compare ? e.content.stages[0] : f.next,
      mix: compare ? 0 : f.mix,
      original: compare,
      appearance: compare ? null : f.appearance,
      time: e.clock,
      areaWorld: compare
        ? null
        : {
            floorOffset: f.floorOffset,
            gates,
            landmark: [
              f.area.landmark[0],
              f.area.landmark[1],
              f.area.landmark[2],
              f.presence,
            ],
          },
      warp:
        e.warp?.phase === "loading"
          ? 0.6
          : e.warp?.phase === "blend"
            ? Math.sin(f.mix * Math.PI) * 0.55
            : 0,
    });
    $("area").textContent = e.world.area.name;
    $("readout").textContent =
      `Depth ${e.world.area.depth.toFixed(1)} · colored hex ${Math.round((renderer.settings.fullHex ? 1 : renderer.settings.digital ? f.appearance.hex : 0) * 100)}% · ${e.world.visited.size} places visited`;
    $("status").textContent = e.message || e.world.area.description;
    $("activity").textContent = e.activity;
    const nearest = e.world.nearest(space.position);
    $("enter").disabled =
      !!e.warp ||
      !nearest ||
      nearest.distance > 3.3 ||
      !renderer.settings.portal;
    $("enter").textContent =
      nearest && nearest.distance < 3.3
        ? "Enter " + worldArea(nearest.target).name + " · E"
        : "Enter nearby fold · E";
    $("cancel").hidden = !e.warp;
    $("retry").hidden = e.warp?.phase !== "error";
    $("hint").textContent = e.warp
      ? "The floor stays level while this place unfolds. Escape cancels the transition."
      : nearest && nearest.distance < 3.3
        ? "Walk through this opening, or press E. You can also walk around it."
        : "Choose a visible fold, or wander freely. B holds the original image.";
    if (shownArea !== e.world.current) {
      shownArea = e.world.current;
      $("description").textContent = e.world.area.description;
    }
    updateExits();
    drawMap();
    updateLabels(compare ? [] : gates, f.position);
    $("map-wrap").hidden = !$("show-map").checked;
    return f;
  }
  const parameterKeys = [
    "waveMode",
    "gain",
    "frequency",
    "speed",
    "eccentricity",
    "depthScale",
    "neuralSwell",
    "edgeCoupling",
    "chromaticDispersion",
    "cameraDolly",
  ];
  function syncControls() {
    for (const key of parameterKeys) $(key).value = renderer.params[key];
    for (const key of ["floor", "negative"])
      $(key).value = renderer.settings[key];
    $("hex").checked = renderer.settings.fullHex;
    $("digital").checked = renderer.settings.digital;
    $("portal").checked = renderer.settings.portal;
  }
  for (const key of parameterKeys)
    $(key).oninput = () => {
      renderer.params[key] = Number($(key).value);
    };
  for (const key of ["floor", "negative"])
    $(key).oninput = () => {
      renderer.settings[key] = Number($(key).value);
    };
  $("hex").onchange = () => {
    renderer.settings.fullHex = $("hex").checked;
  };
  $("digital").onchange = () => {
    renderer.settings.digital = $("digital").checked;
  };
  $("portal").onchange = () => {
    renderer.settings.portal = $("portal").checked;
  };
  function refreshPresets() {
    const looks = loadWorldPresets(storage);
    $("presets").replaceChildren();
    for (const preset of looks) {
      const option = document.createElement("option");
      option.textContent = preset.name;
      option.value = preset.name;
      $("presets").append(option);
    }
    $("load-look").disabled = !looks.length;
    return looks;
  }
  function applyPreset(preset) {
    Object.assign(renderer.params, preset.params);
    Object.assign(renderer.settings, preset.settings);
    syncControls();
    e.message = `Loaded “${preset.name}”. The wave controls remain yours.`;
  }
  $("save-look").onclick = () => {
    try {
      const preset = createWorldPreset(
        $("look-name").value,
        renderer.params,
        renderer.settings,
      );
      storeWorldPreset(storage, preset);
      refreshPresets();
      $("presets").value = preset.name;
      e.message = `Saved “${preset.name}” in this browser.`;
    } catch {
      e.message =
        "This browser could not save the look. Your current settings are still active.";
    }
  };
  $("load-look").onclick = () => {
    const preset = loadWorldPresets(storage).find(
      (p) => p.name === $("presets").value,
    );
    if (preset) applyPreset(preset);
  };
  $("reset-look").onclick = () => {
    for (const c of renderer.model.controls) renderer.params[c.key] = c.default;
    Object.assign(renderer.settings, {
      floor: 0.72,
      negative: 0.55,
      portal: true,
      fullHex: false,
      digital: true,
    });
    syncControls();
  };
  const looks = refreshPresets();
  if (looks.length) applyPreset(looks.at(-1));
  syncControls();
  $("source").onchange = () => source($("source").value).catch(console.error);
  $("upload").onchange = () => {
    const file = $("upload").files[0];
    if (file) source("custom", file).catch(console.error);
  };
  $("home").onclick = home;
  $("enter").onclick = () => {
    e.travel = enterGate();
  };
  $("cancel").onclick = cancelTravel;
  $("retry").onclick = () => {
    const target = e.warp?.target;
    cancelTravel();
    if (target) e.travel = enterGate(target);
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
    const focus = document.activeElement;
    if (
      ["SELECT", "TEXTAREA"].includes(focus?.tagName) ||
      (focus?.tagName === "INPUT" &&
        !["checkbox", "radio"].includes(focus.type))
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
      if (event.code === "KeyE" && !event.repeat) e.travel = enterGate();
      if (event.code === "Escape") cancelTravel();
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
  document.addEventListener("visibilitychange", () => {
    keys.clear();
    previous = performance.now();
    if (document.hidden) saveProgress();
  });
  for (const [id, key] of [
    ["forward", "KeyW"],
    ["back", "KeyS"],
    ["left", "KeyA"],
    ["right", "KeyD"],
  ]) {
    const button = $(id);
    button.onpointerdown = (event) => {
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      keys.add(key);
    };
    button.onpointerup = button.onpointercancel = () => keys.delete(key);
  }
  Object.assign(e, {
    draw,
    advance,
    enterGate,
    source,
    home,
    cancelTravel,
    requestPlace,
    faceGate,
    saveProgress,
    frame,
  });
  e.dispose = () => {
    saveProgress();
    disposed = true;
    transitionEpoch++;
    cancelJobs();
    e.content?.dispose();
    renderer.dispose();
    void store.close();
  };
  window.addEventListener("pagehide", e.dispose, { once: true });
  let initial = "photo-3";
  try {
    const saved = storage?.getItem("dream-world:last-source");
    if (["demo", "photo-1", "photo-2", "photo-3"].includes(saved))
      initial = saved;
  } catch {}
  await source(initial);
  window.worldReady = true;
  await draw();
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
mountDreamWorld().catch((error) => {
  document.getElementById("status").textContent = error.message;
  console.error(error);
});
