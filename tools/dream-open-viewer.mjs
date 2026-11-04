import { createOriginRenderer } from "./dream-origin-renderer.mjs";
import { OriginSpace } from "./dream-origin-space.mjs";
import {
  OpenDriftField,
  driftWaves,
  openAppearance,
  ENCOUNTERS,
  smooth,
  fieldHash,
} from "./dream-open-field.mjs";
import { OpenDriftContent } from "./dream-open-content.mjs";
import {
  copyWorldImage,
  imageFingerprint,
  loadWorldImage,
} from "./dream-world-content.mjs";
import {
  createWorldPreset,
  validateWorldPreset,
} from "./dream-world-presets.mjs";

export async function mountOpenDrift() {
  const $ = (id) => document.getElementById(id),
    canvas = $("view");
  const renderer = await createOriginRenderer(canvas, { driftMode: true }),
    space = new OriginSpace();
  space.enabled = true;
  const e = {
    renderer,
    space,
    field: new OpenDriftField(),
    content: null,
    image: null,
    blend: null,
    currentKey: "",
    clock: 0,
    paused: false,
    loading: true,
    automation: false,
    landscapes: true,
    sourceId: "photo-3",
    message: "",
    activity: "",
    lastRender: null,
    lastEffective: null,
  };
  window.openDrift = e;
  let disposed = false,
    compare = false,
    drag = null,
    previous = performance.now(),
    requestClock = 0,
    sourceEpoch = 0,
    landscapePreference = null;
  const keys = new Set(),
    params = renderer.model.controls.filter(
      (c) =>
        c.key in renderer.params &&
        (c.type === "range" || c.key === "waveMode"),
    );
  // Build the advanced sliders from the real model's ranges and defaults.
  for (const c of params) {
    const label = document.createElement("label"),
      text = document.createElement("span"),
      input = document.createElement(c.key === "waveMode" ? "select" : "input");
    text.textContent = c.label;
    input.id = c.key;
    if (c.key === "waveMode")
      for (const option of c.options) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        input.append(el);
      }
    else {
      input.type = "range";
      input.min = c.min ?? 0;
      input.max = c.max;
      input.step = c.step ?? 0.01;
    }
    input.value = renderer.params[c.key];
    input.oninput = () => {
      renderer.params[c.key] = Number(input.value);
    };
    label.append(text, input);
    $("wave-controls").append(label);
  }
  const copyOptions = () => ({
    autoWaves: e.field.autoWaves,
    strength: e.field.strength,
    autoDepth: e.field.autoDepth,
    landscapes: e.landscapes,
  });
  function sync() {
    for (const c of params) $(c.key).value = renderer.params[c.key];
    $("auto-waves").checked = e.field.autoWaves;
    $("strength").value = e.field.strength;
    $("auto-depth").checked = e.field.autoDepth;
    $("landscapes").checked = e.landscapes;
    $("full-hex").checked = renderer.settings.fullHex;
    $("arches").checked = renderer.settings.portal;
    $("floor").value = renderer.settings.floor;
    $("negative").value = renderer.settings.negative;
  }
  function saveLook() {
    try {
      const preset = createWorldPreset(
        "Open drift",
        renderer.params,
        renderer.settings,
      );
      localStorage.setItem(
        "dream-open:look:v1",
        JSON.stringify({ preset, options: copyOptions() }),
      );
      e.message =
        "Saved your wave settings and drift preferences in this browser.";
    } catch {
      e.message =
        "This browser could not save the look. Your settings are still active.";
    }
  }
  try {
    const saved = JSON.parse(
        localStorage.getItem("dream-open:look:v1") || "null",
      ),
      preset = validateWorldPreset(saved?.preset);
    if (preset) {
      Object.assign(renderer.params, preset.params);
      Object.assign(renderer.settings, preset.settings);
      const o = saved.options;
      if (typeof o?.autoWaves === "boolean") e.field.autoWaves = o.autoWaves;
      if (typeof o?.autoDepth === "boolean") e.field.autoDepth = o.autoDepth;
      if (typeof o?.landscapes === "boolean")
        landscapePreference = o.landscapes;
      if (Number.isFinite(o?.strength))
        e.field.strength = Math.max(0, Math.min(1, o.strength));
      e.field.waveAmount = e.field.autoWaves ? e.field.strength : 0;
    }
  } catch {}
  sync();
  async function source(id, file = null) {
    const ticket = ++sourceEpoch;
    e.loading = true;
    e.blend = null;
    $("source").disabled = $("upload").disabled = true;
    e.message = "Opening the image";
    try {
      const decoded = file
        ? await createImageBitmap(file)
        : id === "demo"
          ? null
          : await loadWorldImage(`/origin/source-${id}.png`);
      e.content?.dispose();
      const seed = await renderer.source(decoded, {
        name: file?.name || id,
        features: true,
      });
      decoded?.close?.();
      if (ticket !== sourceEpoch || disposed) return;
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
      const options = copyOptions();
      e.field = new OpenDriftField();
      Object.assign(e.field, options);
      e.field.waveAmount = e.field.autoWaves ? e.field.strength : 0;
      space.home();
      space.enabled = true;
      e.sourceId = id;
      e.clock = 0;
      e.image = stages[0];
      e.currentKey = "";
      e.landscapes = id.startsWith("photo-") && (landscapePreference ?? true);
      e.content = new OpenDriftContent({
        stages,
        fingerprint,
        onProgress: (_id, text) => {
          e.activity = text;
        },
      });
      if (e.landscapes) await e.content.loadLandscapes();
      e.message =
        "Wander in any direction, or stay and watch. The image keeps unfolding.";
      if (id !== "custom") $("source").value = id;
      sync();
    } finally {
      if (ticket === sourceEpoch) {
        e.loading = false;
        $("source").disabled = $("upload").disabled = false;
      }
    }
  }
  function requestImage() {
    if (!e.content || e.loading || e.blend) return;
    const descriptor = e.field.descriptor(space.position, e.landscapes);
    if (e.currentKey === descriptor.key) return;
    const ready = e.content.request(descriptor);
    if (ready) {
      e.currentKey = descriptor.key;
      if (ready.image !== e.image)
        e.blend = { base: e.image, next: ready.image, elapsed: 0, descriptor };
    }
  }
  function encounter(arch = null) {
    if (e.loading || e.paused || !renderer.settings.portal || e.field.effect)
      return false;
    const candidate =
      arch || e.field.arches(space.position).find((a) => a.distance < 3.5);
    if (!candidate) return false;
    const ok = e.field.encounter(candidate);
    if (ok) {
      e.message = ENCOUNTERS[candidate.type].description;
      requestClock = 1;
    }
    return ok;
  }
  function home() {
    const options = copyOptions();
    e.field = new OpenDriftField();
    Object.assign(e.field, options);
    e.field.waveAmount = e.field.autoWaves ? e.field.strength : 0;
    space.home();
    space.enabled = true;
    e.clock = 0;
    e.blend = null;
    e.image = e.content?.stages[0];
    e.currentKey = "";
    keys.clear();
    e.message = "Back at your image. There is no route to follow.";
  }
  function advance(seconds, forward = 0, right = 0) {
    const dt = Math.max(0, Math.min(0.1, seconds));
    if (e.loading) return;
    const before = [...space.position];
    space.move(forward, right, dt);
    const moved = Math.hypot(
      space.position[0] - before[0],
      space.position[1] - before[1],
    );
    if (moved > 0 && renderer.settings.portal) {
      const arch = e.field.crossed(before, space.position);
      if (arch) encounter(arch);
    }
    e.field.rebase(space.position);
    if (!e.paused) {
      e.clock += dt;
      e.field.advance(dt, moved, renderer.params);
    }
    if (e.blend && !e.paused) {
      e.blend.elapsed += dt;
      if (e.blend.elapsed >= 8) {
        e.image = e.blend.next;
        e.blend = null;
      }
    }
    if (!e.paused) requestClock += dt;
    if (requestClock > 0.35) {
      requestClock = 0;
      requestImage();
    }
  }
  async function draw() {
    if (e.loading || !e.image) return;
    const f = e.field,
      global = f.global(space.position),
      arches = f.arches(space.position),
      amount = f.waveAmount;
    const effective = driftWaves(
      renderer.params,
      f.age,
      f.depth,
      amount,
      f.seed,
    );
    const cycle = f.age / 64,
      waveNext = Math.floor(fieldHash(Math.floor(cycle), 12, f.seed) * 4);
    const waveMix =
      smooth(Math.sin(Math.PI * (cycle % 1)) ** 2) * amount * 0.72;
    const appearance = openAppearance(f.depth);
    if (f.effect?.type === 2)
      appearance.hex += (1 - appearance.hex) * f.effectAmount;
    const pose = {
      enabled: !compare,
      position: space.position,
      yaw: space.yaw,
      pitch: space.pitch,
      parallax: compare
        ? [0, 0, 0]
        : [Math.sin(global[0] / 90) * 0.38, 0, Math.sin(global[1] / 90) * 0.38],
    };
    e.lastRender = await renderer.draw({
      space: pose,
      base: compare ? e.content.stages[0] : e.blend?.base || e.image,
      next: compare ? e.content.stages[0] : e.blend?.next || e.image,
      mix: compare ? 0 : smooth((e.blend?.elapsed || 0) / 8),
      original: compare,
      appearance: compare ? null : appearance,
      time: e.clock,
      waveParams: compare ? renderer.params : effective,
      drift: compare
        ? null
        : {
            mapping: f.mappingAt(space.position),
            phase: f.wavePhase,
            waveNext,
            waveMix,
            waveAmount: amount,
            effect: [f.effect?.type ?? -1, f.effectAmount],
            arches,
          },
    });
    e.lastEffective = effective;
    $("depth").value = f.depth;
    $("depth-value").textContent = f.depth.toFixed(1);
    $("readout").textContent =
      `${Math.round((renderer.settings.fullHex ? 1 : appearance.hex) * 100)}% colored hex · ${e.field.autoWaves ? "automatic waves" : amount > 0 ? "settling into your waves" : "your waves"}`;
    $("status").textContent = e.content.error
      ? `The next image is taking a break. You can keep drifting. ${e.content.error}`
      : e.message;
    $("activity").textContent = e.content.active
      ? `The next image is forming · ${e.activity}`
      : "";
    $("effective").textContent =
      `Live wave gain ${effective.gain.toFixed(2)} · spacing ${effective.frequency.toFixed(1)} · speed ${effective.speed.toFixed(2)}. Sliders below remain your base settings.`;
    $("effect-note").textContent = f.effect
      ? `${ENCOUNTERS[f.effect.type].name} · fades in ${Math.ceil(f.effect.duration - f.effect.elapsed)}s · Escape releases it`
      : "Arches hold brief changes. Walk through one, or let it pass.";
    const nearest = arches.find((a) => a.distance < 3.5);
    $("enter").disabled = !nearest || !!f.effect || !renderer.settings.portal;
    $("release").hidden = !f.effect;
    $("try-arch").disabled = !!f.effect || !renderer.settings.portal;
    return e.lastRender;
  }
  function release() {
    if (e.field.effect)
      e.field.effect.elapsed = Math.max(
        e.field.effect.elapsed,
        e.field.effect.duration - 1.5,
      );
  }
  $("source").onchange = () =>
    source($("source").value).catch((error) => {
      e.message = error.message;
    });
  $("upload").onchange = () => {
    const file = $("upload").files[0];
    if (file)
      source("custom", file).catch((error) => {
        e.message = error.message;
      });
  };
  $("auto-waves").onchange = () => {
    e.field.autoWaves = $("auto-waves").checked;
  };
  $("strength").oninput = () => {
    e.field.strength = Number($("strength").value);
  };
  $("auto-depth").onchange = () => {
    e.field.autoDepth = $("auto-depth").checked;
  };
  $("depth").oninput = () => {
    e.field.depth = Number($("depth").value);
    requestClock = 1;
  };
  $("landscapes").onchange = async () => {
    e.landscapes = $("landscapes").checked;
    landscapePreference = e.landscapes;
    if (e.landscapes && !e.content.landscapes.length) {
      try {
        await e.content.loadLandscapes();
      } catch (error) {
        e.landscapes = false;
        sync();
        e.message = error.message;
      }
    }
    e.currentKey = "";
  };
  $("full-hex").onchange = () => {
    renderer.settings.fullHex = $("full-hex").checked;
  };
  $("arches").onchange = () => {
    renderer.settings.portal = $("arches").checked;
    if (!renderer.settings.portal) release();
  };
  for (const id of ["floor", "negative"])
    $(id).oninput = () => {
      renderer.settings[id] = Number($(id).value);
    };
  $("save-look").onclick = saveLook;
  $("reset-look").onclick = () => {
    for (const c of renderer.model.controls) renderer.params[c.key] = c.default;
    e.field.autoWaves = true;
    e.field.strength = 0.65;
    sync();
  };
  $("home").onclick = home;
  $("enter").onclick = () => encounter();
  $("release").onclick = release;
  $("try-arch").onclick = () =>
    encounter({
      id: `preview:${Math.floor(e.field.age)}`,
      type: Math.floor(
        fieldHash(Math.floor(e.field.age), 24, e.field.seed) * 4,
      ),
    });
  $("pause").onclick = () => {
    e.paused = !e.paused;
    $("pause").textContent = e.paused ? "Resume drift" : "Pause drift";
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
    if (drag) {
      space.yaw -= (event.clientX - drag[0]) * 0.005;
      space.pitch = Math.max(
        -1.35,
        Math.min(1.35, space.pitch + (event.clientY - drag[1]) * 0.005),
      );
      drag = [event.clientX, event.clientY];
    }
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    drag = null;
  };
  window.addEventListener("keydown", (event) => {
    const focus = document.activeElement;
    if (["SELECT", "TEXTAREA", "INPUT"].includes(focus?.tagName)) return;
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
        "KeyB",
        "KeyE",
        "Escape",
      ].includes(event.code)
    ) {
      event.preventDefault();
      keys.add(event.code);
      if (event.code === "KeyB") compare = true;
      if (event.code === "KeyE" && !event.repeat) encounter();
      if (event.code === "Escape") release();
    }
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
    if (event.code === "KeyB") compare = false;
  });
  window.addEventListener("blur", () => {
    keys.clear();
    compare = false;
    drag = null;
  });
  document.addEventListener("visibilitychange", () => {
    keys.clear();
    previous = performance.now();
  });
  for (const [id, key] of [
    ["forward", "KeyW"],
    ["back", "KeyS"],
    ["left", "KeyA"],
    ["right", "KeyD"],
  ]) {
    $(id).onpointerdown = (event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      keys.add(key);
    };
    $(id).onpointerup = $(id).onpointercancel = () => keys.delete(key);
  }
  Object.assign(e, {
    source,
    advance,
    draw,
    requestImage,
    encounter,
    release,
    home,
    saveLook,
  });
  e.dispose = () => {
    disposed = true;
    sourceEpoch++;
    e.content?.dispose();
    renderer.dispose();
  };
  window.addEventListener("pagehide", e.dispose, { once: true });
  await source("photo-3");
  window.openDriftReady = true;
  await draw();
  async function loop(now) {
    if (disposed) return;
    const dt = Math.max(0, Math.min(0.1, (now - previous) / 1000));
    previous = now;
    try {
      if (!e.automation && !document.hidden && !e.loading) {
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
mountOpenDrift().catch((error) => {
  document.getElementById("status").textContent = error.message;
  console.error(error);
});
