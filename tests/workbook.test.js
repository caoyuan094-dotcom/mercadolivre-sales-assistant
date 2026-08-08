const assert = require("node:assert/strict");
const fs = require("node:fs");
const ExcelJS = require("../vendor/exceljs.min.js");
const { buildWorkbook } = require("../excel-export.js");

const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const items = Array.from({ length: 20 }, (_, index) => ({
  title: `测试商品 ${index + 1}`,
  link: `https://www.mercadolivre.com.br/produto-${index + 1}`,
  price: 100 + index,
  status: index === 19 ? "unavailable" : "ok",
  sales: 1000 - index,
  salesIsLowerBound: true,
  platformRank: index + 1,
  organicRank: index + 1,
  salesRank: index + 1,
  recent30: 20 - index,
  recentRank: index + 1,
  recent30Source: "observed-partial",
  observedDays: 7,
  savedAt: "2026-07-30T11:00:00Z",
  listingId: `MLB${1000000000 + index}`,
  categoryRank: index + 5,
  categoryName: "Carrinhos de Bebês",
  rating: 4.8,
  reviews: 120,
  imageSimilarity: 0.95 - index * 0.02
}));

(async () => {
  const buffer = await buildWorkbook(ExcelJS, items, [{ base64: pixel, extension: "png" }], {
    keyword: "carrinho de bebê",
    exportedAt: new Date("2026-07-30T12:00:00Z"),
    currency: "BRL",
    rate: 1.3219,
    rateDate: "2026-07-29",
    rateSource: "Frankfurter",
    sortLabel: "累计销量档位（从高到低）",
    sourceUrl: "https://lista.mercadolivre.com.br/carrinho-de-bebe"
  });
  const output = "/private/tmp/mlsa-workbook-test.xlsx";
  fs.writeFileSync(output, Buffer.from(buffer));

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fs.readFileSync(output));
  const rankingSheet = workbook.getWorksheet("前20名榜单");
  const sheet = workbook.getWorksheet("关键词前20名");
  assert.ok(rankingSheet);
  assert.ok(sheet);
  assert.equal(workbook.worksheets[0].name, "前20名榜单");
  assert.equal(rankingSheet.getCell("A4").value, 1);
  assert.equal(rankingSheet.getCell("A23").value, 20);
  assert.equal(rankingSheet.getCell("C4").value.text, "测试商品 1");
  assert.equal(rankingSheet.getCell("E4").value.formula, "D4*'关键词前20名'!$E$3");
  assert.equal(rankingSheet.getCell("J4").value, 1);
  assert.equal(rankingSheet.getCell("K4").value, 0.95);
  assert.equal(rankingSheet.getCell("E2").value, "累计销量档位（从高到低）");
  assert.equal(rankingSheet.getImages().length, 1);
  assert.deepEqual(rankingSheet.autoFilter, "A3:K23");
  assert.equal(sheet.getCell("B2").value, "carrinho de bebê");
  assert.equal(sheet.getCell("A27").value, 20);
  assert.equal(sheet.getCell("K27").value, "未公开");
  assert.equal(sheet.getCell("J8").value.formula, "H8*$E$3");
  assert.equal(sheet.getCell("N8").value, "插件观察 7 天，尚未满30天");
  assert.equal(sheet.getCell("U8").value, "MLB1000000000");
  assert.equal(sheet.getCell("V8").value, 0.95);
  assert.equal(sheet.getCell("H2").value, "累计销量档位（从高到低）");
  assert.equal(sheet.getImages().length, 1);
  assert.deepEqual(sheet.autoFilter, "A7:V27");
  console.log(`workbook tests passed: ${output}`);
})();
