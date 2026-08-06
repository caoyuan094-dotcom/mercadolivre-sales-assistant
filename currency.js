(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MLSACurrency = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const HOST_CURRENCIES = [
    [/mercadolivre\.com\.br$/i, "BRL"],
    [/mercadolibre\.com\.mx$/i, "MXN"],
    [/mercadolibre\.com\.ar$/i, "ARS"],
    [/mercadolibre\.cl$/i, "CLP"],
    [/mercadolibre\.com\.co$/i, "COP"],
    [/mercadolibre\.com\.pe$/i, "PEN"]
  ];

  function detectCurrency(hostname, text = "") {
    const match = HOST_CURRENCIES.find(([pattern]) => pattern.test(hostname || ""));
    if (match) return match[1];
    if (/R\$/i.test(text)) return "BRL";
    if (/US\$/i.test(text)) return "USD";
    return null;
  }

  function parseLocalizedPrice(value) {
    const raw = String(value || "").replace(/[^\d.,]/g, "");
    if (!raw) return null;
    const comma = raw.lastIndexOf(",");
    const dot = raw.lastIndexOf(".");
    const decimalAt = Math.max(comma, dot);
    const decimalDigits = decimalAt >= 0 ? raw.length - decimalAt - 1 : 0;
    const hasDecimal = decimalAt >= 0 && decimalDigits > 0 && decimalDigits <= 2;
    const integer = (hasDecimal ? raw.slice(0, decimalAt) : raw).replace(/[.,]/g, "");
    const decimal = hasDecimal ? raw.slice(decimalAt + 1) : "";
    const amount = Number(`${integer || "0"}${decimal ? `.${decimal}` : ""}`);
    return Number.isFinite(amount) ? amount : null;
  }

  function formatCny(amount, rate) {
    if (!Number.isFinite(amount) || !Number.isFinite(rate)) return null;
    return new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: "CNY",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount * rate);
  }

  return { detectCurrency, parseLocalizedPrice, formatCny };
});
