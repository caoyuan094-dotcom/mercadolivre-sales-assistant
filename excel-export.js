(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MLSAExcel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  async function buildWorkbook(ExcelJS, items, images, meta) {
    if (!ExcelJS?.Workbook) throw new Error("Excel 组件未加载");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "美客多销量助手";
    workbook.created = meta.exportedAt;
    const rankingSheet = workbook.addWorksheet("前20名榜单", { views: [{ state: "frozen", ySplit: 3, showGridLines: false }] });
    const sheet = workbook.addWorksheet("关键词前20名", { views: [{ state: "frozen", ySplit: 7 }] });
    const rate = meta.rate || null;
    const imageIds = images.map((image) => image
      ? workbook.addImage({ base64: image.base64, extension: image.extension })
      : null);

    buildRankingSheet(rankingSheet, items, imageIds, meta, rate);

    sheet.mergeCells("A1:U1");
    sheet.getCell("A1").value = `美客多关键词搜索前20名｜${meta.sortLabel || "平台原排序"}`;
    sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFE53935" } };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    sheet.getRow(1).height = 32;
    sheet.getCell("A2").value = "搜索关键词"; sheet.getCell("B2").value = meta.keyword;
    sheet.getCell("D2").value = "导出时间"; sheet.getCell("E2").value = meta.exportedAt;
    sheet.getCell("G2").value = "导出排序"; sheet.getCell("H2").value = meta.sortLabel || "平台原排序";
    sheet.getCell("A3").value = "页面币种"; sheet.getCell("B3").value = meta.currency || "未识别";
    sheet.getCell("D3").value = "兑人民币汇率"; sheet.getCell("E3").value = rate;
    sheet.getCell("A4").value = "汇率日期"; sheet.getCell("B4").value = meta.rateDate || "未取得";
    sheet.getCell("D4").value = "汇率来源"; sheet.getCell("E4").value = meta.rateSource || "未取得";
    sheet.getCell("A5").value = "搜索页面"; sheet.getCell("B5").value = { text: meta.sourceUrl, hyperlink: meta.sourceUrl };
    sheet.mergeCells("B5:U5");
    sheet.getCell("A6").value = "口径说明"; sheet.getCell("B6").value = "表格第1-20行按本次导出排序排列；累计销量通常为公开档位下限，同档位并列；近30天优先使用平台公开值，否则使用插件快照差值。";
    sheet.mergeCells("B6:U6");

    const headers = [
      "导出排名", "平台排名", "自然排名", "累计档位排名", "近30天排名", "产品图片", "产品名称",
      "原币价格", "币种", "约合人民币", "累计销量", "累计口径", "近30天/观察增量",
      "30天数据说明", "官方类目排名", "官方类目", "评分", "评价数", "商品链接",
      "销量数据时间", "刊登ID"
    ];
    sheet.getRow(7).values = headers;
    sheet.getRow(7).height = 26;
    sheet.getRow(7).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FF111111" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });

    items.forEach((item, index) => {
      const rowNumber = 8 + index;
      const sales = item.status === "ok" ? item.sales : item.status === "unavailable" ? "未公开" : "读取失败";
      const recent = Number.isFinite(item.recent30) ? item.recent30 : null;
      const row = sheet.getRow(rowNumber);
      row.values = [
        index + 1, item.platformRank || null, item.organicRank || null, item.salesRank || null, item.recentRank || null,
        "", { text: item.title, hyperlink: item.link }, item.price, meta.currency || "",
        rate && Number.isFinite(item.price) ? { formula: `H${rowNumber}*$E$3`, result: roundMoney(item.price * rate) } : null,
        sales, item.salesIsLowerBound ? "档位下限（≥）" : item.status === "ok" ? "公开值" : "未取得",
        recent, describeRecent(item), item.categoryRank || null, item.categoryName || null,
        item.rating, item.reviews, { text: item.link, hyperlink: item.link },
        item.savedAt ? new Date(item.savedAt) : null, item.listingId || null
      ];
      row.height = 76;
      row.eachCell((cell) => {
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = { bottom: { style: "thin", color: { argb: "FFD8E0E5" } } };
      });
      if (index % 2) row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF5F8FA" } };
      });
      if (imageIds[index] != null) {
        sheet.addImage(imageIds[index], { tl: { col: 5.08, row: rowNumber - 0.92 }, ext: { width: 88, height: 88 }, editAs: "oneCell" });
      }
    });

    sheet.columns = [
      { width: 11 }, { width: 11 }, { width: 11 }, { width: 14 }, { width: 13 }, { width: 16 }, { width: 45 },
      { width: 14 }, { width: 9 }, { width: 16 }, { width: 14 }, { width: 15 }, { width: 18 },
      { width: 27 }, { width: 14 }, { width: 24 }, { width: 9 }, { width: 11 }, { width: 40 },
      { width: 19 }, { width: 18 }
    ];
    sheet.getColumn(8).numFmt = "#,##0.00";
    sheet.getColumn(10).numFmt = "¥#,##0.00";
    sheet.getColumn(11).numFmt = "#,##0";
    sheet.getColumn(13).numFmt = "#,##0";
    sheet.getColumn(17).numFmt = "0.0";
    sheet.getColumn(18).numFmt = "#,##0";
    sheet.getColumn(20).numFmt = "yyyy-mm-dd hh:mm";
    sheet.getCell("E2").numFmt = "yyyy-mm-dd hh:mm";
    sheet.getCell("E3").numFmt = "0.00000";
    sheet.autoFilter = { from: "A7", to: `U${7 + items.length}` };
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    for (let rowNumber = 1; rowNumber <= 7 + items.length; rowNumber += 1) {
      sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: "Arial Unicode MS", ...(cell.font || {}) };
      });
    }
    return workbook.xlsx.writeBuffer();
  }

  function buildRankingSheet(sheet, items, imageIds, meta, rate) {
    sheet.mergeCells("A1:J1");
    sheet.getCell("A1").value = `美客多 ${meta.keyword || "关键词"} 前20名榜单｜${meta.sortLabel || "平台原排序"}`;
    sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFE53935" } };
    sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };
    sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
    sheet.getRow(1).height = 32;

    sheet.getCell("A2").value = "关键词";
    sheet.getCell("B2").value = meta.keyword || "未识别";
    sheet.getCell("D2").value = "导出排序";
    sheet.getCell("E2").value = meta.sortLabel || "平台原排序";
    sheet.getCell("H2").value = "导出时间";
    sheet.getCell("I2").value = meta.exportedAt;
    sheet.mergeCells("E2:G2");
    sheet.mergeCells("I2:J2");
    ["A2", "D2", "H2"].forEach((address) => {
      sheet.getCell(address).font = { bold: true };
      sheet.getCell(address).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF59D" } };
    });
    sheet.getCell("I2").numFmt = "yyyy-mm-dd hh:mm";

    const headers = [
      "导出排名", "产品图片", "产品名称", "原币价格", "约合人民币",
      "累计销量", "近30天/观察增量", "累计档位排名", "官方类目排名", "平台排名"
    ];
    sheet.getRow(3).values = headers;
    sheet.getRow(3).height = 27;
    sheet.getRow(3).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FF111111" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });

    items.forEach((item, index) => {
      const rowNumber = 4 + index;
      const sales = item.status === "ok" ? item.sales : item.status === "unavailable" ? "未公开" : "读取失败";
      const row = sheet.getRow(rowNumber);
      row.values = [
        index + 1, "", { text: item.title, hyperlink: item.link }, item.price,
        rate && Number.isFinite(item.price)
          ? { formula: `D${rowNumber}*'关键词前20名'!$E$3`, result: roundMoney(item.price * rate) }
          : null,
        sales, Number.isFinite(item.recent30) ? item.recent30 : null,
        item.salesRank || null, item.categoryRank || null, item.platformRank || null
      ];
      row.height = 76;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { vertical: "middle", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "FFD8D8D8" } },
          left: { style: "thin", color: { argb: "FFD8D8D8" } },
          bottom: { style: "thin", color: { argb: "FFD8D8D8" } },
          right: { style: "thin", color: { argb: "FFD8D8D8" } }
        };
      });
      if (index % 2) row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFDE7" } };
      });
      if (imageIds[index] != null) {
        sheet.addImage(imageIds[index], { tl: { col: 1.08, row: rowNumber - 0.92 }, ext: { width: 88, height: 88 }, editAs: "oneCell" });
      }
    });

    sheet.columns = [
      { width: 11 }, { width: 16 }, { width: 48 }, { width: 14 }, { width: 16 },
      { width: 14 }, { width: 18 }, { width: 15 }, { width: 15 }, { width: 12 }
    ];
    sheet.getColumn(4).numFmt = "#,##0.00";
    sheet.getColumn(5).numFmt = "¥#,##0.00";
    sheet.getColumn(6).numFmt = "#,##0";
    sheet.getColumn(7).numFmt = "#,##0";
    sheet.autoFilter = { from: "A3", to: `J${3 + items.length}` };
    sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    for (let rowNumber = 1; rowNumber <= 3 + items.length; rowNumber += 1) {
      sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: "Arial Unicode MS", ...(cell.font || {}) };
      });
    }
  }

  function describeRecent(item) {
    if (item.recent30Source === "public") return `平台公开近30天${item.recent30IsLowerBound ? "档位下限" : ""}`;
    if (item.recent30Source === "observed-30d") return `插件30天快照${item.recent30IsLowerBound ? "档位增量下限" : "增量"}`;
    if (item.recent30Source === "observed-partial") return `插件观察 ${item.observedDays || 0} 天，尚未满30天`;
    if (item.recent30Source === "bucket-unchanged") return `观察 ${item.observedDays || 0} 天，公开销量档位未变化；不代表零销量`;
    if (item.recent30Source === "reset") return "商品销量档位重置，重新观察中";
    return `开始记录，已观察 ${item.observedDays || 0}/30 天`;
  }

  function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  return { buildWorkbook };
});
