// Renders docs/mockups/chat.html into docs/img/*.png  (needs Playwright; not a project dependency)
//   node docs/mockups/render.cjs
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 2 });
  await page.goto('file://' + path.resolve(__dirname, 'chat.html'));
  for (const id of ['capture', 'search', 'digest']) {
    await page.locator('#' + id).screenshot({ path: path.resolve(__dirname, '../img', id + '.png') });
  }
  await browser.close();
})();
