import { ExperimentStore } from "../core/experiment-store.js";
import {
  downloadBlob,
  formatTimestampForFile,
} from "../core/utils.js";
import { terminal } from "../ui/terminal.js";

export function formatArchiveTime(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return String(iso || "-");
  }
}

function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes)) return "LOCAL";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createArchiveController({
  elements,
  onRestore,
  onClear,
  setStatus,
}) {
  const eventController = new AbortController();

  function render() {
    const records = ExperimentStore.getAll();
    elements.archiveRuns.textContent = String(records.length);
    elements.archiveModels.textContent = String(
      new Set(records.map((record) => record.modelId)).size,
    );
    const maximum = records.reduce(
      (current, record) =>
        Math.max(current, Number(record.qualityResolution) || 0),
      0,
    );
    elements.archiveResolution.textContent = maximum
      ? `${maximum} x ${maximum}`
      : "-";
    elements.archiveStorage.textContent = `${ExperimentStore.isPersistent() ? "LOCAL" : "MEMORY"} / ${formatStorageSize(ExperimentStore.sizeBytes())}`;
    elements.archiveGrid.replaceChildren();

    if (!records.length) {
      const empty = document.createElement("div");
      empty.className = "archive-empty";
      empty.textContent = "NO SAVED RUNS. RETURN TO LAB AND SAVE A FRAME.";
      elements.archiveGrid.append(empty);
      return;
    }

    records.forEach((record) => {
      const card = document.createElement("article");
      card.className = "run-card";
      if (record.thumbnail) {
        const image = document.createElement("img");
        image.className = "run-card__image";
        image.src = record.thumbnail;
        image.alt = `Saved output ${record.id}`;
        card.append(image);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "run-card__placeholder";
        placeholder.textContent = "THUMBNAIL NOT STORED";
        card.append(placeholder);
      }

      const body = document.createElement("div");
      body.className = "run-card__body";
      const idLine = document.createElement("div");
      idLine.className = "run-card__id";
      const id = document.createElement("span");
      id.textContent = record.id;
      const date = document.createElement("time");
      date.textContent = formatArchiveTime(record.createdAt);
      idLine.append(id, date);

      const title = document.createElement("h3");
      title.textContent = record.modelName || record.modelId;
      const description = document.createElement("p");
      description.textContent = `${record.modelFamily || "MODEL ROUTE"} / ${record.backend || "LOCAL"}`;
      const note = document.createElement("p");
      note.className = "run-card__note";
      note.textContent = record.note ? `NOTE: ${record.note}` : "NOTE: —";

      const metrics = document.createElement("div");
      metrics.className = "run-card__metrics";
      const metricItems = [
        ["RESOLUTION", `${record.qualityResolution || "-"} px`],
      ];
      const activeLfo = Object.values(record.modulation || {}).some(
        (entry) => entry?.enabled,
      );
      const activeAudio = Object.values(record.audioModulation || {}).some(
        (route) => route?.source && route.source !== "none",
      );
      if (activeLfo || activeAudio) {
        metricItems.push([
          "MODULATION",
          activeLfo && activeAudio
            ? "LFO + AUDIO"
            : activeLfo
              ? "LFO ACTIVE"
              : "AUDIO REACTIVE",
        ]);
      }
      metricItems.forEach(([label, value]) => {
        const box = document.createElement("span");
        box.append(document.createTextNode(label));
        const strong = document.createElement("strong");
        strong.textContent = value;
        box.append(strong);
        metrics.append(box);
      });

      const actions = document.createElement("div");
      actions.className = "run-card__actions";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "RESTORE";
      restore.addEventListener("click", () => onRestore(record));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "DELETE";
      remove.addEventListener("click", () => {
        ExperimentStore.remove(record.id);
        render();
        setStatus(`${record.id} DELETED`);
      });
      actions.append(restore, remove);
      body.append(idLine, title, description, note, metrics, actions);
      card.append(body);
      elements.archiveGrid.append(card);
    });
  }

  function exportCsv() {
    const records = ExperimentStore.getAll();
    if (!records.length) {
      setStatus("NO SAVED RUNS TO EXPORT");
      return;
    }
    const blob = new Blob([ExperimentStore.toCsv()], {
      type: "text/csv;charset=utf-8",
    });
    const filename = `LATENT_FIELD_SAVED_RUNS_${formatTimestampForFile()}.csv`;
    downloadBlob(blob, filename);
    terminal("DATA", `${filename} written / ${records.length} rows`);
    setStatus("CSV EXPORTED");
  }

  function clear() {
    const records = ExperimentStore.getAll();
    if (!records.length) return;
    if (
      !window.confirm(
        `Delete all ${records.length} saved runs from this browser?`,
      )
    )
      return;
    ExperimentStore.clear();
    onClear?.();
    render();
    terminal("ARCHIVE", "all saved runs deleted", "warning");
    setStatus("SAVED RUNS CLEARED");
  }

  function initialize() {
    const options = { signal: eventController.signal };
    elements.exportCsv.addEventListener("click", exportCsv, options);
    elements.clearArchive.addEventListener("click", clear, options);
    render();
  }

  function dispose() {
    eventController.abort();
  }

  return { initialize, render, dispose, exportCsv, clear };
}
