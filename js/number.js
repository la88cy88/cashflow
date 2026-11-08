/**
 * 逐位滚动金额显示
 *
 * 显示值始终等于引擎算出的真实金额（绝不做视觉上的插值造假）。
 * 只在「字符真正变化」时写 DOM；高频的最后几位纯文本替换，
 * 低频位（整数部分 + 小数点后两位）变化时做一次轻微上滑，形成滚动感而不会抖动。
 */

function kindOf(ch) {
  if (ch >= '0' && ch <= '9') return 'num';
  if (ch === '.' || ch === ',') return 'punct';
  return 'symbol';
}

export class RollingNumber {
  constructor(root) {
    this.root = root;
    this.spans = [];
    this.text = '';
  }

  update(text, animate = true) {
    if (text === this.text) return;
    const prev = this.text;
    this.text = text;

    while (this.spans.length < text.length) {
      const span = document.createElement('span');
      span.className = 'digit';
      span.setAttribute('aria-hidden', 'true');
      this.root.appendChild(span);
      this.spans.push(span);
    }
    while (this.spans.length > text.length) {
      this.spans.pop().remove();
    }

    const dot = text.indexOf('.');
    const animateUntil = dot >= 0 ? dot + 2 : text.length - 1;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const span = this.spans[i];
      const kind = kindOf(ch);
      if (prev[i] === ch && span.dataset.kind === kind && span.textContent === ch) continue;

      span.dataset.kind = kind;
      const frac = dot >= 0 && i > dot ? ' digit--frac' : '';
      span.className = `digit digit--${kind}${frac}`;
      span.textContent = ch;

      if (animate && kind === 'num' && i <= animateUntil && typeof span.animate === 'function') {
        span.animate(
          [
            { transform: 'translateY(-0.34em)', opacity: 0.35 },
            { transform: 'translateY(0)', opacity: 1 }
          ],
          { duration: 210, easing: 'cubic-bezier(.22,.9,.3,1)' }
        );
      }
    }
    if (this.root.getAttribute('aria-label') !== text) {
      this.root.setAttribute('aria-label', text);
    }
  }
}
