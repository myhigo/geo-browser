import { chromium } from 'playwright';
import path from 'path';

const file = path.resolve('diagnostics/wenxin/2026-08-28_17-12-03/page/finished.html');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('file://' + file);
await page.waitForTimeout(400);

const out = await page.evaluate(() => {
  const cqc = document.querySelector('.chat-qa-container, [class*="chat-qa-container"]');
  if (!cqc) return { found: false };
  const cqcRect = cqc.getBoundingClientRect();

  // 1) 直接子元素 rect（问题 wrapper 与 answer container）
  const kids = Array.from(cqc.children).map((c) => {
    const r = c.getBoundingClientRect();
    return {
      cls: (c.className || '').toString().slice(0, 80),
      textHead: (c.textContent || '').trim().slice(0, 40),
      top: r.top, bottom: r.bottom, height: r.height,
    };
  });

  // 2) 找"图片"/"运行时"（疑似输入条）与反馈按钮的位置
  const findText = (t) => {
    const els = Array.from(document.querySelectorAll('*')).filter((e) => (e.textContent || '').trim() === t);
    return els.slice(0, 2).map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 60), top: r.top, bottom: r.bottom, inCqc: cqc.contains(e) };
    });
  };
  // 3) chat-qa-container 里最深的文本末端：找答案正文的结尾"避坑清单吗"
  const ansEnd = Array.from(document.querySelectorAll('*')).filter((e) => (e.textContent || '').includes('避坑清单吗'));

  return {
    found: true,
    cqcTop: cqcRect.top, cqcBottom: cqcRect.bottom,
    kids,
    imgLabel: findText('图片'),
    runtimeLabel: findText('运行时'),
    ansEnd: ansEnd.slice(0, 1).map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, cls: (e.className || '').toString().slice(0, 60), top: r.top, bottom: r.bottom, inCqc: cqc.contains(e) };
    }),
    // 输入区（textarea）rect
    input: Array.from(document.querySelectorAll('textarea')).map((e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, inCqc: cqc.contains(e), cls: (e.className || '').toString().slice(0, 40) };
    }),
  };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();