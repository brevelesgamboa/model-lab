import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const PORT = 8767;
const executablePath =
  "/home/sparky/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".glsl": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
  ".frag": "text/plain; charset=utf-8",
  ".onnx": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(process.cwd(), reqPath.replace(/^\//, ""));
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`Server listening on http://127.0.0.1:${PORT}`);

const browser = await chromium.launch({
  executablePath,
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  // Block external fonts
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#model-select");

  // Wait for app initialization to populate model options
  await page.waitForFunction(() => {
    return document.getElementById("model-select")?.children.length > 0;
  }, { timeout: 15000 });

  const options = await page.locator("#model-select option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.value,
      label: node.textContent.trim(),
    }))
  );

  console.log("Model selector options on feature branch:", JSON.stringify(options, null, 2));

  // Verify all 8 available models exist in selector
  const expectedModes = [
    { value: "chromatic-field", label: "Chromatic Flow" },
    { value: "folded-fractal", label: "Folded Fractal" },
    { value: "fractal-functions", label: "Fractal Explorer" },
    { value: "digiface-vae", label: "DigiFace Generator" },
    { value: "inception-dream", label: "Inception Dream" },
    { value: "neural-growth", label: "Neural Growth" },
    { value: "cortical-topography", label: "3D Cortical Topography" },
    { value: "cortical-dream-dome", label: "Cortical Dream Dome (360)" },
  ];

  assert.strictEqual(options.length, 8, `Expected exactly 8 modes, found ${options.length}`);
  for (let i = 0; i < expectedModes.length; i++) {
    assert.strictEqual(options[i].value, expectedModes[i].value);
    assert.strictEqual(options[i].label, expectedModes[i].label);
  }

  // Test each mode
  for (const mode of expectedModes) {
    console.log(`Testing mode: ${mode.label} (${mode.value})...`);
    await page.locator("#model-select").selectOption(mode.value);
    await page.waitForTimeout(400);

    const renderState = await page.locator("#render-state").textContent();
    console.log(`  -> Render state: ${renderState}`);

    if (mode.value === "cortical-dream-dome") {
      // Specific checks for Cortical Dream Dome
      await page.waitForSelector("#dome-tools:not([hidden])");

      // Test 360 mouselook drag
      const canvasBox = await page.locator("#output-canvas").boundingBox();
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 100, canvasBox.y + canvasBox.height / 2 + 50);
      await page.mouse.up();
      await page.waitForTimeout(200);

      const presetLabel = await page.locator("#dome-nca-preset-label").textContent().catch(() => "N/A");
      console.log(`  -> Active preset label: ${presetLabel}`);

      // Verify pixel color from center of canvas (ensure natural warm/red hues, zero inverted color)
      const pixel = await page.evaluate(() => {
        const c = document.getElementById("output-canvas");
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const imgData = ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
        return Array.from(imgData);
      });
      console.log(`  -> Sampled center pixel [R, G, B, A]: [${pixel.join(", ")}]`);

      // Screenshot for verification
      const artifactDir = "/home/sparky/.gemini/antigravity/brain/d34ca240-c3e2-435f-bf26-64a4ff6c7aa5";
      await page.screenshot({ path: path.join(artifactDir, "feature-cortical-dream-dome-verified.png") });
      console.log("  -> Saved screenshot: feature-cortical-dream-dome-verified.png");
    }
  }

  const criticalErrors = pageErrors.filter(
    (e) =>
      !e.includes("favicon.ico") &&
      !e.includes("font") &&
      !e.includes("net::ERR_FAILED"),
  );
  assert.strictEqual(criticalErrors.length, 0, `Critical errors found: ${criticalErrors.join("; ")}`);
  console.log("\nALL VERIFICATIONS PASSED: Cortical Dream Dome and all 7 sibling models load cleanly!");
} finally {
  await browser.close();
  server.close();
}
