import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { createNeuralGrowthServer } from "./neural-growth-server.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function optionsFrom(argumentsList) {
  const options = { hardware: false, headed: false, soakMinutes: 0, grid: 128 };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--hardware") options.hardware = true;
    else if (argument === "--headed") options.headed = true;
    else if (argument === "--help") options.help = true;
    else {
      const [key, inline] = argument.split("=", 2);
      if (!["--output", "--soak-minutes", "--grid"].includes(key)) {
        throw new Error(`Unknown argument: ${argument}`);
      }
      const value = inline ?? argumentsList[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for ${key}`);
      }
      if (key === "--output") options.output = path.resolve(value);
      if (key === "--soak-minutes") options.soakMinutes = Number(value);
      if (key === "--grid") options.grid = Number(value);
    }
  }
  if (
    !Number.isFinite(options.soakMinutes) ||
    options.soakMinutes < 0 ||
    options.soakMinutes > 240
  ) {
    throw new Error("--soak-minutes must be between 0 and 240.");
  }
  if (![128, 256].includes(options.grid)) {
    throw new Error("--grid must be 128 or 256.");
  }
  return options;
}

function percentiles(values) {
  if (!values.length) return { samples: 0 };
  const sorted = values.slice().sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.floor((sorted.length - 1) * fraction)];
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
  };
}

async function pageState(page) {
  return page.evaluate(async () => {
    const controller = window.neuralGrowthPrototype;
    const runtime = controller.runtime;
    const state = runtime.readState();
    const hash = await crypto.subtle.digest("SHA-256", state);
    return {
      status: controller.getStatus(),
      stats: runtime.getStats(),
      hash: Array.from(new Uint8Array(hash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
    };
  });
}

async function gpuChecks(page) {
  return page.evaluate(async () => {
    const { validateCheckpoint, referenceStep } = await import("/reference.js");
    const { TextureNcaRuntime } = await import("/runtime.js");
    const model = validateCheckpoint(
      await (await fetch("/checkpoint.json")).json(),
    );
    const initial = Uint8Array.from(
      { length: 8 * 8 * 12 },
      (_, index) => 112 + ((index * 13) % 31),
    );
    const runtimes = [];
    try {
      const first = new TextureNcaRuntime({ model, size: 8, seed: 17 });
      runtimes.push(first);
      first.writeState(initial);
      first.step();
      const mask = first.getLastUpdateMask();
      const expected = referenceStep(initial, model, 8, mask);
      const actual = first.readState();
      let maxByteError = 0;
      let mismatchedBytes = 0;
      let inactiveMismatches = 0;
      const errorHistogram = {};
      const largestMismatches = [];
      for (let index = 0; index < actual.length; index += 1) {
        const error = Math.abs(actual[index] - expected[index]);
        maxByteError = Math.max(maxByteError, error);
        errorHistogram[error] = (errorHistogram[error] ?? 0) + 1;
        if (error) mismatchedBytes += 1;
        if (error > 1 && largestMismatches.length < 16) {
          largestMismatches.push({
            x: Math.floor(index / 12) % 8,
            y: Math.floor(index / 12 / 8),
            channel: index % 12,
            initial: initial[index],
            expected: expected[index],
            actual: actual[index],
            error,
          });
        }
        if (!mask[Math.floor(index / 12)] && actual[index] !== initial[index]) {
          inactiveMismatches += 1;
        }
      }
      const second = new TextureNcaRuntime({ model, size: 8, seed: 17 });
      runtimes.push(second);
      second.writeState(initial);
      second.step();
      const secondState = second.readState();
      const deterministic = actual.every(
        (value, index) => value === secondState[index],
      );
      const resourcesBefore = first.getStats().resources;
      for (let index = 0; index < 8; index += 1) {
        first.restart(index + 1);
        first.step(2);
        first.readState();
        first.disturb(4, 4, 2);
      }
      const resourcesAfter = first.getStats().resources;
      first.dispose();
      const disposed = first.getStats();
      return {
        maxByteError,
        toleranceBytes: 1,
        toleranceExplanation:
          "RGBA8 UNORM encoding permits one byte of rounding difference; inactive cells must remain exact.",
        mismatchedBytes,
        errorHistogram,
        largestMismatches,
        inactiveMismatches,
        deterministic,
        resourcesBefore,
        resourcesAfter,
        disposed,
      };
    } finally {
      for (const runtime of runtimes) runtime.dispose();
    }
  });
}

async function benchmarks(page) {
  const results = [];
  for (const size of [128, 256]) {
    console.log(`Benchmarking ${size}x${size} with synchronized readbacks.`);
    results.push(
      await page.evaluate(async (gridSize) => {
        const { validateCheckpoint } = await import("/reference.js");
        const { TextureNcaRuntime } = await import("/runtime.js");
        const model = validateCheckpoint(
          await (await fetch("/checkpoint.json")).json(),
        );
        const runtime = new TextureNcaRuntime({
          model,
          size: gridSize,
          seed: 73,
        });
        try {
          runtime.step(8);
          runtime.readState();
          const samples = [];
          const started = performance.now();
          for (let index = 0; index < 16; index += 1) {
            const before = performance.now();
            runtime.step();
            runtime.readState();
            samples.push(performance.now() - before);
          }
          const elapsed = performance.now() - started;
          return {
            size: gridSize,
            samples,
            elapsedMs: elapsed,
            completedStepsPerSecond: (samples.length * 1000) / elapsed,
            stats: runtime.getStats(),
            measurement:
              "Wall time for one submitted update plus a blocking full-state readback. Includes CPU/readback overhead; not pure GPU kernel time.",
          };
        } finally {
          runtime.dispose();
        }
      }, size),
    );
  }
  return results.map(({ samples, ...result }) => ({
    ...result,
    synchronizedStepAndReadbackMs: percentiles(samples),
  }));
}

async function telemetry(page) {
  return page.evaluate(async () => {
    const runtime = window.neuralGrowthPrototype.runtime;
    const state = runtime.readState();
    let sum = 0;
    let sumSquares = 0;
    let saturated = 0;
    for (let cell = 0; cell < state.length / 12; cell += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const value = state[cell * 12 + channel];
        sum += value;
        sumSquares += value * value;
        if (value === 0 || value === 255) saturated += 1;
      }
    }
    const count = (state.length / 12) * 3;
    const memory = performance.memory;
    const hash = await crypto.subtle.digest("SHA-256", state);
    return {
      timestamp: new Date().toISOString(),
      stats: runtime.getStats(),
      status: window.neuralGrowthPrototype.getStatus(),
      rgbVariance: sumSquares / count - (sum / count) ** 2,
      saturatedRgbFraction: saturated / count,
      stateHash: Array.from(new Uint8Array(hash), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
      jsHeap: memory
        ? {
            usedBytes: memory.usedJSHeapSize,
            allocatedBytes: memory.totalJSHeapSize,
            limitBytes: memory.jsHeapSizeLimit,
          }
        : null,
      resourceMeasurement:
        "Runtime-owned live-resource counters and estimated storage, not driver-wide GPU memory usage.",
    };
  });
}

async function soak(page, options, output, abortSignal) {
  await page.evaluate(async (grid) => {
    const controller = window.neuralGrowthPrototype;
    await controller.setSize(grid);
    controller.pause();
    controller.restart();
    const metrics = { intervals: [], maxStepBurst: 0, handle: null };
    let previousTime;
    let previousSteps = controller.runtime.getStats().steps;
    const frame = (time) => {
      if (previousTime !== undefined && metrics.intervals.length < 200000) {
        metrics.intervals.push(time - previousTime);
      }
      previousTime = time;
      const steps = controller.runtime.getStats().steps;
      metrics.maxStepBurst = Math.max(
        metrics.maxStepBurst,
        steps - previousSteps,
      );
      previousSteps = steps;
      metrics.handle = requestAnimationFrame(frame);
    };
    metrics.handle = requestAnimationFrame(frame);
    window.__neuralGrowthValidationMetrics = metrics;
    controller.play();
  }, options.grid);
  const started = Date.now();
  const deadline = started + options.soakMinutes * 60000;
  const samples = [await telemetry(page)];
  await page.screenshot({ path: path.join(output, "soak-start.png") });
  let nextScreenshot = started + 5 * 60000;
  while (Date.now() < deadline) {
    await delay(Math.min(30000, deadline - Date.now()), undefined, {
      signal: abortSignal,
    });
    const sample = await telemetry(page);
    samples.push(sample);
    await writeFile(
      path.join(output, "soak-telemetry.json"),
      JSON.stringify(samples, null, 2) + "\n",
    );
    console.log(
      `Soak ${((Date.now() - started) / 60000).toFixed(1)} min: ${sample.stats.steps} updates, RGB variance ${sample.rgbVariance.toFixed(2)}, heap ${sample.jsHeap?.usedBytes ?? "unavailable"}.`,
    );
    if (Date.now() >= nextScreenshot) {
      await page.screenshot({
        path: path.join(
          output,
          `soak-${Math.round((Date.now() - started) / 60000)}m.png`,
        ),
      });
      nextScreenshot += 5 * 60000;
    }
  }
  const metrics = await page.evaluate(() => {
    const controller = window.neuralGrowthPrototype;
    controller.pause();
    const metrics = window.__neuralGrowthValidationMetrics;
    cancelAnimationFrame(metrics.handle);
    delete window.__neuralGrowthValidationMetrics;
    return { intervals: metrics.intervals, maxStepBurst: metrics.maxStepBurst };
  });
  await page.screenshot({ path: path.join(output, "soak-end.png") });
  const first = samples[0];
  const last = samples.at(-1);
  return {
    requestedMinutes: options.soakMinutes,
    elapsedMinutes: (Date.now() - started) / 60000,
    grid: options.grid,
    samples,
    completedStepsPerSecond:
      ((last.stats.steps - first.stats.steps) * 1000) / (Date.now() - started),
    displayFrameIntervalMs: percentiles(metrics.intervals),
    maxStepBurst: metrics.maxStepBurst,
    resourceCountsStable: samples.every(
      (sample) =>
        JSON.stringify(sample.stats.resources) ===
        JSON.stringify(first.stats.resources),
    ),
    explanation:
      "Display intervals measure requestAnimationFrame pacing, not GPU kernel execution. State readbacks every 30 seconds synchronize work and may briefly affect pacing. Heap and variance are observations, not proof of a leak-free or artistically successful model.",
  };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (options.help) {
    console.log(
      "Usage: node tools/validate-neural-growth.mjs [--hardware] [--headed] [--grid=128|256] [--soak-minutes=30] [--output=/absolute/path]\nWithout --soak-minutes, runs only functional checks and short synchronized benchmarks. Artifacts default to a temporary directory.",
    );
    return;
  }
  const output =
    options.output ??
    (await mkdtemp(path.join(os.tmpdir(), "latent-field-nca-validation-")));
  await mkdir(output, { recursive: true });
  console.log(`Validation artifacts: ${output}`);
  const report = {
    startedAt: new Date().toISOString(),
    runnerPid: process.pid,
    options,
    output,
    checks: [],
    pageErrors: [],
    consoleErrors: [],
  };
  const abortController = new AbortController();
  const interrupt = () => abortController.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let browser;
  const server = await createNeuralGrowthServer(repositoryRoot);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: !options.headed,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: options.hardware
        ? [
            "--use-gl=angle",
            "--use-angle=gl",
            "--enable-gpu",
            "--ignore-gpu-blocklist",
          ]
        : [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
    });
    const context = await browser.newContext({
      viewport: { width: 1100, height: 850 },
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => report.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.consoleErrors.push(message.text());
    });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(
      () => window.neuralGrowthPrototype?.getStatus().ready,
      undefined,
      { timeout: 30000 },
    );
    await page.evaluate(() => window.neuralGrowthPrototype.pause());
    report.device = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      stats: window.neuralGrowthPrototype.runtime.getStats(),
    }));
    const check = async (name, operation) => {
      try {
        const details = await operation();
        report.checks.push({ name, passed: true, details });
        console.log(`PASS ${name}`);
      } catch (error) {
        report.checks.push({ name, passed: false, error: error.message });
        console.error(`FAIL ${name}: ${error.message}`);
      }
    };
    await check(
      "GPU reference, deterministic update, and resource disposal",
      async () => {
        const result = await gpuChecks(page);
        report.numericalReference = result;
        assert.ok(
          result.maxByteError <= result.toleranceBytes,
          `Maximum error ${result.maxByteError} exceeds one encoded byte.`,
        );
        assert.equal(result.inactiveMismatches, 0);
        assert.equal(result.deterministic, true);
        assert.deepEqual(result.resourcesAfter, result.resourcesBefore);
        assert.equal(result.disposed.disposed, true);
        for (const key of [
          "textures",
          "framebuffers",
          "programs",
          "vaos",
          "bytes",
        ]) {
          assert.equal(
            result.disposed.resources[key],
            0,
            `${key} remain after disposal.`,
          );
        }
        return result;
      },
    );
    await check("Pause and non-resetting controls preserve state", async () => {
      const before = await pageState(page);
      await delay(250);
      const paused = await pageState(page);
      assert.equal(paused.stats.steps, before.stats.steps);
      assert.equal(paused.hash, before.hash);
      await page.evaluate(() => {
        window.neuralGrowthPrototype.setSpeed(60);
        window.neuralGrowthPrototype.setPalette("spectral");
      });
      const after = await pageState(page);
      assert.equal(after.hash, before.hash);
      assert.equal(after.stats.steps, before.stats.steps);
      await page.evaluate(() => {
        window.neuralGrowthPrototype.setSpeed(30);
        window.neuralGrowthPrototype.setPalette("native");
      });
      return { stateHash: after.hash };
    });
    await check(
      "Single-step, disturbance, and seeded restart work",
      async () => {
        await page.evaluate(() => window.neuralGrowthPrototype.setSeed(71));
        const initial = await pageState(page);
        await page.evaluate(() => window.neuralGrowthPrototype.step());
        const stepped = await pageState(page);
        assert.equal(stepped.stats.steps, initial.stats.steps + 1);
        assert.notEqual(stepped.hash, initial.hash);
        await page.evaluate(() => window.neuralGrowthPrototype.restart());
        const restarted = await pageState(page);
        assert.equal(restarted.hash, initial.hash);
        await page.evaluate(() => window.neuralGrowthPrototype.step());
        const beforeDisturbance = await pageState(page);
        await page.evaluate(() =>
          window.neuralGrowthPrototype.disturb(64, 64, 12),
        );
        const disturbed = await pageState(page);
        assert.notEqual(disturbed.hash, beforeDisturbance.hash);
        return {
          steppedUpdates: stepped.stats.steps,
          disturbanceChangedState: true,
        };
      },
    );
    await check(
      "Viewport resizing and PNG snapshots do not mutate simulation",
      async () => {
        const before = await pageState(page);
        await page.setViewportSize({ width: 820, height: 700 });
        await delay(100);
        const png = await page.evaluate(async () => {
          const blob = await window.neuralGrowthPrototype.snapshot();
          return { type: blob.type, size: blob.size };
        });
        const after = await pageState(page);
        assert.equal(after.hash, before.hash);
        assert.equal(after.stats.size, before.stats.size);
        assert.equal(after.stats.steps, before.stats.steps);
        assert.equal(png.type, "image/png");
        assert.ok(png.size > 100);
        return png;
      },
    );
    await check(
      "Invalid configuration is rejected transactionally",
      async () => {
        const before = await pageState(page);
        const rejected = await page.evaluate(async () => {
          try {
            const result = await window.neuralGrowthPrototype.setSize(129);
            return result === false;
          } catch {
            return true;
          }
        });
        assert.equal(rejected, true);
        const invalidSeedsRejected = await page.evaluate(() =>
          ["", "   ", -1, 4294967296, 0.5].every((seed) => {
            try {
              return window.neuralGrowthPrototype.setSeed(seed) === false;
            } catch {
              return true;
            }
          }),
        );
        assert.equal(invalidSeedsRejected, true);
        const after = await pageState(page);
        assert.equal(after.hash, before.hash);
        assert.equal(after.stats.size, before.stats.size);
        return { preservedState: true, invalidSeedsRejected: true };
      },
    );
    await check(
      "Failed checkpoint loading preserves state and displayed image",
      async () => {
        const before = await pageState(page);
        const beforeImage = await page.evaluate(async () => {
          const blob = await window.neuralGrowthPrototype.snapshot();
          return Array.from(new Uint8Array(await blob.arrayBuffer()));
        });
        await page.route("**/checkpoint.json", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ format: "invalid-checkpoint" }),
          }),
        );
        try {
          const result = await page.evaluate(() =>
            window.neuralGrowthPrototype.reloadCheckpoint(),
          );
          assert.equal(result, false);
          const after = await pageState(page);
          assert.equal(after.hash, before.hash);
          assert.equal(after.stats.steps, before.stats.steps);
          const afterImage = await page.evaluate(async () => {
            const blob = await window.neuralGrowthPrototype.snapshot();
            return Array.from(new Uint8Array(await blob.arrayBuffer()));
          });
          assert.deepEqual(afterImage, beforeImage);
        } finally {
          await page.unroute("**/checkpoint.json");
        }
        assert.equal(
          await page.evaluate(() =>
            window.neuralGrowthPrototype.reloadCheckpoint(),
          ),
          true,
        );
        await page.evaluate(() => window.neuralGrowthPrototype.pause());
        return { invalidPackRejected: true, previousFramePreserved: true };
      },
    );
    await check(
      "Synthetic visibility pause has no accumulated catch-up",
      async () => {
        await page.evaluate(() => {
          window.neuralGrowthPrototype.play();
          Object.defineProperty(document, "hidden", {
            configurable: true,
            get: () => true,
          });
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const hiddenBefore = await pageState(page);
        await delay(250);
        const hiddenAfter = await pageState(page);
        assert.equal(hiddenAfter.stats.steps, hiddenBefore.stats.steps);
        assert.equal(hiddenAfter.hash, hiddenBefore.hash);
        const firstResumeSteps = await page.evaluate(async () => {
          const before = window.neuralGrowthPrototype.runtime.getStats().steps;
          delete document.hidden;
          delete document.visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const after = window.neuralGrowthPrototype.runtime.getStats().steps;
          window.neuralGrowthPrototype.pause();
          return after - before;
        });
        assert.ok(
          firstResumeSteps <= 2,
          `Resume performed ${firstResumeSteps} updates in its first frame.`,
        );
        return {
          syntheticVisibilityEvent: true,
          firstResumeSteps,
          requiresManualRealTabCheck: true,
        };
      },
    );
    await check(
      "Back-forward cache suspension preserves state and resumes safely",
      async () => {
        await page.evaluate(() => {
          window.neuralGrowthPrototype.play();
          window.dispatchEvent(
            new PageTransitionEvent("pagehide", { persisted: true }),
          );
        });
        const before = await pageState(page);
        assert.equal(before.status.pageSuspended, true);
        assert.equal(before.stats.disposed, false);
        await delay(250);
        const suspended = await pageState(page);
        assert.equal(suspended.hash, before.hash);
        assert.equal(suspended.stats.steps, before.stats.steps);
        const result = await page.evaluate(async () => {
          const controller = window.neuralGrowthPrototype;
          const before = controller.runtime.getStats().steps;
          window.dispatchEvent(
            new PageTransitionEvent("pageshow", { persisted: true }),
          );
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const after = controller.runtime.getStats().steps;
          const status = controller.getStatus();
          controller.pause();
          return { firstResumeSteps: after - before, status };
        });
        assert.equal(result.status.pageSuspended, false);
        assert.ok(result.firstResumeSteps <= 2);
        return {
          syntheticPageTransition: true,
          firstResumeSteps: result.firstResumeSteps,
        };
      },
    );
    await page.screenshot({ path: path.join(output, "functional.png") });
    if (report.checks.every((result) => result.passed)) {
      report.benchmarks = await benchmarks(page);
      const renderer = String(report.device.stats.renderer);
      const actualHardware = !/swiftshader|llvmpipe|software/i.test(renderer);
      report.hardwareClassification = {
        requestedHardware: options.hardware,
        renderer,
        appearsHardwareAccelerated: actualHardware,
        explanation:
          "Renderer strings are evidence, not an independent physical-device certification.",
      };
      if (options.hardware && !actualHardware) {
        throw new Error(
          "Hardware mode resolved to a software renderer; refusing to label this a physical-GPU benchmark.",
        );
      }
      await page.evaluate(() => {
        const controller = window.neuralGrowthPrototype;
        controller.pause();
        controller.restart();
        controller.runtime.step(128);
        controller.runtime.step(127);
        controller.step();
      });
      report.evolvedPreview = await telemetry(page);
      await page.screenshot({
        path: path.join(output, "evolved-256-updates.png"),
      });
      if (options.soakMinutes > 0) {
        report.soak = await soak(page, options, output, abortController.signal);
        assert.equal(
          report.soak.resourceCountsStable,
          true,
          "Live-resource counters changed during the soak.",
        );
        assert.ok(
          report.soak.maxStepBurst <= 2,
          "The frame update cap was exceeded.",
        );
      }
      await check(
        "Page disposal releases resources and prevents reloading",
        async () => {
          const result = await page.evaluate(async () => {
            const controller = window.neuralGrowthPrototype;
            window.dispatchEvent(
              new PageTransitionEvent("pagehide", { persisted: false }),
            );
            return {
              stats: controller.runtime.getStats(),
              status: controller.getStatus(),
              reloadResult: await controller.reloadCheckpoint(),
            };
          });
          assert.equal(result.stats.disposed, true);
          assert.equal(result.reloadResult, false);
          for (const key of [
            "textures",
            "framebuffers",
            "programs",
            "vaos",
            "bytes",
          ]) {
            assert.equal(result.stats.resources[key], 0);
          }
          return result;
        },
      );
    } else if (options.soakMinutes > 0) {
      report.soakSkipped =
        "Functional acceptance gates failed; no long run started.";
    }
  } catch (error) {
    report.interrupted = abortController.signal.aborted;
    report.fatalError = error.stack ?? error.message;
    console.error(error.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    report.passed =
      !report.fatalError &&
      report.checks.length > 0 &&
      report.checks.every((result) => result.passed) &&
      report.pageErrors.length === 0;
    await writeFile(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    console.log(
      `${report.passed ? "PASS" : "FAIL"}: ${path.join(output, "report.json")}`,
    );
    if (!report.passed) process.exitCode = 1;
  }
}

await main();
