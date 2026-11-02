import {
  dreamMapSegments,
  dreamWarp,
  dreamCellHash,
  getRoomTypology,
} from "../models/dome-journey-layout.js";

const contourCache = new WeakMap();
const COLORS = ["#69dcd0", "#c397f4", "#ebbd79", "#ee83b1"];

// Marching squares over cached relative depth; no inference or image readback.
export function depthContours(map, columns = 32, rows = 24) {
  if (!map?.depth || map.width < 1 || map.height < 1) return [];
  const values = new Float32Array(columns * rows);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const sx = (x / (columns - 1)) * (map.width - 1),
        sy = (y / (rows - 1)) * (map.height - 1);
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        fx = sx - ix,
        fy = sy - iy;
      const at = (dx, dy) =>
        map.depth[
          Math.min(map.height - 1, iy + dy) * map.width +
            Math.min(map.width - 1, ix + dx)
        ];
      values[y * columns + x] =
        (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) +
        (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
    }
  const segments = [];
  for (const level of [0.15, 0.27, 0.39, 0.51, 0.63, 0.75, 0.87])
    for (let y = 0; y < rows - 1; y++)
      for (let x = 0; x < columns - 1; x++) {
        const v = [
          values[y * columns + x],
          values[y * columns + x + 1],
          values[(y + 1) * columns + x + 1],
          values[(y + 1) * columns + x],
        ];
        if (!v.every(Number.isFinite)) continue;
        const corners = [
            [x, y],
            [x + 1, y],
            [x + 1, y + 1],
            [x, y + 1],
          ],
          cuts = [];
        for (let i = 0; i < 4; i++) {
          const j = (i + 1) % 4;
          if (v[i] >= level === v[j] >= level) continue;
          const t = (level - v[i]) / (v[j] - v[i]);
          cuts.push(
            corners[i].map(
              (n, a) =>
                (n + (corners[j][a] - n) * t) / ((a ? rows : columns) - 1),
            ),
          );
        }
        if (cuts.length === 4 && v.reduce((a, b) => a + b, 0) / 4 < level)
          cuts.push(cuts.shift());
        for (let i = 0; i + 1 < cuts.length; i += 2)
          segments.push([cuts[i], cuts[i + 1]]);
      }
  return segments;
}
function contours(map) {
  if (!map?.depth) return [];
  if (!contourCache.has(map)) contourCache.set(map, depthContours(map));
  return contourCache.get(map);
}

export function createDomeRadar(canvas, journey) {
  const layers = { geo: true, net: true, trace: true };
  let segments = [],
    topologyKey = "",
    targets = [],
    hover = null;
  const point = ([x, z]) => {
    const scale = Math.min(canvas.width, canvas.height - 28) / 96;
    return [
      canvas.width / 2 + (x - journey.position[0]) * scale,
      canvas.height / 2 + 9 + (z - journey.position[1]) * scale,
    ];
  };
  const hitTest = (x, y) =>
    targets.reduce((best, node) => {
      const distance = Math.hypot(x - node.screen[0], y - node.screen[1]);
      return distance < 9 && (!best || distance < best.distance)
        ? { ...node, distance }
        : best;
    }, null);
  function draw({ yaw, depthMap, depthMaps = [], rooms = new Map() }) {
    const ctx = canvas.getContext("2d"),
      w = canvas.width,
      h = canvas.height;
    const cell = dreamWarp(journey.position, journey.seed).map((v) =>
      Math.round(v / 18),
    );
    const key = `${journey.seed}:${cell}`;
    if (key !== topologyKey) {
      topologyKey = key;
      segments = dreamMapSegments(journey.position, journey.seed, 3);
    }
    const visible = [...journey.discovered.values()]
      .map((node) => ({
        ...node,
        screen: point(node.position),
        visited: journey.visited.has(node.id),
      }))
      .filter(
        (node) =>
          node.screen[0] > 8 &&
          node.screen[0] < w - 8 &&
          node.screen[1] > 28 &&
          node.screen[1] < h - 19,
      );
    targets = layers.net ? visible : [];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#070f19";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.beginPath();
    ctx.rect(1, 27, w - 2, h - 44);
    ctx.clip();
    ctx.strokeStyle = "#15313c";
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += 16) {
      ctx.beginPath();
      ctx.moveTo(x, 27);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 27; y < h; y += 16) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const [px, py] = point(journey.position);
    for (const radius of [20, 45, 70, 95]) {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (layers.geo) {
      ctx.lineWidth = 0.65;
      ctx.strokeStyle = "#58887c65";
      for (const node of visible) {
        const map =
          node.id === "0,0"
            ? depthMap
            : (rooms.get(node.id)?.depth ?? depthMaps[node.motif] ?? depthMap);
        ctx.beginPath();
        for (const [a, b] of contours(map)) {
          const p = point([
            node.position[0] + (a[0] - 0.5) * 17,
            node.position[1] + (a[1] - 0.5) * 17,
          ]);
          const q = point([
            node.position[0] + (b[0] - 0.5) * 17,
            node.position[1] + (b[1] - 0.5) * 17,
          ]);
          ctx.moveTo(...p);
          ctx.lineTo(...q);
        }
        ctx.stroke();
      }
    }
    if (layers.net) {
      ctx.lineCap = "round";
      for (const segment of segments) {
        const points = segment.points.map(point),
          origin = segment.id.split(":")[0];
        const known = journey.visited.has(origin);
        ctx.beginPath();
        points.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.strokeStyle = COLORS[segment.motif] + (known ? "45" : "13");
        ctx.lineWidth = known ? 6 : 2;
        ctx.stroke();
        ctx.strokeStyle = COLORS[segment.motif] + (known ? "cc" : "35");
        ctx.lineWidth = known ? 1.1 : 0.6;
        ctx.shadowColor = COLORS[segment.motif];
        ctx.shadowBlur = known ? 6 : 0;
        ctx.stroke();
        ctx.shadowBlur = 0;
        // Two scales of dendritic filaments decorate actual corridor edges.
        if (known)
          for (let i = 2; i < points.length - 1; i += 2) {
            const p = points[i],
              n = points[i + 1],
              dx = n[0] - p[0],
              dy = n[1] - p[1];
            const side =
              dreamCellHash(i, segment.motif, journey.seed) % 2 ? 1 : -1;
            const end = [p[0] - dy * side * 0.6, p[1] + dx * side * 0.6];
            ctx.strokeStyle = COLORS[segment.motif] + "66";
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(...p);
            ctx.lineTo(...end);
            ctx.lineTo(end[0] + dx * 0.3, end[1] + dy * 0.3);
            ctx.stroke();
          }
      }
      for (const node of visible) {
        const [x, y] = node.screen,
          color = COLORS[node.motif];
        ctx.strokeStyle = color;
        ctx.fillStyle = node.visited ? color : "#0c1721";
        ctx.shadowColor = color;
        ctx.shadowBlur = node.visited ? 10 : 3;
        ctx.beginPath();
        const type = getRoomTypology(...node.cell, journey.seed).id;
        if (type === 0 || node.id === "0,0")
          ctx.arc(x, y, node.id === "0,0" ? 4 : 3, 0, Math.PI * 2);
        else if (type === 1) {
          ctx.moveTo(x - 5, y + 3);
          ctx.lineTo(x - 2, y - 3);
          ctx.lineTo(x + 2, y + 3);
          ctx.lineTo(x + 5, y - 3);
        } else if (type === 3) ctx.rect(x - 3.5, y - 3.5, 7, 7);
        else {
          ctx.moveTo(x, y - 4);
          ctx.lineTo(x + 4, y);
          ctx.lineTo(x, y + 4);
          ctx.lineTo(x - 4, y);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (!node.visited) {
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.arc(x, y, 8, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        if (node.id === "0,0") {
          ctx.fillStyle = "#b4e6d5";
          ctx.font = "8px monospace";
          ctx.fillText("PHOTO", x + 8, y - 4);
        }
        if (node.id === hover || node.id === journey.warp?.id) {
          ctx.strokeStyle = "#efffff";
          ctx.strokeRect(x - 7, y - 7, 14, 14);
        }
      }
    }
    if (layers.trace) {
      const trail = journey.breadcrumbs;
      ctx.lineCap = "round";
      for (let i = 1; i < trail.length; i++) {
        if (trail[i].break) continue;
        const alpha = Math.max(
          0,
          1 - (journey.radarTime - trail[i - 1].time) / 24,
        );
        ctx.globalAlpha = alpha * alpha;
        ctx.strokeStyle = "#9effdf";
        ctx.shadowColor = "#55e8cf";
        ctx.shadowBlur = 5;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(...point(trail[i - 1].position));
        ctx.lineTo(...point(trail[i].position));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = "#edfff5";
    ctx.shadowColor = "#a9ffe4";
    ctx.shadowBlur = 7;
    ctx.beginPath();
    ctx.moveTo(px + Math.sin(yaw) * 6, py - Math.cos(yaw) * 6);
    ctx.lineTo(px + Math.sin(yaw + 2.5) * 4, py - Math.cos(yaw + 2.5) * 4);
    ctx.lineTo(px + Math.sin(yaw - 2.5) * 4, py - Math.cos(yaw - 2.5) * 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#7facae";
    ctx.font = "8px monospace";
    ctx.fillText("NEURO RADAR", 8, 16);
    const selected = journey.discovered.get(hover);
    const label = journey.warping
      ? `WARP ${Math.round(journey.warpProgress * 100)}%  ·  ESC CANCEL`
      : selected
        ? `${journey.visited.has(selected.id) ? "VISITED" : "FRONTIER"} · ${getRoomTypology(...selected.cell, journey.seed).name}`
        : `RELATIVE ${depthMap?.kind === "estimated" ? "DEPTH" : "RELIEF"}  ·  CLICK HUB TO WARP`;
    ctx.fillStyle = "#96d5cb";
    ctx.fillText(label, 7, h - 7, w - 14);
    ctx.strokeStyle = "#23434d";
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    if (journey.warping) {
      ctx.fillStyle = "#92f7db";
      ctx.fillRect(1, h - 19, (w - 2) * journey.warpProgress, 1);
    }
  }
  return {
    layers,
    draw,
    hitTest,
    get targets() {
      return targets;
    },
    setHover(id) {
      hover = id;
    },
  };
}
