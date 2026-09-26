// 验证 mask 假说：滚动容器带 mask-image 渐变 + 被展开撑高后，顶部内容被透明罩住；
// 清除 mask 后顶部内容恢复可见
import { chromium } from 'playwright';
import sharp from 'sharp';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0}
  #scroller{height:200px;overflow:hidden;background:#fff;
    -webkit-mask-image:linear-gradient(to bottom, transparent 0px, black 60px, black 100%);
    mask-image:linear-gradient(to bottom, transparent 0px, black 60px, black 100%)}
  #qa{padding:8px;background:#fff}
  .bubble{height:34px;background:#333;color:#fff;line-height:34px;padding:0 12px;font-size:13px}
  .a{height:140px;background:#ddf;margin-bottom:6px}
</style></head><body>
  <div id="scroller">
    <div id="qa">
      <div class="bubble">预约小程序商城平台 美业用的哪种</div>
      <div class="a">回答1</div>
      <div class="a">回答2</div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
await page.setContent(html);

const analyze = async (label) => {
  const meta = await sharp('/tmp/mask_test.png').metadata();
  const raw = await sharp('/tmp/mask_test.png').raw().toBuffer();
  const ch = raw.length / (meta.width * meta.height);
  // 前 40 行深色像素（气泡是深色 #333）
  let dark = 0;
  for (let y = 0; y < 40 && y < meta.height; y++) {
    for (let x = 0; x < meta.width; x++) {
      const i = (y * meta.width + x) * ch;
      if (raw[i] < 100 && raw[i + 1] < 100 && raw[i + 2] < 100) dark++;
    }
  }
  console.log(`[${label}] 截图 ${meta.width}x${meta.height} | 顶部40行深色像素=${dark} ${dark > 500 ? '✓ 气泡可见' : '✗ 气泡被 mask 罩透明'}`);
};

// 情形 1：未展开（正常滚动容器），截图 qa box
await page.locator('#qa').screenshot({ path: '/tmp/mask_test.png', animations: 'disabled' });
await analyze('未展开(mask生效)');

// 情形 2：展开容器（模拟我们的展开逻辑：height=scrollHeight + overflow visible）
await page.evaluate(() => {
  const s = document.getElementById('scroller');
  s.style.height = s.scrollHeight + 'px';
  s.style.overflow = 'visible';
  s.style.maxHeight = 'none';
});
await page.locator('#qa').screenshot({ path: '/tmp/mask_test.png', animations: 'disabled' });
await analyze('展开后(mask仍生效)');

// 情形 3：展开 + 清 mask
await page.evaluate(() => {
  document.querySelectorAll('*').forEach((el) => {
    const h = el;
    const cs = getComputedStyle(h);
    if ((cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) {
      h.style.setProperty('mask-image', 'none', 'important');
      h.style.setProperty('-webkit-mask-image', 'none', 'important');
    }
  });
});
await page.locator('#qa').screenshot({ path: '/tmp/mask_test.png', animations: 'disabled' });
await analyze('展开+清mask');

await browser.close();
