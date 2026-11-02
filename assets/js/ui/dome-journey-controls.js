import { createDomeRadar } from "./dome-neuro-radar.js";

export function createDomeJourneyControls({
  elements: e,
  model,
  isActive,
  canInteract,
  render,
  onWarpChange = () => {},
}) {
  const journey = model.journey,
    keys = new Set(),
    radar = createDomeRadar(e.journeyMap, journey);
  let frame = null,
    lastTime = null,
    lookMessage = "",
    displayedSeed = null,
    warpLook = null,
    selectedNode = null;
  const allowed = () =>
    isActive() &&
    canInteract() &&
    journey.enabled &&
    model.bakeState !== "baking";
  const drawMap = () =>
    radar.draw({
      yaw: model.camera.yaw,
      depthMap:
        model.outpaintingMode === "migan"
          ? (model.aiDepthMap ?? model.depthMap)
          : model.depthMap,
      depthMaps: model.journeyFields.depthMaps,
      rooms: model.journeyFields.pool.entries,
    });
  const redraw = () => {
    update();
    if (isActive()) {
      void render();
      if (allowed() && !document.hidden && journey.breadcrumbs.length > 1)
        startTick();
    }
  };
  function stop() {
    keys.clear();
    lastTime = null;
    warpLook = null;
    const cancelled = journey.cancelWarp();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (cancelled) onWarpChange();
  }
  function unlock() {
    if (document.pointerLockElement === e.canvas) document.exitPointerLock();
  }
  function startTick() {
    if (frame === null) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = null;
    if (!allowed() || document.hidden) {
      stop();
      return;
    }
    const seconds =
      lastTime === null ? 0 : Math.max(0, (now - lastTime) / 1000);
    lastTime = now;
    journey.setRadarTime(now / 1000);
    let changed = false;
    if (journey.warping) {
      changed = journey.advanceWarp(seconds);
      if (!journey.warping) onWarpChange();
      if (warpLook) {
        const t = Math.min(1, journey.warpProgress / 0.18),
          ease = t * t * (3 - 2 * t);
        const delta = Math.atan2(
          Math.sin(warpLook.to - warpLook.from),
          Math.cos(warpLook.to - warpLook.from),
        );
        model.camera.yaw = warpLook.from + delta * ease;
        model.camera.pitch = warpLook.pitch * (1 - ease);
        if (!journey.warping) warpLook = null;
      }
    } else
      changed = journey.move(
        Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
        Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
        seconds,
        model.camera.yaw,
      );
    if (changed) redraw();
    else drawMap();
    // Decaying radar history redraws only the 2D map when the scene is stationary.
    if (keys.size || journey.warping || journey.breadcrumbs.length > 1)
      startTick();
    else lastTime = null;
  }
  function beginWarp(id) {
    if (!allowed() || journey.warping) return;
    keys.clear();
    unlock();
    if (!journey.startWarp(id)) return;
    const [dx, dz] = journey.warp.to.map((v, i) => v - journey.warp.from[i]);
    warpLook = {
      from: model.camera.yaw,
      pitch: model.camera.pitch,
      to: Math.atan2(dx, -dz),
    };
    lookMessage = "";
    lastTime = performance.now();
    onWarpChange();
    redraw();
    startTick();
  }
  for (const [button, layer] of [
    [e.journeyGeo, "geo"],
    [e.journeyNet, "net"],
    [e.journeyTrace, "trace"],
  ]) {
    button.addEventListener("click", () => {
      radar.layers[layer] = !radar.layers[layer];
      button.setAttribute("aria-pressed", String(radar.layers[layer]));
      drawMap();
    });
  }
  e.journeyMap.addEventListener("click", (event) => {
    const rect = e.journeyMap.getBoundingClientRect();
    const node = radar.hitTest(
      ((event.clientX - rect.left) * e.journeyMap.width) / rect.width,
      ((event.clientY - rect.top) * e.journeyMap.height) / rect.height,
    );
    if (node) beginWarp(node.id);
  });
  e.journeyMap.addEventListener("pointermove", (event) => {
    const rect = e.journeyMap.getBoundingClientRect();
    const node = radar.hitTest(
      ((event.clientX - rect.left) * e.journeyMap.width) / rect.width,
      ((event.clientY - rect.top) * e.journeyMap.height) / rect.height,
    );
    radar.setHover(node?.id ?? null);
    e.journeyMap.style.cursor =
      node && !journey.warping ? "pointer" : "default";
    drawMap();
  });
  e.journeyMap.addEventListener("pointerleave", () => {
    radar.setHover(null);
    drawMap();
  });
  e.journeyMap.addEventListener("keydown", (event) => {
    if (!allowed() || journey.warping) return;
    const targets = radar.targets;
    if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) &&
      targets.length
    ) {
      event.preventDefault();
      const direction = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
      const current = targets.findIndex((n) => n.id === selectedNode);
      selectedNode =
        targets[(current + direction + targets.length) % targets.length].id;
      radar.setHover(selectedNode);
      drawMap();
      e.journeyMap.setAttribute(
        "aria-label",
        `${journey.visited.has(selectedNode) ? "Visited hub" : "Unexplored frontier"} ${selectedNode}. Press Enter to warp, arrows to select.`,
      );
    } else if (
      ["Enter", " "].includes(event.key) &&
      targets.some((node) => node.id === selectedNode)
    ) {
      event.preventDefault();
      beginWarp(selectedNode);
    }
  });
  e.journeyEnabled.addEventListener("change", () => {
    if (!isActive() || !canInteract()) return;
    stop();
    model.setJourneyEnabled(e.journeyEnabled.checked);
    if (journey.enabled) e.canvas.focus({ preventScroll: true });
    else unlock();
  });
  e.journeyNew.addEventListener("click", () => {
    if (!allowed()) return;
    stop();
    model.newJourney();
    selectedNode = null;
    redraw();
  });
  e.journeyLoadSeed.addEventListener("click", () => {
    if (!allowed() || !e.journeySeed.reportValidity()) return;
    stop();
    model.newJourney(Number(e.journeySeed.value));
    selectedNode = null;
    redraw();
  });
  e.journeySpeed.addEventListener("input", () => {
    journey.speed = Math.max(
      0.5,
      Math.min(6, Number(e.journeySpeed.value) || 2),
    );
    update();
  });
  e.journeyNeuralDetail.addEventListener("change", () => {
    journey.neuralDetail = e.journeyNeuralDetail.checked;
  });
  e.journeySwapRB.addEventListener("change", () => {
    if (!isActive()) return;
    model.colorSwapRB = e.journeySwapRB.checked;
    redraw();
  });
  for (const [element, key] of [
    [e.journeyRecursion, "recursion"],
    [e.journeyCorruption, "corruption"],
    [e.journeyDensity, "density"],
    [e.journeyClarity, "clarity"],
    [e.journeyFaithfulness, "faithfulness"],
    [e.journeyRetro, "retro"],
    [e.journeyDepthParallax, "depthParallax"],
    [e.journeyDepthFog, "depthFog"],
    [e.journeyDepthContours, "depthContours"],
  ])
    element.addEventListener("input", () => {
      journey[key] = Math.max(0, Math.min(1, Number(element.value) || 0));
      redraw();
    });
  e.journeyHome.addEventListener("click", () => {
    if (!isActive() || !journey.enabled) return;
    stop();
    journey.home();
    model.camera.reset();
    redraw();
  });
  e.journeyCancel.addEventListener("click", () => model.journeyFields.cancel());
  e.journeyLook.addEventListener("click", async () => {
    if (!allowed() || journey.warping) return;
    try {
      if (document.pointerLockElement === e.canvas) {
        unlock();
        return;
      }
      e.canvas.focus({ preventScroll: true });
      await e.canvas.requestPointerLock();
      lookMessage = "";
    } catch {
      lookMessage = "Mouse capture unavailable · drag to look instead.";
    }
    update();
  });
  e.canvas.addEventListener("keydown", (event) => {
    if (
      !allowed() ||
      !["KeyW", "KeyA", "KeyS", "KeyD"].includes(event.code) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (journey.warping) return;
    keys.add(event.code);
    startTick();
  });
  window.addEventListener("keyup", (event) => {
    keys.delete(event.code);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isActive() && journey.warping) {
      event.preventDefault();
      stop();
      redraw();
    }
  });
  window.addEventListener("blur", () => {
    const active = journey.warping;
    stop();
    if (active) redraw();
  });
  e.canvas.addEventListener("blur", () => {
    if (document.pointerLockElement !== e.canvas && !journey.warping) {
      keys.clear();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      unlock();
    }
  });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== e.canvas) {
      keys.clear();
      if (!journey.warping) lastTime = null;
    }
    update();
  });
  document.addEventListener("mousemove", (event) => {
    if (
      document.pointerLockElement !== e.canvas ||
      !allowed() ||
      journey.warping
    )
      return;
    model.camera.look(-event.movementX, -event.movementY);
    redraw();
  });
  function update() {
    if (!isActive() || !journey.enabled || !canInteract()) {
      stop();
      unlock();
    }
    journey.setRadarTime(performance.now() / 1000);
    e.journeyEnabled.checked = journey.enabled;
    e.journeySwapRB.checked = model.colorSwapRB;
    e.journeyOptions.hidden = !journey.enabled;
    const position = `${journey.section} · ${journey.position.map((v) => v.toFixed(1)).join(", ")}`;
    if (e.journeyPosition.textContent !== position)
      e.journeyPosition.textContent = position;
    if (displayedSeed !== journey.seed) {
      e.journeySeed.value = String(journey.seed);
      displayedSeed = journey.seed;
    }
    e.journeySpeedValue.textContent = String(journey.speed);
    const status = journey.warping
      ? `Warping · ${Math.round(journey.warpProgress * 100)}% · Esc cancels`
      : lookMessage || model.journeyFields.status;
    if (e.journeyStatus.textContent !== status)
      e.journeyStatus.textContent = status;
    drawMap();
    e.journeyProgress.hidden = model.journeyFields.state !== "baking";
    e.journeyProgress.value = model.journeyFields.progress;
    e.journeyCancel.hidden = model.journeyFields.state !== "baking";
    e.journeyLook.disabled =
      journey.warping || typeof e.canvas.requestPointerLock !== "function";
    e.journeyLook.textContent =
      document.pointerLockElement === e.canvas ? "Release mouse" : "Mouse look";
  }
  return { update, stop };
}
