import path from "node:path";
import { writeFile } from "node:fs/promises";

export async function writeDreamProgressionGallery(output, report) {
  const escape = (value) =>
    String(value).replace(
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
  const groups = report.inputs
    .map((input) => ({
      ...input,
      original: report.artifacts.find(
        (a) => a.input === input.id && a.id === "source",
      )?.texture,
      recipes: report.configuration.progressionPlan.recipes
        .map((recipe) => ({
          id: recipe.id,
          label: recipe.label,
          stages: Array.from({ length: 7 }, (_, level) => {
            const entries = report.artifacts.filter(
              (a) => a.input === input.id,
            );
            const plain =
              level === 0
                ? entries.find((a) => a.id === "migan")
                : entries.find(
                    (a) =>
                      a.experiment?.phase === "progression" &&
                      a.experiment.recipe === recipe.id &&
                      a.experiment.level === level &&
                      a.experiment.variant === "plain",
                  );
            const neon =
              level === 0
                ? entries.find((a) => a.id === "progression-baseline-neon")
                : entries.find(
                    (a) =>
                      a.experiment?.phase === "progression" &&
                      a.experiment.recipe === recipe.id &&
                      a.experiment.level === level &&
                      a.experiment.variant === "neon",
                  );
            return plain && neon ? { level, plain, neon } : null;
          }).filter(Boolean),
        }))
        .filter((r) => r.stages.length),
    }))
    .filter((g) => g.recipes.length);
  const data = JSON.stringify(groups).replace(/</g, "\\u003c");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marmot dream studies · AI and neon</title>
<style>
select{max-width:100%;min-width:0}.controls label{min-width:0}
:root{color-scheme:dark;font:16px/1.5 system-ui;background:#0b111b;color:#edf3f7}*{box-sizing:border-box}body{margin:0}main{max-width:1400px;margin:auto;padding:32px 24px 64px}h1{font-size:clamp(26px,4vw,42px);line-height:1.15;margin:8px 0 16px}h2{font-size:19px}p{max-width:88ch;color:#b8c8d6}a{color:#7de5ec}label{display:grid;gap:5px;font-size:14px;color:#bfccd8}select,button,input{font:inherit}select,button{background:#172332;color:#f1f7fc;border:1px solid #3c5567;padding:9px 12px;border-radius:7px}button{cursor:pointer}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #7de5ec;outline-offset:3px}.controls{display:flex;gap:18px;align-items:end;flex-wrap:wrap;padding:18px;background:#121e2a;border-radius:12px}.controls label:first-child{max-width:320px}.controls input{width:220px;accent-color:#79dfe9}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;padding:15px;background:#121e2a;border:1px solid #263c4c;border-radius:12px}figcaption{color:#d8e4ed;margin-bottom:10px}.pair img{width:100%;display:block;background:#071018;aspect-ratio:4/3;object-fit:contain}.pair[data-view="texture"] img{aspect-ratio:2/1}#recipe-note{min-height:3em}.levels{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}.level{padding:8px;border-radius:8px;background:#172332;color:#c4d3df;border:1px solid #2a4252;text-align:left}.level[aria-pressed="true"]{border-color:#7de5ec}.level img{width:100%;display:block;margin-top:6px}.sources{display:flex;gap:16px;flex-wrap:wrap}.sources figure{width:200px}.sources img{height:185px;width:100%;object-fit:contain}.tag{color:#87dee8;letter-spacing:.08em;text-transform:uppercase;font-size:12px}.small{font-size:13px}footer{margin-top:30px;border-top:1px solid #263c4c;padding-top:16px}#error{color:#ffb79f}@media(max-width:700px){main{padding:20px 14px}.pair{grid-template-columns:1fr}.levels{grid-template-columns:repeat(3,minmax(0,1fr))}}
</style><main><div class="tag">Local model experiments · ${escape(report.status)}</div><h1>Marmot dream studies</h1><p>One uploaded image becomes progressively stranger through real MI-GAN and Inception synthesis. Compare identical generated scenes with natural color and a separate cyan/violet lighting treatment.</p><p class="small">The camera stays fixed. These are saved visual stages, not a movement or endless-world demonstration. Neon is authored color treatment and bloom; model inference supplies the changing patterns. Neon never feeds the next synthesis stage.</p>
<div class="controls"><label>Source image<select id="photo-select">${groups.map((g, i) => `<option value="${i}">${escape(g.id)} · ${escape(g.name)}</option>`).join("")}</select></label><label>Pattern progression<select id="recipe-select"></select></label><label>View<select id="view-select"><option value="front">Dome front view</option><option value="texture">Full panorama</option></select></label><label>Dream depth <input id="level-slider" type="range" min="0" max="6" value="0" step="1"></label><button id="play-button" type="button">Play stages</button></div>
<h2 id="stage-title"></h2><p id="recipe-note"></p><p id="error" hidden></p><div class="pair" id="pair" data-view="front"><figure><figcaption>Model output · natural color</figcaption><a id="plain-link"><img id="plain-preview" alt="Actual model output without neon treatment"></a></figure><figure><figcaption>Same output · neon lighting</figcaption><a id="neon-link"><img id="neon-preview" alt="The same generated image with cyan and violet lighting"></a></figure></div><p id="six-views" class="small"></p><h2>Six stages · natural color above neon</h2><div class="levels" id="levels"></div>
<h2>Uploaded source images</h2><div class="sources">${groups.map((g) => `<figure><figcaption>${escape(g.id)}</figcaption><a href="${escape(g.original || "")}"><img loading="lazy" src="${escape(g.original || "")}" alt="${escape(g.name)}"></a></figure>`).join("")}</div><footer><p class="small">Targets named arches and organic are visual hypotheses, not semantic scene prompts. Each recipe has the same per-level iteration budget. The mixed recipe applies arches followed by organic passes within each stage. A hand-marked head patch stays protected; no automatic animal detection is claimed.</p><p><a href="report.json">Model settings, provenance and measurements</a></p></footer>
<script>
const groups=${data};
const photo=document.getElementById('photo-select'),recipe=document.getElementById('recipe-select'),view=document.getElementById('view-select'),slider=document.getElementById('level-slider'),play=document.getElementById('play-button'),levels=document.getElementById('levels');let timer;
const tone=document.createElement('select');tone.id='color-select';tone.innerHTML='<option value="vivid">More saturated</option><option value="soft">Previous look</option>';const toneLabel=document.createElement('label');toneLabel.textContent='Neon color';toneLabel.append(tone);toneLabel.hidden=!groups.some(g=>g.recipes.some(r=>r.stages.some(s=>s.neon.soft)));document.querySelector('.controls').insertBefore(toneLabel,view.parentElement);
function current(){const r=groups[Number(photo.value)]?.recipes[Number(recipe.value)];if(!r||tone.value!=='soft')return r;return {...r,stages:r.stages.map(s=>({...s,neon:s.neon.soft?{...s.neon,...s.neon.soft}:s.neon}))};}
function stop(){clearInterval(timer);timer=null;play.textContent='Play stages';}
function show(){const r=current();if(!r){document.getElementById('error').hidden=false;document.getElementById('error').textContent='This run has no completed stages yet.';return;}const i=Math.min(Number(slider.value),r.stages.length-1),s=r.stages[i];slider.max=String(r.stages.length-1);slider.value=String(i);const e=s.plain.experiment;document.getElementById('stage-title').textContent=s.level===0?'Starting panorama':s.level+' / 6 · '+e.name+' · '+r.label;document.getElementById('recipe-note').textContent=s.level===0?'MI-GAN extends the supplied photograph. No subsequent Dream synthesis yet.':e.passes.map(p=>p.target+' '+p.iterations+' steps').join(' → ')+' · step '+e.stepSize+' · head patch protected · neon strength '+e.neon;document.getElementById('pair').dataset.view=view.value;for(const variant of ['plain','neon']){const entry=s[variant];document.getElementById(variant+'-preview').src=entry[view.value];document.getElementById(variant+'-link').href=entry.texture;}const six=document.getElementById('six-views');six.replaceChildren();if(s.plain.views&&s.neon.views){for(const variant of ['plain','neon']){const a=document.createElement('a');a.href=s[variant].views;a.textContent=variant==='plain'?'Six dome views · natural':'Six dome views · neon';six.append(a,document.createTextNode('  '));}}for(const b of levels.children)b.setAttribute('aria-pressed',String(Number(b.dataset.level)===i));}
function thumbnails(){levels.replaceChildren();const r=current();if(!r)return;r.stages.forEach((s,i)=>{if(s.level===0)return;const b=document.createElement('button');b.type='button';b.className='level';b.dataset.level=String(i);b.textContent=s.level+' · '+s.plain.experiment.name;for(const variant of ['plain','neon']){const img=document.createElement('img');img.loading='lazy';img.src=s[variant].front;img.alt=s.plain.experiment.name+' · '+variant;b.append(img);}b.addEventListener('click',()=>{stop();slider.value=String(i);show();});levels.append(b);});}
function recipes(){const old=recipe.value;recipe.replaceChildren();groups[Number(photo.value)]?.recipes.forEach((r,i)=>{const o=document.createElement('option');o.value=String(i);o.textContent=r.label;recipe.append(o);});recipe.value=String(Math.min(Number(old)||0,recipe.options.length-1));thumbnails();show();}
photo.addEventListener('change',()=>{stop();recipes();});recipe.addEventListener('change',()=>{stop();thumbnails();show();});slider.addEventListener('input',()=>{stop();show();});view.addEventListener('change',show);play.addEventListener('click',()=>{if(timer){stop();return;}play.textContent='Pause';timer=setInterval(()=>{slider.value=String((Number(slider.value)+1)%current().stages.length);show();},1100);});window.addEventListener('pagehide',stop);recipes();
if(groups.length>1){photo.value='1';recipes();}if(current()){const mixed=groups[Number(photo.value)].recipes.findIndex(r=>r.id==='mixed');if(mixed>=0)recipe.value=String(mixed);slider.value=String(Math.min(4,current().stages.length-1));thumbnails();show();}
const neonCaption=document.querySelector('#pair figure:last-child figcaption');function colorLabel(){neonCaption.textContent=tone.value==='soft'?'Same output · previous neon':'Same output · saturated neon';}tone.addEventListener('change',()=>{stop();thumbnails();show();colorLabel();});colorLabel();
</script></main></html>`;
  await writeFile(path.join(output, "index.html"), html);
}
