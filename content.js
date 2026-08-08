(() => {
  const CARD_SELECTORS = [
    ".ui-search-layout__item",
    "li.ui-search-layout__item",
    ".poly-card",
    "article.andes-card"
  ];
  const TOOLBAR_ID = "mlsa-toolbar";
  const EXPORT_LIMIT = 20;
  const SALES_WORKERS = 4;
  const STATE = {
    cards: [], sort: "original", scanning: false, completed: 0, total: 0,
    sortMessage: "", currency: MLSACurrency.detectCurrency(location.hostname, document.body.innerText),
    exchangeEnabled: true, exchange: null, exchangeStatus: "loading",
    imageSearch: { running: false, compared: 0, total: 0, reference: null, preview: null },
    fullCatalog: { running: false, phase: "idle", pages: 0, items: [], completed: 0, expectedTotal: null, endedBy: null }
  };
  let scanTimer;
  let lastUrl = location.href;

  init();

  function init() {
    loadSettingsAndRate();
    scanPage();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.exchangeEnabled) return;
      STATE.exchangeEnabled = changes.exchangeEnabled.newValue !== false;
      renderAllPrices();
      updateToolbar();
    });

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "MLSA_EXPORT_TOP20") return;
      exportTop20().then(() => sendResponse({ status: "ok" }))
        .catch((error) => sendResponse({ status: "error", error: error.message }));
      return true;
    });

    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        STATE.cards = [];
        STATE.sort = "original";
        STATE.sortMessage = "";
        STATE.completed = 0;
        STATE.imageSearch = { running: false, compared: 0, total: 0, reference: null, preview: null };
        STATE.fullCatalog = { running: false, phase: "idle", pages: 0, items: [], completed: 0, expectedTotal: null, endedBy: null };
      }
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanPage, 450);
    });

    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function scanPage() {
    const elements = findCards();
    if (elements.length < 2) return;

    ensureToolbar(elements[0]);
    const knownElements = new Set(STATE.cards.map((item) => item.element));
    const newCards = elements.filter((element) => !knownElements.has(element));
    newCards.forEach((element) => {
      const link = findProductLink(element);
      if (!link) return;

      const originalIndex = elements.indexOf(element);
      const productKey = MLSAExport.canonicalProductKey(link);
      const local = extractSales(element.innerText || "");
      const price = extractPrice(element);
      const item = {
        element, link, productKey, listingId: MLSAExport.extractListingId(link), originalIndex, platformRank: originalIndex + 1,
        sponsored: detectSponsored(element, link),
        sales: local?.sales ?? null, salesIsLowerBound: local?.salesIsLowerBound ?? false,
        status: local ? "ok" : "pending", ...price, ...extractProductDetails(element)
      };
      element.dataset.mlsaOriginalIndex = String(originalIndex);
      STATE.cards.push(item);
      renderBadge(item);
      renderCnyPrice(item);
    });

    updateRanks();
    STATE.total = STATE.cards.length;
    if (STATE.sort !== "original") applySort();
    updateToolbar();
    fetchMissingSales();
  }

  function detectSponsored(element, link) {
    const text = element.innerText || "";
    try {
      const url = new URL(link);
      const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
      const type = url.searchParams.get("type") || hashParams.get("type") || "";
      return /^(sponsored|ads?)$/i.test(type) || /(?:^|\n)\s*(Patrocinado|Anúncio|Promovido)\s*(?:\n|$)/i.test(text);
    } catch { return false; }
  }

  function extractProductDetails(element) {
    const titleNode = element.querySelector([
      ".poly-component__title", ".ui-search-item__title", "h2", "h3"
    ].join(","));
    const imageNode = element.querySelector("img");
    const ratingNode = element.querySelector([
      ".poly-reviews__rating", ".ui-search-reviews__rating-number", "[aria-label*='estrel']",
      "[aria-label*='star']", "[aria-label*='calific']"
    ].join(","));
    const reviewContainer = element.querySelector(".poly-reviews, .ui-search-reviews") || ratingNode?.parentElement;
    return {
      title: titleNode?.textContent?.trim() || element.querySelector("a[title]")?.getAttribute("title") || "未识别名称",
      imageUrl: imageNode?.currentSrc || imageNode?.src || imageNode?.dataset?.src || null,
      rating: MLSAExport.parseRating(ratingNode?.getAttribute("aria-label") || ratingNode?.textContent),
      reviews: MLSAExport.parseReviewCount(reviewContainer?.textContent || ratingNode?.getAttribute("aria-label"))
    };
  }

  async function loadSettingsAndRate(force = false) {
    const settings = await chrome.storage.local.get("exchangeEnabled");
    STATE.exchangeEnabled = settings.exchangeEnabled !== false;
    if (!STATE.currency) {
      STATE.exchangeStatus = "unsupported";
      updateToolbar();
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({ type: "MLSA_GET_RATE", currency: STATE.currency, force });
      if (result?.status !== "ok") throw new Error(result?.error || "汇率读取失败");
      STATE.exchange = result;
      STATE.exchangeStatus = result.stale ? "stale" : "ok";
    } catch {
      STATE.exchangeStatus = "error";
    }
    renderAllPrices();
    updateToolbar();
  }

  function extractPrice(element) {
    const selectors = [
      ".poly-price__current .andes-money-amount",
      ".ui-search-price__second-line .andes-money-amount",
      ".ui-search-price__part--medium",
      ".andes-money-amount"
    ];
    const node = selectors.map((selector) => element.querySelector(selector)).find(Boolean);
    if (!node) return { price: null, priceNode: null };
    const fraction = node.querySelector(".andes-money-amount__fraction")?.textContent?.trim();
    const cents = node.querySelector(".andes-money-amount__cents")?.textContent?.trim();
    const value = fraction
      ? MLSACurrency.parseLocalizedPrice(`${fraction}${cents ? `,${cents}` : ""}`)
      : MLSACurrency.parseLocalizedPrice(node.getAttribute("aria-label") || node.textContent);
    return { price: value, priceNode: node };
  }

  function renderAllPrices() {
    STATE.cards.forEach(renderCnyPrice);
  }

  function renderCnyPrice(item) {
    if (!item.priceNode) return;
    let label = item.element.querySelector(":scope .mlsa-cny-price");
    if (!STATE.exchangeEnabled || !Number.isFinite(item.price)) {
      label?.remove();
      return;
    }
    if (!label) {
      label = document.createElement("span");
      label.className = "mlsa-cny-price";
      item.priceNode.insertAdjacentElement("afterend", label);
    }
    if (STATE.exchange?.rate) {
      label.textContent = `约 ${MLSACurrency.formatCny(item.price, STATE.exchange.rate)}`;
      label.dataset.state = STATE.exchangeStatus;
      label.title = `按 1 ${STATE.currency} ≈ ¥${formatRate(STATE.exchange.rate)} 换算；参考汇率日期 ${STATE.exchange.rateDate || "未知"}`;
    } else {
      label.textContent = STATE.exchangeStatus === "error" ? "人民币换算暂不可用" : "正在换算人民币…";
      label.dataset.state = STATE.exchangeStatus;
    }
  }

  function formatRate(rate) {
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: rate < 0.1 ? 5 : 4 }).format(rate);
  }

  function findCards() {
    for (const selector of CARD_SELECTORS) {
      const nodes = Array.from(document.querySelectorAll(selector)).filter((node) => findProductLink(node));
      if (nodes.length >= 2) return uniqueTopLevel(nodes);
    }

    return uniqueTopLevel(Array.from(document.querySelectorAll("li, article")).filter((node) => {
      const text = node.innerText || "";
      return /(?:R\$|\$)\s*[\d.,]+/.test(text) && findProductLink(node);
    }));
  }

  function uniqueTopLevel(nodes) {
    return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
  }

  function findProductLink(element) {
    const links = Array.from(element.querySelectorAll("a[href]"));
    return MLSAExport.selectBestProductUrl(links.map((link) => link.href));
  }

  function extractSales(text) {
    const match = text.match(/(?:\+\s*|mais\s+de\s+|m[aá]s\s+de\s+)?([\d.,]+\s*(?:mil|milh(?:ão|ões)|mill[oó]n(?:es)?)?)\s*(?:vendidos?|vendas?|ventas?)/i);
    if (!match) return null;

    const normalized = match[1].toLowerCase().trim();
    const multiplier = /milh|mill[oó]n/.test(normalized) ? 1_000_000 : /mil/.test(normalized) ? 1_000 : 1;
    const numeric = normalized.replace(/[^\d.,]/g, "");
    const sales = multiplier > 1 && /[.,]/.test(numeric)
      ? Math.round(Number(numeric.replace(",", ".")) * multiplier)
      : Number(numeric.replace(/[.,]/g, "")) * multiplier;

    const salesIsLowerBound = /^\s*(?:\+|mais\s+de|m[aá]s\s+de)/i.test(match[0]) || /\b(?:mil|milh|mill[oó]n)/i.test(match[1]);
    return Number.isFinite(sales) ? { sales, salesIsLowerBound } : null;
  }

  async function fetchMissingSales(force = false) {
    if (STATE.scanning) return;
    const pending = STATE.cards.filter((item) => item.status === "pending");
    if (!pending.length) return;

    STATE.scanning = true;
    updateToolbar();

    pending.forEach((item) => {
      item.status = "loading";
      renderBadge(item);
    });

    await MLSAExport.runWorkerPool(pending, SALES_WORKERS, async (item) => {
        try {
          const result = await chrome.runtime.sendMessage({ type: "MLSA_FETCH_SALES", url: item.link, force });
          item.status = result?.status === "ok" ? "ok" : result?.status === "unavailable" ? "unavailable" : "error";
          Object.assign(item, result?.status === "ok" ? {
            sales: result.sales,
            salesIsLowerBound: Boolean(result.salesIsLowerBound),
            recent30: result.recent30 ?? null,
            recent30IsLowerBound: Boolean(result.recent30IsLowerBound),
            recent30Source: result.recent30Source || "observing",
            snapshotDelta: result.snapshotDelta ?? null,
            observedDays: result.observedDays || 0,
            categoryRank: result.categoryRank ?? null,
            categoryName: result.categoryName || null,
            savedAt: result.savedAt || null,
            cached: Boolean(result.cached)
          } : { sales: null });
        } catch {
          item.status = "error";
        }

        STATE.completed += 1;
        updateRanks();
        STATE.cards.forEach(renderBadge);
        updateToolbar();
        if (STATE.sort !== "original") applySort();
    });

    STATE.scanning = false;
    updateToolbar();
    if (STATE.cards.some((item) => item.status === "pending")) fetchMissingSales(false);
  }

  function ensureToolbar(firstCard) {
    if (document.getElementById(TOOLBAR_ID)) return;
    const toolbar = document.createElement("section");
    toolbar.id = TOOLBAR_ID;
    toolbar.innerHTML = `
      <div class="mlsa-title-group">
        <span class="mlsa-mark">销</span>
        <div><strong>销量排名、30天趋势与人民币价格</strong><small id="mlsa-status">正在识别商品…</small><small id="mlsa-rate"></small></div>
      </div>
      <div class="mlsa-actions" role="group" aria-label="销量排序">
        <button type="button" data-sort="sales-desc">累计销量档位</button>
        <button type="button" data-sort="recent-desc">近30天/观察增量</button>
        <button type="button" data-sort="category-rank">官方类目排名</button>
        <button type="button" id="mlsa-image-search" title="上传参考图片并按当前结果的主图相似度排序">以图找同款</button>
        <button type="button" id="mlsa-full-catalog" title="遍历全部搜索结果页并读取所有商品销量">读取全部页</button>
        <button type="button" data-sort="original">平台原排序</button>
        <button type="button" id="mlsa-refresh">刷新销量</button>
        <button type="button" id="mlsa-export" class="mlsa-export-button">导出前20名</button>
        <input type="file" id="mlsa-image-input" accept="image/jpeg,image/png,image/webp" hidden>
      </div>
    `;

    toolbar.addEventListener("click", (event) => {
      const exportButton = event.target.closest("#mlsa-export");
      if (exportButton) {
        exportTop20().catch(() => {});
        return;
      }
      const refreshButton = event.target.closest("#mlsa-refresh");
      if (refreshButton) {
        refreshSales(refreshButton);
        return;
      }
      const imageButton = event.target.closest("#mlsa-image-search");
      if (imageButton) {
        toolbar.querySelector("#mlsa-image-input").click();
        return;
      }
      const fullCatalogButton = event.target.closest("#mlsa-full-catalog");
      if (fullCatalogButton) {
        if (STATE.fullCatalog.items.length && !STATE.fullCatalog.running) openFullRanking();
        else collectFullCatalog().catch((error) => {
          STATE.fullCatalog.running = false;
          STATE.sortMessage = `全量读取失败：${error.message}`;
          fullCatalogButton.disabled = false;
          fullCatalogButton.textContent = "重新读取全部页";
          updateToolbar();
        });
        return;
      }
      const button = event.target.closest("button[data-sort]");
      if (!button) return;
      STATE.sort = button.dataset.sort;
      applySort();
      updateToolbar();
    });

    toolbar.querySelector("#mlsa-image-input").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) runImageSearch(file).catch((error) => {
        STATE.imageSearch.running = false;
        STATE.sortMessage = `图搜失败：${error.message}`;
        const button = document.getElementById("mlsa-image-search");
        if (button) { button.disabled = false; button.textContent = "以图找同款"; }
        updateToolbar();
      });
    });

    const container = firstCard.parentElement;
    container?.parentElement?.insertBefore(toolbar, container);
  }

  async function runImageSearch(file) {
    if (!/^image\/(?:jpeg|png|webp)$/i.test(file.type)) throw new Error("请选择 JPG、PNG 或 WebP 图片");
    if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过10MB");
    const candidates = STATE.cards.filter((item) => !item.sponsored && item.imageUrl).slice(0, 80);
    if (!candidates.length) throw new Error("当前页面没有可比较的商品图片");

    const button = document.getElementById("mlsa-image-search");
    STATE.imageSearch = { running: true, compared: 0, total: candidates.length, reference: null, preview: null };
    STATE.sortMessage = "正在生成参考图特征";
    if (button) { button.disabled = true; button.textContent = "分析图片…"; }
    updateToolbar();

    const preview = await MLSAImageSimilarity.fileToDataUrl(file);
    const reference = await MLSAImageSimilarity.createSignature(preview);
    STATE.imageSearch.reference = reference;
    STATE.imageSearch.preview = preview;
    STATE.cards.forEach((item) => { item.imageSimilarity = null; delete item.imageSimilarityRank; renderBadge(item); });

    await MLSAExport.runWorkerPool(candidates, 4, async (item) => {
      try {
        const image = await chrome.runtime.sendMessage({ type: "MLSA_FETCH_IMAGE", url: item.imageUrl });
        if (image?.status === "ok") {
          const signature = await MLSAImageSimilarity.createSignature(image.base64);
          item.imageSimilarity = MLSAImageSimilarity.compareSignatures(reference, signature);
        }
      } catch { item.imageSimilarity = null; }
      STATE.imageSearch.compared += 1;
      renderBadge(item);
      if (button) button.textContent = `比图 ${STATE.imageSearch.compared}/${candidates.length}`;
      updateToolbar();
    });

    const matched = candidates.filter((item) => Number.isFinite(item.imageSimilarity));
    if (!matched.length) throw new Error("商品主图读取失败，请稍后重试");
    assignCompetitionRanks(matched, "imageSimilarity", "imageSimilarityRank");
    matched.forEach(renderBadge);
    STATE.imageSearch.running = false;
    STATE.sort = "image-similarity";
    applySort();
    if (button) {
      button.disabled = false;
      button.textContent = `图片相似度 (${matched.length})`;
      button.classList.add("is-active");
      if (STATE.imageSearch.preview) button.style.setProperty("--mlsa-reference", `url(${STATE.imageSearch.preview})`);
    }
    updateToolbar();
  }

  async function collectFullCatalog() {
    if (STATE.fullCatalog.running) return;
    const button = document.getElementById("mlsa-full-catalog");
    STATE.fullCatalog = {
      running: true, phase: "pages", pages: 1, items: [], completed: 0,
      expectedTotal: MLSAExport.parseResultCount(document.body.innerText), endedBy: null
    };
    STATE.sortMessage = "正在汇总第1页商品";
    if (button) { button.disabled = true; button.textContent = "扫描第1页…"; }
    updateToolbar();

    const itemMap = new Map();
    STATE.cards.filter((item) => !item.sponsored).forEach((item) => addCatalogItem(itemMap, toPortableItem(item)));
    const pageStride = 48;
    const firstPageUrl = location.href;
    let pageDocument = document;
    let pageUrl = location.href;
    const visitedPages = new Set([normalizePageUrl(pageUrl)]);

    while (STATE.fullCatalog.pages < 200) {
      const nextUrl = findNextPageUrl(pageDocument, pageUrl)
        || MLSAExport.buildPagedSearchUrl(firstPageUrl, STATE.fullCatalog.pages * pageStride + 1);
      if (!nextUrl) { STATE.fullCatalog.endedBy = "no-next"; break; }
      if (visitedPages.has(normalizePageUrl(nextUrl))) { STATE.fullCatalog.endedBy = "repeated-page"; break; }
      const response = await chrome.runtime.sendMessage({ type: "MLSA_FETCH_SEARCH_PAGE", url: nextUrl });
      if (response?.status !== "ok") throw new Error(response?.error || "下一页读取失败");
      pageUrl = response.url || nextUrl;
      visitedPages.add(normalizePageUrl(pageUrl));
      pageDocument = new DOMParser().parseFromString(response.html, "text/html");
      const pageItems = extractCatalogItems(pageDocument, pageUrl, itemMap.size);
      if (!pageItems.length) { STATE.fullCatalog.endedBy = "empty-page"; break; }
      const previousSize = itemMap.size;
      pageItems.forEach((item) => addCatalogItem(itemMap, item));
      if (itemMap.size === previousSize) { STATE.fullCatalog.endedBy = "no-new-items"; break; }
      STATE.fullCatalog.pages += 1;
      STATE.sortMessage = `已扫描 ${STATE.fullCatalog.pages} 页，共 ${itemMap.size} 个自然商品`;
      if (button) button.textContent = `${STATE.fullCatalog.pages}页 · ${itemMap.size}款`;
      updateToolbar();
    }

    const remainingPage = findNextPageUrl(pageDocument, pageUrl)
      || MLSAExport.buildPagedSearchUrl(firstPageUrl, STATE.fullCatalog.pages * pageStride + 1);
    if (STATE.fullCatalog.pages >= 200 && remainingPage) {
      STATE.fullCatalog.endedBy = "page-limit";
      throw new Error("搜索结果超过200页，为避免无限循环已暂停");
    }

    const items = Array.from(itemMap.values());
    STATE.fullCatalog.items = items;
    STATE.fullCatalog.phase = "sales";
    STATE.fullCatalog.completed = 0;
    if (button) button.textContent = `销量 0/${items.length}`;
    updateToolbar();

    await MLSAExport.runWorkerPool(items, SALES_WORKERS, async (item) => {
      const cardSales = Number.isFinite(item.sales) ? item.sales : null;
      const cardLowerBound = Boolean(item.salesIsLowerBound);
      try {
        const result = await chrome.runtime.sendMessage({ type: "MLSA_FETCH_SALES", url: item.link, force: false });
        if (result?.status === "ok") applySalesResult(item, result);
        else if (cardSales != null) {
          item.status = "ok";
          item.sales = cardSales;
          item.salesIsLowerBound = cardLowerBound;
          item.salesSource = "search-card";
          item.detailStatus = result?.status || "error";
        } else applySalesResult(item, result);
      } catch {
        if (cardSales != null) {
          item.status = "ok";
          item.sales = cardSales;
          item.salesIsLowerBound = cardLowerBound;
          item.salesSource = "search-card";
          item.detailStatus = "error";
        } else { item.status = "error"; item.sales = null; }
      }
      STATE.fullCatalog.completed += 1;
      if (button) button.textContent = `销量 ${STATE.fullCatalog.completed}/${items.length}`;
      updateToolbar();
    });

    assignCompetitionRanks(items.filter((item) => Number.isFinite(item.sales)), "sales", "globalSalesRank");
    const globalByKey = new Map(items.map((item) => [item.productKey, item]));
    STATE.cards.forEach((item) => {
      item.globalSalesRank = globalByKey.get(item.productKey)?.globalSalesRank || null;
      renderBadge(item);
    });
    STATE.fullCatalog.running = false;
    STATE.fullCatalog.phase = "done";
    const summary = getFullCatalogSummary();
    STATE.sortMessage = `${summary.coverageLabel}：${STATE.fullCatalog.pages}页，发现${items.length}个，销量成功${summary.known}`;
    if (button) { button.disabled = false; button.textContent = `查看全量榜单 (${items.length})`; }
    updateToolbar();
    openFullRanking();
  }

  function toPortableItem(item) {
    const { element, priceNode, ...portable } = item;
    return { ...portable };
  }

  function addCatalogItem(map, item) {
    const key = item.productKey || MLSAExport.canonicalProductKey(item.link);
    if (!key || map.has(key)) return;
    item.productKey = key;
    item.originalIndex = map.size;
    item.platformRank = map.size + 1;
    map.set(key, item);
  }

  function extractCatalogItems(root, baseUrl, startIndex) {
    const nodes = findCardsIn(root);
    return nodes.map((element, index) => {
      const rawLinks = Array.from(element.querySelectorAll("a[href]"))
        .map((anchor) => absoluteUrl(anchor.getAttribute("href"), baseUrl)).filter(Boolean);
      const link = MLSAExport.selectBestProductUrl(rawLinks);
      if (!link) return null;
      const local = extractSales(element.innerText || element.textContent || "");
      const price = extractPrice(element);
      const details = extractProductDetails(element);
      details.imageUrl = absoluteUrl(details.imageUrl, baseUrl);
      return {
        link,
        productKey: MLSAExport.canonicalProductKey(link),
        listingId: MLSAExport.extractListingId(link),
        originalIndex: startIndex + index,
        platformRank: startIndex + index + 1,
        sponsored: detectSponsored(element, link),
        sales: local?.sales ?? null,
        salesIsLowerBound: local?.salesIsLowerBound ?? false,
        status: local ? "ok" : "pending",
        price: price.price,
        ...details
      };
    }).filter((item) => item && !item.sponsored);
  }

  function findCardsIn(root) {
    for (const selector of CARD_SELECTORS) {
      const nodes = Array.from(root.querySelectorAll(selector)).filter((node) => node.querySelector("a[href]"));
      if (nodes.length >= 2) return uniqueTopLevel(nodes);
    }
    return uniqueTopLevel(Array.from(root.querySelectorAll("li, article")).filter((node) => {
      const text = node.innerText || node.textContent || "";
      return /(?:R\$|\$)\s*[\d.,]+/.test(text) && node.querySelector("a[href]");
    }));
  }

  function findNextPageUrl(root, baseUrl) {
    const selectors = [
      "a[rel='next']", ".andes-pagination__button--next a",
      "a[title*='Seguinte']", "a[aria-label*='Seguinte']",
      "a[title*='Siguiente']", "a[aria-label*='Siguiente']"
    ];
    const anchor = selectors.map((selector) => root.querySelector(selector)).find((node) => node && !node.closest("[aria-disabled='true'], .andes-pagination__button--disabled"));
    return absoluteUrl(anchor?.getAttribute("href"), baseUrl);
  }

  function absoluteUrl(value, baseUrl) {
    if (!value) return null;
    try { return new URL(value, baseUrl).href; } catch { return null; }
  }

  function normalizePageUrl(value) {
    try { const url = new URL(value); url.hash = ""; return url.href; } catch { return value; }
  }

  function applySalesResult(item, result) {
    item.status = result?.status === "ok" ? "ok" : result?.status === "unavailable" ? "unavailable" : "error";
    if (result?.status !== "ok") { item.sales = null; return; }
    Object.assign(item, {
      sales: result.sales,
      salesSource: "product-page",
      salesIsLowerBound: Boolean(result.salesIsLowerBound),
      recent30: result.recent30 ?? null,
      recent30IsLowerBound: Boolean(result.recent30IsLowerBound),
      recent30Source: result.recent30Source || "observing",
      observedDays: result.observedDays || 0,
      categoryRank: result.categoryRank ?? null,
      categoryName: result.categoryName || null,
      savedAt: result.savedAt || null
    });
  }

  function openFullRanking() {
    document.getElementById("mlsa-full-ranking")?.remove();
    const knownItems = STATE.fullCatalog.items.filter((item) => Number.isFinite(item.sales));
    const unknownItems = STATE.fullCatalog.items.filter((item) => !Number.isFinite(item.sales));
    const ranked = [
      ...MLSAExport.rankItems(knownItems, "sales-desc"),
      ...MLSAExport.rankItems(unknownItems, "original")
    ];
    const summary = getFullCatalogSummary();
    const panel = document.createElement("section");
    panel.id = "mlsa-full-ranking";
    panel.innerHTML = `<div class="mlsa-ranking-head"><div><strong>全部搜索结果销量榜单</strong><small>${summary.coverageLabel} · 页面标称 ${summary.expectedLabel} · 实际发现 ${ranked.length} · 销量成功 ${summary.known} · 未公开 ${summary.unavailable} · 失败 ${summary.errors}</small></div><button type="button" aria-label="关闭榜单">×</button></div><div class="mlsa-ranking-scroll"><table><thead><tr><th>销量排名</th><th>商品</th><th>累计销量</th><th>价格</th><th>数据状态</th></tr></thead><tbody></tbody></table></div>`;
    panel.querySelector("button").addEventListener("click", () => panel.remove());
    const body = panel.querySelector("tbody");
    ranked.forEach((item, index) => {
      const row = document.createElement("tr");
      const rank = Number.isFinite(item.globalSalesRank) ? item.globalSalesRank : null;
      row.innerHTML = `<td></td><td><a target="_blank" rel="noopener"><img loading="lazy"><span></span></a></td><td></td><td></td><td></td>`;
      row.children[0].textContent = rank ? String(rank) : "-";
      const link = row.querySelector("a");
      link.href = item.link;
      link.querySelector("img").src = item.imageUrl || "";
      link.querySelector("span").textContent = item.title || "未识别名称";
      row.children[2].textContent = Number.isFinite(item.sales) ? `${item.salesIsLowerBound ? "≥" : ""}${formatInteger(item.sales)}` : "未公开";
      row.children[3].textContent = Number.isFinite(item.price) ? `${STATE.currency || ""} ${item.price.toLocaleString("zh-CN")}` : "-";
      row.children[4].textContent = item.status === "ok"
        ? item.salesSource === "search-card" ? "搜索卡片公开值" : "详情页公开值"
        : item.status === "unavailable" ? "销量未公开" : "读取失败";
      body.appendChild(row);
    });
    document.body.appendChild(panel);
  }

  function getFullCatalogSummary() {
    const items = STATE.fullCatalog.items;
    const known = items.filter((item) => Number.isFinite(item.sales)).length;
    const unavailable = items.filter((item) => item.status === "unavailable").length;
    const errors = items.filter((item) => item.status === "error").length;
    const expected = STATE.fullCatalog.expectedTotal;
    const countVerified = Number.isFinite(expected) && items.length >= expected;
    return {
      known, unavailable, errors,
      expectedLabel: Number.isFinite(expected) ? formatInteger(expected) : "未公开",
      coverageLabel: countVerified ? "数量校验通过" : Number.isFinite(expected) ? "未达到页面标称总数" : "已读取平台可访问分页"
    };
  }

  async function refreshSales(button) {
    if (STATE.scanning) return;
    button.disabled = true;
    button.textContent = "刷新中…";
    STATE.cards.forEach((item) => {
      item.status = "pending";
      item.sales = null;
      item.recent30 = null;
      renderBadge(item);
    });
    await fetchMissingSales(true);
    button.textContent = "已刷新";
    setTimeout(() => { button.textContent = "刷新销量"; button.disabled = false; }, 1600);
  }

  async function exportTop20() {
    const button = document.getElementById("mlsa-export");
    if (button?.disabled) return;
    const originalText = button?.textContent || "导出前20名";
    try {
      if (STATE.fullCatalog.running) throw new Error("全部页面仍在读取，请等待全量榜单完成后导出");
      if (button) { button.disabled = true; button.textContent = "准备数据…"; }
      await waitForTop20Sales(45_000);
      const items = getExportItems();
      if (!items.length) throw new Error("当前页面没有可导出的商品");
      if (button) button.textContent = "下载图片…";
      const images = await fetchImages(items, (done) => {
        if (button) button.textContent = `图片 ${done}/${items.length}`;
      });
      if (button) button.textContent = "生成Excel…";
      const blob = await buildWorkbook(items, images);
      downloadBlob(blob, buildFilename());
      if (button) button.textContent = `已导出 ${items.length} 条`;
      setTimeout(() => { if (button) button.textContent = originalText; }, 2400);
    } catch (error) {
      console.error("美客多销量助手导出失败", error);
      if (button) {
        button.textContent = "导出失败，点击重试";
        button.title = error.message;
        setTimeout(() => { button.textContent = originalText; button.disabled = false; }, 3000);
      }
      throw error;
    } finally {
      if (button && !button.textContent.startsWith("导出失败")) button.disabled = false;
    }
  }

  async function waitForTop20Sales(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const organic = MLSAExport.rankItems(STATE.cards, "original");
      const required = STATE.sort === "original" ? organic.slice(0, EXPORT_LIMIT) : organic;
      if (required.length && required.every((item) => !["pending", "loading"].includes(item.status))) return;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }

  function getExportItems() {
    const source = STATE.fullCatalog.items.length ? STATE.fullCatalog.items : STATE.cards;
    return MLSAExport.rankItems(source, STATE.sort).slice(0, EXPORT_LIMIT);
  }

  async function fetchImages(items, onProgress) {
    const results = new Array(items.length).fill(null);
    let cursor = 0;
    let done = 0;
    async function worker() {
      while (cursor < items.length) {
        const index = cursor++;
        const url = items[index].imageUrl;
        if (url) {
          try {
            const result = await chrome.runtime.sendMessage({ type: "MLSA_FETCH_IMAGE", url });
            if (result?.status === "ok") results[index] = result;
          } catch { /* Export the row even if an individual image fails. */ }
        }
        done += 1;
        onProgress(done);
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker));
    return results;
  }

  async function buildWorkbook(items, images) {
    const buffer = await MLSAExcel.buildWorkbook(ExcelJS, items, images, {
      keyword: getSearchKeyword(), exportedAt: new Date(), currency: STATE.currency,
      rate: STATE.exchange?.rate || null, rateDate: STATE.exchange?.rateDate,
      rateSource: STATE.exchange?.source, sourceUrl: location.href,
      sortLabel: getSortLabel(STATE.sort)
    });
    return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function getSearchKeyword() {
    const input = document.querySelector("input.nav-search-input, input[name='as_word'], input[type='search']");
    const fromInput = input?.value?.trim();
    if (fromInput) return fromInput;
    const url = new URL(location.href);
    const query = url.searchParams.get("q") || url.searchParams.get("as_word");
    if (query) return query;
    return document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*\|.*$/, "").trim();
  }

  function buildFilename() {
    const date = new Date().toISOString().slice(0, 10);
    return `美客多_${MLSAExport.sanitizeFilename(getSearchKeyword())}_前20名_${date}.xlsx`;
  }

  function getSortLabel(sortMode) {
    return {
      "sales-desc": "累计销量档位（从高到低）",
      "recent-desc": "近30天/观察增量（从高到低）",
      "category-rank": "官方类目排名（名次从小到大）",
      "image-similarity": "图片相似度（从高到低）",
      original: "平台原排序"
    }[sortMode] || "平台原排序";
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.style.display = "none";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  function renderBadge(item) {
    let badge = item.element.querySelector(":scope > .mlsa-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "mlsa-badge";
      item.element.prepend(badge);
    }

    const labels = {
      pending: "等待读取",
      loading: "读取销量…",
      unavailable: "销量未公开",
      error: "销量读取失败",
    };
    badge.dataset.state = item.status;
    badge.replaceChildren();
    if (item.sponsored) badge.appendChild(makeBadgeLine("广告位 · 不计自然排名", "flag"));
    if (Number.isFinite(item.imageSimilarity)) {
      const imageRank = item.imageSimilarityRank ? ` · 第 ${item.imageSimilarityRank} 名` : "";
      badge.appendChild(makeBadgeLine(`图片相似 ${Math.round(item.imageSimilarity * 100)}%${imageRank}`, "image"));
    }
    if (item.globalSalesRank) badge.appendChild(makeBadgeLine(`全部搜索结果销量档位第 ${item.globalSalesRank} 名`, "global"));
    if (item.status === "ok") {
      const prefix = item.salesIsLowerBound ? "≥" : "";
      const rank = item.salesRank ? ` · 销量档位并列第 ${item.salesRank}` : "";
      badge.appendChild(makeBadgeLine(`累计 ${prefix}${formatInteger(item.sales)} 件${rank}`, "main"));
      if (item.categoryRank) badge.appendChild(makeBadgeLine(`美客多官方：${item.categoryName || "类目"}第 ${item.categoryRank} 名`, "category"));
      badge.appendChild(makeBadgeLine(formatRecentTrend(item), "recent"));
    } else {
      badge.appendChild(makeBadgeLine(labels[item.status] || labels.pending, "main"));
    }
    badge.title = item.status === "ok"
      ? "累计销量通常是公开档位下限；同档位并列。近30天只使用平台公开值或插件快照差值。"
      : "美客多没有提供可核验的公开销量，或读取暂时失败";
  }

  function makeBadgeLine(text, type) {
    const line = document.createElement("span");
    line.className = `mlsa-badge-line mlsa-badge-${type}`;
    line.textContent = text;
    return line;
  }

  function formatInteger(value) {
    return new Intl.NumberFormat("zh-CN").format(value);
  }

  function formatRecentTrend(item) {
    const prefix = item.recent30IsLowerBound ? "≥" : "";
    if (Number.isFinite(item.recent30)) {
      if (item.recent30Source === "public") return `近30天 ${prefix}${formatInteger(item.recent30)} 件（平台公开）${item.recentRank ? ` · 并列第 ${item.recentRank}` : ""}`;
      return `观察 ${item.observedDays} 天：档位增加 ${prefix}${formatInteger(item.recent30)} 件${item.recentRank ? ` · 并列第 ${item.recentRank}` : ""}`;
    }
    if (item.recent30Source === "bucket-unchanged" && item.observedDays > 0) return `观察 ${item.observedDays} 天：公开销量档位未变化`;
    if (item.recent30Source === "reset") return "近30天：商品档位发生重置，重新观察中";
    return `近30天：开始记录（已观察 ${item.observedDays || 0}/30 天）`;
  }

  function updateRanks() {
    STATE.cards.forEach((item) => {
      delete item.organicRank;
      delete item.salesRank;
      delete item.recentRank;
    });
    const organic = STATE.cards.filter((item) => !item.sponsored).sort((a, b) => a.originalIndex - b.originalIndex);
    organic.forEach((item, index) => { item.organicRank = index + 1; });
    assignCompetitionRanks(organic.filter((item) => Number.isFinite(item.sales)), "sales", "salesRank");
    assignCompetitionRanks(organic.filter((item) => Number.isFinite(item.recent30)), "recent30", "recentRank");
  }

  function assignCompetitionRanks(items, valueKey, rankKey) {
    const sorted = [...items].sort((a, b) => b[valueKey] - a[valueKey] || tieBreaker(a, b));
    let previous = null;
    sorted.forEach((item, index) => {
      item[rankKey] = item[valueKey] === previous ? sorted[index - 1][rankKey] : index + 1;
      previous = item[valueKey];
    });
  }

  function tieBreaker(a, b) {
    const categoryA = Number.isFinite(a.categoryRank) ? a.categoryRank : Number.MAX_SAFE_INTEGER;
    const categoryB = Number.isFinite(b.categoryRank) ? b.categoryRank : Number.MAX_SAFE_INTEGER;
    return categoryA - categoryB || (b.rating || 0) - (a.rating || 0) || (b.reviews || 0) - (a.reviews || 0) || a.originalIndex - b.originalIndex;
  }

  function applySort() {
    const layout = MLSAExport.resolveSortLayout(
      STATE.cards.map((item) => item.element),
      [document.body, document.documentElement]
    );
    if (!layout) {
      STATE.sortMessage = "当前页面结构暂时无法重新排列";
      return false;
    }

    const sorted = MLSAExport.rankItems(STATE.cards, STATE.sort);

    const desiredUnits = sorted.map((item) => layout.units.get(item.element));
    const currentUnits = layout.slotted
      ? [...desiredUnits].sort(compareDocumentOrder)
      : Array.from(layout.parent.children).filter((child) => new Set(desiredUnits).has(child));
    const alreadySorted = currentUnits.every((unit, index) => unit === desiredUnits[index]);
    if (!alreadySorted) {
      if (layout.slotted) {
        const markers = currentUnits.map((unit) => {
          const marker = document.createComment("mlsa-sort-slot");
          unit.parentNode.insertBefore(marker, unit);
          unit.remove();
          return marker;
        });
        markers.forEach((marker, index) => marker.replaceWith(desiredUnits[index]));
      } else {
        const fragment = document.createDocumentFragment();
        desiredUnits.forEach((unit) => fragment.appendChild(unit));
        layout.parent.appendChild(fragment);
      }
    }
    const labels = {
      "sales-desc": "累计销量档位",
      "recent-desc": "近30天/观察增量",
      "category-rank": "官方类目排名",
      "image-similarity": "图片相似度",
      original: "平台原排序"
    };
    STATE.sortMessage = `已按${labels[STATE.sort] || "所选规则"}重新排列 ${sorted.length} 个商品`;
    return true;
  }

  function compareDocumentOrder(a, b) {
    if (a === b || typeof a.compareDocumentPosition !== "function") return 0;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }

  function updateToolbar() {
    const toolbar = document.getElementById(TOOLBAR_ID);
    if (!toolbar) return;
    const known = STATE.cards.filter((item) => item.status === "ok").length;
    const unresolved = STATE.cards.filter((item) => ["unavailable", "error"].includes(item.status)).length;
    const loading = STATE.cards.filter((item) => ["pending", "loading"].includes(item.status)).length;
    const organic = STATE.cards.filter((item) => !item.sponsored).length;
    const tracked = STATE.cards.filter((item) => (item.observedDays || 0) > 0 || item.recent30Source === "public").length;
    const status = toolbar.querySelector("#mlsa-status");
    const baseStatus = loading
      ? `已找到 ${STATE.total} 个商品，正在读取 ${loading} 个…`
      : `自然结果 ${organic} 个：${known} 个有累计档位，${tracked} 个有30天/观察趋势，${unresolved} 个未公开`;
    const imageStatus = STATE.imageSearch.running
      ? `正在比图 ${STATE.imageSearch.compared}/${STATE.imageSearch.total}`
      : "";
    const catalogStatus = STATE.fullCatalog.running
      ? STATE.fullCatalog.phase === "pages"
        ? `正在扫描全部页：${STATE.fullCatalog.pages} 页，${STATE.fullCatalog.items.length || "汇总中"}`
        : `正在读取全量销量：${STATE.fullCatalog.completed}/${STATE.fullCatalog.items.length}`
      : "";
    status.textContent = [baseStatus, imageStatus || catalogStatus || STATE.sortMessage].filter(Boolean).join(" · ");

    const rate = toolbar.querySelector("#mlsa-rate");
    if (!STATE.exchangeEnabled) rate.textContent = "人民币换算已关闭";
    else if (STATE.exchange?.rate) {
      const stale = STATE.exchangeStatus === "stale" ? "（缓存）" : "";
      rate.textContent = `1 ${STATE.currency} ≈ ¥${formatRate(STATE.exchange.rate)} · ${STATE.exchange.rateDate || "最新"}${stale}`;
    } else if (STATE.exchangeStatus === "error") rate.textContent = "汇率读取失败，销量功能不受影响";
    else if (STATE.exchangeStatus === "unsupported") rate.textContent = "未识别页面币种";
    else rate.textContent = "正在读取人民币汇率…";

    toolbar.querySelectorAll("button[data-sort]").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.sort === STATE.sort);
    });
    const imageButton = toolbar.querySelector("#mlsa-image-search");
    imageButton?.classList.toggle("is-active", STATE.sort === "image-similarity");
  }
})();
