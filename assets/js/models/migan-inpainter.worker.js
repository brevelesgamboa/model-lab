import { getMiganSession, loadMiganFromFile } from "./migan-loader.js";
import { inpaintEquirectangular } from "./migan-inpainter.js";
self.onmessage = async ({ data }) => {
  try {
    const session = data.file
      ? await loadMiganFromFile(data.file)
      : await getMiganSession();
    if (!session) {
      self.postMessage({ type: "missing" });
      return;
    }
    if (data.type === "prepare") {
      self.postMessage({ type: "ready", ...session.miganInfo });
      return;
    }
    const canvas = await inpaintEquirectangular(data.bitmap, session, {
      coverage: data.coverage || "immersive",
    });
    const rgba = canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height).data;
    self.postMessage(
      {
        type: "result",
        rgba,
        width: canvas.width,
        height: canvas.height,
        photoRect: canvas.photoRect,
      },
      [rgba.buffer],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      error: error.message || "MI-GAN failed.",
    });
  } finally {
    data.bitmap?.close();
  }
};
