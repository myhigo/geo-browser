import { chromium } from 'playwright';
import sharp from 'sharp';
import path from 'path';
const file = path.resolve('diagnostics/wenxin/2026-08-28_17-59-31/page/finished.html');
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('file://' + file, { waitUntil: 'domcontentloaded', timeout: 15000 });
// 1) 杀动画 + 等图
await page.evaluate(async () => {
  const st = document.createElement('style');
  st.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
  document.head.appendChild(st);
  const imgs = Array.from(document.querySelectorAll('img')).filter(i => !i.complete);
  if (imgs.length) await Promise.race([Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))), new Promise(r => setTimeout(r, 6000))]);
}).catch(() => {});
await page.waitForTimeout(300);
const qaSel = '.chat-qa-container, [class*="chat-qa-container"]';
// 2) 预测量右缘 + 加宽视口
const prelimRight = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  let rightEdge = r.x + r.width;
  for (const img of document.querySelectorAll('img, video')) {
    const ir = img.getBoundingClientRect();
    if (ir.width < 80 || ir.height < 60) continue;
    if (ir.bottom > r.y && ir.right > rightEdge) rightEdge = ir.right;
  }
  return rightEdge;
}, qaSel);
const targetW = Math.max(1280, (prelimRight ?? 0) + 60);
console.log('prelimRight:', prelimRight, 'targetW:', targetW);
if (targetW > 1280) {
  await page.setViewportSize({ width: targetW, height: 800 });
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelectorAll('*').forEach((el) => { const h = el; if (h.scrollHeight > h.clientHeight + 1 && h.scrollTop !== 0) h.scrollTop = 0; }); window.scrollTo(0,0); }).catch(() => {});
  await page.waitForTimeout(300);
}
// 3) 锚点
const blockInfo = await page.evaluate((sel) => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  const core = document.querySelector('.chat-search-answer-generate');
  const coreBottom = core ? core.getBoundingClientRect().bottom : null;
  const firstKid = el.firstElementChild;
  const qTop = firstKid ? firstKid.getBoundingClientRect().top : null;
  const pageW = document.documentElement.scrollWidth;
  const topForImg = qTop !== null && qTop >= r.y ? qTop : r.y;
  const bottomForImg = coreBottom !== null && coreBottom > topForImg + 200 ? coreBottom : r.y + r.height;
  let rightEdge = r.x + r.width;
  for (const img of document.querySelectorAll('img, video')) {
    const ir = img.getBoundingClientRect();
    if (ir.width < 80 || ir.height < 60) continue;
    if (ir.bottom > topForImg && ir.top < bottomForImg && ir.right > rightEdge) rightEdge = ir.right;
  }
  return { x: r.x, y: r.y, w: r.width, h: r.height, coreBottom, qTop, pageW, rightEdge };
}, qaSel);
console.log('blockInfo:', JSON.stringify(blockInfo));
const pad = 12;
const top = Math.max(0, blockInfo.qTop !== null && blockInfo.qTop >= blockInfo.y ? Math.floor(blockInfo.qTop) : Math.floor(blockInfo.y));
const left = Math.max(0, Math.floor(blockInfo.x - pad));
const right = Math.min(blockInfo.pageW, Math.ceil(Math.max(blockInfo.x + blockInfo.w, blockInfo.rightEdge) + pad));
const cropBottom = blockInfo.coreBottom !== null && blockInfo.coreBottom > top + 200 ? Math.floor(blockInfo.coreBottom - 6) : Math.floor(blockInfo.y + blockInfo.h);
console.log('crop:', { top, left, right, cropBottom, w: right - left, h: cropBottom - top });
const t0 = Date.now();
await page.screenshot({ path: '_v8.png', fullPage: true, animations: 'disabled' });
console.log('fullPage seconds:', ((Date.now()-t0)/1000).toFixed(1));
await sharp('_v8.png').extract({ left, top, width: right - left, height: cropBottom - top }).png().toFile('_v8_crop.png');
const m = await sharp('_v8_crop.png').metadata();
console.log('final:', m.width, 'x', m.height);
await browser.close();
