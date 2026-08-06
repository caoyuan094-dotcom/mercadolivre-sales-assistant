const assert = require("node:assert/strict");
const { runWorkerPool } = require("../export-utils.js");

(async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const completed = [];
  let active = 0;
  let maximumActive = 0;

  await runWorkerPool(items, 4, async (item) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed.push(item);
    active -= 1;
  });

  assert.equal(maximumActive, 4);
  assert.deepEqual([...completed].sort((a, b) => a - b), items);
  assert.equal(new Set(completed).size, items.length);
  console.log("concurrency tests passed");
})();
