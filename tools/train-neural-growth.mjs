// Local development runner. The app never downloads targets or trains an NCA.
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routes = new Map([
  ["/", ["prototypes/neural-growth/training/index.html", "text/html"]],
  [
    "/training-controller.js",
    ["prototypes/neural-growth/training/controller.js", "text/javascript"],
  ],
  [
    "/trainer.js",
    ["prototypes/neural-growth/training/trainer.js", "text/javascript"],
  ],
  [
    "/target.png",
    [
      "prototypes/neural-growth/training/targets/membrane-field.png",
      "image/png",
    ],
  ],
  ["/tf.min.js", ["assets/vendor/tensorflow/tf.min.js", "text/javascript"]],
  ...["reference", "runtime"].map((file) => [
    `/assets/js/models/neural-growth/${file}.js`,
    [`assets/js/models/neural-growth/${file}.js`, "text/javascript"],
  ]),
]);

export function createTrainingServer(pattern = "membrane-field") {
  if (!["membrane-field", "filament-network", "xeno-reef"].includes(pattern))
    throw new Error("Unknown original pattern target.");
  return http.createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405).end();
        return;
      }
      const pathname = request.url?.split("?")[0];
      const route =
        pathname === "/target.png"
          ? [
              `prototypes/neural-growth/training/targets/${pattern}.png`,
              "image/png",
            ]
          : routes.get(pathname);
      if (!route) {
        response.writeHead(404).end();
        return;
      }
      const filepath = path.join(root, route[0]);
      if ((await realpath(filepath)) !== filepath) {
        response.writeHead(403).end();
        return;
      }
      const data = await readFile(filepath);
      response
        .writeHead(200, {
          "Content-Type": route[1],
          "Content-Length": data.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self' 'unsafe-eval'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        })
        .end(request.method === "HEAD" ? undefined : data);
    } catch {
      response.writeHead(404).end();
    }
  });
}

async function main() {
  const iterations = Number(process.argv[2] || 1000);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10000)
    throw new Error("Iterations must be 1–10000.");
  const output = path.resolve(
    process.argv[3] || "/tmp/latent-field-membrane-training",
  );
  await mkdir(output, { recursive: true });
  const pattern = process.argv[4] || "membrane-field";
  const targetBytes = await readFile(
    path.join(root, `prototypes/neural-growth/training/targets/${pattern}.png`),
  );
  const targetSha256 = createHash("sha256").update(targetBytes).digest("hex");
  const server = createTrainingServer(pattern);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.error(error));
    const spatial = process.argv[5] === "spatial";
    await page.goto(
      `http://127.0.0.1:${server.address().port}/?pattern=${pattern}&spatial=${spatial ? 1 : 0}`,
    );
    await page.waitForFunction(() => Boolean(window.patternTrainer), {
      timeout: 30000,
    });
    console.log(
      await page.evaluate(() => ({
        backend: window.tf.getBackend(),
        memory: window.tf.memory(),
        renderer: window.tf
          .backend()
          .getGPGPUContext()
          .gl.getParameter(
            window.tf
              .backend()
              .getGPGPUContext()
              .gl.getExtension("WEBGL_debug_renderer_info")
              .UNMASKED_RENDERER_WEBGL,
          ),
      })),
    );
    await page.evaluate((count) => {
      window.patternTrainer.run(count).catch(() => {});
    }, iterations);
    let saved = 0;
    while (true) {
      await page.waitForTimeout(1000);
      const status = await page.evaluate(() => ({
        running: window.patternTrainer.running,
        error: window.patternTrainer.error,
        last: window.patternTrainer.records.at(-1),
      }));
      if (status.error) throw new Error(status.error);
      if (
        status.last &&
        (status.last.iteration >= saved + 50 || !status.running)
      ) {
        const result = await page.evaluate(() =>
          window.patternTrainer.trainer.checkpoint(),
        );
        saved = status.last.iteration;
        await writeFile(
          path.join(output, `checkpoint-${saved}.json`),
          JSON.stringify(result.checkpoint),
        );
        await writeFile(
          path.join(output, "training.json"),
          JSON.stringify(
            {
              ...result.training,
              targetSha256,
              records: await page.evaluate(() => window.patternTrainer.records),
            },
            null,
            2,
          ) + "\n",
        );
        await page
          .locator("#preview")
          .screenshot({ path: path.join(output, `preview-${saved}.png`) });
        console.log(JSON.stringify(status.last));
      }
      if (!status.running) break;
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
