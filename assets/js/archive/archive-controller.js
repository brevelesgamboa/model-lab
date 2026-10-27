import { ExperimentStore } from "../core/experiment-store.js";
import { downloadBlob, formatTimestampForFile } from "../core/utils.js";
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
    return String(iso || "—");
  }
}

function formatStorageSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function createArchiveController({
  elements,
  onRestore,
  onOpenLab,
  onClear,
  setStatus,
  hqGallery = null,
}) {
  const eventController = new AbortController();

  function renderCard(record) {
    const card = document.createElement("article");
    card.className = "run-card";
    card.dataset.runId = record.id;
    if (record.thumbnail) {
      const image = document.createElement("img");
      image.className = "run-card__image";
      image.src = record.thumbnail;
      image.alt = `${record.modelName || "Saved frame"} preview`;
      image.loading = "lazy";
      card.append(image);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "run-card__placeholder";
      placeholder.textContent = "No preview saved";
      card.append(placeholder);
    }
    const body = document.createElement("div");
    body.className = "run-card__body";
    const date = document.createElement("time");
    date.className = "run-card__id";
    date.dateTime = record.createdAt;
    date.textContent = formatArchiveTime(record.createdAt);
    date.title = record.id;
    const title = document.createElement("h3");
    title.textContent = record.modelName || record.modelId;
    const metrics = document.createElement("div");
    metrics.className = "run-card__metrics";
    const items = [];
    if (record.qualityResolution)
      items.push(`${record.qualityResolution} × ${record.qualityResolution}`);
    if (Object.values(record.modulation || {}).some((entry) => entry?.enabled))
      items.push("LFO");
    if (
      Object.values(record.audioModulation || {}).some(
        (route) => route?.source && route.source !== "none",
      )
    )
      items.push("Audio");
    for (const text of items) {
      const item = document.createElement("span");
      item.textContent = text;
      metrics.append(item);
    }
    body.append(date, title);
    if (record.note) {
      const note = document.createElement("p");
      note.className = "run-card__note";
      note.textContent = record.note;
      body.append(note);
    }
    const actions = document.createElement("div");
    actions.className = "run-card__actions";
    const restore = document.createElement("button");
    restore.className = "action-button";
    restore.type = "button";
    restore.textContent = "Restore";
    restore.addEventListener("click", () => onRestore(record));
    const remove = document.createElement("button");
    remove.className = "action-button text-button--danger";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      ExperimentStore.remove(record.id);
      render();
      setStatus("Run deleted");
    });
    actions.append(restore, remove);
    body.append(metrics, actions);
    card.append(body);
    return card;
  }

  function render() {
    const records = ExperimentStore.getAll();
    const models = new Map(
      records.map((record) => [
        record.modelId,
        record.modelName || record.modelId,
      ]),
    );
    const selected = elements.archiveModelFilter.value;
    elements.archiveModelFilter.replaceChildren(new Option("All models", ""));
    for (const [id, name] of [...models].sort((a, b) =>
      a[1].localeCompare(b[1]),
    )) {
      elements.archiveModelFilter.append(new Option(name, id));
    }
    elements.archiveModelFilter.value = models.has(selected) ? selected : "";
    elements.archiveRuns.textContent = String(records.length);
    elements.archiveModels.textContent = String(models.size);
    const maximum = records.reduce(
      (current, record) =>
        Math.max(current, Number(record.qualityResolution) || 0),
      0,
    );
    elements.archiveResolution.textContent = maximum
      ? `${maximum} × ${maximum}`
      : "—";
    elements.archiveStorage.textContent = formatStorageSize(
      ExperimentStore.sizeBytes(),
    );
    elements.archiveStorageStatus.textContent = ExperimentStore.isPersistent()
      ? "Stored in this browser"
      : "Available for this session only";
    elements.exportCsv.disabled = !records.length;
    elements.clearArchive.disabled = !records.length;
    const filtered = records.filter(
      (record) =>
        !elements.archiveModelFilter.value ||
        record.modelId === elements.archiveModelFilter.value,
    );
    elements.archiveGrid.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "archive-empty";
      const heading = document.createElement("h2");
      heading.textContent = records.length
        ? "No runs for this model"
        : "No saved runs yet";
      const hint = document.createElement("p");
      hint.textContent = "Save a frame in the Lab to keep it here.";
      const openLab = document.createElement("button");
      openLab.type = "button";
      openLab.className = "action-button";
      openLab.textContent = "Open Lab";
      openLab.addEventListener("click", () => onOpenLab?.());
      empty.append(heading, hint, openLab);
      elements.archiveGrid.append(empty);
    } else {
      for (const record of filtered)
        elements.archiveGrid.append(renderCard(record));
    }
    if (hqGallery) {
      hqGallery.render(elements.archiveModelFilter.value);
    }
  }

  function exportCsv() {
    const records = ExperimentStore.getAll();
    if (!records.length) return;
    const filename = `GL_BENCH_SAVED_RUNS_${formatTimestampForFile()}.csv`;
    downloadBlob(
      new Blob([ExperimentStore.toCsv()], { type: "text/csv;charset=utf-8" }),
      filename,
    );
    terminal("data", `${filename} written / ${records.length} rows`);
    setStatus("CSV exported");
  }

  function clear() {
    const records = ExperimentStore.getAll();
    if (
      !records.length ||
      !window.confirm(
        `Delete all ${records.length} saved runs from this browser?`,
      )
    )
      return;
    ExperimentStore.clear();
    onClear?.();
    render();
    setStatus("Saved runs cleared");
  }

  function initialize() {
    const options = { signal: eventController.signal };
    elements.exportCsv.addEventListener("click", exportCsv, options);
    elements.clearArchive.addEventListener("click", clear, options);
    elements.archiveModelFilter.addEventListener("change", render, options);
    render();
  }
  return {
    initialize,
    render,
    dispose: () => eventController.abort(),
    exportCsv,
    clear,
  };
}
