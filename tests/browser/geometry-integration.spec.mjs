import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.goto("/");
  await expect(page.locator("#status-message")).toContainText("ready");
});

test("all 56 transfer models load, step, and draw through the production loader", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const results = await page.evaluate(async () => {
    const { NeuralGrowthModel } =
      await import("/assets/js/models/neural-growth.js");
    const { PATTERNS } =
      await import("/assets/js/models/neural-growth/patterns.js");
    const { defaultParameters } =
      await import("/assets/js/core/model-contract.js");
    const model = new NeuralGrowthModel();
    const defaults = defaultParameters(model);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const results = [];
    try {
      for (const pattern of PATTERNS.filter(
        ({ id }) => id.includes("-guidance-") || id.startsWith("feature-"),
      )) {
        const previous = model._runtime;
        const parameters = {
          ...defaults,
          pattern: pattern.id,
          simulationSize: 128,
          seed: pattern.startup.seed,
        };
        const frame = await model.render(canvas, parameters);
        if (frame.status !== "ready")
          throw new Error(`${pattern.id}: ${model.lastError}`);
        const runtime = model._runtime;
        const errors = [runtime.gl.getError()];
        const feature = pattern.id.startsWith("feature-");
        runtime.step(feature ? 96 : 4);
        runtime.draw(canvas, { echoDecay: 0.2 });
        errors.push(runtime.gl.getError());
        const data = runtime.readState();
        const colors = new Set();
        for (let i = 0; i < data.length; i += 12)
          colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        let respondsToDamage = null;
        if (feature) {
          runtime.disturb(64, 64, 16, "erase");
          const damaged = runtime.readState();
          runtime.step(64);
          const regrown = runtime.readState();
          respondsToDamage =
            damaged.some((value, i) => value !== data[i]) &&
            regrown.some((value, i) => value !== damaged[i]);
          errors.push(runtime.gl.getError());
        }
        for (const preview of new Set([
          pattern.previewUrl.href,
          ...Object.values(pattern.previews || {}).map((url) => url.href),
        ])) {
          const response = await fetch(preview, { method: "HEAD" });
          if (
            !response.ok ||
            !response.headers.get("content-type").includes("image/gif")
          )
            throw new Error(`Missing GIF: ${preview}`);
        }
        results.push({
          id: runtime.model.id,
          errors,
          colors: colors.size,
          respondsToDamage,
          previousDisposed: !previous || previous.disposed,
        });
      }
    } finally {
      model.dispose();
    }
    return results;
  });
  expect(results).toHaveLength(56);
  for (const result of results) {
    expect(result.errors, result.id).toEqual(result.errors.map(() => 0));
    expect(result.previousDisposed, result.id).toBe(true);
    if (result.id.startsWith("feature-")) {
      expect(result.colors, result.id).toBeGreaterThan(1);
      expect(result.respondsToDamage, result.id).toBe(true);
    }
  }
});

test("spiral shaders guard raw uniforms and blend groomed perception coefficients", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { TextureNcaRuntime, SPIRAL_MAX_PITCH_RADIANS: limit } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const { validateCheckpoint } =
      await import("/assets/js/models/neural-growth/reference.js");
    const raw = await (
      await fetch(
        "/models/neural-growth/custom/mixed4a-489-guidance-r07-s01.json",
      )
    ).json();
    const runtime = new TextureNcaRuntime({
      model: validateCheckpoint(raw),
      size: 32,
    });
    const gl = runtime.gl;
    const errors = [];
    const uniforms = {
      u_offset: [0, 0],
      u_angle: 0.17,
      u_perceptionPhase: 0.23,
      u_topology: 0,
      u_transform: 2,
      u_twist: 0.5,
      u_geometryCenterX: 0,
      u_geometryCenterY: 0,
      u_geometrySoftness: 0,
      u_foldCount: 6,
    };
    const perception = (strength, twist = 0.5) => {
      runtime.run(
        "perception",
        runtime.perception,
        {
          u_state: runtime.state,
          u_shuffle: runtime.shuffleTexture,
          u_orientation: runtime.orientation,
        },
        { ...uniforms, u_geometryStrength: strength, u_twist: twist },
      );
      const bytes = new Uint8Array(
        runtime.perception.width * runtime.perception.height * 4,
      );
      gl.readPixels(
        0,
        0,
        runtime.perception.width,
        runtime.perception.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        bytes,
      );
      errors.push(gl.getError());
      return bytes;
    };
    const same = (a, b) => a.every((value, i) => value === b[i]);
    const blends = [];
    try {
      for (const groom of [false, true]) {
        if (groom) runtime.disturb(16, 16, 12, "groom", { strokeAngle: 0.8 });
        const base = perception(0);
        const full = perception(1);
        const half = perception(0.5);
        let error = 0;
        for (let i = 0; i < half.length; i++)
          error = Math.max(error, Math.abs(half[i] - (base[i] + full[i]) / 2));
        blends.push({ error, distinct: !same(base, full) });
      }
      const guards = [
        same(perception(1, Math.PI / 2), perception(1, limit)),
        same(perception(1, -Math.PI / 2), perception(1, -limit)),
        same(perception(2), perception(1)),
        same(perception(-1), perception(0)),
      ];
      runtime.step(2, {
        coordinateTransform: "spiral",
        twist: Math.PI / 2,
        geometryStrength: 0.5,
        resonance: {
          enabled: true,
          latentFeedback: 0.3,
          perceptionDrift: 0.02,
        },
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 32;
      runtime.twist = -Math.PI / 2;
      runtime.draw(canvas, { echoDecay: 0.5, pan: [0.125, -0.0625] });
      errors.push(gl.getError());
      const echoPitch = gl.getUniform(
        runtime.program.echo.handle,
        runtime.program.echo.locations.get("u_twist"),
      );
      const feedback = gl.getUniform(
        runtime.program.update.handle,
        runtime.program.update.locations.get("u_resonanceFeedback"),
      );
      const evolvedColors = [];
      for (const twist of [-Math.PI / 2, Math.PI / 2]) {
        runtime.restart();
        runtime.step(96, {
          coordinateTransform: "spiral",
          twist,
          geometryStrength: 1,
          resonance: null,
        });
        const bytes = runtime.readState();
        const colors = new Set();
        for (let i = 0; i < bytes.length; i += 12)
          colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
        evolvedColors.push(colors.size);
        errors.push(gl.getError());
      }
      return {
        blends,
        guards,
        errors,
        echoPitch,
        feedback,
        limit,
        evolvedColors,
      };
    } finally {
      runtime.dispose();
    }
  });
  for (const blend of result.blends) {
    expect(blend.distinct).toBe(true);
    expect(blend.error).toBeLessThanOrEqual(1);
  }
  expect(result.guards).toEqual([true, true, true, true]);
  expect(result.errors).toEqual(result.errors.map(() => 0));
  expect(result.echoPitch).toBeCloseTo(-result.limit, 6);
  expect(result.feedback).toBeCloseTo(0.3, 6);
  for (const colors of result.evolvedColors) expect(colors).toBeGreaterThan(1);
});

test("feature gallery entries show motion previews and select their unique checkpoints", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__transferRuntime = this;
      return draw.apply(this, args);
    };
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled({ timeout: 30_000 });
  for (const [id, name, description] of [
    [
      "feature-mixed4a-489",
      "Ocular Iris (mixed4a:489)",
      "Autonomous concentric iris rings and eye whorls",
    ],
    [
      "feature-mixed4c-439",
      "Cellular Vesicle (mixed4c:439)",
      "Autonomous organic cell membranes and circular lumens",
    ],
  ]) {
    await page.locator("#open-growth-gallery").click();
    await page.locator('.growth-gallery__tab[data-filter="all"]').click();
    await expect(page.locator("#growth-gallery-count")).toHaveText(
      "161 patterns",
    );
    await page.locator('.growth-gallery__tab[data-filter="inception"]').click();
    const card = page.locator(`.growth-gallery__card[data-pattern-id="${id}"]`);
    await expect(card.locator(".growth-gallery__card-name")).toHaveText(name);
    await expect(card).toHaveAttribute("title", description);
    await card.scrollIntoViewIfNeeded();
    await expect(card.locator("img")).toHaveAttribute(
      "src",
      new RegExp(`${id}\\.gif$`),
    );
    await expect
      .poll(() =>
        card
          .locator("img")
          .evaluate((img) => img.complete && img.naturalWidth === 256),
      )
      .toBe(true);
    await card.click();
    await expect(page.locator("#growth-gallery-dialog")).not.toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.__transferRuntime.model.id))
      .toBe(id);
    await page.locator("#step-growth").click();
    expect(
      await page.evaluate(() => window.__transferRuntime.gl.getError()),
    ).toBe(0);
  }
});
