import { encodeAnimatedGif } from "../core/gif-encoder.js";
import {
  deepClone,
  downloadBlob,
  formatTimestampForFile,
  nextFrame,
} from "../core/utils.js";
import { terminal } from "../ui/terminal.js";
import { captureCapabilities } from "../core/model-contract.js";

export function createExportController({
  elements,
  capabilities,
  hqGallery,
  getState,
  onBusyChange,
  renderCurrentFrame,
  effectiveParametersAt,
  selectedLoopPreset,
  updateFractalTools,
  setStatus,
}) {
  function outputFilename(
    extension,
    width = elements.canvas.width,
    height = elements.canvas.height,
  ) {
    const model = getState().model?.name || "LATENT FIELD";
    const safeModel = model.replace(/[^a-z0-9]+/gi, "_");
    return (
      safeModel +
      "_" +
      formatTimestampForFile() +
      "_" +
      width +
      "x" +
      height +
      "." +
      extension
    );
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not encode this render"));
      }, "image/png");
    });
  }

  function highQualityDimensions(requestedLongEdge) {
    const safeLongEdge = Math.max(
      512,
      Math.min(
        Number(requestedLongEdge) || 2048,
        capabilities.maxTextureSize || 2048,
      ),
    );
    const screenWidth = Math.max(
      1,
      window.screen?.width || window.innerWidth || 16,
    );
    const screenHeight = Math.max(
      1,
      window.screen?.height || window.innerHeight || 9,
    );
    const aspect = screenWidth / screenHeight;
    if (aspect >= 1)
      return {
        width: safeLongEdge,
        height: Math.max(1, Math.round(safeLongEdge / aspect)),
      };
    return {
      width: Math.max(1, Math.round(safeLongEdge * aspect)),
      height: safeLongEdge,
    };
  }

  function updateModalLabels() {
    const model = getState().model;
    const isDream = model?.id === "inception-dream";
    const capture = captureCapabilities(model);
    const radio2k = elements.exportOption2k?.querySelector(
      'input[type="radio"]',
    );
    const radio4k = elements.exportOption4k?.querySelector(
      'input[type="radio"]',
    );
    if (radio2k) radio2k.disabled = !capture.highResolution;
    elements.exportOption2k?.classList.toggle(
      "is-disabled",
      !capture.highResolution,
    );
    if (!capture.highResolution) {
      if (radio4k) radio4k.disabled = true;
      elements.exportOption4k?.classList.add("is-disabled");
      const current = elements.exportModal?.querySelector(
        'input[value="current"]',
      );
      if (current) current.checked = true;
      if (elements.exportNameCurrent)
        elements.exportNameCurrent.textContent = "CURRENT SNAPSHOT";
      if (elements.exportResCurrent)
        elements.exportResCurrent.textContent = `${elements.canvas.width} × ${elements.canvas.height} (DISPLAY · ${model.simulationSize}² GRID)`;
      if (elements.exportName2k) elements.exportName2k.textContent = "2K OUTPUT";
      if (elements.exportName4k) elements.exportName4k.textContent = "4K OUTPUT";
      if (elements.exportRes2k)
        elements.exportRes2k.textContent = "Not supported for this simulation";
      if (elements.exportRes4k)
        elements.exportRes4k.textContent = "Not supported for this simulation";
      return;
    }

    if (elements.exportResCurrent) {
      if (isDream && model.dreamCanvas?.width) {
        elements.exportResCurrent.textContent = `${model.dreamCanvas.width} × ${model.dreamCanvas.height} (NATIVE PEAK)`;
        if (elements.exportNameCurrent)
          elements.exportNameCurrent.textContent = "CURRENT PEAK CANVAS";
      } else {
        elements.exportResCurrent.textContent = `${elements.canvas.width} × ${elements.canvas.height}`;
        if (elements.exportNameCurrent)
          elements.exportNameCurrent.textContent = "CURRENT VIEWPORT";
      }
    }

    if (isDream && model.sourceImage) {
      const srcW = model.sourceImage.width;
      const srcH = model.sourceImage.height;
      const aspect = srcW / srcH;
      const w2k = aspect >= 1 ? 2048 : Math.max(1, Math.round(2048 * aspect));
      const h2k = aspect >= 1 ? Math.max(1, Math.round(2048 / aspect)) : 2048;

      if (elements.exportName2k)
        elements.exportName2k.textContent = "2K TILED SYNTHESIS";
      if (elements.exportRes2k)
        elements.exportRes2k.textContent = `${w2k} × ${h2k} (TILED ASCENT)`;

      if (elements.exportOption4k) {
        const radio4k =
          elements.exportOption4k.querySelector('input[type="radio"]');
        if (radio4k) radio4k.disabled = false;
        elements.exportOption4k.classList.remove("is-disabled");
      }
      if (elements.exportName4k)
        elements.exportName4k.textContent = "100% NATIVE PHOTO";
      if (elements.exportRes4k)
        elements.exportRes4k.textContent = `${srcW} × ${srcH} (FULL RES TILED)`;
    } else {
      const dim2k = highQualityDimensions(2048);
      if (elements.exportName2k)
        elements.exportName2k.textContent = "2K SCREEN";
      if (elements.exportRes2k) {
        elements.exportRes2k.textContent = `${dim2k.width} × ${dim2k.height}`;
      }
      const maxTex = capabilities.maxTextureSize || 2048;
      const canDo4k = maxTex >= 4096;
      if (elements.exportOption4k) {
        const radio4k =
          elements.exportOption4k.querySelector('input[type="radio"]');
        if (radio4k) radio4k.disabled = !canDo4k;
        elements.exportOption4k.classList.toggle("is-disabled", !canDo4k);
      }
      const dim4k = highQualityDimensions(canDo4k ? 4096 : maxTex);
      if (elements.exportName4k)
        elements.exportName4k.textContent = "4K SCREEN";
      if (elements.exportRes4k) {
        elements.exportRes4k.textContent = canDo4k
          ? `${dim4k.width} × ${dim4k.height}`
          : `${dim4k.width} × ${dim4k.height} (MAX GPU: ${maxTex}px)`;
      }
    }
  }

  function openExportModal() {
    if (
      !elements.exportModal ||
      typeof elements.exportModal.showModal !== "function"
    ) {
      return executeExport("current");
    }
    updateModalLabels();
    elements.exportModal.showModal();
  }

  async function renderHighQuality(requestedSize = 2048) {
    if (
      getState().hqRendering ||
      !captureCapabilities(getState().model).highResolution
    ) return;
    onBusyChange("hq", true);
    if (elements.hqRenders) elements.hqRenders.hidden = false;
    if (elements.hqStatus) elements.hqStatus.textContent = "PREPARING";
    elements.renderState.textContent = "HQ PREP";
    elements.renderState.classList.add("is-processing");

    const model = getState().model;
    const parameters = effectiveParametersAt(getState().time);
    const frameTime = getState().time;
    let { width, height } = highQualityDimensions(requestedSize);
    if (model?.id === "inception-dream" && model.sourceImage) {
      const srcW = model.sourceImage.width;
      const srcH = model.sourceImage.height;
      const aspect = srcW / srcH;
      if (requestedSize === 4096) {
        width = srcW;
        height = srcH;
      } else {
        if (aspect >= 1) {
          width = 2048;
          height = Math.max(1, Math.round(2048 / aspect));
        } else {
          height = 2048;
          width = Math.max(1, Math.round(2048 * aspect));
        }
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    try {
      if (getState().pending) await getState().pending;
      await nextFrame();
      if (elements.hqStatus)
        elements.hqStatus.textContent = "RENDERING " + width + " × " + height;
      elements.renderState.textContent = "HQ RENDER";
      setStatus("RENDERING " + width + " × " + height + " PNG");

      if (
        model?.id === "inception-dream" &&
        typeof model.renderHighRes === "function"
      ) {
        await model.renderHighRes(canvas, {
          width,
          height,
          parameters,
          onProgress: ({ current, total, percent }) => {
            const statusText = `TILED ASCENT: ${current}/${total} (${percent}%)`;
            if (elements.hqStatus) elements.hqStatus.textContent = statusText;
            elements.renderState.textContent = `${percent}% TILED`;
            setStatus(`${statusText} · ${width}×${height}`);
          },
        });
      } else {
        await Promise.resolve(model.render(canvas, parameters, frameTime));
      }
      await nextFrame();
      if (elements.hqStatus) elements.hqStatus.textContent = "ENCODING PNG";
      const blob = await canvasToPngBlob(canvas);
      const filename = outputFilename("png", width, height);
      downloadBlob(blob, filename);

      const seedMix = Number(parameters.__seedMix) || 0;
      const smoothSeed = seedMix * seedMix * (3 - 2 * seedMix);
      const visibleSeed = Math.round(
        Number(parameters.seed) +
          ((Number(parameters.__seedB) || Number(parameters.seed)) -
            Number(parameters.seed)) *
            smoothSeed,
      );
      const record = {
        id:
          "HQ-" +
          Date.now() +
          "-" +
          Math.random().toString(36).slice(2, 7).toUpperCase(),
        createdAt: new Date().toISOString(),
        modelId: model.id,
        modelName: model.name,
        seed: visibleSeed,
        width,
        height,
        byteSize: blob.size,
        frameTimeSeconds: frameTime,
        parameters: deepClone(parameters),
        blob,
      };
      if (hqGallery) {
        try {
          await hqGallery.store(record);
          if (elements.hqStatus)
            elements.hqStatus.textContent = "SAVED IN BROWSER";
        } catch {
          hqGallery.addSession(record);
          if (elements.hqStatus)
            elements.hqStatus.textContent = "SESSION ONLY";
        }
        await hqGallery.render();
      }
      terminal(
        "HQ RENDER",
        width + " × " + height + " / " + model.name + " / " + filename,
      );
      setStatus("PNG EXPORTED (" + width + " × " + height + ")");
    } catch (error) {
      console.error(error);
      if (elements.hqStatus) elements.hqStatus.textContent = "RENDER FAILED";
      terminal(
        "HQ ERROR",
        error instanceof Error ? error.message : String(error),
        "warning",
      );
      setStatus("HQ RENDER FAILED");
    } finally {
      onBusyChange("hq", false);
      elements.renderState.classList.remove("is-processing");
      updateFractalTools?.();
      renderCurrentFrame({ forceAnalysis: true, timeSeconds: getState().time });
    }
  }

  async function executeExport(resolution = "current") {
    const model = getState().model;
    if (
      !captureCapabilities(model).png ||
      getState().hqRendering ||
      getState().gifEncoding
    ) return;
    if (resolution === "current") {
      if (model?.statefulSimulation) {
        // Freeze the app clock and encode a private canvas. No simulation step,
        // parameter application, or viewport resize is part of this capture.
        onBusyChange("hq", true);
        try {
          await getState().pending;
          await model.waitForIdle?.();
          const canvas = document.createElement("canvas");
          canvas.width = elements.canvas.width;
          canvas.height = elements.canvas.height;
          model.renderSnapshot(canvas);
          const blob = await canvasToPngBlob(canvas);
          downloadBlob(blob, outputFilename("png", canvas.width, canvas.height));
          setStatus(`PNG SNAPSHOT EXPORTED (${canvas.width} × ${canvas.height})`);
        } catch (error) {
          terminal("PNG ERROR", error.message || String(error), "warning");
          setStatus("PNG SNAPSHOT FAILED");
        } finally {
          onBusyChange("hq", false);
          renderCurrentFrame({ forceAnalysis: true, timeSeconds: getState().time });
        }
        return;
      }
      if (model?.id === "inception-dream" && model.dreamCanvas?.width) {
        const dreamCanvas = model.dreamCanvas;
        const canvas = document.createElement("canvas");
        canvas.width = dreamCanvas.width;
        canvas.height = dreamCanvas.height;
        const ctx = canvas.getContext("2d", { alpha: false });
        const fusionAlpha = Number(model.parameters?.detailFusion ?? 0.22);
        if (typeof model.drawSharpenedContain === "function") {
          model.drawSharpenedContain(
            ctx,
            dreamCanvas,
            model.sourceImage || model.sourceCanvas,
            canvas.width,
            canvas.height,
            fusionAlpha,
          );
        } else {
          ctx.drawImage(dreamCanvas, 0, 0);
        }
        const blob = await canvasToPngBlob(canvas);
        const filename = outputFilename(
          "png",
          canvas.width,
          canvas.height,
        );
        downloadBlob(blob, filename);
        terminal(
          "FILE",
          `${filename} written (${canvas.width}×${canvas.height})`,
        );
        setStatus(
          `PNG EXPORTED (${canvas.width} × ${canvas.height})`,
        );
        return;
      }

      await renderCurrentFrame({
        forceAnalysis: true,
        timeSeconds: getState().time,
        exact: true,
      });
      elements.canvas.toBlob((blob) => {
        if (!blob) return;
        const filename = outputFilename("png");
        downloadBlob(blob, filename);
        terminal("FILE", `${filename} written`);
        setStatus("PNG EXPORTED");
      }, "image/png");
      return;
    }

    const size = Number(resolution) || 2048;
    await renderHighQuality(size);
  }

  function savePng() {
    openExportModal();
  }

  if (elements.exportModal) {
    elements.exportModalClose?.addEventListener("click", () => {
      elements.exportModal.close();
    });
    elements.exportModalCancel?.addEventListener("click", () => {
      elements.exportModal.close();
    });
    elements.exportModalConfirm?.addEventListener("click", () => {
      const selected =
        elements.exportModal.querySelector(
          'input[name="export-resolution"]:checked',
        )?.value || "current";
      elements.exportModal.close();
      executeExport(selected);
    });
    elements.exportModal.addEventListener("click", (event) => {
      if (event.target === elements.exportModal) {
        elements.exportModal.close();
      }
    });
  }

  async function saveGif() {
    if (
      getState().gifEncoding ||
      !getState().model?.available ||
      !captureCapabilities(getState().model).gif
    )
      return;
    onBusyChange("gif", true);
    elements.gifProgress.hidden = false;
    elements.gifProgressBar.value = 0;
    elements.saveGif.disabled = true;
    elements.renderState.textContent = "CAPTURING GIF";
    elements.renderState.classList.add("is-processing");
    setStatus("GIF CAPTURE IN PROGRESS");

    const captureSize = getState().quality.gifSize;
    const captureCanvas = document.createElement("canvas");
    captureCanvas.width = captureSize;
    captureCanvas.height = captureSize;
    const captureContext = captureCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    });
    const frames = [];
    const loopPreset = selectedLoopPreset();
    const fps = loopPreset.duration ? 15 : 12;
    const frameCount = loopPreset.duration
      ? Math.round(loopPreset.duration * fps)
      : getState().quality.gifFrames;
    const startTime = getState().time;

    try {
      for (let index = 0; index < frameCount; index += 1) {
        const loopPhase = loopPreset.duration ? index / frameCount : null;
        const frameTime = loopPreset.duration
          ? getState().loopPresetState.startedAt +
            loopPhase * loopPreset.duration
          : startTime + index / fps;
        const effective = effectiveParametersAt(frameTime, { loopPhase });
        await Promise.resolve(
          getState().model.render(captureCanvas, effective, frameTime),
        );
        frames.push(
          captureContext.getImageData(0, 0, captureSize, captureSize),
        );
        elements.gifProgressBar.value = Math.round(
          ((index + 1) / frameCount) * 55,
        );
        if (index % 2 === 1) await nextFrame();
      }

      const blob = await encodeAnimatedGif({
        frames,
        width: captureSize,
        height: captureSize,
        fps,
        loop: 0,
        onProgress: (progress) => {
          elements.gifProgressBar.value = 55 + Math.round(progress * 45);
        },
      });
      const filename = outputFilename("gif", captureSize, captureSize);
      downloadBlob(blob, filename);
      terminal(
        "FILE",
        filename +
          " written / " +
          frameCount +
          " frames" +
          (loopPreset.duration ? " / seamless " + loopPreset.name : ""),
      );
      setStatus("GIF EXPORTED");
    } catch (error) {
      console.error(error);
      terminal(
        "GIF ERROR",
        error instanceof Error ? error.message : String(error),
        "warning",
      );
      setStatus("GIF EXPORT FAILED");
    } finally {
      onBusyChange("gif", false);
      elements.gifProgress.hidden = true;
      elements.saveGif.disabled = !captureCapabilities(getState().model).gif;
      elements.renderState.classList.remove("is-processing");
      renderCurrentFrame({ forceAnalysis: true, timeSeconds: getState().time });
    }
  }

  return { savePng, saveGif, renderHighQuality };
}
