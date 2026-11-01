import path from "node:path";
import { writeFile } from "node:fs/promises";

export async function writeDreamDriftGallery(output, report) {
  const escape = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const cards = report.artifacts
    .map(
      (entry) =>
        `<article><h2>${escape(entry.input)} · ${escape(entry.label)}</h2><a href="${escape(entry.texture)}"><img loading="lazy" src="${escape(entry.texture)}" alt="${escape(entry.label)}"></a>${entry.views ? `<details><summary>Six views in the actual dome</summary><a href="${escape(entry.views)}"><img loading="lazy" src="${escape(entry.views)}" alt="Front, right, rear, left, ceiling and floor"></a></details>` : ""}<p>${escape(entry.provenance || entry.mapping)} · ${Math.round(entry.elapsedMs)} ms</p></article>`,
    )
    .join("\n");
  const comparisonGroups = [
    [
      "MI-GAN panoramas for all three sources",
      report.artifacts.filter((a) => a.id === "migan"),
    ],
    [
      "Increasing Dream synthesis from the same panorama",
      report.artifacts.filter(
        (a) =>
          a.input === "photo-1" &&
          [
            "migan",
            "independent-5",
            "independent-15",
            "independent-30",
          ].includes(a.id),
      ),
    ],
    [
      "Successive outpainting from generated views",
      report.artifacts.filter(
        (a) =>
          a.input === "photo-1" &&
          ["migan", "recursive-outpaint-1", "recursive-outpaint-2"].includes(
            a.id,
          ),
      ),
    ],
  ];
  const comparisons = comparisonGroups
    .filter(([, entries]) => entries.length > 1)
    .map(
      ([title, entries]) =>
        `<section><h2>${escape(title)}</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px">${entries.map((entry) => `<div><p>${escape(entry.input)} · ${escape(entry.label)}</p><a href="${escape(entry.texture)}"><img src="${escape(entry.texture)}" alt="${escape(entry.label)}"></a></div>`).join("")}</div></section>`,
    )
    .join("\n");
  const inputList = report.inputs
    .map((input) => `<li>${escape(input.id)}: ${escape(input.name)}</li>`)
    .join("");
  await writeFile(
    path.join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dream Drift · Marmot model tests</title><style>body{margin:24px;background:#111318;color:#e6e7eb;font:16px system-ui}main{max-width:1400px;margin:auto}article{padding:18px;margin:24px 0;background:#1b1e25;border-radius:12px}h1{font-size:28px}h2{font-size:19px}img{display:block;max-width:100%;height:auto;margin:12px auto}a{color:#a5ceff}p{color:#b7becb}summary{cursor:pointer;padding:12px 0}li{overflow-wrap:anywhere}</style><main><h1>Dream Drift · Marmot model tests</h1><p>Actual local MI-GAN and InceptionV3. Waves, refraction, dispersion, relief and camera translation are disabled. Status: ${escape(report.status)}.</p><p>Mirrored baseline images are source textures; expand six views to see the dome mapping. Raw MI-GAN images precede the app's seam/pole compositor. Model artifacts and rendering seams can be compared separately.</p><ul>${inputList}</ul><p><a href="report.json">Full settings, provenance, hardware and measurements</a></p>${comparisons}<h2>Full outputs and dome views</h2>${cards}</main>`,
  );
}
