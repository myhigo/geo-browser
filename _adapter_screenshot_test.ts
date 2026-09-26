// 单元级回归：直接调用 WenxinAdapter.captureQaScreenshot（截图逻辑已下沉到平台私有实现）
// 假页复刻文心结构：多层滚动容器 + mask 渐隐 + fixed 问题气泡（内部 absolute 背景层）
//   + 外部 fixed 导航 + selection 浮层
// 期望：截图 = qa box；气泡背景可见；导航/浮层不出现
import { chromium } from 'playwright';
import sharp from 'sharp';
import { WenxinAdapter } from './src/platforms/wenxin/WenxinAdapter.js';

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:sans-serif}
  #nav{position:fixed;top:0;left:0;right:0;height:24px;background:#000;color:#fff;font-size:12px;line-height:24px;padding-left:8px;z-index:999}
  #space{height:80px;background:#999}
  #conversation-flow-content{padding:0}
  #scroller{height:300px;overflow:hidden;
    -webkit-mask-image:linear-gradient(to bottom, transparent 0px, black 60px, black 100%);
    mask-image:linear-gradient(to bottom, transparent 0px, black 60px, black 100%)}
  .chat-qa-container{padding:10px;background:#fff}
  .cs-question-bubble{position:fixed;top:0;right:0;width:240px;height:30px;z-index:50}
  .cs-question-bubble .bg{position:absolute;inset:0;background:#333}
  .cs-question-bubble .txt{position:relative;z-index:1;color:#fff;font-size:13px;line-height:30px;text-align:center}
  .sel-popup{position:absolute;top:200px;right:40px;width:220px;height:80px;background:#fc3;color:#000;padding:8px;z-index:777}
  .a{height:150px;background:#ddf;margin-bottom:6px}
</style></head><body>
  <div id="nav">外部 fixed 导航（应被隐藏）</div>
  <div id="space"></div>
  <div id="conversation-flow-content">
    <div id="scroller">
      <div class="chat-qa-container">
        <div class="cs-question-bubble"><span class="bg"></span><span class="txt">适合多门店的一体化私域SaaS</span></div>
        <div class="sel-popup">selection AI 工具条（应被隐藏）</div>
        <div class="a">回答1</div>
        <div class="a">回答2</div>
      </div>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 700, height: 400 } });
const page = await context.newPage();
await page.setContent(html);
// 造一个 selection，验证清 selection 逻辑
await page.evaluate(() => {
  const sel = window.getSelection(); const r = document.createRange();
  const node = document.querySelector('.a').firstChild;
  r.setStart(node, 0); r.setEnd(node, 2); sel.addRange(r);
});

const adapter = new WenxinAdapter(page, context);
const out = '/tmp/adapter_shot.png';
await adapter.captureQaScreenshot(out);

const meta = await sharp(out).metadata();
const raw = await sharp(out).raw().toBuffer();
const ch = raw.length / (meta.width * meta.height);
let dark = 0, yellow = 0, black = 0;
for (let i = 0; i < raw.length; i += ch) {
  const r = raw[i], g = raw[i + 1], b = raw[i + 2];
  if (r < 100 && g < 100 && b < 100) dark++;
  if (r > 200 && g > 180 && b < 120) yellow++;
  if (r < 40 && g < 40 && b < 40 && i / ch < meta.width * 30) black++;
}
console.log(`\n截图 ${meta.width}x${meta.height}`);
console.log(`  气泡深色背景像素=${dark} ${dark > 3000 ? '✓ 气泡可见' : '✗ 气泡背景丢失'}`);
console.log(`  selection 浮层黄色像素=${yellow} ${yellow < 100 ? '✓ 已隐藏' : '✗ 浮层仍在'}`);
console.log(`  顶部30行黑色（导航）像素=${black} ${black < 100 ? '✓ 导航已排除' : '✗ 导航混入'}`);
await browser.close();
