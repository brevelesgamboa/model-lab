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
    [
      "Gentle target sweep · 4 steps",
      report.artifacts.filter(
        (a) => a.experiment?.phase === "sweep" && a.experiment.steps === 4,
      ),
    ],
    [
      "Gentle target sweep · 8 steps",
      report.artifacts.filter(
        (a) => a.experiment?.phase === "sweep" && a.experiment.steps === 8,
      ),
    ],
    [
      "Ten-stage forward-regeneration sequence",
      report.artifacts.filter(
        (a) =>
          report.configuration.experimentMode === "forward" &&
          (a.id === "migan" || /^forward-\d+$/.test(a.id)),
      ),
    ],
    [
      "Crop/projection control · no further inference",
      report.artifacts
        .filter((a) => a.id === "migan" || /^forward-control-\d+$/.test(a.id))
        .filter(
          () => report.configuration.experimentMode === "forward-control",
        ),
    ],
  ];
  const stageEntries = report.artifacts.filter(
    (a) =>
      ["forward", "forward-control"].includes(
        report.configuration.experimentMode,
      ) &&
      a.front &&
      (a.id === "migan" || /^forward-(?:control-)?\d+$/.test(a.id)),
  );
  const stagePlayer =
    stageEntries.length > 2
      ? `<section><h2>Front-view stage snapshots</h2><p>Generated keyframes in the actual dome renderer. This player does not demonstrate smooth continuous movement.</p><label>Stage <input id="stage-slider" type="range" min="0" max="${stageEntries.length - 1}" value="0" step="1"></label> <button id="stage-play" type="button">Play stages</button><p id="stage-label"></p><img id="stage-preview" src="${escape(stageEntries[0].front)}" alt="Selected forward-regeneration stage"><script>const stages=${JSON.stringify(stageEntries.map((a) => ({ file: a.front, label: a.label })))};const slider=document.getElementById('stage-slider'),preview=document.getElementById('stage-preview'),label=document.getElementById('stage-label'),button=document.getElementById('stage-play');let timer;function showStage(){const stage=stages[Number(slider.value)];preview.src=stage.file;label.textContent=stage.label;}slider.addEventListener('input',showStage);button.addEventListener('click',()=>{if(timer){clearInterval(timer);timer=null;button.textContent='Play stages';}else{timer=setInterval(()=>{slider.value=String((Number(slider.value)+1)%stages.length);showStage();},1000);button.textContent='Pause';}});showStage();</script></section>`
      : "";
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
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Dream Drift · ${escape(report.configuration.experimentMode || "Marmot model tests")}</title><style>body{margin:24px;background:#111318;color:#e6e7eb;font:16px system-ui}main{max-width:1400px;margin:auto}article{padding:18px;margin:24px 0;background:#1b1e25;border-radius:12px}h1{font-size:28px}h2{font-size:19px}img{display:block;max-width:100%;height:auto;margin:12px auto}a{color:#a5ceff}p{color:#b7becb}summary{cursor:pointer;padding:12px 0}li{overflow-wrap:anywhere}#stage-preview{width:768px;max-width:100%}</style><main><h1>Dream Drift · ${escape(report.configuration.experimentMode || "Marmot model tests")}</h1><p>Actual local MI-GAN and InceptionV3. Waves, refraction, dispersion, relief and camera translation are disabled. Status: ${escape(report.status)}.</p><p>Mirrored baseline images are source textures; expand six views to see the dome mapping. Raw MI-GAN images precede the app's seam/pole compositor. Model artifacts and rendering seams can be compared separately.</p><ul>${inputList}</ul><p><a href="report.json">Full settings, provenance, hardware and measurements</a></p>${stagePlayer}${comparisons}<h2>Full outputs and dome views</h2>${cards}</main>`,
  );
}
