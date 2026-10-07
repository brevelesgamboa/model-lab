import { clamp } from "../core/utils.js";
import { terminal } from "../ui/terminal.js";

/**
 * Calculates containment rectangle metrics (matching drawContain).
 */
export function getContainRect(containerW, containerH, contentW, contentH) {
  const sw = Math.max(1, contentW);
  const sh = Math.max(1, contentH);
  const scale = Math.min(containerW / sw, containerH / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  const dx = (containerW - dw) / 2;
  const dy = (containerH - dh) / 2;
  return { scale, dw, dh, dx, dy };
}

/**
 * Advanced Edge-Aware & Aperture-Bounded Flood Fill for Magic Wand object selection.
 * Features:
 * 1. Reach Radius limit: prevents selection from escaping beyond a local search radius.
 * 2. Perceptual color tolerance distance threshold: prevents color drift across gradients.
 * 3. Step barrier stopping at high-contrast edges: stops fill from crossing sharp borders.
 * 4. Morphological bridge cutting: erodes narrow 1-2px leaks and prunes disconnected puddles.
 * 5. Pinhole removal: fills 1px isolated holes inside object.
 */
export function floodFillSelect(
  sourceImageData,
  seedX,
  seedY,
  tolerance = 35,
  reachRadius = 150,
) {
  const { width, height, data } = sourceImageData;
  const mask = new Uint8Array(width * height);
  if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) {
    return mask;
  }

  const seedIdx = (seedY * width + seedX) * 4;
  const sR = data[seedIdx];
  const sG = data[seedIdx + 1];
  const sB = data[seedIdx + 2];

  // Perceptual color tolerance distance threshold
  const tol = clamp(Number(tolerance) || 35, 5, 100);
  const tolSq = tol * tol;

  // Reach radius threshold (0 or Infinity means unbounded)
  const maxR = Number(reachRadius) > 0 ? Number(reachRadius) : 0;
  const maxRSq = maxR > 0 ? maxR * maxR : Infinity;

  // Queue-based BFS flood fill with flat typed arrays
  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  queueX[tail] = seedX;
  queueY[tail] = seedY;
  tail += 1;
  mask[seedY * width + seedX] = 255;

  while (head < tail) {
    const x = queueX[head];
    const y = queueY[head];
    head += 1;

    const currIdx = (y * width + x) * 4;
    const cR = data[currIdx];
    const cG = data[currIdx + 1];
    const cB = data[currIdx + 2];
    const cLum = 0.299 * cR + 0.587 * cG + 0.114 * cB;

    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];

    for (let i = 0; i < 4; i += 1) {
      const [nx, ny] = neighbors[i];
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nPos = ny * width + nx;
        if (mask[nPos] === 0) {
          // 1. Reach Radius check
          if (maxRSq < Infinity) {
            const rx = nx - seedX;
            const ry = ny - seedY;
            if (rx * rx + ry * ry > maxRSq) {
              continue;
            }
          }

          const pIdx = nPos * 4;
          const nR = data[pIdx];
          const nG = data[pIdx + 1];
          const nB = data[pIdx + 2];
          const nLum = 0.299 * nR + 0.587 * nG + 0.114 * nB;

          // 2. Perceptual distance to seed color
          const drSeed = nR - sR;
          const dgSeed = nG - sG;
          const dbSeed = nB - sB;
          const seedDistSq =
            0.299 * drSeed * drSeed +
            0.587 * dgSeed * dgSeed +
            0.114 * dbSeed * dbSeed;

          // 3. Step edge-barrier: stops at sharp contrast boundaries
          const lumDiff = Math.abs(nLum - cLum);
          const rgbStep =
            Math.abs(nR - cR) + Math.abs(nG - cG) + Math.abs(nB - cB);

          // Must be within tolerance to seed and not jump high-contrast edge barrier
          if (seedDistSq <= tolSq && lumDiff < 40 && rgbStep < 95) {
            mask[nPos] = 255;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail += 1;
          }
        }
      }
    }
  }

  // Morphological bridge cutting (opening to prune narrow 1-2px leaks into background)
  if (tail > 16) {
    const eroded = new Uint8Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        if (
          mask[idx] === 255 &&
          mask[idx - 1] === 255 &&
          mask[idx + 1] === 255 &&
          mask[idx - width] === 255 &&
          mask[idx + width] === 255
        ) {
          eroded[idx] = 255;
        }
      }
    }

    const seedPos = seedY * width + seedX;
    if (eroded[seedPos] === 255) {
      const connected = new Uint8Array(width * height);
      const cQueueX = new Int32Array(width * height);
      const cQueueY = new Int32Array(width * height);
      let cHead = 0;
      let cTail = 0;

      cQueueX[cTail] = seedX;
      cQueueY[cTail] = seedY;
      cTail += 1;
      connected[seedPos] = 255;

      while (cHead < cTail) {
        const cx = cQueueX[cHead];
        const cy = cQueueY[cHead];
        cHead += 1;

        const cNeighbors = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];

        for (let i = 0; i < 4; i += 1) {
          const [nx, ny] = cNeighbors[i];
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const nPos = ny * width + nx;
            if (eroded[nPos] === 255 && connected[nPos] === 0) {
              connected[nPos] = 255;
              cQueueX[cTail] = nx;
              cQueueY[cTail] = ny;
              cTail += 1;
            }
          }
        }
      }

      // Dilate connected component back by 1 pixel, masked by original flood fill
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const idx = y * width + x;
          if (
            connected[idx] === 255 ||
            connected[idx - 1] === 255 ||
            connected[idx + 1] === 255 ||
            connected[idx - width] === 255 ||
            connected[idx + width] === 255
          ) {
            if (mask[idx] === 255) {
              mask[idx] = 255;
            }
          } else {
            mask[idx] = 0; // Cut off leaked islands
          }
        }
      }
    }
  }

  // Pinhole removal: fill single unselected pixels surrounded by 4 selected pixels
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      if (mask[idx] === 0) {
        if (
          mask[idx - 1] === 255 &&
          mask[idx + 1] === 255 &&
          mask[idx - width] === 255 &&
          mask[idx + width] === 255
        ) {
          mask[idx] = 255;
        }
      }
    }
  }

  return mask;
}

/**
 * Extracts a crisp boundary contour outline canvas for Photoshop/Paint.NET selection glow.
 */
export function extractContourBoundary(sourceCanvas) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const ctx = sourceCanvas.getContext("2d");
  const src = ctx.getImageData(0, 0, w, h).data;
  const boundaryCanvas = document.createElement("canvas");
  boundaryCanvas.width = w;
  boundaryCanvas.height = h;
  const bCtx = boundaryCanvas.getContext("2d");
  const bData = bCtx.createImageData(w, h);
  const dst = bData.data;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const idx = (y * w + x) * 4;
      if (src[idx + 3] > 30) {
        const isBoundary =
          x === 0 ||
          x === w - 1 ||
          y === 0 ||
          y === h - 1 ||
          src[((y - 1) * w + x) * 4 + 3] <= 30 ||
          src[((y + 1) * w + x) * 4 + 3] <= 30 ||
          src[(y * w + (x - 1)) * 4 + 3] <= 30 ||
          src[(y * w + (x + 1)) * 4 + 3] <= 30;

        if (isBoundary) {
          dst[idx] = 43;
          dst[idx + 1] = 219;
          dst[idx + 2] = 219;
          dst[idx + 3] = 255;
        }
      }
    }
  }
  bCtx.putImageData(bData, 0, 0);
  return boundaryCanvas;
}

export function createSpatialMaskController({
  elements,
  controlElements,
  getModel,
  setStatus,
  onParameterChange,
}) {
  let activeTool = null; // 'brush' | 'spotlight' | 'edges' | 'attention' | null
  let previewVisible = true;
  let isDraggingSpotlight = false;
  let isPainting = false;
  let brushMode = "paint"; // 'paint' | 'erase'
  let brushRadius = 40;
  let lastPaintCoords = null;
  let cursorNormPos = { x: 0.5, y: 0.5, inside: false };

  const isActive = () => getModel()?.id === "inception-dream";

  function getWorkingCanvas() {
    const model = getModel();
    if (!model || !model.sourceLoaded) return null;
    return model.sourceCanvas;
  }

  function ensureMaskCanvas() {
    const model = getModel();
    if (!model) return null;
    let canvas = model.customMaskCanvas;
    if (
      !canvas ||
      canvas.width !== model.workingWidth ||
      canvas.height !== model.workingHeight
    ) {
      canvas = document.createElement("canvas");
      canvas.width = model.workingWidth;
      canvas.height = model.workingHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      model.setCustomMaskCanvas(canvas);
    }
    return {
      canvas,
      ctx: canvas.getContext("2d", { willReadFrequently: true }),
    };
  }

  function applyBrushDab(u, v, mode) {
    const res = ensureMaskCanvas();
    if (!res) return;
    const { ctx } = res;
    ctx.save();
    if (mode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#ffffff";
    }
    ctx.beginPath();
    ctx.arc(u, v, brushRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function applyBrushStroke(fromCoords, toCoords, mode) {
    const res = ensureMaskCanvas();
    if (!res) return;
    const { ctx } = res;
    ctx.save();
    if (mode === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0, 0, 0, 1)";
      ctx.fillStyle = "rgba(0, 0, 0, 1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#ffffff";
    }
    ctx.lineWidth = brushRadius * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(fromCoords.u, fromCoords.v);
    ctx.lineTo(toCoords.u, toCoords.v);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(toCoords.u, toCoords.v, brushRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function computeMaskCoverage(maskCanvas) {
    if (!maskCanvas) return "0.0";
    const ctx = maskCanvas.getContext("2d");
    const { width, height } = maskCanvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    let selected = 0;
    const total = width * height;
    const step = 4;
    for (let i = 3; i < data.length; i += 4 * step) {
      if (data[i] > 10) selected += 1;
    }
    const sampleTotal = total / step;
    return ((selected / sampleTotal) * 100).toFixed(1);
  }

  function syncOverlayDimensions() {
    const canvas = elements.canvas;
    const overlay = elements.maskOverlayCanvas;
    if (!overlay || !canvas) return;
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }
  }

  function syncSidebarControl(key, value) {
    if (controlElements) {
      const ctrl = controlElements.get(key);
      if (ctrl) {
        if (ctrl.slider) ctrl.slider.value = String(value);
        if (ctrl.fine) ctrl.fine.value = String(value);
        if (ctrl.select) ctrl.select.value = String(value);
        ctrl.guidance?.update?.(value);
      }
    }
    onParameterChange?.(key, value);
  }

  function renderContextualOptions() {
    const container = elements.spatialToolOptions;
    if (!container) return;
    const model = getModel();
    if (!isActive() || !model?.sourceLoaded) {
      container.hidden = true;
      container.replaceChildren();
      return;
    }

    const currentFocus = model.parameters?.spatialFocus || "full";
    const currentTool =
      activeTool ||
      (currentFocus === "spotlight"
        ? "spotlight"
        : currentFocus === "edges"
          ? "edges"
          : currentFocus === "attention"
            ? "attention"
            : currentFocus === "custom"
              ? "brush"
              : null);

    if (!currentTool || currentFocus === "full") {
      container.hidden = true;
      container.replaceChildren();
      return;
    }

    container.hidden = false;
    container.replaceChildren();

    if (currentTool === "spotlight") {
      // Radius control
      const radGroup = document.createElement("div");
      radGroup.className = "option-group";
      const radLabel = document.createElement("span");
      radLabel.className = "option-label";
      radLabel.textContent = "RADIUS:";
      const radSlider = document.createElement("input");
      radSlider.type = "range";
      radSlider.min = "30";
      radSlider.max = "250";
      radSlider.step = "5";
      const currRadius = Number(
        model.parameters?.spotlightRadius ||
          model.spotlightState?.radius ||
          120,
      );
      radSlider.value = String(currRadius);
      const radVal = document.createElement("span");
      radVal.className = "option-value";
      radVal.textContent = `${currRadius}px`;

      radSlider.addEventListener("input", () => {
        const val = Number(radSlider.value);
        radVal.textContent = `${val}px`;
        model.parameters.spotlightRadius = val;
        if (model.spotlightState) model.spotlightState.radius = val;
        syncSidebarControl("spotlightRadius", val);
        renderOverlay();
      });
      radGroup.append(radLabel, radSlider, radVal);

      // Hardness control
      const hardGroup = document.createElement("div");
      hardGroup.className = "option-group";
      const hardLabel = document.createElement("span");
      hardLabel.className = "option-label";
      hardLabel.textContent = "HARDNESS:";
      const hardSlider = document.createElement("input");
      hardSlider.type = "range";
      hardSlider.min = "0";
      hardSlider.max = "100";
      hardSlider.step = "5";
      const currHardness = Number(
        model.parameters?.spotlightHardness ??
          model.spotlightState?.hardness ??
          0.8,
      );
      hardSlider.value = String(Math.round(currHardness * 100));
      const hardVal = document.createElement("span");
      hardVal.className = "option-value";
      hardVal.textContent = `${hardSlider.value}%`;

      hardSlider.addEventListener("input", () => {
        const val = Number(hardSlider.value) / 100;
        hardVal.textContent = `${hardSlider.value}%`;
        model.parameters.spotlightHardness = val;
        if (model.spotlightState) {
          model.spotlightState.hardness = val;
          model.spotlightState.feather = 1.0 - val;
        }
        syncSidebarControl("spotlightHardness", val);
        renderOverlay();
      });
      hardGroup.append(hardLabel, hardSlider, hardVal);

      const hint = document.createElement("span");
      hint.className = "option-hint";
      hint.textContent = "Scroll wheel over image to resize";

      container.append(radGroup, hardGroup, hint);
    } else if (currentTool === "brush" || currentTool === "wand") {
      // Mode controls: PAINT vs ERASE
      const modeGroup = document.createElement("div");
      modeGroup.className = "option-group";
      const modeLabel = document.createElement("span");
      modeLabel.className = "option-label";
      modeLabel.textContent = "MODE:";

      const paintBtn = document.createElement("button");
      paintBtn.type = "button";
      paintBtn.className = `mode-btn ${brushMode === "paint" ? "is-active" : ""}`;
      paintBtn.textContent = "PAINT";

      const eraseBtn = document.createElement("button");
      eraseBtn.type = "button";
      eraseBtn.className = `mode-btn ${brushMode === "erase" ? "is-erase-active" : ""}`;
      eraseBtn.textContent = "ERASE";

      paintBtn.addEventListener("click", () => {
        brushMode = "paint";
        paintBtn.className = "mode-btn is-active";
        eraseBtn.className = "mode-btn";
        renderOverlay();
      });

      eraseBtn.addEventListener("click", () => {
        brushMode = "erase";
        paintBtn.className = "mode-btn";
        eraseBtn.className = "mode-btn is-erase-active";
        renderOverlay();
      });

      modeGroup.append(modeLabel, paintBtn, eraseBtn);

      // Brush Radius control
      const radGroup = document.createElement("div");
      radGroup.className = "option-group";
      const radLabel = document.createElement("span");
      radLabel.className = "option-label";
      radLabel.textContent = "RADIUS:";
      const radSlider = document.createElement("input");
      radSlider.type = "range";
      radSlider.min = "10";
      radSlider.max = "150";
      radSlider.step = "5";
      const currRadius = Number(
        model.parameters?.brushRadius || brushRadius || 40,
      );
      brushRadius = currRadius;
      radSlider.value = String(currRadius);
      const radVal = document.createElement("span");
      radVal.className = "option-value";
      radVal.textContent = `${currRadius}px`;

      radSlider.addEventListener("input", () => {
        const val = Number(radSlider.value);
        radVal.textContent = `${val}px`;
        brushRadius = val;
        model.parameters.brushRadius = val;
        syncSidebarControl("brushRadius", val);
        renderOverlay();
      });
      radGroup.append(radLabel, radSlider, radVal);

      // Action buttons: Clear & Invert
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "mode-btn";
      clearBtn.textContent = "CLEAR";
      clearBtn.addEventListener("click", () => {
        if (model.customMaskCanvas) {
          const ctx = model.customMaskCanvas.getContext("2d");
          ctx.clearRect(
            0,
            0,
            model.customMaskCanvas.width,
            model.customMaskCanvas.height,
          );
        }
        model.clearCustomMask();
        renderOverlay();
        setStatus("CUSTOM MASK CLEARED");
        terminal("BRUSH", "Custom mask cleared");
        updateToolbarState();
      });

      const invertBtn = document.createElement("button");
      invertBtn.type = "button";
      invertBtn.className = "mode-btn";
      invertBtn.textContent = "INVERT";
      invertBtn.addEventListener("click", () => {
        model.invertCustomMask();
        renderOverlay();
        setStatus("CUSTOM MASK INVERTED");
        terminal("BRUSH", "Mask inverted");
        updateToolbarState();
      });

      const hint = document.createElement("span");
      hint.className = "option-hint";
      hint.textContent = "Scroll wheel to resize · Alt+drag to erase";

      container.append(modeGroup, radGroup, clearBtn, invertBtn, hint);
    } else if (currentTool === "edges" || currentTool === "attention") {
      const sensGroup = document.createElement("div");
      sensGroup.className = "option-group";
      const sensLabel = document.createElement("span");
      sensLabel.className = "option-label";
      sensLabel.textContent = "SENSITIVITY:";
      const sensSlider = document.createElement("input");
      sensSlider.type = "range";
      sensSlider.min = "0.1";
      sensSlider.max = "1.0";
      sensSlider.step = "0.05";
      const currSens = Number(model.parameters?.edgeSensitivity || 0.5);
      sensSlider.value = String(currSens);
      const sensVal = document.createElement("span");
      sensVal.className = "option-value";
      sensVal.textContent = currSens.toFixed(2);

      sensSlider.addEventListener("input", () => {
        const val = Number(sensSlider.value);
        sensVal.textContent = val.toFixed(2);
        model.parameters.edgeSensitivity = val;
        syncSidebarControl("edgeSensitivity", val);
      });
      sensGroup.append(sensLabel, sensSlider, sensVal);

      const reextractBtn = document.createElement("button");
      reextractBtn.className = "mini-button";
      reextractBtn.type = "button";
      reextractBtn.textContent =
        currentTool === "edges" ? "RE-DETECT" : "RE-SELECT SUBJECT";
      reextractBtn.addEventListener("click", async () => {
        if (currentTool === "edges") {
          setStatus("RE-EXTRACTING SOBEL CONTOURS...");
          await model.extractAndApplyEdgeMask();
          setStatus("EDGE CONTOUR MASK UPDATED");
        } else {
          setStatus("RE-EXTRACTING INCEPTIONV3 ATTENTION...");
          await model.extractAndApplyNeuralAttentionMask();
          setStatus("SUBJECT SELECTED (INCEPTIONV3 ATTENTION) · REFINE WITH BRUSH");
        }
        renderOverlay();
      });

      const hint = document.createElement("span");
      hint.className = "option-hint";
      hint.textContent =
        currentTool === "edges"
          ? "Sobel edge contours"
          : "InceptionV3 subject isolation · Refine or carve with BRUSH";

      container.append(sensGroup, reextractBtn, hint);
    }
  }

  function renderOverlay() {
    const overlay = elements.maskOverlayCanvas;
    if (!overlay) return;
    const model = getModel();

    if (!isActive() || !model?.sourceLoaded || !previewVisible) {
      overlay.hidden = true;
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    syncOverlayDimensions();
    overlay.hidden = false;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const contain = getContainRect(
      overlay.width,
      overlay.height,
      model.workingWidth,
      model.workingHeight,
    );

    // Strictly clip all mask and spotlight rendering inside the image frame
    ctx.save();
    ctx.beginPath();
    ctx.rect(contain.dx, contain.dy, contain.dw, contain.dh);
    ctx.clip();

    // 1. Draw Custom Mask or Active Edge/Attention Mask if present
    if (model.customMaskCanvas && model.customMaskActive) {
      ctx.save();
      ctx.imageSmoothingEnabled = false;

      // Draw tinted mask layer
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = model.workingWidth;
      tempCanvas.height = model.workingHeight;
      const tCtx = tempCanvas.getContext("2d");

      tCtx.drawImage(model.customMaskCanvas, 0, 0);
      tCtx.globalCompositeOperation = "source-in";
      tCtx.fillStyle = "rgba(43, 219, 219, 0.35)"; // Cyan tint over selected pixels
      tCtx.fillRect(0, 0, model.workingWidth, model.workingHeight);

      // Extract boundary contours for crisp Photoshop/Paint.NET outline
      const boundaryCanvas = extractContourBoundary(model.customMaskCanvas);

      ctx.drawImage(
        tempCanvas,
        0,
        0,
        model.workingWidth,
        model.workingHeight,
        contain.dx,
        contain.dy,
        contain.dw,
        contain.dh,
      );

      ctx.drawImage(
        boundaryCanvas,
        0,
        0,
        model.workingWidth,
        model.workingHeight,
        contain.dx,
        contain.dy,
        contain.dw,
        contain.dh,
      );
      ctx.restore();
    }

    // 2. Draw Brush or Wand Aperture Ring around cursor if active
    if (activeTool === "brush" && cursorNormPos?.inside) {
      const cx = contain.dx + cursorNormPos.x * contain.dw;
      const cy = contain.dy + cursorNormPos.y * contain.dh;
      const r = (brushRadius / model.workingWidth) * contain.dw;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      if (brushMode === "erase") {
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255, 95, 86, 0.95)";
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(43, 219, 219, 0.95)";
        ctx.shadowColor = "rgba(43, 219, 219, 0.7)";
        ctx.shadowBlur = 4;
      }
      ctx.stroke();

      // Center dot
      ctx.beginPath();
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.restore();
    } else if (activeTool === "wand" && cursorNormPos?.inside) {
      const wandRadius = Number(model.parameters?.wandRadius || 150);
      const cx = contain.dx + cursorNormPos.x * contain.dw;
      const cy = contain.dy + cursorNormPos.y * contain.dh;
      const r = (wandRadius / model.workingWidth) * contain.dw;

      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(43, 219, 219, 0.8)";
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // 3. Draw Spotlight HUD if spotlight mode/tool is active
    const isSpotlightActive =
      model.spotlightState?.active ||
      activeTool === "spotlight" ||
      model.parameters?.spatialFocus === "spotlight";

    if (isSpotlightActive) {
      const sp = model.spotlightState || {
        x: 0.5,
        y: 0.5,
        radius: 120,
        hardness: 0.8,
      };
      const radius = Number(
        model.parameters?.spotlightRadius || sp.radius || 120,
      );
      const hardness = clamp(
        Number(model.parameters?.spotlightHardness ?? sp.hardness ?? 0.8),
        0.0,
        1.0,
      );
      const cx = contain.dx + (sp.x ?? 0.5) * contain.dw;
      const cy = contain.dy + (sp.y ?? 0.5) * contain.dh;
      const r = (radius / model.workingWidth) * contain.dw;
      const rInner = Math.max(0, r * hardness);

      ctx.save();
      // Outer darkened vignette over unselected regions
      ctx.fillStyle = "rgba(5, 3, 10, 0.50)";
      ctx.beginPath();
      ctx.rect(contain.dx, contain.dy, contain.dw, contain.dh);
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2, true);
      ctx.fill();

      // Smooth radial gradient for feathering/hardness zone
      if (hardness < 0.98) {
        const grad = ctx.createRadialGradient(
          cx,
          cy,
          rInner,
          cx,
          cy,
          Math.max(1, r),
        );
        grad.addColorStop(0, "rgba(5, 3, 10, 0)");
        grad.addColorStop(1, "rgba(5, 3, 10, 0.50)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
        ctx.fill();
      }

      // Glowing spotlight boundary circle
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1, r), 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(43, 219, 219, 0.95)";
      ctx.shadowColor = "rgba(43, 219, 219, 0.8)";
      ctx.shadowBlur = 8;
      ctx.stroke();

      // Inner boundary circle (if feathered)
      if (hardness < 0.92 && rInner > 6) {
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.arc(cx, cy, rInner, 0, Math.PI * 2);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(43, 219, 219, 0.45)";
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Reticle center crosshair
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy);
      ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx, cy + 6);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  function updateToolbarState() {
    const active = isActive();
    const model = getModel();
    const sourceLoaded = Boolean(active && model?.sourceLoaded);
    const spatialFocus = model?.parameters?.spatialFocus || "full";

    if (elements.neuralDreamSpatialTools) {
      elements.neuralDreamSpatialTools.hidden = !active;
    }

    const brushBtn = elements.spatialToolBrush || elements.spatialToolWand;
    if (brushBtn) {
      brushBtn.disabled = !sourceLoaded;
      brushBtn.classList.toggle(
        "is-active",
        activeTool === "brush" ||
          activeTool === "wand" ||
          (spatialFocus === "custom" && activeTool !== "spotlight"),
      );
    }
    if (elements.spatialToolSpotlight) {
      elements.spatialToolSpotlight.disabled = !sourceLoaded;
      elements.spatialToolSpotlight.classList.toggle(
        "is-active",
        activeTool === "spotlight" || spatialFocus === "spotlight",
      );
    }
    if (elements.spatialToolEdges) {
      elements.spatialToolEdges.disabled = !sourceLoaded;
      elements.spatialToolEdges.classList.toggle(
        "is-active",
        activeTool === "edges" || spatialFocus === "edges",
      );
    }
    if (elements.spatialToolAttention) {
      elements.spatialToolAttention.disabled =
        !sourceLoaded || !model.ready;
      elements.spatialToolAttention.classList.toggle(
        "is-active",
        activeTool === "attention" || spatialFocus === "attention",
      );
      elements.spatialToolAttention.title = model.ready
        ? "Select Subject: 1-click InceptionV3 semantic segmentation (can refine with BRUSH)"
        : "Load GPU Model first to select subject";
    }
    if (elements.spatialToolPreview) {
      elements.spatialToolPreview.disabled = !sourceLoaded;
      elements.spatialToolPreview.classList.toggle(
        "is-active",
        previewVisible,
      );
      elements.spatialToolPreview.textContent = previewVisible
        ? "PREVIEW: ON"
        : "PREVIEW: OFF";
    }
    if (elements.spatialToolInvert) {
      elements.spatialToolInvert.disabled =
        !sourceLoaded ||
        (!model.customMaskActive && !model.spotlightState?.active);
    }
    if (elements.spatialToolClear) {
      elements.spatialToolClear.disabled =
        !sourceLoaded ||
        (spatialFocus === "full" &&
          !model.customMaskActive &&
          !model.spotlightState?.active);
    }

    // Toggle cursor class on output canvas
    if (elements.canvas) {
      elements.canvas.classList.toggle(
        "is-brush-active",
        activeTool === "brush",
      );
      elements.canvas.classList.toggle(
        "is-wand-active",
        activeTool === "wand",
      );
      elements.canvas.classList.toggle(
        "is-spotlight-active",
        activeTool === "spotlight" || spatialFocus === "spotlight",
      );
    }

    renderContextualOptions();
    renderOverlay();
  }

  function mapEventToImage(event) {
    const canvas = elements.canvas;
    const model = getModel();
    if (!canvas || !model || !model.sourceLoaded) return null;

    const rect = canvas.getBoundingClientRect();
    const cx = (event.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (event.clientY - rect.top) * (canvas.height / rect.height);

    const contain = getContainRect(
      canvas.width,
      canvas.height,
      model.workingWidth,
      model.workingHeight,
    );

    if (
      cx < contain.dx ||
      cx > contain.dx + contain.dw ||
      cy < contain.dy ||
      cy > contain.dy + contain.dh
    ) {
      return null;
    }

    const u = Math.floor(
      ((cx - contain.dx) / contain.dw) * model.workingWidth,
    );
    const v = Math.floor(
      ((cy - contain.dy) / contain.dh) * model.workingHeight,
    );

    return {
      u: Math.max(0, Math.min(model.workingWidth - 1, u)),
      v: Math.max(0, Math.min(model.workingHeight - 1, v)),
      normX: (cx - contain.dx) / contain.dw,
      normY: (cy - contain.dy) / contain.dh,
    };
  }

  function handleCanvasClick(event) {
    if (!isActive()) return;
    const model = getModel();
    if (!model?.sourceLoaded) return;

    const coords = mapEventToImage(event);
    if (!coords) return;

    if (activeTool === "wand") {
      const sourceCanvas = getWorkingCanvas();
      if (!sourceCanvas) return;
      const ctx = sourceCanvas.getContext("2d");
      const imgData = ctx.getImageData(
        0,
        0,
        model.workingWidth,
        model.workingHeight,
      );

      const tolerance = Number(model.parameters?.wandTolerance || 35);
      const reachRadius = Number(model.parameters?.wandRadius || 150);
      const maskBytes = floodFillSelect(
        imgData,
        coords.u,
        coords.v,
        tolerance,
        reachRadius,
      );

      // Create mask canvas
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = model.workingWidth;
      maskCanvas.height = model.workingHeight;
      const mCtx = maskCanvas.getContext("2d");
      const maskImgData = mCtx.createImageData(
        model.workingWidth,
        model.workingHeight,
      );

      let selectedCount = 0;
      for (let i = 0; i < maskBytes.length; i += 1) {
        const val = maskBytes[i];
        if (val > 0) selectedCount += 1;
        maskImgData.data[i * 4] = val;
        maskImgData.data[i * 4 + 1] = val;
        maskImgData.data[i * 4 + 2] = val;
        maskImgData.data[i * 4 + 3] = val > 0 ? 255 : 0; // Alpha strictly 255 for selected, 0 for unselected
      }
      mCtx.putImageData(maskImgData, 0, 0);

      model.setCustomMaskCanvas(maskCanvas);
      model.parameters.spatialFocus = "custom";
      syncSidebarControl("spatialFocus", "custom");
      previewVisible = true;

      const pct = (
        (selectedCount / (model.workingWidth * model.workingHeight)) *
        100
      ).toFixed(1);
      terminal(
        "WAND",
        `Selected object at (${coords.u}, ${coords.v}) [radius: ${reachRadius}px] — ${pct}% of canvas`,
      );
      setStatus(`MASK SET: OBJECT SELECTED (${pct}%)`);
      updateToolbarState();
    } else if (activeTool === "spotlight") {
      const radius = Number(model.parameters?.spotlightRadius || 120);
      const hardness = Number(model.parameters?.spotlightHardness ?? 0.8);
      model.setSpotlight(coords.normX, coords.normY, radius, hardness);
      model.parameters.spatialFocus = "spotlight";
      syncSidebarControl("spatialFocus", "spotlight");
      previewVisible = true;

      terminal(
        "SPOTLIGHT",
        `Focus positioned at (${Math.round(coords.normX * 100)}%, ${Math.round(coords.normY * 100)}%)`,
      );
      setStatus("SPOTLIGHT FOCUS ACTIVE");
      updateToolbarState();
    }
  }

  function handlePointerDown(event) {
    if (!isActive()) return;
    const model = getModel();
    if (!model?.sourceLoaded) return;

    if (activeTool === "spotlight") {
      const coords = mapEventToImage(event);
      if (!coords) return;
      isDraggingSpotlight = true;
      handleCanvasClick(event);
      return;
    }

    if (activeTool === "brush") {
      event.preventDefault();
      const coords = mapEventToImage(event);
      if (!coords) return;
      isPainting = true;
      const effectiveMode =
        event.altKey || event.button === 2 ? "erase" : brushMode;
      applyBrushDab(coords.u, coords.v, effectiveMode);
      lastPaintCoords = { u: coords.u, v: coords.v };
      model.customMaskActive = true;
      model.parameters.spatialFocus = "custom";
      syncSidebarControl("spatialFocus", "custom");
      previewVisible = true;
      renderOverlay();
    }
  }

  function handlePointerMove(event) {
    if (!isActive()) return;
    const coords = mapEventToImage(event);
    if (coords) {
      cursorNormPos = { x: coords.normX, y: coords.normY, inside: true };
    } else {
      cursorNormPos.inside = false;
    }

    if (isPainting && activeTool === "brush") {
      event.preventDefault();
      if (coords) {
        const effectiveMode =
          event.altKey || event.buttons === 2 ? "erase" : brushMode;
        if (lastPaintCoords) {
          applyBrushStroke(lastPaintCoords, coords, effectiveMode);
        } else {
          applyBrushDab(coords.u, coords.v, effectiveMode);
        }
        lastPaintCoords = { u: coords.u, v: coords.v };
        renderOverlay();
      }
      return;
    }

    if (activeTool === "brush" || activeTool === "wand") {
      renderOverlay();
      return;
    }

    if (!isDraggingSpotlight || activeTool !== "spotlight") {
      return;
    }
    if (!coords) return;
    const model = getModel();
    const radius = Number(model.parameters?.spotlightRadius || 120);
    const hardness = Number(model.parameters?.spotlightHardness ?? 0.8);
    model.setSpotlight(coords.normX, coords.normY, radius, hardness);
    renderOverlay();
  }

  function handlePointerUp() {
    isDraggingSpotlight = false;
    if (isPainting && activeTool === "brush") {
      isPainting = false;
      lastPaintCoords = null;
      const model = getModel();
      if (model?.customMaskCanvas) {
        const pct = computeMaskCoverage(model.customMaskCanvas);
        terminal(
          "BRUSH",
          `Painted mask [radius: ${brushRadius}px, mode: ${brushMode}] — ${pct}% of canvas`,
        );
        setStatus(`MASK SET: BRUSH (${pct}%)`);
        updateToolbarState();
      }
    }
  }

  function handlePointerLeave() {
    cursorNormPos.inside = false;
    if (isPainting && activeTool === "brush") {
      isPainting = false;
      lastPaintCoords = null;
    }
    renderOverlay();
  }

  async function onSpatialFocusSelect(focusValue) {
    const model = getModel();
    if (!isActive() || !model?.sourceLoaded) return;

    if (focusValue === "spotlight") {
      activeTool = "spotlight";
      if (!model.spotlightState?.active) {
        model.setSpotlight(
          0.5,
          0.5,
          Number(model.parameters?.spotlightRadius || 120),
          Number(model.parameters?.spotlightHardness ?? 0.8),
        );
      }
      previewVisible = true;
      setStatus("SPOTLIGHT FOCUS ACTIVE: POSITION BEAM ON CANVAS");
    } else if (focusValue === "custom") {
      activeTool = "brush";
      previewVisible = true;
      setStatus("BRUSH ACTIVE: PAINT OR ERASE MASK ON CANVAS (SCROLL TO RESIZE)");
    } else if (focusValue === "edges") {
      activeTool = "edges";
      previewVisible = true;
      setStatus("EXTRACTING SOBEL CONTOURS...");
      await model.extractAndApplyEdgeMask();
      setStatus("EDGE CONTOUR MASK ACTIVE");
    } else if (focusValue === "attention") {
      activeTool = "attention";
      previewVisible = true;
      if (model.ready) {
        setStatus("EXTRACTING INCEPTIONV3 ATTENTION...");
        await model.extractAndApplyNeuralAttentionMask();
        setStatus("SUBJECT SELECTED (INCEPTIONV3 ATTENTION) · REFINE WITH BRUSH");
      } else {
        setStatus("LOAD GPU MODEL TO SELECT SUBJECT");
      }
    } else if (focusValue === "full") {
      activeTool = null;
      model.clearCustomMask();
      setStatus("FULL FRAME SYNTHESIS ACTIVE");
    }

    updateToolbarState();
  }

  // Bind spatial tool buttons
  const brushBtn = elements.spatialToolBrush || elements.spatialToolWand;
  brushBtn?.addEventListener("click", () => {
    activeTool = activeTool === "brush" ? null : "brush";
    if (activeTool === "brush") {
      const model = getModel();
      if (model?.parameters) model.parameters.spatialFocus = "custom";
      syncSidebarControl("spatialFocus", "custom");
      previewVisible = true;
      setStatus("BRUSH ACTIVE: PAINT OR ERASE MASK ON CANVAS (SCROLL TO RESIZE)");
      terminal(
        "TOOL",
        "Brush Mask selected — scroll wheel to resize radius, left-click drag to paint, Alt/right-drag to erase",
      );
    }
    updateToolbarState();
  });

  elements.spatialToolSpotlight?.addEventListener("click", () => {
    activeTool = activeTool === "spotlight" ? null : "spotlight";
    if (activeTool === "spotlight") {
      const model = getModel();
      if (!model.spotlightState?.active) {
        model.setSpotlight(
          0.5,
          0.5,
          Number(model.parameters?.spotlightRadius || 120),
          Number(model.parameters?.spotlightHardness ?? 0.8),
        );
      }
      if (model?.parameters) model.parameters.spatialFocus = "spotlight";
      syncSidebarControl("spatialFocus", "spotlight");
      setStatus("SPOTLIGHT ACTIVE: CLICK/DRAG TO POSITION FOCUS");
      terminal("TOOL", "Interactive Spotlight selected — position focus on canvas");
    }
    updateToolbarState();
  });

  elements.spatialToolEdges?.addEventListener("click", async () => {
    const model = getModel();
    if (!isActive() || !model?.sourceLoaded) return;
    activeTool = "edges";
    setStatus("EXTRACTING SOBEL CONTOURS...");
    await model.extractAndApplyEdgeMask();
    syncSidebarControl("spatialFocus", "edges");
    previewVisible = true;
    setStatus("EDGE CONTOUR MASK ACTIVE");
    terminal("MASK", "Sobel edge contours extracted");
    updateToolbarState();
  });

  elements.spatialToolAttention?.addEventListener("click", async () => {
    const model = getModel();
    if (!isActive() || !model?.sourceLoaded || !model.ready) return;
    activeTool = "attention";
    setStatus("EXTRACTING INCEPTIONV3 ATTENTION...");
    try {
      await model.extractAndApplyNeuralAttentionMask();
      syncSidebarControl("spatialFocus", "attention");
      previewVisible = true;
      setStatus("SUBJECT SELECTED (INCEPTIONV3 ATTENTION) · REFINE WITH BRUSH");
      terminal(
        "ATTENTION",
        "InceptionV3 semantic saliency map extracted (primary subject isolated — select BRUSH to refine/erase)",
      );
    } catch (err) {
      setStatus(`ATTENTION FAILED: ${err.message}`);
      terminal("ATTENTION", err.message, "warning");
    } finally {
      updateToolbarState();
    }
  });

  elements.spatialToolPreview?.addEventListener("click", () => {
    previewVisible = !previewVisible;
    updateToolbarState();
  });

  elements.spatialToolInvert?.addEventListener("click", () => {
    const model = getModel();
    if (!isActive() || !model) return;
    model.invertCustomMask();
    terminal("MASK", "Active mask inverted");
    setStatus("MASK INVERTED");
    updateToolbarState();
  });

  elements.spatialToolClear?.addEventListener("click", () => {
    const model = getModel();
    if (!isActive() || !model) return;
    model.clearCustomMask();
    activeTool = null;
    syncSidebarControl("spatialFocus", "full");
    terminal("MASK", "Custom mask cleared (full frame)");
    setStatus("MASK CLEARED — FULL FRAME ACTIVE");
    updateToolbarState();
  });

  // Mouse wheel listener for resizing brush radius or spotlight radius dynamically
  elements.canvas?.addEventListener(
    "wheel",
    (event) => {
      const model = getModel();
      if (!isActive() || !model?.sourceLoaded) return;

      if (activeTool === "brush") {
        event.preventDefault();
        const step = event.deltaY < 0 ? 5 : -5;
        brushRadius = clamp(brushRadius + step, 10, 150);
        model.parameters.brushRadius = brushRadius;
        syncSidebarControl("brushRadius", brushRadius);
        renderContextualOptions();
        renderOverlay();
      } else if (activeTool === "wand") {
        event.preventDefault();
        const currentR = Number(model.parameters?.wandRadius || 150);
        const step = event.deltaY < 0 ? 10 : -10;
        const newR = clamp(currentR + step, 30, 400);
        model.parameters.wandRadius = newR;
        syncSidebarControl("wandRadius", newR);
        renderContextualOptions();
        renderOverlay();
      } else if (
        activeTool === "spotlight" ||
        model?.parameters?.spatialFocus === "spotlight" ||
        model?.spotlightState?.active
      ) {
        event.preventDefault();
        const currentR = Number(
          model.spotlightState?.radius ||
            model.parameters?.spotlightRadius ||
            120,
        );
        const step = event.deltaY < 0 ? 10 : -10;
        const newR = clamp(currentR + step, 30, 250);
        const hardness = Number(
          model.spotlightState?.hardness ??
            model.parameters?.spotlightHardness ??
            0.8,
        );
        model.setSpotlight(
          model.spotlightState?.x ?? 0.5,
          model.spotlightState?.y ?? 0.5,
          newR,
          hardness,
        );
        model.parameters.spotlightRadius = newR;
        syncSidebarControl("spotlightRadius", newR);
        renderContextualOptions();
        renderOverlay();
      }
    },
    { passive: false },
  );

  // Suppress context menu on canvas so right-drag erases smoothly
  elements.canvas?.addEventListener("contextmenu", (event) => {
    if (activeTool === "brush") {
      event.preventDefault();
    }
  });

  // Attach canvas pointer listeners
  elements.canvas?.addEventListener("click", handleCanvasClick);
  elements.canvas?.addEventListener("pointerdown", handlePointerDown);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  elements.canvas?.addEventListener("pointerleave", handlePointerLeave);

  return {
    updateToolbarState,
    renderOverlay,
    renderContextualOptions,
    onSpatialFocusSelect,
    getActiveTool: () => activeTool,
    setPreviewVisible: (v) => {
      previewVisible = Boolean(v);
      updateToolbarState();
    },
  };
}
