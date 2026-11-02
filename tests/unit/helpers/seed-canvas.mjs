// Minimal nearest-neighbor canvas for exercising crop pixels in Node, where the
// browser's OffscreenCanvas is unavailable. Browser tests cover real resampling.
export function seedCanvas(width, height, pixel = () => [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  const canvas = { width, height, data };
  canvas.getContext = () => ({
    drawImage(source, ...args) {
      let sx = 0,
        sy = 0,
        sw = source.width,
        sh = source.height,
        dx = 0,
        dy = 0,
        dw = sw,
        dh = sh;
      if (args.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = args;
      else if (args.length === 4) [dx, dy, dw, dh] = args;
      else if (args.length === 2) [dx, dy] = args;
      for (let y = 0; y < dh; y++)
        for (let x = 0; x < dw; x++) {
          const ix = Math.min(source.width - 1, Math.floor(sx + (x / dw) * sw)),
            iy = Math.min(source.height - 1, Math.floor(sy + (y / dh) * sh));
          data.set(
            source.data.subarray(
              (iy * source.width + ix) * 4,
              (iy * source.width + ix) * 4 + 4,
            ),
            ((dy + y) * width + dx + x) * 4,
          );
        }
    },
    getImageData: () => ({ data: data.slice(), width, height }),
    putImageData: (image) => data.set(image.data),
  });
  return canvas;
}
