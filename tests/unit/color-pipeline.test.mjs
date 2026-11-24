import test from "node:test";
import assert from "node:assert/strict";
import { uploadDream360 } from "../../assets/js/render/dome-graphics.js";
import {
  packMiganInputs,
  compositeMigan,
} from "../../assets/js/models/migan-inpainter.js";

test("uploadDream360 sets UNPACK_COLORSPACE_CONVERSION_WEBGL to gl.NONE and preserves canonical RGBA bytes", () => {
  const calls = [];
  const pixelStore = {};
  const mockGl = {
    TEXTURE_2D: 0x0de1,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_ALIGNMENT: 0x0cf5,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
    NONE: 0,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    bindTexture(target, tex) {
      calls.push({ method: "bindTexture", target, tex });
    },
    pixelStorei(param, value) {
      pixelStore[param] = value;
      calls.push({ method: "pixelStorei", param, value });
    },
    texParameteri(target, pname, param) {
      calls.push({ method: "texParameteri", target, pname, param });
    },
    texImage2D(target, level, internalformat, format, type, source) {
      calls.push({
        method: "texImage2D",
        target,
        level,
        internalformat,
        format,
        type,
        source,
      });
    },
  };

  const mockImage = {
    width: 2,
    height: 2,
  };

  const mockTexture = {};
  uploadDream360(mockGl, mockTexture, mockImage);

  // UNPACK_COLORSPACE_CONVERSION_WEBGL must be set to NONE
  assert.equal(
    pixelStore[mockGl.UNPACK_COLORSPACE_CONVERSION_WEBGL],
    mockGl.NONE,
    "UNPACK_COLORSPACE_CONVERSION_WEBGL must be explicitly set to gl.NONE to prevent browser gamma/ICC color distortion",
  );

  const uploadCall = calls.find((c) => c.method === "texImage2D");
  assert.ok(uploadCall, "texImage2D must be called");
  assert.equal(uploadCall.format, mockGl.RGBA);
  assert.equal(uploadCall.source, mockImage);
});

test("MI-GAN packing and masking preserves pure RGB channels without R/B channel swap", () => {
  const width = 4;
  const height = 4;
  const count = width * height;
  const rgba = new Uint8ClampedArray(count * 4);
  for (let i = 0; i < count; i++) {
    rgba[i * 4 + 0] = 220; // Red
    rgba[i * 4 + 1] = 40;  // Green
    rgba[i * 4 + 2] = 10;  // Blue
    rgba[i * 4 + 3] = 255;
  }
  const rect = { x: 1, y: 1, width: 2, height: 2 };
  const packed = packMiganInputs(rgba, width, height, rect);

  // Planar [3, H, W]: Channel 0 is Red, Channel 1 is Green, Channel 2 is Blue
  for (let i = 0; i < count; i++) {
    assert.equal(packed.image[0 * count + i], 220, "Planar channel 0 must be Red (220)");
    assert.equal(packed.image[1 * count + i], 40, "Planar channel 1 must be Green (40)");
    assert.equal(packed.image[2 * count + i], 10, "Planar channel 2 must be Blue (10)");
  }

  // Composite simulated model output back into RGBA
  const syntheticResult = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    syntheticResult[0 * count + i] = 250; // Red
    syntheticResult[1 * count + i] = 20;  // Green
    syntheticResult[2 * count + i] = 5;   // Blue
  }

  const composited = compositeMigan(syntheticResult, rgba, width, height, rect);
  // Pixel (0,0) outside rect - should be synthesized background (with cosine transition)
  assert.ok(composited[0] > 0, "Synthesized pixel Red must remain positive");
  assert.ok(composited[0] >= composited[2], "Synthesized pixel Red must dominate Blue");
});
