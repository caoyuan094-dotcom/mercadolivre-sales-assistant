const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_GAP_MS = 500;
const HISTORY_RETENTION_DAYS = 40;

let nextFetchAt = 0;
const inFlightSales = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "MLSA_FETCH_IMAGE" && isAllowedImageUrl(message.url)) {
    fetchImage(message.url)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  if (message?.type === "MLSA_GET_RATE" && isCurrency(message.currency)) {
    getExchangeRate(message.currency, Boolean(message.force))
      .then(sendResponse)
      .catch((error) => sendResponse({ status: "error", error: error.message }));
    return true;
  }

  if (message?.type !== "MLSA_FETCH_SALES" || !isAllowedUrl(message.url)) return;

  fetchSalesDeduped(message.url, Boolean(message.force))
    .then(sendResponse)
    .catch((error) => sendResponse({ status: "error", error: error.message }));

  return true;
});

function isAllowedImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)mlstatic\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

async function fetchImage(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`图片 HTTP ${response.status}`);
  let blob = await response.blob();
  let extension = blob.type.includes("png") ? "png" : blob.type.includes("gif") ? "gif" : "jpeg";

  if (blob.type.includes("webp") && typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined") {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    blob = await canvas.convertToBlob({ type: "image/png" });
    bitmap.close();
    extension = "png";
  } else if (blob.type.includes("webp")) {
    throw new Error("当前浏览器无法转换 WebP 图片");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const mime = extension === "png" ? "image/png" : extension === "gif" ? "image/gif" : "image/jpeg";
  return { status: "ok", base64: `data:${mime};base64,${btoa(binary)}`, extension };
}

function isCurrency(value) {
  return ["BRL", "MXN", "ARS", "CLP", "COP", "PEN", "USD"].includes(value);
}

async function getExchangeRate(currency, force = false) {
  const key = `rate:${currency}:CNY`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (!force && cached && Date.now() - cached.savedAt < RATE_CACHE_TTL_MS) {
    return { status: "ok", ...cached, cached: true };
  }

  try {
    const response = await fetch(`https://api.frankfurter.dev/v2/rate/${currency}/CNY`);
    if (!response.ok) throw new Error(`汇率接口 HTTP ${response.status}`);
    const payload = await response.json();
    if (!Number.isFinite(payload.rate) || payload.rate <= 0) throw new Error("汇率数据格式异常");
    const value = {
      currency,
      quote: "CNY",
      rate: payload.rate,
      rateDate: payload.date || null,
      savedAt: Date.now(),
      source: "Frankfurter"
    };
    await chrome.storage.local.set({ [key]: value });
    return { status: "ok", ...value, cached: false };
  } catch (error) {
    if (cached?.rate) return { status: "ok", ...cached, cached: true, stale: true };
    throw error;
  }
}

function isAllowedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)mercado(livre|libre)\./i.test(url.hostname);
  } catch {
    return false;
  }
}

async function fetchSales(url, force = false) {
  const key = `sales:${normalizeUrl(url)}`;
  const cached = (await chrome.storage.local.get(key))[key];

  if (!force && cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
    return { ...cached, cached: true };
  }

  await waitForFetchSlot();

  const response = await fetch(normalizeUrl(url), {
    credentials: "include",
    headers: { "Accept-Language": "pt-BR,pt;q=0.9,es;q=0.8" },
    redirect: "follow"
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  const parsed = parseSalesFromHtml(html);
  const trend = parsed.status === "ok"
    ? await recordSalesSnapshot(url, parsed.sales, parsed.salesIsLowerBound)
    : {};
  const observed = parsed.recent30 != null ? { observedDays: trend.observedDays || 0 } : trend;
  const value = { ...parsed, ...observed, savedAt: Date.now(), source: "product-page" };
  await chrome.storage.local.set({ [key]: value });
  return value;
}

function fetchSalesDeduped(url, force = false) {
  const key = normalizeUrl(url);
  if (!force && inFlightSales.has(key)) return inFlightSales.get(key);
  const request = fetchSales(url, force).finally(() => {
    if (inFlightSales.get(key) === request) inFlightSales.delete(key);
  });
  inFlightSales.set(key, request);
  return request;
}

async function waitForFetchSlot(now = Date.now()) {
  const slot = Math.max(now, nextFetchAt);
  nextFetchAt = slot + FETCH_GAP_MS;
  const delay = slot - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function recordSalesSnapshot(url, sales, salesIsLowerBound, now = new Date()) {
  const key = `history:${normalizeUrl(url)}`;
  const stored = (await chrome.storage.local.get(key))[key] || [];
  const date = toDateKey(now);
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 86400000);
  const history = stored.filter((entry) => new Date(`${entry.date}T00:00:00Z`) >= cutoff);
  const existing = history.find((entry) => entry.date === date);
  if (existing) {
    existing.sales = sales;
    existing.salesIsLowerBound = Boolean(salesIsLowerBound);
  } else {
    history.push({ date, sales, salesIsLowerBound: Boolean(salesIsLowerBound) });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  await chrome.storage.local.set({ [key]: history });
  return computeObservedTrend(history, now);
}

function computeObservedTrend(history, now = new Date()) {
  if (!history.length) return { observedDays: 0, recent30: null, recent30Source: "observing" };
  const latest = history[history.length - 1];
  const latestDate = new Date(`${latest.date}T00:00:00Z`);
  const target = new Date(latestDate.getTime() - 30 * 86400000);
  const beforeTarget = history.filter((entry) => new Date(`${entry.date}T00:00:00Z`) <= target);
  const baseline = beforeTarget[beforeTarget.length - 1] || history[0] || latest;
  const observedDays = Math.max(0, Math.round((new Date(`${latest.date}T00:00:00Z`) - new Date(`${baseline.date}T00:00:00Z`)) / 86400000));
  const delta = latest.sales - baseline.sales;
  const bucketed = Boolean(latest.salesIsLowerBound || baseline.salesIsLowerBound);
  if (delta < 0) return { observedDays, recent30: null, recent30Source: "reset" };
  if (bucketed && delta === 0) {
    return { observedDays, recent30: null, snapshotDelta: 0, recent30Source: "bucket-unchanged" };
  }
  return {
    observedDays,
    recent30: delta,
    snapshotDelta: delta,
    recent30IsLowerBound: bucketed,
    recent30Source: observedDays >= 30 ? "observed-30d" : "observed-partial"
  };
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeUrl(value) {
  const url = new URL(value);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const existingFilter = url.searchParams.get("pdp_filters") || "";
  const listingId = hashParams.get("wid") || existingFilter.match(/item_id:([A-Z]{3}\d+)/i)?.[1];
  url.hash = "";
  url.search = "";
  if (listingId) url.searchParams.set("pdp_filters", `item_id:${listingId}`);
  return url.toString();
}

function parseSalesFromHtml(html) {
  const text = decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

  const visible = parseSalesText(text);
  const recent = parseRecentSalesText(text);
  const category = parseCategoryRank(text);
  if (visible) return { status: "ok", ...visible, ...recent, ...category };

  const structuredPatterns = [
    /"sold_quantity"\s*:\s*(\d+)/i,
    /"soldQuantity"\s*:\s*(\d+)/i,
    /"units_sold"\s*:\s*(\d+)/i
  ];

  for (const pattern of structuredPatterns) {
    const match = html.match(pattern);
    if (match) return { status: "ok", sales: Number(match[1]), display: formatSales(Number(match[1])), ...recent, ...category };
  }

  return { status: "unavailable" };
}

function parseSalesText(text) {
  const patterns = [
    /(?:\+\s*|mais\s+de\s+)?([\d.,]+\s*(?:mil|milh(?:ão|ões))?)\s*(?:vendidos?|vendas?)/gi,
    /(?:\+\s*|m[aá]s\s+de\s+)?([\d.,]+\s*(?:mil|mill[oó]n(?:es)?)?)\s*(?:vendidos?|ventas?)/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const tail = text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 60);
      if (/(?:últim|ultim|m[eê]s\s+passado|mes\s+pasado|30\s+d[ií]as)/i.test(tail)) continue;
      const sales = parseLocalizedNumber(match[1]);
      const salesIsLowerBound = /^\s*(?:\+|mais\s+de|m[aá]s\s+de)/i.test(match[0]) || /\b(?:mil|milh|mill[oó]n)/i.test(match[1]);
      if (Number.isFinite(sales)) return { sales, display: formatSales(sales), salesIsLowerBound };
    }
  }

  return null;
}

function parseRecentSalesText(text) {
  const patterns = [
    /(?:\+\s*|mais\s+de\s+)?([\d.,]+\s*(?:mil|milh(?:ão|ões))?)\s*(?:vendidos?|vendas?)\s*(?:nos?\s+)?(?:últimos?\s+30\s+dias|último\s+m[eê]s|m[eê]s\s+passado)/i,
    /(?:\+\s*|m[aá]s\s+de\s+)?([\d.,]+\s*(?:mil|mill[oó]n(?:es)?)?)\s*(?:vendidos?|ventas?)\s*(?:en\s+)?(?:los\s+)?(?:últimos?\s+30\s+d[ií]as|último\s+mes|mes\s+pasado)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const recent30 = parseLocalizedNumber(match[1]);
    if (Number.isFinite(recent30)) {
      return {
        recent30,
        recent30IsLowerBound: /^\s*(?:\+|mais\s+de|m[aá]s\s+de)/i.test(match[0]) || /\b(?:mil|milh|mill[oó]n)/i.test(match[1]),
        recent30Source: "public"
      };
    }
  }
  return {};
}

function parseCategoryRank(text) {
  const match = text.match(/(?:mais\s+vendido\s*)?(\d+)\s*[º°]\s*(?:em|en)\s+([^|\n]{2,80})/i);
  if (!match) return {};
  return { categoryRank: Number(match[1]), categoryName: match[2].trim() };
}

function parseLocalizedNumber(value) {
  const normalized = value.toLowerCase().trim();
  const multiplier = /milh|mill[oó]n/.test(normalized) ? 1_000_000 : /mil/.test(normalized) ? 1_000 : 1;
  const numeric = normalized.replace(/[^\d.,]/g, "");

  if (multiplier > 1 && /[.,]/.test(numeric)) {
    return Math.round(Number(numeric.replace(",", ".")) * multiplier);
  }

  return Number(numeric.replace(/[.,]/g, "")) * multiplier;
}

function formatSales(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#38;/gi, "&")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&gt;|&#62;/gi, ">");
}

if (typeof module !== "undefined") {
  module.exports = {
    parseSalesFromHtml, parseSalesText, parseRecentSalesText, parseCategoryRank,
    parseLocalizedNumber, computeObservedTrend, isCurrency, isAllowedImageUrl
  };
}
