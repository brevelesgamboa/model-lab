import { DigiFaceVaeModel } from "../models/digiface-vae.js";
import { defaultParameters } from "../core/model-contract.js";

const button = document.getElementById("run-check");
const log = document.getElementById("log");
button.addEventListener("click", async () => {
  button.disabled = true;
  const model = new DigiFaceVaeModel();
  log.textContent = "Checking decoder…";
  try {
    const result = await model.selfCheck();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const frame = await model.render(canvas, defaultParameters(model));
    if (frame.modelMetrics?.modelState !== "READY")
      throw new Error("Inference did not complete.");
    log.textContent = "PASS\n" + JSON.stringify(result, null, 2);
  } catch (error) {
    log.textContent = "FAILED: " + error.message;
  } finally {
    await model.dispose();
    button.disabled = false;
  }
});
