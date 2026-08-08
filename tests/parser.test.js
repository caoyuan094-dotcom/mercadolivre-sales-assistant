const assert = require("node:assert/strict");

global.chrome = { runtime: { onMessage: { addListener() {} } } };
const {
  parseSalesFromHtml, parseSalesText, parseRecentSalesText, parseCategoryRank,
  parseLocalizedNumber, computeObservedTrend, isCurrency, isAllowedImageUrl
} = require("../background.js");
const { detectCurrency, parseLocalizedPrice, formatCny } = require("../currency.js");
const { compareSignatures } = require("../image-similarity.js");
const {
  parseRating, parseReviewCount, sanitizeFilename, extractListingId, canonicalProductKey,
  selectBestProductUrl, resolveSortLayout, rankItems
} = require("../export-utils.js");

assert.equal(parseLocalizedNumber("500"), 500);
assert.equal(parseLocalizedNumber("1.234"), 1234);
assert.equal(parseLocalizedNumber("2,5 mil"), 2500);
assert.equal(parseLocalizedNumber("1,2 milhão"), 1200000);
assert.deepEqual(parseSalesText("Novo | +500 vendidos"), { sales: 500, display: "500", salesIsLowerBound: true });
assert.deepEqual(parseSalesText("Más de 2 mil ventas"), { sales: 2000, display: "2,000", salesIsLowerBound: true });
assert.deepEqual(parseSalesText("500 vendidos"), { sales: 500, display: "500", salesIsLowerBound: false });
assert.equal(parseSalesText("120 vendidos nos últimos 30 dias"), null);
assert.deepEqual(parseRecentSalesText("+120 vendidos nos últimos 30 dias"), {
  recent30: 120, recent30IsLowerBound: true, recent30Source: "public"
});
assert.deepEqual(parseCategoryRank("5º em Carrinhos de Bebês"), {
  categoryRank: 5, categoryName: "Carrinhos de Bebês"
});
assert.equal(parseSalesFromHtml("<span>+100 vendidos</span>").sales, 100);
assert.equal(parseSalesFromHtml('<script>{"sold_quantity":321}</script>').sales, 321);
assert.equal(parseSalesFromHtml("<h1>Produto sem histórico</h1>").status, "unavailable");
assert.equal(isCurrency("BRL"), true);
assert.equal(isCurrency("EUR"), false);
assert.equal(detectCurrency("www.mercadolivre.com.br"), "BRL");
assert.equal(detectCurrency("listado.mercadolibre.com.mx"), "MXN");
assert.equal(detectCurrency("www.mercadolibre.com", "US$ 19"), "USD");
assert.equal(parseLocalizedPrice("R$ 399,90"), 399.9);
assert.equal(parseLocalizedPrice("$ 1.299"), 1299);
assert.equal(parseLocalizedPrice("1,299.50"), 1299.5);
assert.equal(formatCny(100, 1.25), "¥125.00");
assert.equal(parseRating("4.8"), 4.8);
assert.equal(parseRating("Avaliação 4,7 de 5"), 4.7);
assert.equal(parseReviewCount("4.8 (1.234)"), 1234);
assert.equal(parseReviewCount("500 opiniões"), 500);
assert.equal(sanitizeFilename('carrinho / bebê: "leve"'), "carrinho _ bebê_ _leve_");
assert.equal(isAllowedImageUrl("https://http2.mlstatic.com/D_NQ_NP_123.webp"), true);
assert.equal(isAllowedImageUrl("https://example.com/image.jpg"), false);
assert.equal(extractListingId("https://produto.mercadolivre.com.br/x#position=1&wid=MLB3491700219"), "MLB3491700219");
assert.equal(extractListingId("https://www.mercadolivre.com.br/x?pdp_filters=item_id%3AMLB3491700219"), "MLB3491700219");
assert.equal(extractListingId("https://produto.mercadolivre.com.br/MLB-3491700219-produto-_JM"), "MLB3491700219");
assert.equal(extractListingId("https://www.mercadolivre.com.br/catalogo/p/MLB22508964"), null);
assert.equal(canonicalProductKey("https://produto.mercadolivre.com.br/x#wid=MLB3491700219"), "MLB3491700219");
assert.equal(selectBestProductUrl([
  "https://www.mercadolivre.com.br/catalogo/p/MLB22508964",
  "https://www.mercadolivre.com.br/catalogo/p/MLB22508964#position=1&wid=MLB3491700219"
]), "https://www.mercadolivre.com.br/catalogo/p/MLB22508964#position=1&wid=MLB3491700219");
assert.equal(selectBestProductUrl([
  "https://www.mercadolivre.com.br/catalogo/p/MLB22508964",
  "https://example.com/ajuda"
]), "https://www.mercadolivre.com.br/catalogo/p/MLB22508964");

const sortRoot = { parentElement: null, children: [] };
const sortList = { parentElement: sortRoot, children: [] };
const sortWrapA = { parentElement: sortList, children: [] };
const sortWrapB = { parentElement: sortList, children: [] };
const sortCardA = { parentElement: sortWrapA, children: [] };
const sortCardB = { parentElement: sortWrapB, children: [] };
sortRoot.children = [sortList];
sortList.children = [sortWrapA, sortWrapB];
sortWrapA.children = [sortCardA];
sortWrapB.children = [sortCardB];
const nestedLayout = resolveSortLayout([sortCardA, sortCardB], [sortRoot]);
assert.equal(nestedLayout.parent, sortList);
assert.equal(nestedLayout.units.get(sortCardA), sortWrapA);
assert.equal(nestedLayout.units.get(sortCardB), sortWrapB);

const groupedRoot = { parentElement: null, children: [] };
const groupA = { parentElement: groupedRoot, children: [] };
const groupB = { parentElement: groupedRoot, children: [] };
const groupWrapA = { parentElement: groupA, children: [] };
const groupWrapB = { parentElement: groupB, children: [] };
const groupedCardA = { parentElement: groupWrapA, children: [] };
const groupedCardB = { parentElement: groupWrapB, children: [] };
groupedRoot.children = [groupA, groupB];
groupA.children = [groupWrapA];
groupB.children = [groupWrapB];
groupWrapA.children = [groupedCardA];
groupWrapB.children = [groupedCardB];
const groupedLayout = resolveSortLayout([groupedCardA, groupedCardB], [groupedRoot]);
assert.equal(groupedLayout.slotted, true);
assert.equal(groupedLayout.units.get(groupedCardA), groupA);
assert.equal(groupedLayout.units.get(groupedCardB), groupB);

const ranked = rankItems([
  { originalIndex: 0, sales: 100, categoryRank: 8 },
  { originalIndex: 1, sales: 500, categoryRank: 4 },
  { originalIndex: 2, sales: 300, categoryRank: 2 },
  { originalIndex: 3, sales: 900, sponsored: true }
], "sales-desc");
assert.deepEqual(ranked.map((item) => item.sales), [500, 300, 100]);

const referenceSignature = {
  hash: [1, 1, 0, 0, 1, 0, 1, 0],
  histogram: [0.5, 0.3, 0.2],
  mask: [1, 1, 0, 0, 1, 0, 1, 0],
  aspect: 1
};
assert.equal(compareSignatures(referenceSignature, referenceSignature), 1);
const differentSignature = {
  hash: [0, 0, 1, 1, 0, 1, 0, 1],
  histogram: [0, 0, 1],
  mask: [0, 0, 1, 1, 0, 1, 0, 1],
  aspect: 2
};
assert.ok(compareSignatures(referenceSignature, differentSignature) < 0.2);
const imageRanked = rankItems([
  { originalIndex: 0, imageSimilarity: 0.42 },
  { originalIndex: 1, imageSimilarity: 0.91 },
  { originalIndex: 2, imageSimilarity: null }
], "image-similarity");
assert.deepEqual(imageRanked.map((item) => item.imageSimilarity), [0.91, 0.42, null]);

const unchanged = computeObservedTrend([
  { date: "2026-07-01", sales: 1000, salesIsLowerBound: true },
  { date: "2026-07-08", sales: 1000, salesIsLowerBound: true }
]);
assert.equal(unchanged.recent30, null);
assert.equal(unchanged.recent30Source, "bucket-unchanged");
assert.equal(unchanged.observedDays, 7);
const observed30 = computeObservedTrend([
  { date: "2026-07-01", sales: 1000, salesIsLowerBound: true },
  { date: "2026-07-31", sales: 5000, salesIsLowerBound: true }
]);
assert.equal(observed30.recent30, 4000);
assert.equal(observed30.recent30Source, "observed-30d");
assert.equal(observed30.recent30IsLowerBound, true);

console.log("parser tests passed");
