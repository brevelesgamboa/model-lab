import test from "node:test";
import assert from "node:assert/strict";
import { uploadDream360 } from "../../assets/js/models/inception-dream-bake.js";

test("dream photos upload canonical RGBA bytes with dimensions, vertical flip and safe row alignment", () => {
  const uploads = [],
    parameters = new Map(),
    stores = new Map();
  const gl = Object.fromEntries(
    [
      "TEXTURE_2D",
      "UNPACK_FLIP_Y_WEBGL",
      "UNPACK_ALIGNMENT",
      "RGBA",
      "UNSIGNED_BYTE",
      "TEXTURE_MIN_FILTER",
      "TEXTURE_MAG_FILTER",
      "TEXTURE_WRAP_S",
      "TEXTURE_WRAP_T",
      "LINEAR",
      "REPEAT",
      "CLAMP_TO_EDGE",
    ].map((key, i) => [key, i + 1]),
  );
  const texture = {};
  gl.bindTexture = (target, value) => {
    assert.equal(target, gl.TEXTURE_2D);
    assert.equal(value, texture);
  };
  gl.pixelStorei = (key, value) => stores.set(key, value);
  gl.texParameteri = (_target, key, value) => parameters.set(key, value);
  gl.texImage2D = (...args) => uploads.push(args);
  const data = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 30, 60, 90, 128, 120, 90,
    60, 255, 200, 130, 10, 255,
  ]);
  const canvas = {
    width: 3,
    height: 2,
    getContext(type) {
      assert.equal(type, "2d");
      return {
        getImageData(...rect) {
          assert.deepEqual(rect, [0, 0, 3, 2]);
          return { data };
        },
      };
    },
  };
  uploadDream360(gl, texture, canvas);
  assert.deepEqual(uploads, [
    [gl.TEXTURE_2D, 0, gl.RGBA, 3, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data],
  ]);
  assert.equal(uploads[0][8], data, "no canvas surface reaches texImage2D");
  assert.equal(stores.get(gl.UNPACK_FLIP_Y_WEBGL), true);
  assert.equal(stores.get(gl.UNPACK_ALIGNMENT), 1);
  assert.equal(parameters.get(gl.TEXTURE_WRAP_S), gl.REPEAT);
  assert.equal(parameters.get(gl.TEXTURE_WRAP_T), gl.CLAMP_TO_EDGE);
});

test("failed photo readback never falls back to the affected canvas-surface upload", () => {
  let uploads = 0;
  const canvas = {
    width: 64,
    height: 64,
    getContext: () => ({
      getImageData() {
        throw new DOMException("Unreadable photo", "SecurityError");
      },
    }),
  };
  assert.throws(
    () =>
      uploadDream360(
        {
          texImage2D() {
            uploads++;
          },
        },
        {},
        canvas,
      ),
    { name: "SecurityError" },
  );
  assert.equal(uploads, 0);
});
