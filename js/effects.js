/**
 * 轻量的激励性视觉效果。
 * 所有元素在动画结束后自行移除，不常驻 DOM；动画开关或系统「减少动态效果」开启时完全不创建。
 */

let enabled = true;

export function setEffectsEnabled(value) {
  enabled = Boolean(value);
}

function canPlay() {
  if (!enabled) return false;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return true;
}

function spawn(layer, className, text, vars = {}, ttl = 1600) {
  const el = document.createElement('span');
  el.className = className;
  if (text) el.textContent = text;
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, String(v));
  layer.appendChild(el);
  const remove = () => el.remove();
  el.addEventListener('animationend', remove, { once: true });
  window.setTimeout(remove, ttl + 200);
  return el;
}

const MILESTONE_LABEL = { 25: '四分之一到手', 50: '已经过半啦', 75: '快收工了', 100: '今日工资到账' };

/** 25 / 50 / 75：少量金币从数字下方浮起 */
export function playMilestone(level, layer) {
  if (!canPlay() || !layer) return;
  const count = level === 100 ? 0 : 6 + level / 25;
  for (let i = 0; i < count; i += 1) {
    spawn(
      layer,
      'fx-coin',
      '¥',
      {
        '--fx-x': `${18 + Math.random() * 64}%`,
        '--fx-delay': `${i * 55}ms`,
        '--fx-drift': `${(Math.random() - 0.5) * 90}px`,
        '--fx-scale': (0.7 + Math.random() * 0.6).toFixed(2)
      },
      1500
    );
  }
  if (level !== 100) {
    spawn(layer, 'fx-badge', `${level}% · ${MILESTONE_LABEL[level]}`, {}, 1900);
  }
}

/** 100%：彩带 + 中央庆祝卡片 */
export function celebrate(layer) {
  if (!canPlay() || !layer) return;
  const colors = ['#0E9F6E', '#34D399', '#F6C453', '#F59E0B', '#60A5FA', '#F472B6'];
  for (let i = 0; i < 22; i += 1) {
    spawn(
      layer,
      'fx-confetti',
      '',
      {
        '--fx-x': `${Math.random() * 100}%`,
        '--fx-delay': `${Math.random() * 420}ms`,
        '--fx-rotate': `${Math.random() * 720 - 360}deg`,
        '--fx-color': colors[i % colors.length],
        '--fx-duration': `${1500 + Math.random() * 900}ms`
      },
      2800
    );
  }
  spawn(layer, 'fx-badge fx-badge--final', '🎉 今日目标达成', {}, 2600);
}

/** 进度条末端的一次性微光 */
export function pulseProgress(el) {
  if (!canPlay() || !el) return;
  el.classList.remove('is-pulsing');
  // 触发重排以重放动画
  void el.offsetWidth;
  el.classList.add('is-pulsing');
  window.setTimeout(() => el.classList.remove('is-pulsing'), 700);
}

/** 状态切换时给数字区一个极轻的呼吸 */
export function pulseAmount(el) {
  if (!canPlay() || !el) return;
  el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.018)' }, { transform: 'scale(1)' }], {
    duration: 420,
    easing: 'ease-out'
  });
}
