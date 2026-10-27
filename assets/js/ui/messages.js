const TECHNICAL_WORDS = new Map([
  ["PNG", "PNG"],
  ["GIF", "GIF"],
  ["CSV", "CSV"],
  ["JSON", "JSON"],
  ["GPU", "GPU"],
  ["CPU", "CPU"],
  ["NCA", "NCA"],
  ["PCA", "PCA"],
  ["RGB", "RGB"],
  ["FFT", "FFT"],
  ["LFO", "LFO"],
  ["ONNX", "ONNX"],
  ["WEBGL2", "WebGL2"],
  ["WEBGL", "WebGL"],
  ["WEBGPU", "WebGPU"],
  ["INCEPTIONV3", "InceptionV3"],
  ["SOBEL", "Sobel"],
  ["HQ", "HQ"],
  ["GB", "GB"],
  ["MB", "MB"],
  ["KB", "KB"],
  ["FPS", "FPS"],
  ["NVIDIA", "NVIDIA"],
  ["AMD", "AMD"],
  ["HTTP", "HTTP"],
  ["URL", "URL"],
]);

// Quiet legacy shouting while retaining model names, IDs, paths and acronyms.
export function displayMessage(value) {
  const text = String(value || "Ready").trim();
  const normalized = text.replace(/\b[A-Z][A-Z0-9]*\b/g, (word, offset) => {
    const start = text.lastIndexOf(" ", offset) + 1;
    const nextSpace = text.indexOf(" ", offset);
    const token = text.slice(start, nextSpace === -1 ? text.length : nextSpace);
    if (/[\/_]/.test(token) || /\w\.\w|[A-Z]+-\d/.test(token)) return word;
    if (TECHNICAL_WORDS.has(word)) return TECHNICAL_WORDS.get(word);
    if (word.length < 2 || /\d/.test(word)) return word;
    return word.toLowerCase();
  });
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
