const HOST_CURRENCIES = [
  [/mercadolivre\.com\.br$/i, "BRL"], [/mercadolibre\.com\.mx$/i, "MXN"],
  [/mercadolibre\.com\.ar$/i, "ARS"], [/mercadolibre\.cl$/i, "CLP"],
  [/mercadolibre\.com\.co$/i, "COP"], [/mercadolibre\.com\.pe$/i, "PEN"]
];

init();

async function init() {
  const settings = await chrome.storage.local.get("exchangeEnabled");
  document.getElementById("exchange-enabled").checked = settings.exchangeEnabled !== false;
  await showRate(false);
}

document.getElementById("exchange-enabled").addEventListener("change", async (event) => {
  await chrome.storage.local.set({ exchangeEnabled: event.target.checked });
});

document.getElementById("refresh-rate").addEventListener("click", () => showRate(true));

document.getElementById("export-top20").addEventListener("click", async () => {
  const button = document.getElementById("export-top20");
  const message = document.getElementById("message");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !detectCurrency(tab.url)) {
    message.textContent = "请先打开美客多关键词搜索结果页。";
    return;
  }
  button.disabled = true;
  button.textContent = "正在生成Excel…";
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "MLSA_EXPORT_TOP20" });
    if (result?.status !== "ok") throw new Error(result?.error || "导出失败");
    message.textContent = "Excel 已保存到浏览器下载目录。";
  } catch (error) {
    message.textContent = `导出失败：${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = "导出当前关键词前20名";
  }
});

async function showRate(force) {
  const status = document.getElementById("rate-status");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currency = detectCurrency(tab?.url);
  if (!currency) {
    status.textContent = "打开支持的美客多站点后可查看汇率";
    return;
  }
  status.textContent = `正在读取 ${currency} → CNY…`;
  try {
    const result = await chrome.runtime.sendMessage({ type: "MLSA_GET_RATE", currency, force });
    if (result?.status !== "ok") throw new Error(result?.error || "读取失败");
    const digits = result.rate < 0.1 ? 5 : 4;
    status.textContent = `1 ${currency} ≈ ¥${result.rate.toFixed(digits)} · ${result.rateDate || "最新"}${result.stale ? "（缓存）" : ""}`;
  } catch {
    status.textContent = "汇率暂时不可用，请稍后重试";
  }
}

function detectCurrency(value) {
  try {
    const hostname = new URL(value).hostname;
    return HOST_CURRENCIES.find(([pattern]) => pattern.test(hostname))?.[1] || null;
  } catch { return null; }
}

document.getElementById("refresh").addEventListener("click", async () => {
  const message = document.getElementById("message");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/mercado(livre|libre)\./i.test(tab.url || "")) {
    message.textContent = "请先打开美客多搜索结果页。";
    return;
  }

  const all = await chrome.storage.local.get(null);
  const salesKeys = Object.keys(all).filter((key) => key.startsWith("sales:"));
  await chrome.storage.local.remove(salesKeys);
  await chrome.tabs.reload(tab.id);
  message.textContent = "销量缓存已清除，30天历史已保留，页面正在重新读取。";
});
