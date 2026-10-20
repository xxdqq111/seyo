/**
 * 吃药提醒：把"每天几点吃什么药"算成此刻该不该提醒。
 * ==========================================================================
 * 规则很简单，但有几处是特意这样定的：
 *
 *   · 提前 10 分钟就开始提醒（"快到点了"），不是卡到分钟才说 ——
 *     老人找药、倒水都要时间，等正点才喊就晚了。
 *   · 没确认吃过的，过了点一直算 due。页面会每 5 分钟再提醒一次，
 *     直到老人按「我吃过了」。
 *   · 只算**今天**。跨过零点，昨天的顿数自然消失，重新从今天算。
 *   · 一顿药的身份是「药 + 日期 + 时间」（slot），确认一次记一条；
 *     改时间/删药不会把已有的确认记到别的药头上。
 */
import { listMeds, medLogsFor } from './store.mjs';

/** 提前多少分钟开始提醒 */
export const LEAD_MIN = 10;

const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function slotOf(d, hhmm) {
  return `${dateKey(d)} ${hhmm}`;
}
function atOf(d, hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const x = new Date(d);
  x.setHours(Number.isFinite(h) ? h : 0, Number.isFinite(m) ? m : 0, 0, 0);
  return x;
}

/**
 * 现在的用药状态。
 * @returns {{now:string, leadMin:number, meds:Array, items:Array, dueCount:number, next:object|null}}
 * items 里每一顿：
 *   state  'later'（还早）| 'soon'（快到点了）| 'due'（该吃了/已经过点）| 'done'（确认吃过了）
 *   minutes 负数 = 还有几分钟；正数 = 已经晚了几分钟
 */
export function medStatus({ now = new Date() } = {}) {
  const meds = listMeds().filter((m) => m.enabled !== false);
  const doneMap = new Map(medLogsFor(dateKey(now)).map((l) => [l.med_id + '|' + l.slot, l.at]));
  const items = [];
  for (const m of meds) {
    for (const t of m.times) {
      const at = atOf(now, t);
      const slot = slotOf(now, t);
      const doneAt = doneMap.get(m.id + '|' + slot) || '';
      const minutes = Math.round((now.getTime() - at.getTime()) / 60000);
      let state;
      if (doneAt) state = 'done';
      else if (minutes >= 0) state = 'due';
      else if (minutes >= -LEAD_MIN) state = 'soon';
      else state = 'later';
      items.push({
        medId: m.id,
        name: m.name,
        dose: m.dose,
        note: m.note,
        time: t,
        slot,
        at: at.toISOString(),
        state,
        doneAt,
        minutes,
      });
    }
  }
  items.sort((a, b) => a.slot.localeCompare(b.slot));
  return {
    now: now.toISOString(),
    leadMin: LEAD_MIN,
    meds,
    items,
    dueCount: items.filter((i) => i.state === 'due').length,
    next: items.find((i) => i.state !== 'done') || null,
  };
}
