(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MLSAExport = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function parseRating(value) {
    const match = String(value || "").match(/(?:rating|评分|avaliação|calificaci[oó]n)?\s*([0-5](?:[.,]\d{1,2})?)/i);
    if (!match) return null;
    const rating = Number(match[1].replace(",", "."));
    return rating >= 0 && rating <= 5 ? rating : null;
  }

  function parseReviewCount(value) {
    const text = String(value || "");
    const parenthesized = text.match(/\(([\d.,]+)\)/);
    const labeled = text.match(/([\d.,]+)\s*(?:opini[oõ]es|avaliaç(?:ões|ao)|reseñas|opiniones|reviews?)/i);
    const raw = parenthesized?.[1] || labeled?.[1];
    return raw ? Number(raw.replace(/[.,]/g, "")) : null;
  }

  function sanitizeFilename(value) {
    const cleaned = String(value || "美客多关键词")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return cleaned || "美客多关键词";
  }

  function extractListingId(value) {
    try {
      const url = new URL(value);
      const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
      const filter = url.searchParams.get("pdp_filters") || "";
      const direct = url.pathname.match(/\/(ML[A-Z])-(\d+)(?:-|\/|$)/i);
      return hash.get("wid") || filter.match(/item_id:([A-Z]{3}\d+)/i)?.[1] || (direct ? `${direct[1]}${direct[2]}` : null);
    } catch { return null; }
  }

  function canonicalProductKey(value) {
    const listingId = extractListingId(value);
    if (listingId) return listingId.toUpperCase();
    try { return new URL(value).pathname.replace(/\/$/, "").toLowerCase(); }
    catch { return String(value || ""); }
  }

  function selectBestProductUrl(values) {
    const urls = Array.from(values || []).filter(Boolean);
    return urls.find((value) => extractListingId(value))
      || urls.find((value) => /(?:produto\.|\/p\/|\/up\/|ML[A-Z]-?\d+)/i.test(value))
      || null;
  }

  function resolveSortLayout(elements, stopElements = []) {
    const nodes = Array.from(elements || []).filter(Boolean);
    if (nodes.length < 2) return null;
    const stops = new Set(stopElements);
    let candidate = nodes[0];
    for (let depth = 0; candidate?.parentElement && depth < 6; depth += 1, candidate = candidate.parentElement) {
      const parent = candidate.parentElement;
      if (!parent || stops.has(parent)) break;
      const units = new Map();
      const used = new Set();
      let valid = true;
      for (const element of nodes) {
        const unit = directChildUnder(element, parent);
        if (!unit || used.has(unit)) { valid = false; break; }
        units.set(element, unit);
        used.add(unit);
      }
      if (valid) return { parent, units };
    }

    // Mercado Livre may split one result stream across multiple list containers.
    // Keep every container in place and treat each product wrapper as a sortable slot.
    const units = new Map();
    const used = new Set();
    for (const element of nodes) {
      let unit = element;
      while (unit.parentElement && !stops.has(unit.parentElement)) {
        const trackedInParent = nodes.filter((node) => containsNode(unit.parentElement, node)).length;
        if (trackedInParent !== 1) break;
        unit = unit.parentElement;
      }
      if (used.has(unit)) return null;
      units.set(element, unit);
      used.add(unit);
    }
    return units.size === nodes.length ? { parent: null, units, slotted: true } : null;
  }

  async function runWorkerPool(items, workerCount, handler) {
    const values = Array.from(items || []);
    const count = Math.max(1, Math.min(Number(workerCount) || 1, values.length || 1));
    let cursor = 0;
    async function worker() {
      while (cursor < values.length) {
        const index = cursor++;
        await handler(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: count }, () => worker()));
  }

  function rankItems(items, sortMode = "original") {
    return Array.from(items || []).filter((item) => !item.sponsored).sort((a, b) => {
      if (sortMode === "original") return a.originalIndex - b.originalIndex;
      if (sortMode === "category-rank") return compareNullableAscending(a.categoryRank, b.categoryRank) || tieBreaker(a, b);
      const key = sortMode === "recent-desc" ? "recent30" : "sales";
      return compareNullableDescending(a[key], b[key]) || tieBreaker(a, b);
    });
  }

  function tieBreaker(a, b) {
    const categoryA = Number.isFinite(a.categoryRank) ? a.categoryRank : Number.MAX_SAFE_INTEGER;
    const categoryB = Number.isFinite(b.categoryRank) ? b.categoryRank : Number.MAX_SAFE_INTEGER;
    return categoryA - categoryB || (b.rating || 0) - (a.rating || 0)
      || (b.reviews || 0) - (a.reviews || 0) || a.originalIndex - b.originalIndex;
  }

  function compareNullableDescending(a, b) {
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return b - a;
  }

  function compareNullableAscending(a, b) {
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0;
    if (!Number.isFinite(a)) return 1;
    if (!Number.isFinite(b)) return -1;
    return a - b;
  }

  function directChildUnder(element, parent) {
    let node = element;
    while (node && node.parentElement !== parent) node = node.parentElement;
    return node?.parentElement === parent ? node : null;
  }

  function containsNode(ancestor, node) {
    if (typeof ancestor?.contains === "function") return ancestor.contains(node);
    for (let current = node; current; current = current.parentElement) {
      if (current === ancestor) return true;
    }
    return false;
  }

  return {
    parseRating, parseReviewCount, sanitizeFilename, extractListingId, canonicalProductKey,
    selectBestProductUrl, resolveSortLayout, runWorkerPool, rankItems
  };
});
