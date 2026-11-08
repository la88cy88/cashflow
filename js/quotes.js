/** 按工作状态分组的激励语，切换时避免连续重复同一句 */

const QUOTES = {
  before: [
    '你的时间正在变成钱。',
    '今天也值得被好好计酬。',
    '还没开工，钱已经在排队了。',
    '把今天过好，账户会替你记住。',
    '准备好，马上开始积累。'
  ],
  working: [
    '又多赚了一点，继续加油。',
    '距离下班又近了一点。',
    '今天的努力正在兑现。',
    '每一秒都在结算，别急。',
    '你正在把时间兑换成自由。',
    '钱在涨，你也在往前走。',
    '稳稳地赚，比什么都踏实。',
    '这一刻的专注，正在被计价。'
  ],
  break: [
    '休息也是工作的一部分。',
    '喘口气，下午继续。',
    '工资暂停，好心情不停。',
    '好好吃饭，钱等会儿再涨。'
  ],
  done: [
    '今日工资到账，辛苦了。',
    '今天的份额，一分不少。',
    '收工！把时间还给自己。',
    '又完整兑现了一天。'
  ],
  invalid: ['把计划填好，钱就能开始跳了。']
};

let lastQuote = '';

export function pickQuote(status) {
  const pool = QUOTES[status] || QUOTES.working;
  let text = pool[Math.floor(Math.random() * pool.length)];
  if (text === lastQuote && pool.length > 1) {
    text = pool[(pool.indexOf(text) + 1) % pool.length];
  }
  lastQuote = text;
  return text;
}
