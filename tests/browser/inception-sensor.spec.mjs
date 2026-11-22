import { test, expect } from "@playwright/test";

test("a forward-only worker routes neural energy without audio and survives target, pause and navigation changes", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) =>
    route.abort(),
  );
  await page.addInitScript(() => {
    window.__sensorGuards = 0;
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (event.data.type === "audit-guard") window.__sensorGuards++;
        });
      }
    };
  });
  await context.route("**/inception-sensor.worker.js", async (route) => {
    const response = await route.fetch();
    const guard = `const originalImport = self.importScripts.bind(self);
      self.importScripts = (...urls) => {
        originalImport(...urls);
        self.tf.engine().gradients = () => { throw new Error('Unexpected backward pass'); };
        const data = self.tf.Tensor.prototype.data;
        self.tf.Tensor.prototype.data = function() {
          if (this.size !== 1) throw new Error('Downloaded an unpooled activation');
          return data.call(this);
        };
        self.postMessage({type:'audit-guard'});
      };\n`;
    await route.fulfill({ response, body: guard + (await response.text()) });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(async () => {
    const { TextureNcaRuntime } =
      await import("/assets/js/models/neural-growth/runtime.js");
    const draw = TextureNcaRuntime.prototype.draw;
    TextureNcaRuntime.prototype.draw = function (...args) {
      window.__sensorRuntime = this;
      return draw.apply(this, args);
    };
    TextureNcaRuntime.prototype.readPhenotypeRgb = () => {
      throw new Error("Synchronous phenotype read in the visual sensor");
    };
  });
  await page.locator("#model-select").selectOption("neural-growth");
  await expect(page.locator("#step-growth")).toBeEnabled();
  await page.evaluate(() => {
    window.__initialSensorRuntime = window.__sensorRuntime;
  });
  const control = page.locator('[data-parameter="rotation"]');
  await control.evaluate((element) => {
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    )
      if (parent.tagName === "DETAILS") parent.open = true;
  });
  await control.locator(".modulation-toggle").click();
  const drawer = control.locator(".modulation-drawer");
  await drawer.getByRole("button", { name: "Inception", exact: true }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { inceptionSensor } =
            await import("/assets/js/models/neural-growth/inception-sensor.js");
          return inceptionSensor.error || inceptionSensor.samples >= 4;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  const stats = await page.evaluate(async () => {
    const { inceptionSensor: sensor } =
      await import("/assets/js/models/neural-growth/inception-sensor.js");
    const { rhythmController } =
      await import("/assets/js/core/rhythm-controller.js");
    const { getAudioRoute } =
      await import("/assets/js/core/modulation-matrix.js");
    return {
      ...sensor.getStats(),
      audio: rhythmController.status,
      route: getAudioRoute("neural-growth", "rotation"),
      mainThreadTf: Boolean(window.tf),
      guards: window.__sensorGuards,
      steps: window.__sensorRuntime.steps,
    };
  });
  expect(stats).toMatchObject({
    backend: "webgl",
    downloadedValues: 1,
    retainedTensors: 0,
    error: null,
    audio: "idle",
    mainThreadTf: false,
    guards: 1,
    route: { source: "inception", depth: 0.25 },
  });
  expect(stats.level).toBeGreaterThanOrEqual(0);
  expect(stats.level).toBeLessThanOrEqual(1);
  expect(stats.steps).toBeGreaterThan(0);
  await expect(drawer.locator(".sensor-activity-line")).toHaveAttribute(
    "d",
    /^M.+L/,
  );
  const help = drawer.locator(".drawer-sensor-help");
  const paper = help.getByRole("link", {
    name: "Read Feature Visualization",
    exact: false,
  });
  await expect(paper).toBeHidden();
  await help.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(paper).toBeVisible();
  await expect(paper).toHaveAttribute(
    "href",
    "https://distill.pub/2017/feature-visualization/",
  );
  await expect(help).toContainText(
    "Layer chooses a network stage; Channel chooses a neuron.",
  );
  await page.keyboard.press("Enter");
  await expect(paper).toBeHidden();
  await expect(drawer.locator('[data-field="sensorChannel"]')).toHaveValue(
    "42",
  );
  await drawer.locator('[data-field="sensorLayer"]').selectOption("mixed_5b");
  await drawer.locator('[data-field="sensorChannel"]').fill("120");
  await drawer.locator('[data-field="sensorChannel"]').dispatchEvent("change");
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (
              await import("/assets/js/models/neural-growth/inception-sensor.js")
            ).inceptionSensor.samples,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(2);
  await drawer
    .locator('[data-field="sensorLayer"]')
    .selectOption("Conv2d_2b_3x3");
  await expect(drawer.locator('[data-field="sensorChannel"]')).toHaveAttribute(
    "max",
    "63",
  );
  await expect(drawer.locator('[data-field="sensorChannel"]')).toHaveValue(
    "63",
  );
  await page.locator("#toggle-animation").click();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await import("/assets/js/models/neural-growth/inception-sensor.js"))
            .inceptionSensor.active,
      ),
    )
    .toBe(false);
  const paused = await page.evaluate(() => ({
    steps: window.__sensorRuntime.steps,
    state: Array.from(window.__sensorRuntime.readState()),
  }));
  await page.locator('[data-view="saved"]').click();
  await page.locator('[data-view="lab"]').click();
  expect(
    await page.evaluate(() => ({
      steps: window.__sensorRuntime.steps,
      state: Array.from(window.__sensorRuntime.readState()),
    })),
  ).toEqual(paused);
  expect(
    await page.evaluate(
      () => window.__sensorRuntime === window.__initialSensorRuntime,
    ),
  ).toBe(true);
  await page.locator("#toggle-animation").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          async () =>
            (
              await import("/assets/js/models/neural-growth/inception-sensor.js")
            ).inceptionSensor.samples,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => window.__sensorGuards)).toBe(1);
  await drawer.getByRole("button", { name: "Off", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await import("/assets/js/models/neural-growth/inception-sensor.js")
        ).inceptionSensor.getLevel(),
      ),
    )
    .toBe(0);
  expect(await page.evaluate(() => window.__sensorRuntime.gl.getError())).toBe(
    0,
  );
  expect(errors).toEqual([]);
});
