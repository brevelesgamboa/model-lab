// UI extracted from Gemini's local gateway demo; visual behavior is preserved.
import { createAsciiRenderer } from "./dream-drift-ascii-renderer.mjs";

export async function mountDreamAsciiViewer({ assets, scenes: entries }) {
  const scenes = entries.map((s) => ({
    ...s,
    neon: assets[s.neon],
    natural: assets[s.natural],
    seed: assets[s.seed],
  }));
  const canvas = document.getElementById("view"),
    renderer = createAsciiRenderer(canvas);
  const el = (id) => document.getElementById(id),
    modes = [
      "Saturated image",
      "Woven ASCII · clear face",
      "Colored ASCII throughout",
    ],
    geometries = ["Plain dome", "Shallow relief", "Relief + neon arches"],
    densities = { 240: 80, 320: 112, 416: 144 };
  let active,
    loading = false,
    generation = 0,
    automation = false,
    drag = null,
    time = 0,
    last = undefined;
  async function selectScene(id) {
    const s = scenes.find((s) => s.id === id);
    if (!s) throw new Error("Unknown scene");
    const ticket = ++generation;
    loading = true;
    await renderer.load(s);
    if (ticket !== generation) return;
    active = s;
    loading = false;
    time = 0;
    el("status").textContent = "Ready · drag to look, or enable slow change";
    renderer.draw(time);
  }
  function controls() {
    renderer.settings.mode = +el("mode").value;
    renderer.settings.geometry = +el("geometry").value;
    renderer.settings.columns = +el("density").value;
    renderer.settings.rows = densities[renderer.settings.columns] || 112;
    if (el("archStyle")) renderer.settings.archStyle = +el("archStyle").value;
    if (el("animMode")) renderer.settings.animMode = +el("animMode").value;
    if (el("animSpeed")) renderer.settings.animSpeed = +el("animSpeed").value;
    renderer.draw(time);
    refreshStills();
  }
  function refreshStills() {
    if (!active) return;
    el("stills").innerHTML = modes
      .flatMap((m, mode) =>
        geometries.map(
          (g, geometry) =>
            '<figure><a href="' +
            active.id +
            "-m" +
            mode +
            "-g" +
            geometry +
            '.png"><img loading="lazy" src="' +
            active.id +
            "-m" +
            mode +
            "-g" +
            geometry +
            '.png" alt="' +
            m +
            " with " +
            g +
            '"></a><figcaption>' +
            m +
            " · " +
            g +
            "</figcaption></figure>",
        ),
      )
      .join("");
  }
  async function change() {
    await selectScene(el("photo").value + "-level-" + el("level").value);
    controls();
  }
  for (const id of ["photo", "level"])
    el(id).addEventListener("change", () => change().catch(showError));
  for (const id of [
    "mode",
    "geometry",
    "density",
    "archStyle",
    "animMode",
    "animSpeed",
  ])
    el(id).addEventListener("change", controls);
  function showError(e) {
    el("status").textContent = e.message;
    console.error(e);
  }
  el("reset").onclick = () => {
    el("motion").checked = false;
    renderer.camera.reset();
    renderer.camera.pitch = active.pitch;
    renderer.draw(time);
  };
  canvas.onpointerdown = (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    el("motion").checked = false;
  };
  canvas.onpointerup = () => {
    drag = null;
  };
  canvas.onpointercancel = () => {
    drag = null;
  };
  canvas.onpointermove = (e) => {
    if (!drag || loading) return;
    const dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    if (e.shiftKey) {
      renderer.camera.pan(dx * 0.4, dy * 0.4, canvas.clientHeight);
    } else renderer.camera.look(dx * 0.45, dy * 0.45);
    renderer.draw(time);
  };
  function pose(t) {
    renderer.camera.yaw = Math.sin(t * Math.PI * 2) * 0.22;
    renderer.camera.pitch = active.pitch + Math.sin(t * Math.PI * 4) * 0.025;
    renderer.camera.target = [
      Math.sin(t * Math.PI * 2) * 0.32,
      0,
      Math.sin(t * Math.PI * 2) * 0.1,
    ];
  }
  function tick(now) {
    const delta = last === undefined ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!automation && !loading && active) {
      if (el("living") && el("living").checked) time += delta;
      if (el("motion") && el("motion").checked) pose((now % 12000) / 12000);
      const isAnimated =
        renderer.settings.animMode > 0 && el("living") && el("living").checked;
      if (isAnimated || (el("motion") && el("motion").checked)) {
        renderer.draw(time);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  const clips = [
    { mode: 0, geometry: 2 },
    { mode: 1, geometry: 0 },
    { mode: 1, geometry: 1 },
    { mode: 1, geometry: 2 },
    { mode: 2, geometry: 2 },
  ];
  el("clips").innerHTML = clips
    .map(
      (c) =>
        '<figure><video controls loop muted playsinline preload="none" src="motion-m' +
        c.mode +
        "-g" +
        c.geometry +
        '.webm"></video><figcaption>' +
        modes[c.mode] +
        " · " +
        geometries[c.geometry] +
        "</figcaption></figure>",
    )
    .join("");
  window.experiment = {
    renderer,
    scenes,
    selectScene,
    pose,
    get active() {
      return active;
    },
    set automation(v) {
      automation = v;
    },
  };
  await change();
  window.experimentReady = true;
  return window.experiment;
}
