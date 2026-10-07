const ENDPOINT = "https://commons.wikimedia.org/w/api.php";

function htmlToText(value) {
  const parser = new DOMParser();
  const documentValue = parser.parseFromString(
    String(value || ""),
    "text/html",
  );
  return documentValue.body.textContent?.replace(/\s+/g, " ").trim() || "";
}

function metadataValue(metadata, key) {
  return htmlToText(metadata?.[key]?.value || "");
}

function normalizeResult(page) {
  const info = page.imageinfo?.[0];
  if (!info || !String(info.mime || "").startsWith("image/")) return null;
  const metadata = info.extmetadata || {};
  return {
    pageId: page.pageid,
    title: String(page.title || "Untitled file").replace(/^File:/, ""),
    thumbnailUrl: info.thumburl || info.url,
    originalUrl: info.url,
    descriptionUrl: info.descriptionurl,
    width: info.width,
    height: info.height,
    mime: info.mime,
    license:
      metadataValue(metadata, "LicenseShortName") ||
      metadataValue(metadata, "UsageTerms") ||
      "UNKNOWN",
    licenseUrl: metadata?.LicenseUrl?.value || "",
    artist: metadataValue(metadata, "Artist") || "Unknown creator",
    credit: metadataValue(metadata, "Credit"),
    description: metadataValue(metadata, "ImageDescription"),
  };
}

export function licenseGroup(license) {
  const normalized = String(license || "").toUpperCase();
  if (
    normalized.includes("PUBLIC DOMAIN") ||
    normalized.includes("CC0") ||
    normalized === "PD"
  )
    return "public-domain";
  if (
    normalized.includes("CC BY-SA") ||
    normalized.includes("ATTRIBUTION-SHAREALIKE")
  )
    return "cc-by-sa";
  if (normalized.includes("CC BY") || normalized.includes("ATTRIBUTION"))
    return "cc-by";
  return "other";
}

export async function searchCommons(query, { limit = 24, signal } = {}) {
  const cleaned = String(query || "").trim();
  if (!cleaned) throw new Error("Enter a search term.");
  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    generator: "search",
    gsrsearch: cleaned,
    gsrnamespace: "6",
    gsrlimit: String(Math.max(1, Math.min(40, limit))),
    prop: "imageinfo",
    iiprop: "url|mime|size|extmetadata",
    iiurlwidth: "420",
    format: "json",
    formatversion: "2",
  });
  const response = await fetch(`${ENDPOINT}?${parameters}`, {
    signal,
    mode: "cors",
  });
  if (!response.ok)
    throw new Error(`Wikimedia Commons returned ${response.status}.`);
  const payload = await response.json();
  if (payload.error)
    throw new Error(payload.error.info || "Wikimedia Commons search failed.");
  return (payload.query?.pages || []).map(normalizeResult).filter(Boolean);
}
