// Re-render saved model textures with revised experiment lighting/framing.
// Runs no inference and verifies that every natural-color model PNG is unchanged.
// node tools/refresh-dream-drift-progression.mjs test-results/dream-drift-neon-progression
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createStaticServer } from "../server.mjs";
import { writeDreamDriftGallery } from "./dream-drift-gallery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(
  process.argv[2] || "test-results/dream-drift-neon-progression",
);
const reportPath = path.join(output, "report.json");
const originalReport = await readFile(reportPath, "utf8");
const report = JSON.parse(originalReport);
assert.equal(report.status, "complete");
assert.equal(report.configuration.experimentMode, "progression");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const plainEntries = report.artifacts.filter(
  (a) => a.id === "migan" || a.experiment?.variant === "plain",
);
const before = await Promise.all(
  plainEntries.map(async (a) => [
    a.texture,
    hash(await readFile(path.join(output, a.texture))),
  ]),
);
const helperSource = await readFile(
  new URL("./dream-drift-progression.mjs", import.meta.url),
  "utf8",
);
const server = await createStaticServer(root);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    "--enable-gpu",
  ],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.route(`${origin}/`, (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Dream display comparison</title>",
    }),
  );
  await page.route("**/assets/js/models/dream-drift-progression.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: helperSource }),
  );
  await page.route(`${origin}/experiment-output/*`, async (r) => {
    const name = decodeURIComponent(
      new URL(r.request().url()).pathname.split("/").at(-1),
    );
    assert.equal(path.basename(name), name);
    await r.fulfill({
      path: path.join(output, name),
      contentType: "image/png",
    });
  });
  await page.route(/^https?:\/\//, (r) =>
    new URL(r.request().url()).origin === origin ? r.fallback() : r.abort(),
  );
  await page.exposeFunction("saveDisplayArtifact", async (file, base64) => {
    assert.equal(path.basename(file), file);
    await writeFile(path.join(output, file), Buffer.from(base64, "base64"));
  });
  await page.goto(origin);
  const display = await page.evaluate(
    async ({ inputs, artifacts }) => {
      const { neonPanoramaPixels, marmotViewPitch } =
        await import("/assets/js/models/dream-drift-progression.js");
      const { CorticalDreamDomeModel } =
        await import("/assets/js/models/cortical-dream-dome.js");
      const model = new CorticalDreamDomeModel();
      const frame = document.createElement("canvas");
      frame.width = 512;
      frame.height = 384;
      const p = Object.fromEntries(
        model.controls.map((c) => [c.key, c.default]),
      );
      Object.assign(p, {
        gain: 0,
        edgeCoupling: 0,
        chromaticDispersion: 0,
        depthScale: 0,
        neuralSwell: 0,
        cameraDolly: 0,
      });
      await model.ensureGraphics();
      const encode = async (c) => {
        const blob = c.convertToBlob
          ? await c.convertToBlob({ type: "image/png" })
          : await new Promise((r) => c.toBlob(r));
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.readAsDataURL(blob);
        });
      };
      const load = async (file) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`/experiment-output/${file}`)).blob(),
        );
        const c = new OffscreenCanvas(bitmap.width, bitmap.height);
        c.getContext("2d").drawImage(bitmap, 0, 0);
        bitmap.close();
        return c;
      };
      const pixels = (c) =>
        c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      const measure = (c, reference) => {
        const data = pixels(c),
          base = pixels(reference),
          { width, height } = c;
        let change = 0,
          seam = 0,
          seamMax = 0,
          edge = 0,
          neighbor = 0,
          clipped = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255)
              clipped++;
            for (let c = 0; c < 3; c++) {
              change += Math.abs(data[i + c] - base[i + c]);
              if (x > 0) edge += Math.abs(data[i + c] - data[i - 4 + c]);
              if (x === 0) {
                const delta = Math.abs(
                  data[i + c] - data[(y * width + width - 1) * 4 + c],
                );
                seam += delta;
                seamMax = Math.max(seamMax, delta);
                neighbor += Math.abs(data[i + c] - data[i + 4 + c]);
              }
            }
          }
        return {
          width,
          height,
          opaque: true,
          meanChangeByte: change / (width * height * 3),
          seamMeanByte: seam / (height * 3),
          seamMaxByte: seamMax,
          seamNeighborMeanByte: neighbor / (height * 3),
          meanHorizontalEdgeByte: edge / (width * height * 3),
          protectedMaxByte: null,
          whiteClippedFraction: clipped / (width * height),
        };
      };
      const render = async (canvas, entry, pitch) => {
        model.panorama = canvas;
        model.outpaintingMode = "migan";
        model.photoRect = {
          x: 0,
          y: 0,
          width: canvas.width,
          height: canvas.height,
          feather: 1,
        };
        model.camera.reset();
        model.uploadSource();
        const angles = entry.views
          ? [
              ["Front", 0, pitch],
              ["Right", Math.PI / 2, 0],
              ["Rear", Math.PI, 0],
              ["Left", -Math.PI / 2, 0],
              ["Ceiling", 0, 1.45],
              ["Floor", 0, -1.45],
            ]
          : [["Front", 0, pitch]];
        const sheet = new OffscreenCanvas(1536, 816),
          ctx = sheet.getContext("2d");
        for (let i = 0; i < angles.length; i++) {
          const [label, yaw, direction] = angles[i];
          model.camera.yaw = yaw;
          model.camera.pitch = direction;
          await model.render(frame, p, 0);
          if (i === 0)
            await window.saveDisplayArtifact(entry.front, await encode(frame));
          const x = (i % 3) * 512,
            y = Math.floor(i / 3) * 408;
          ctx.fillStyle = "#111";
          ctx.fillRect(x, y, 512, 408);
          ctx.fillStyle = "#eee";
          ctx.font = "16px sans-serif";
          ctx.fillText(label, x + 10, y + 18);
          ctx.drawImage(frame, x, y + 24);
        }
        if (entry.views)
          await window.saveDisplayArtifact(entry.views, await encode(sheet));
      };
      const updates = [],
        framing = [];
      try {
        for (const input of inputs) {
          const entries = artifacts.filter((a) => a.input === input.id);
          const baseline = entries.find((a) => a.id === "migan"),
            initial = await load(baseline.texture);
          const subjectRect = entries.find(
            (a) => a.experiment?.variant === "plain",
          ).experiment.subjectRect;
          const pitch = marmotViewPitch(input.name);
          framing.push({
            input: input.id,
            yaw: 0,
            pitch,
            width: 512,
            height: 384,
          });
          const plain = entries.filter(
            (a) => a.id === "migan" || a.experiment?.variant === "plain",
          );
          for (const entry of plain) {
            const canvas =
              entry.id === "migan" ? initial : await load(entry.texture);
            await render(canvas, entry, pitch);
            const neon = entries.find(
              (a) =>
                a.id ===
                (entry.id === "migan"
                  ? "progression-baseline-neon"
                  : entry.id + "-neon"),
            );
            const styled = new OffscreenCanvas(canvas.width, canvas.height);
            const data = neonPanoramaPixels(
              pixels(canvas),
              pixels(initial),
              canvas.width,
              canvas.height,
              { strength: neon.experiment.neon, photoRect: subjectRect },
            );
            styled
              .getContext("2d")
              .putImageData(
                new ImageData(data, canvas.width, canvas.height),
                0,
                0,
              );
            await window.saveDisplayArtifact(
              neon.texture,
              await encode(styled),
            );
            await render(styled, neon, pitch);
            updates.push({
              input: input.id,
              id: neon.id,
              metrics: measure(styled, canvas),
            });
          }
          const mixed = entries.filter(
            (a) =>
              a.experiment?.recipe === "mixed" &&
              a.experiment.variant === "plain",
          );
          const sheet = new OffscreenCanvas(1536, 456),
            ctx = sheet.getContext("2d");
          ctx.fillStyle = "#0b111b";
          ctx.fillRect(0, 0, sheet.width, sheet.height);
          ctx.font = "14px sans-serif";
          for (let i = 0; i < mixed.length; i++) {
            const plain = mixed[i],
              neon = entries.find((a) => a.id === plain.id + "-neon");
            ctx.fillStyle = "#d8e4ed";
            ctx.fillText(
              `${i + 1} · ${plain.experiment.name}`,
              i * 256 + 8,
              20,
            );
            ctx.drawImage(await load(plain.front), i * 256, 30, 256, 192);
            ctx.drawImage(await load(neon.front), i * 256, 240, 256, 192);
          }
          await window.saveDisplayArtifact(
            `${input.id}-mixed-overview.png`,
            await encode(sheet),
          );
        }
        return { updates, framing, glError: model.gl.getError() };
      } finally {
        model.dispose();
      }
    },
    { inputs: report.inputs, artifacts: report.artifacts },
  );
  assert.equal(display.glError, 0);
  assert.deepEqual(errors, []);
  for (const [file, sha] of before)
    assert.equal(
      hash(await readFile(path.join(output, file))),
      sha,
      `${file} model pixels changed`,
    );
  for (const update of display.updates)
    report.artifacts.find(
      (a) => a.input === update.input && a.id === update.id,
    ).metrics = update.metrics;
  for (const entry of report.artifacts)
    if (entry.experiment?.phase === "progression")
      entry.experiment.frontPitch = display.framing.find(
        (f) => f.input === entry.input,
      ).pitch;
  await writeFile(path.join(output, "inference-report.json"), originalReport);
  report.displayPass = {
    finishedAt: new Date().toISOString(),
    helperSha256: hash(helperSource),
    originalReportSha256: hash(originalReport),
    inferenceRuns: 0,
    generatedTextureHashesUnchanged: true,
    framing: display.framing,
    originalModelTextures: Object.fromEntries(before),
    glError: display.glError,
    errors,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await writeDreamDriftGallery(output, report);
  console.log(
    JSON.stringify({
      refreshedPairs: display.updates.length,
      modelTexturesUnchanged: before.length,
      errors,
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
