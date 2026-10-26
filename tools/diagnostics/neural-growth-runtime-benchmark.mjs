// Read-only comparison with the pre-snapshot runtime. No production code is patched.
// gl.finish() is not a reliable GPU timing boundary in this browser path;
// stepCpuSubmissionOnly must not be interpreted as completed GPU step time.
import { chromium } from "@playwright/test";
import { createStaticServer } from "../../server.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = new URL(
  "../../diagnostics/neural-growth-performance/",
  import.meta.url,
);
await mkdir(output, { recursive: true });
const server = await createStaticServer(root);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
});
const baseline = execFileSync(
  "git",
  ["show", "ac5e8b2:assets/js/models/neural-growth/runtime.js"],
  { cwd: root, encoding: "utf8" },
);
const report = [];
try {
  for (const variant of ["current", "previous", "current"]) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    page.setDefaultTimeout(60000);
    await page.route(base + "/", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body></body></html>",
      }),
    );
    if (variant === "previous")
      await page.route("**/assets/js/models/neural-growth/runtime.js", (r) =>
        r.fulfill({ contentType: "text/javascript", body: baseline }),
      );
    await page.goto(base + "/");
    const result = await page.evaluate(async () => {
      const { TextureNcaRuntime } =
        await import("/assets/js/models/neural-growth/runtime.js");
      const { validateCheckpoint } =
        await import("/assets/js/models/neural-growth/reference.js");
      const checkpoint = validateCheckpoint(
        await (await fetch("/models/neural-growth/checkpoint.json")).json(),
      );
      const start = performance.now();
      const runtime = new TextureNcaRuntime({
        model: checkpoint,
        size: 256,
        seed: 1,
      });
      const gl = runtime.gl;
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      const info = {
        renderer: debug
          ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : gl.getParameter(gl.RENDERER),
        vendor: debug
          ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)
          : gl.getParameter(gl.VENDOR),
        timerQueries: !!gl.getExtension("EXT_disjoint_timer_query_webgl2"),
      };
      const createdMs = performance.now() - start;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 768;
      const summarize = (values) => {
        const sorted = values.slice().sort((a, b) => a - b);
        return {
          median: sorted[Math.floor(sorted.length / 2)],
          p90: sorted[Math.floor(sorted.length * 0.9)],
          mean: values.reduce((a, b) => a + b, 0) / values.length,
          samples: values.length,
        };
      };
      for (let i = 0; i < 8; i++) {
        runtime.step(1);
        runtime.draw(canvas);
        gl.finish();
      }
      const step = [];
      for (let i = 0; i < 30; i++) {
        const t = performance.now();
        runtime.step(1);
        gl.finish();
        step.push(performance.now() - t);
      }
      const draws = {};
      for (const size of [384, 768, 1536]) {
        canvas.width = canvas.height = size;
        for (let i = 0; i < 4; i++) {
          runtime.draw(canvas);
          gl.finish();
        }
        const times = [];
        for (let i = 0; i < 24; i++) {
          const t = performance.now();
          runtime.draw(canvas);
          gl.finish();
          times.push(performance.now() - t);
        }
        draws[size] = summarize(times);
      }
      const combined = [];
      canvas.width = canvas.height = 768;
      for (let i = 0; i < 24; i++) {
        const t = performance.now();
        runtime.step(1);
        runtime.draw(canvas);
        gl.finish();
        combined.push(performance.now() - t);
      }
      const stats = runtime.getStats();
      runtime.dispose();
      return {
        info,
        createdMs,
        stepCpuSubmissionOnly: summarize(step),
        draws,
        combined: summarize(combined),
        stats,
      };
    });
    report.push({ variant, ...result });
    console.log(JSON.stringify(report.at(-1)));
    await writeFile(
      new URL("runtime-results.json", output),
      JSON.stringify(report, null, 2),
    );
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
