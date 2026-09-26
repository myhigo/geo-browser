// 通用文本提取：遍历 DOM，在块级元素之间插入换行。
//
// 为什么不用 innerText：innerText 依赖渲染布局，只对「文档中且可见」的元素插入换行；
// 各平台 getAnswer 常对 cloneNode(true) 的脱离文档节点取文本，此时 innerText 会回退成
// textContent（块级元素间不换行）→ 回答变成一坨。
// 本函数纯结构遍历，不依赖布局，attached / detached 节点行为一致、可预测。
//
// 实现约束：内部用栈迭代、不定义任何具名嵌套函数。tsx/esbuild 会对具名嵌套函数注入
// __name() 辅助调用，函数经 Playwright evaluate 序列化进浏览器后 __name 未定义，会报错。

/** 把元素转成带换行的纯文本：块级元素间插入 \n，<br> 转 \n，行内空白压缩。 */
export function elementToText(root: Node): string {
  const BLOCK_TAGS = new Set([
    'ADDRESS','ARTICLE','ASIDE','BLOCKQUOTE','DD','DETAILS','DIV','DL','DT',
    'FIELDSET','FIGCAPTION','FIGURE','FOOTER','FORM','H1','H2','H3','H4','H5','H6',
    'HEADER','HGROUP','LI','MAIN','NAV','OL','P','PRE','SECTION','TABLE','TBODY',
    'TD','TFOOT','TH','THEAD','TR','UL',
  ]);

  let out = '';
  // 栈项 [node, phase]：phase 0 = 进入，1 = 块级元素退出（用于补尾部换行）
  const stack: Array<[Node, number]> = [[root, 0]];

  while (stack.length > 0) {
    const item = stack.pop() as [Node, number];
    const node = item[0];
    const phase = item[1];

    if (phase === 1) {
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      continue;
    }

    if (node.nodeType === 3) {
      // TEXT_NODE
      out += node.nodeValue ?? '';
      continue;
    }
    if (node.nodeType !== 1) continue;

    const tag = (node as Element).tagName;
    if (tag === 'BR') {
      out += '\n';
      continue;
    }
    if (tag === 'HR') {
      // 只做段落分隔。不能输出 '---'：Markdown 中「文字 + 下一行 ---」是 Setext 标题，
      // 会把上一行渲染成放大加粗的标题。
      if (out.length > 0 && !out.endsWith('\n')) out += '\n';
      continue;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock && out.length > 0 && !out.endsWith('\n')) out += '\n';

    if (isBlock) stack.push([node, 1]);
    // 子节点逆序入栈（lastChild 先入、firstChild 在栈顶），保证按文档顺序处理
    let child = node.lastChild;
    while (child) {
      stack.push([child, 0]);
      child = child.previousSibling;
    }
  }

  // 逐行压缩行内空格/制表符、去行首尾空白；3+ 连续换行压成 2 个
  const lines = out.split('\n').map(function (l) {
    return l.replace(/[ \t]+/g, ' ').trim();
  });
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
