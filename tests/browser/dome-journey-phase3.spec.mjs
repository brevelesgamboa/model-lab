import { test, expect } from "@playwright/test";

async function workers(context, delay = 0) {
  await context.route("**/migan-inpainter.worker.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage=async({data})=>{
      if(data.type==='prepare'){self.postMessage({type:'ready'});return;}
      const c=new OffscreenCanvas(data.bitmap.width,data.bitmap.height),ctx=c.getContext('2d');
      ctx.drawImage(data.bitmap,0,0);data.bitmap.close();
      const rgba=ctx.getImageData(0,0,c.width,c.height).data;
      for(let i=0;i<data.mask.length;i++)if(!data.mask[i]){rgba[i*4]=25;rgba[i*4+1]=190;rgba[i*4+2]=150;}
      await new Promise(r=>setTimeout(r,${delay}));
      self.postMessage({type:'result',width:c.width,height:c.height,rgba},[rgba.buffer]);
    };`,
    }),
  );
  for (const name of [
    "depth-estimator.worker.js",
    "inception-feature-map.worker.js",
  ])
    await context.route(`**/${name}`, (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: "self.onmessage=({data})=>{data.bitmap.close();self.postMessage({type:'result',width:2,height:2,depth:new Float32Array([.1,.8,.3,.6]),values:new Float32Array([0,.3,.6,1]),backend:'fixture'});};",
      }),
    );
}
async function blank(page) {
  await page.route("http://127.0.0.1:8080/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Room seeding verification</title>",
    }),
  );
  await page.goto("/");
}

test("real canvases seed one to three images, warp fills commit paired photo/depth, and GPU LRU releases evicted rooms", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await workers(context);
  await blank(page);
  const result = await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const model = new CorticalDreamDomeModel();
    model.colorSwapRB = false;
    model.buildMaps = async () => {};
    const files = await Promise.all(
      ["#cb3520", "#20cb35", "#3520cb"].map(async (color, i) => {
        const c = new OffscreenCanvas(64, 32),
          ctx = c.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 64, 32);
        return new File([await c.convertToBlob()], `seed-${i}.png`, {
          type: "image/png",
        });
      }),
    );
    const center = (canvas) => [
      ...canvas.getContext("2d").getImageData(200, 100, 1, 1).data,
    ];
    const assignments = [];
    for (const count of [1, 2, 3]) {
      await model.setSourceFiles(files.slice(0, count));
      assignments.push(model.journeyFields.anchors.map(center));
    }
    const prior = model.sourceName;
    try {
      await model.setSourceFiles([...files, files[0]]);
    } catch {}
    const rejected = model.sourceName === prior;
    try {
      await model.setSourceFiles([
        files[1],
        new File(["invalid"], "broken.png", { type: "image/png" }),
      ]);
    } catch {}
    const invalidDecodePreservedSource = model.sourceName === prior;
    const target = document.createElement("canvas");
    target.width = 128;
    target.height = 96;
    const params = Object.fromEntries(
      model.controls.map((c) => [c.key, c.default]),
    );
    Object.assign(params, { gain: 0, cameraDolly: 0, neuralSwell: 0 });
    await model.render(target, params, 0);
    const snapshot = () => [
      ...target.getContext("2d").getImageData(0, 0, 128, 96).data,
    ];
    const waking = snapshot();
    model.newJourney(42);
    model.setJourneyEnabled(true);
    const waitRoom = async () => {
      const started = performance.now();
      while (!model.journeyFields.frontier?.result) {
        if (performance.now() - started > 15000)
          throw Error(model.journeyFields.status);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    model.journey.startWarp("0,-1");
    await waitRoom();
    const beforeArrival = model.journeyFields.pool.entries.size;
    model.journey.advanceWarp(4.25);
    await model.render(target, params, 4.25);
    const blossom = snapshot();
    model.journey.advanceWarp(0.75);
    await model.render(target, params, 5);
    const gl = model.gl,
      first = model.journeyFields.pool.get("0,-1"),
      pair = [...first.gpu];
    const cells = Array.from({ length: 4 }, (_, i) =>
      gl.getUniform(
        model.graphics.program,
        gl.getUniformLocation(
          model.graphics.program,
          `u_journey_room_cells[${i}]`,
        ),
      ),
    );
    const slot = cells.findIndex(
      (c) => c[0] === 0 && c[1] === -1 && c[2] === 1,
    );
    gl.activeTexture(gl.TEXTURE0 + 4 + slot);
    const colorBound = gl.getParameter(gl.TEXTURE_BINDING_2D) === pair[0];
    gl.activeTexture(gl.TEXTURE0 + 8 + slot);
    const depthBound = gl.getParameter(gl.TEXTURE_BINDING_2D) === pair[1];
    let gpuDeleted = 0;
    const nativeDelete = gl.deleteTexture.bind(gl);
    gl.deleteTexture = (texture) => {
      if (texture) gpuDeleted++;
      nativeDelete(texture);
    };
    for (let i = 2; i <= 9; i++) {
      if (!model.journey.startWarp(`0,-${i}`))
        throw Error("Frontier not discovered");
      await waitRoom();
      model.journey.advanceWarp(5);
      // Allocate actual texture objects without repeatedly rendering the scene.
      model.journeyFields.roomBindings(
        model.journey.position,
        model.journey.seed,
        gl,
      );
    }
    const poolSize = model.journeyFields.pool.entries.size,
      evicted = pair.every((texture) => !gl.isTexture(texture)),
      latest = model.journeyFields.pool.get("0,-9");
    model.journey.home();
    await model.render(target, params, 50);
    const returned = snapshot();
    const result = {
      assignments,
      rejected,
      invalidDecodePreservedSource,
      beforeArrival,
      poolSize,
      evicted,
      gpuDeleted,
      pairWasAllocated: pair.length === 2,
      depth: latest.depth.kind,
      generator: latest.generator,
      pairedBindings: slot >= 0 && colorBound && depthBound,
      blossomVisible: blossom.some((v, i) => v !== waking[i]),
      sourceRestored: returned.every((v, i) => v === waking[i]),
      gl: gl.getError(),
    };
    model.dispose();
    return result;
  });
  expect(result.assignments[0]).toHaveLength(3);
  expect(result.assignments[0][0]).toEqual([203, 53, 32, 255]);
  expect(result.assignments[0][2]).not.toEqual(result.assignments[0][0]);
  expect(result.assignments[1][1]).toEqual([32, 203, 53, 255]);
  expect(result.assignments[2][2]).toEqual([53, 32, 203, 255]);
  expect(result.rejected).toBe(true);
  expect(result.invalidDecodePreservedSource).toBe(true);
  expect(result.pairedBindings).toBe(true);
  expect(result.beforeArrival).toBe(0);
  expect(result.poolSize).toBe(8);
  expect(result.evicted).toBe(true);
  expect(result.gpuDeleted).toBeGreaterThanOrEqual(2);
  expect(result.pairWasAllocated).toBe(true);
  expect(result.depth).toBe("estimated");
  expect(result.generator).toBe("MI-GAN");
  expect(result.blossomVisible).toBe(true);
  expect(result.sourceRestored).toBe(true);
  expect(result.gl).toBe(0);
});

test("multi-file picker loads seeds and Escape terminates autonomous inpainting without committing a room", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  await workers(context, 15000);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.goto("/");
  await page.locator("#quality-select").selectOption("economy");
  await page.evaluate(async () => {
    const { CorticalDreamDomeModel } =
      await import("/assets/js/models/cortical-dream-dome.js");
    const original = CorticalDreamDomeModel.prototype.render;
    CorticalDreamDomeModel.prototype.render = function (...args) {
      window.__phase3 = this;
      return original.apply(this, args);
    };
    const NativeWorker = window.Worker;
    window.__terminated = 0;
    window.Worker = class extends NativeWorker {
      terminate() {
        window.__terminated++;
        super.terminate();
      }
    };
  });
  await page.locator("#model-select").selectOption("cortical-dream-dome");
  await page.waitForFunction(() => !!window.__phase3?.graphics);
  const bytes = await page.evaluate(async () => {
    const c = new OffscreenCanvas(32, 16),
      ctx = c.getContext("2d");
    ctx.fillStyle = "#b75a28";
    ctx.fillRect(0, 0, 32, 16);
    return [...new Uint8Array(await (await c.convertToBlob()).arrayBuffer())];
  });
  await page.locator("#dome-image").setInputFiles(
    [1, 2].map((i) => ({
      name: `seed-${i}.png`,
      mimeType: "image/png",
      buffer: Buffer.from(bytes),
    })),
  );
  await page.waitForFunction(() => window.__phase3.seedSources?.length === 2);
  await page.locator("#journey-enabled").check();
  await page.evaluate(() => {
    window.__terminated = 0;
    window.__phase3.newJourney(42);
    window.__phase3.journey.startWarp("0,-1");
  });
  await page.waitForFunction(
    () => !!window.__phase3.journeyFields.frontier?.workers.inpainter.pending,
  );
  const controller = await page.evaluate(() => {
    window.__abort = window.__phase3.journeyFields.frontier.abort;
    return window.__abort.signal.aborted;
  });
  expect(controller).toBe(false);
  await page.keyboard.press("Escape");
  const result = await page.evaluate(() => ({
    aborted: window.__abort.signal.aborted,
    warping: window.__phase3.journey.warping,
    frontier: window.__phase3.journeyFields.frontier,
    rooms: window.__phase3.journeyFields.pool.entries.size,
    terminated: window.__terminated,
  }));
  expect(result.aborted).toBe(true);
  expect(result.warping).toBe(false);
  expect(result.frontier).toBeNull();
  expect(result.rooms).toBe(0);
  expect(result.terminated).toBeGreaterThan(0);
});
