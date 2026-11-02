import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test("photo defaults follow the platform while mathematical outputs stay unfiltered", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  await expect(page.locator("#status-message")).toContainText("ready");
  await page.locator("#quality-select").selectOption("economy");
  const output = page.locator("#output-canvas");
  expect(await page.locator("#gl-swap-rb-filter").count()).toBe(0);
  await expect(page.locator("html")).not.toHaveClass(/gl-swap-rb/);
  for (const id of ["chromatic-field", "folded-fractal", "fractal-functions"]) {
    await page.locator("#model-select").selectOption(id);
    await expect(output).toHaveCSS("filter", "none");
    const before = await output.screenshot();
    // Even a stale class from an older session must have no color effect.
    await page.evaluate(() =>
      document.documentElement.classList.add("gl-swap-rb"),
    );
    await expect(output).toHaveCSS("filter", "none");
    expect(await output.screenshot()).toEqual(before);
    await page.evaluate(() =>
      document.documentElement.classList.remove("gl-swap-rb"),
    );
  }
  const expected = await page.evaluate(
    () =>
      /Firefox/i.test(navigator.userAgent) &&
      /Linux|X11/i.test(navigator.userAgent || navigator.platform),
  );
  await page.evaluate(async () => {
    window.__photoModels = {};
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const { CorticalTopographyModel } =
      await import("/assets/js/models/cortical-topography.js");
    for (const prototype of [
      CorticalDreamDomeModel.prototype,
      CorticalTopographyModel.prototype,
    ]) {
      const render = prototype.render;
      prototype.render = async function (...args) {
        const result = await render.apply(this, args);
        window.__photoModels[this.id] = this;
        return result;
      };
    }
  });
  for (const [id, property] of [
    ["cortical-topography", "swapRB"],
    ["cortical-dream-dome", "colorSwapRB"],
  ]) {
    await page.locator("#model-select").selectOption(id);
    await page.waitForFunction(
      (id) => !!window.__photoModels[id]?.graphics,
      id,
    );
    expect(
      await page.evaluate(
        ({ id, property }) => {
          const m = window.__photoModels[id];
          return {
            flag: m[property],
            uniform: m.gl.getUniform(
              m.graphics.program,
              m.graphics.uniforms.swap_rb,
            ),
          };
        },
        { id, property },
      ),
    ).toEqual({ flag: expected, uniform: expected ? 1 : 0 });
    await expect(output).toHaveCSS("filter", "none");
  }
  await page.locator("#journey-enabled").check();
  await page
    .locator("#journey-options details")
    .filter({ has: page.locator("#journey-swap-rb") })
    .locator("summary")
    .click();
  const checkbox = page.locator("#journey-swap-rb");
  await expect(checkbox).toBeChecked({ checked: expected });
  for (const enabled of [!expected, expected]) {
    await checkbox.setChecked(enabled);
    await page.waitForFunction((enabled) => {
      const m = window.__photoModels["cortical-dream-dome"];
      return (
        m.colorSwapRB === enabled &&
        m.gl.getUniform(m.graphics.program, m.graphics.uniforms.swap_rb) ===
          Number(enabled)
      );
    }, enabled);
    await expect(output).toHaveCSS("filter", "none");
    await expect(page.locator("html")).not.toHaveClass(/gl-swap-rb/);
  }
  await page.locator("#journey-new").click();
  await expect(checkbox).toBeChecked({ checked: expected });
  await page.locator("#model-select").selectOption("folded-fractal");
  await expect(output).toHaveCSS("filter", "none");
  expect(errors).toEqual([]);
});

test("photo-only swizzles correct BGR textures in Topography, Dome, depth passages and warps", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  await page.route("http://127.0.0.1:8080/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Photo channel verification</title>",
    }),
  );
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const { CorticalTopographyModel } =
      await import("/assets/js/models/cortical-topography.js");
    const models = [
      new CorticalTopographyModel(),
      new CorticalDreamDomeModel(),
    ];
    const view = document.createElement("canvas");
    view.width = 160;
    view.height = 120;
    const images = [],
      results = [];
    const diff = (a, b) => {
      let total = 0,
        max = 0;
      for (let i = 0; i < a.length; i++)
        if (i % 4 !== 3) {
          const d = Math.abs(a[i] - b[i]);
          total += d;
          max = Math.max(max, d);
        }
      return { mean: total / ((a.length / 4) * 3), max };
    };
    try {
      for (const model of models) {
        const dome = model.id === "cortical-dream-dome",
          flag = dome ? "colorSwapRB" : "swapRB";
        const ctx = model.source.getContext("2d");
        ctx.fillStyle = "#dc451b";
        ctx.fillRect(0, 0, model.source.width, model.source.height);
        ctx.fillStyle = "#195bc3";
        ctx.fillRect(0, 0, model.source.width / 2, model.source.height / 2);
        if (dome) model.prepareSurround();
        await model.ensureGraphics();
        model.uploadSource();
        const gl = model.gl,
          g = model.graphics,
          source = dome ? model.seed360 : model.source;
        const canonical = source
          .getContext("2d")
          .getImageData(0, 0, source.width, source.height).data;
        const textures = dome
          ? [0, 3, 4, 5, 6, 7].map((i) => g.textures[i])
          : [g.sourceTexture];
        const upload = (swap) => {
          const data = canonical.slice();
          if (swap)
            for (let i = 0; i < data.length; i += 4)
              [data[i], data[i + 2]] = [data[i + 2], data[i]];
          gl.activeTexture(gl.TEXTURE0);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          for (const texture of textures) {
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA,
              source.width,
              source.height,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              data,
            );
          }
        };
        const p = Object.fromEntries(
          model.controls.map((c) => [c.key, c.default]),
        );
        Object.assign(p, {
          gain: 0,
          extrude: 0,
          depthScale: 0,
          neuralSwell: 0,
          cameraDolly: 0,
          edgeCoupling: 0,
          chromaticDispersion: 0,
        });
        const render = async () => {
          await model.render(view, p, 0);
          return view
            .getContext("2d")
            .getImageData(0, 0, view.width, view.height).data;
        };
        for (const stage of dome ? ["dome", "depth", "warp"] : ["topography"]) {
          if (stage === "depth") {
            model.journey.enabled = true;
            model.journey.newDream(42);
            model.journey.corruption = 0;
            model.journey.position = [0, -8];
          } else if (stage === "warp") {
            model.journey.home();
            model.journey.startWarp("0,-1");
            model.journey.advanceWarp(2.5);
          }
          model[flag] = false;
          upload(false);
          const baseline = await render();
          model[flag] = true;
          upload(true);
          const corrected = await render();
          images.push({ name: stage, png: view.toDataURL().split(",")[1] });
          const uniform = gl.getUniform(g.program, g.uniforms.swap_rb);
          model[flag] = false;
          const wrong = await render();
          results.push({
            stage,
            corrected: diff(baseline, corrected),
            uncorrected: diff(baseline, wrong),
            uniform,
            gl: gl.getError(),
          });
        }
      }
      return { results, images };
    } finally {
      for (const model of models) model.dispose();
    }
  });
  for (const image of result.images)
    await writeFile(
      info.outputPath(`${image.name}.png`),
      Buffer.from(image.png, "base64"),
    );
  console.log(JSON.stringify(result.results));
  for (const stage of result.results) {
    expect(stage.corrected.max, stage.stage).toBe(0);
    expect(stage.uncorrected.mean, stage.stage).toBeGreaterThan(0.5);
    expect(stage.uniform).toBe(1);
    expect(stage.gl).toBe(0);
  }
});
