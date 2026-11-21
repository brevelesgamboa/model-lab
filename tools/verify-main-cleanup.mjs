import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

const PORT = 8766;
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

// Simple static server for main Workbench app
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
    console.log(`[BROWSER ${msg.type()}]:`, msg.text());
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  page.on("request", (req) => {
    console.log(`[REQ]: ${req.url()}`);
  });
  page.on("requestfailed", (req) => {
    console.log(`[REQ FAILED]: ${req.url()} - ${req.failure()?.errorText}`);
  });

  // Block external fonts for reproducible offline testing
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#model-select");

  // Wait for app initialization to populate model options
  await page.waitForFunction(() => {
    return document.getElementById("model-select")?.children.length > 0;
  }, { timeout: 15000 });

  // 1. Audit model-select dropdown options
  console.log("Recorded page errors:", pageErrors);
  const options = await page.locator("#model-select option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      value: node.value,
      label: node.textContent.trim(),
      disabled: node.disabled,
    }))
  );

  console.log("Model selector options on main:", JSON.stringify(options, null, 2));

  const expectedModes = [
    { value: "chromatic-field", label: "Chromatic Flow" },
    { value: "folded-fractal", label: "Folded Fractal" },
    { value: "fractal-functions", label: "Fractal Explorer" },
    { value: "digiface-vae", label: "DigiFace Generator" },
    { value: "inception-dream", label: "Inception Dream" },
    { value: "neural-growth", label: "Neural Growth" },
    { value: "cortical-topography", label: "3D Cortical Topography" },
  ];

  assert.strictEqual(options.length, 7, `Expected exactly 7 modes in dropdown, found ${options.length}`);
  for (let i = 0; i < expectedModes.length; i++) {
    assert.strictEqual(options[i].value, expectedModes[i].value, `Mode ${i} value mismatch: ${options[i].value} !== ${expectedModes[i].value}`);
    assert.strictEqual(options[i].label, expectedModes[i].label, `Mode ${i} label mismatch: ${options[i].label} !== ${expectedModes[i].label}`);
    assert.strictEqual(options[i].disabled, false, `Mode ${i} should be enabled`);
  }

  // 2. Select each mode and verify clean execution with no errors
  for (const mode of expectedModes) {
    console.log(`Testing mode: ${mode.label} (${mode.value})...`);
    await page.locator("#model-select").selectOption(mode.value);
    await page.waitForTimeout(300);

    const renderState = await page.locator("#render-state").textContent();
    console.log(`  -> Render state: ${renderState}`);

    if (mode.value === "cortical-topography") {
      // Specific checks for 3D Cortical Topography
      await page.waitForSelector("#cortical-tools:not([hidden])");
      const hasOrbit = await page.locator("#output-canvas").evaluate((el) =>
        el.classList.contains("has-orbit-camera")
      );
      assert.strictEqual(hasOrbit, true, "Canvas should have 'has-orbit-camera' class in Cortical Topography mode");

      // Test "Use demo" button
      await page.locator("#cortical-demo").click();
      await page.waitForTimeout(200);

      // Test "Reset camera" button
      await page.locator("#cortical-reset-camera").click();
      await page.waitForTimeout(100);

      const statusText = await page.locator("#cortical-status").textContent();
      console.log(`  -> Cortical status: ${statusText}`);

      // Take a screenshot of 3D Cortical Topography
      const artifactDir = "/home/sparky/.gemini/antigravity/brain/d34ca240-c3e2-435f-bf26-64a4ff6c7aa5";
      await page.screenshot({ path: path.join(artifactDir, "main-cortical-topography-verified.png") });
      console.log("  -> Saved screenshot: main-cortical-topography-verified.png");
    }
  }

  // Filter out any expected non-fatal browser warnings (such as aborted external fonts)
  const criticalErrors = pageErrors.filter(
    (e) =>
      !e.includes("favicon.ico") &&
      !e.includes("font") &&
      !e.includes("net::ERR_FAILED"),
  );
  assert.strictEqual(
    criticalErrors.length,
    0,
    `Encountered errors: ${criticalErrors.join("; ")}`,
  );

  console.log("\nALL AUDIT CHECKS PASSED: Exactly 7 modes registered and functional with 0 errors!");
} finally {
  await browser.close();
  server.close();
}
