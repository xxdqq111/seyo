import { GEO_NAMES } from './geo.mjs';

/**
 * 中文口语理解层（纯函数，可单测）
 *
 * 老人说的一句话，在这里变成三种东西：
 *   ① 原话      —— 一字不改，只留档
 *   ② 主句      —— 去口癖、切句、补主语后的陈述句（入库；以后用来回答）
 *   ③ 疑问形式  —— 同一个事实，老人以后可能怎么问（检索时用来对上他的问法）
 * 另外抽出 人物 / 地点 / 时间 / 事件 / 关键词，并判断意图与情绪。
 */

/* ------------------------------------------------------------------ *
 * 词表
 * ------------------------------------------------------------------ */

const FILLERS = ['嗯+', '呃+', '唉+', '哎+', '哦+', '噢+', '诶+', '哈+', '这个', '那个', '就是说', '你知道吧', '我跟你说', '怎么说呢', '反正吧'];
const TAIL = /(吧|呢|啊|呀|嘛|啦|喽|嘞|哟|哦|喔|哈|咧|咯|呗)+$/;

export const KIN = [
  '老伴', '老头子', '老公', '老婆', '爱人', '媳妇', '丈夫', '妻子',
  '大儿子', '二儿子', '小儿子', '大女儿', '二女儿', '小女儿',
  '儿子', '闺女', '女儿', '大孙子', '小孙子', '孙子', '孙女', '外孙', '外孙女',
  '大哥', '二哥', '大姐', '二姐', '弟弟', '妹妹', '哥哥', '姐姐',
  '父亲', '母亲', '爹', '娘', '爸', '妈', '公公', '婆婆', '岳父', '岳母',
  '大伯', '叔叔', '舅舅', '姑姑', '姨妈', '姑父', '姨夫', '舅妈',
  '师傅', '师父', '工友', '同事', '战友', '同学', '邻居', '班长', '厂长', '队长',
  '书记', '主任', '大夫', '老师', '会计', '司机',
];

const TITLE_SUFFIX = ['师傅', '师父', '大夫', '医生', '老师', '会计', '司机', '班长', '厂长', '书记', '主任', '工友', '战友'];

const SURNAMES = (
  '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜' +
  '戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳鲍史唐' +
  '费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄' +
  '和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁' +
  '杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍'
).split('');

export const REL_WORDS = ['老伴', '儿子', '女儿', '孙子', '孙女', '师傅', '工友', '同事', '战友', '邻居', '同学'];

/** 亲属称谓：本身就是一个"人物"（老伴、大儿子、孙女…） */
const FAMILY_WORDS = new Set([
  '老伴', '老头子', '老公', '老婆', '爱人', '媳妇', '丈夫', '妻子',
  '大儿子', '二儿子', '小儿子', '大女儿', '二女儿', '小女儿', '儿子', '闺女', '女儿',
  '大孙子', '小孙子', '孙子', '孙女', '外孙', '外孙女',
  '大哥', '二哥', '大姐', '二姐', '弟弟', '妹妹', '哥哥', '姐姐',
  '父亲', '母亲', '爹', '娘', '爸', '妈', '公公', '婆婆', '岳父', '岳母',
  '大伯', '叔叔', '舅舅', '姑姑', '姨妈', '姑父', '姨夫', '舅妈',
]);

/**
 * 单字亲属。
 * 老人说"我娘""我爹""我哥"的频率远高于"我母亲""我哥哥"，
 * 而 KIN 里配的都是双字说法，所以这几个字得单独认。
 * （只放亲属，不放"老/小"这种会误伤的。）
 */
const SINGLE_KIN = ['娘', '爹', '妈', '爸', '哥', '姐', '弟', '妹', '舅', '叔', '姨', '婶', '嫂', '姥', '爷', '奶'];
/** 职业/身份称呼：单独出现不算一个"人物"，要和姓在一起才算（张师傅、老李…） */
const ROLE_WORDS = new Set(['师傅', '师父', '工友', '同事', '战友', '同学', '邻居', '班长', '厂长', '队长', '书记', '主任', '大夫', '老师', '会计', '司机']);

const PLACE_KNOWN = [
  '北京', '上海', '天津', '重庆', '沈阳', '长春', '哈尔滨', '大连', '鞍山', '抚顺',
  '济南', '青岛', '烟台', '郑州', '洛阳', '西安', '兰州', '西宁', '银川', '乌鲁木齐',
  '南京', '苏州', '无锡', '徐州', '杭州', '宁波', '温州', '合肥', '福州', '厦门',
  '南昌', '长沙', '武汉', '广州', '深圳', '佛山', '南宁', '桂林', '成都', '绵阳',
  '贵阳', '昆明', '太原', '石家庄', '唐山', '保定', '呼和浩特', '海口',
  '新疆', '西藏', '内蒙古', '东北', '华北', '华东', '华南', '西北', '西南', '北大荒',
];
const PLACE_WORDS = [
  '老家', '厂里', '矿上', '队里', '村里', '乡里', '县里', '城里', '宿舍', '车间', '食堂',
  '办公室', '学校', '小学', '中学', '大学', '医院', '供销社', '公社', '大队', '生产队',
  '农场', '林场', '兵团', '工地', '码头', '车站', '火车站', '水田', '麦田', '菜地',
  '堂屋', '院子', '屋里', '门口', '井边', '河边', '山上', '田里', '地里', '窑洞', '胡同',
  '纺织厂', '机械厂', '钢铁厂', '印刷厂', '食品厂', '电厂', '煤矿', '油田', '仓库', '邮局', '银行',
];
const PLACE_STOP = ['时候', '那会', '现在', '以前', '以后', '后来', '当时', '那年', '这年', '哪儿', '哪里', '这儿', '那儿', '什么', '怎么', '为啥', '咋', '干嘛', '干啥', '起来', '回来', '出来', '过去', '下去', '一趟', '一起', '一块', '一样', '一天', '吃饭', '睡觉', '回家', '上班', '下班', '说话', '干活', '看病'];

export const TIME_WORDS = [
  { raw: '解放前', label: '1949 年以前', kind: 'era' },
  { raw: '刚解放', label: '1949 年前后', kind: 'era' },
  { raw: '建国初期', label: '1949—1952 年', kind: 'era' },
  { raw: '抗美援朝', label: '1950—1953 年', kind: 'era' },
  { raw: '五十年代', label: '1950—1959 年', kind: 'era' },
  { raw: '三年困难时期', label: '1959—1961 年', kind: 'era' },
  { raw: '闹饥荒', label: '1959—1961 年', kind: 'era' },
  { raw: '文革前', label: '1966 年以前', kind: 'era' },
  { raw: '文革前后', label: '1965—1977 年', kind: 'era' },
  { raw: '文革', label: '1966—1976 年', kind: 'era' },
  { raw: '上山下乡', label: '1968—1978 年', kind: 'era' },
  { raw: '插队', label: '1968—1978 年', kind: 'era' },
  { raw: '知青', label: '1968—1978 年', kind: 'era' },
  { raw: '改革开放', label: '1978 年以后', kind: 'era' },
  { raw: '包产到户', label: '1978—1984 年', kind: 'era' },
  { raw: '八十年代', label: '1980—1989 年', kind: 'era' },
  { raw: '九十年代', label: '1990—1999 年', kind: 'era' },
  { raw: '下岗', label: '1990 年代末', kind: 'era' },
  { raw: '小时候', label: '童年', kind: 'life' },
  { raw: '童年', label: '童年', kind: 'life' },
  { raw: '年轻时候', label: '青年时期', kind: 'life' },
  { raw: '年轻那会儿', label: '青年时期', kind: 'life' },
  { raw: '刚参加工作', label: '青年时期', kind: 'life' },
  { raw: '二十来岁', label: '二十岁上下', kind: 'age' },
  { raw: '二十出头', label: '二十岁出头', kind: 'age' },
  { raw: '三十来岁', label: '三十岁上下', kind: 'age' },
  { raw: '四十来岁', label: '四十岁上下', kind: 'age' },
  { raw: '结婚那年', label: '结婚当年', kind: 'life' },
  { raw: '结婚前', label: '结婚以前', kind: 'life' },
  { raw: '退休前', label: '退休以前', kind: 'life' },
  { raw: '退休那年', label: '退休当年', kind: 'life' },
  { raw: '去年', label: '去年', kind: 'abs' },
  { raw: '今年', label: '今年', kind: 'abs' },
];

export const EVENT_WORDS = [
  '住宿舍', '住厂', '当兵', '参军', '入伍', '退伍', '转业', '复员',
  '上大学', '考大学', '考上大学', '高考', '上中专', '念书', '读书', '上学', '辍学',
  '参加工作', '进厂', '学徒', '下岗', '退休', '返城', '回城', '插队', '下乡',
  '结婚', '出嫁', '成家', '娶媳妇', '嫁人', '生孩子', '生儿子', '生女儿', '抱孙子',
  '搬家', '分房', '盖房', '盖房子', '买房', '调工作', '调动', '探亲', '回老家',
  '生火', '做饭', '种地', '下地', '插秧', '割麦', '收秋', '放牛', '喂猪', '挣工分',
  '赶集', '挑水', '拉煤', '开荒', '修水库', '修铁路', '修路', '支边', '分田',
  '养鸡', '换盐', '卖菜', '学手艺', '拜师', '开机床', '开车床', '修机器', '开车', '跑长途',
  '演出', '唱戏', '拉二胡', '吹唢呐', '打快板', '放电影', '大炼钢铁',
  '入党', '提干', '当班长', '当队长', '当厂长', '评先进', '得奖', '立功',
  '生病', '住院', '做手术', '睡不着', '下楼', '来住', '同住', '搬来',
  '走了', '去世', '过世', '没了',
];
const EVENT_PATTERNS = [
  [/分[了过]?(?:一|两|三|\d)?[间套]?房/, '分房'],
  [/(?:娶|嫁)[了过]?/, '结婚'],
  [/[生添][了过]?(?:个)?(?:大)?(?:儿子|闺女|女儿|小子)/, '生孩子'],
  [/抱[了过]?(?:上)?(?:大)?孙/, '抱孙子'],
  [/[考进][了上]?(?:上)?(?:大|中专|师范)/, '上学'],
  [/[住搬][了过]?(?:进)?(?:宿舍|厂里)/, '住宿舍'],
  [/[入当][了过]?伍|参[了过]?军/, '当兵'],
  [/[退办][了过]?休/, '退休'],
  [/[下失][了过]?岗/, '下岗'],
];
const EVENT_SUPPRESS = [['出嫁', ['结婚']], ['考上大学', ['上大学', '考大学']]];

const NEG = ['难受', '心里堵', '没意思', '不想说话', '不想说', '没劲', '没劲儿', '烦', '孤单', '寂寞', '没盼头', '熬日子', '唉', '想他们了', '睡不着', '吃不下', '浑身不得劲', '没用了', '拖累', '不在了', '一个人在家', '一个人过'];
const MILD = ['唉', '哎', '没意思', '没劲', '没事', '算了', '烦', '不去了', '不想', '睡不着', '一个人'];

const STOP = new Set(('的 了 是 在 和 跟 与 也 都 就 还 又 很 挺 太 真 不 没 有 我 你 他 她 咱 我们 你们 他们 这 那 这个 那个 一个 什么 怎么 为啥 为什么 哪 哪儿 哪里 时候 那会儿 因为 所以 但是 不过 然后 后来 现在 以前 之后 一样 这样 那样 可以 能 会 要 想 说 讲 知道 记得 事儿 事情 一下 一点儿 有点 一些 好像 应该 大概 可能 估计 反正 其实 就是 还是 也是 先 再 把 被 给 让 对 从 到 向 往 于 而 且 或 或者 如果 虽然 可是 于是 起来 出来 过去 下来 上来 里 上 下 中 内 外 前 后 左 右 大 小 多 少 好 坏 老 新 来着 嗯 啊 呀 吧 呢 吗').split(/\s+/));
const STOP_CHARS = new Set([...STOP].filter((w) => w.length === 1));

/* ------------------------------------------------------------------ *
 * 1) 清洗
 * ------------------------------------------------------------------ */

export function clean(raw = '') {
  let s = String(raw).replace(/\s+/g, ' ').trim();
  s = s.replace(/[…]+|\.{3,}/g, '，').replace(/[—–~～]+/g, '');
  for (const f of FILLERS) s = s.replace(new RegExp(`(^|[，,。！？!?、\\s])${f}(?=[，,。！？!?、\\s]|$)`, 'g'), '$1');
  s = s.replace(/([\u4e00-\u9fa5])(啊|呀|哪|呐|嘛|呗)(?=[，,。！？!?、])/g, '$1');
  /* 去掉口吃式重复：只合并**三个以上**的。
     原来是 {1,}（两个就合并），结果把**叠词**全吃掉：
       今天天气不错 → 今天气不错
       我天天早上…   → 我天早上…
       爸爸 / 慢慢 / 看看 / 刚刚 / 常常 全被拆坏
     中文叠词太常见了，宁可留着偶尔的口吃（"我我"），也不能把词拆坏。 */
  s = s.replace(/([\u4e00-\u9fa5])\1{2,}/g, '$1');
  s = s.replace(/([\u4e00-\u9fa5]{2,6})\1+/g, '$1');
  s = s.replace(/[，,]{2,}/g, '，').replace(/[。！？!?]{2,}/g, '。');
  s = s.replace(/\s*([，。！？、；：])\s*/g, '$1');
  return s.replace(/^[，、；：。]+/, '').replace(/[，、；：]+$/, '').trim();
}

export function isNonContent(text = '') {
  const t = clean(text).replace(TAIL, '').replace(/[，。！？、；：\s]/g, '');
  if (!t) return true;
  return t.length <= 3 && /^(嗯|哦|噢|啊|唉|哎|好|行|是|对|有|没有|没|不知道|还行|挺好|没事|知道了|算了|忘了|想不起来|差不多|可不|是啊|对的)$/.test(t);
}

/**
 * 是不是「让岁语去干活」的请求句？
 *
 *   "帮我倒杯水"    "把窗户关上"    "打开电视"    "给我拿个凳子"
 *
 * 这不是记忆 —— 不是老人这辈子的事，是他这会儿的需求。
 * 当成记忆存进去会把档案库搞脏；更糟的是它很短、又像"补充细节"，
 * 会被并进上一条正在讲的事里，把正经记忆改坏。
 *
 * 但要小心别误伤：
 *   "给我留下的那两间房在红砖楼" 开头也是"给我"，可这是**记忆**
 *   → 所以要求"帮我/给我"后面紧跟的必须是**动作**
 */
// 请求里最常见的动作
const ACT = '倒|拿|递|端|关|开|放|收|冲|换|洗|扫|锁|弄|调|叫|喊|找|买|去|来|看|说|打|接|送|取|搬|擦|削|煮';
// "帮我/给我/替我 + 动作"
const ASK_ME = new RegExp(`^(帮|替|给)我(${ACT})`);
// 光秃秃的祈使："倒杯水""关上窗户""打开电视"
const BARE_ASK = new RegExp(`^(${ACT})(一?[下个杯碗碟壶件张])?`);
// 祈使 + 商量的尾巴
const REQ_TAIL = /(好吗|行吗|行不行|可以吗|帮个忙|麻烦你|麻烦您)[。！？?!]?$/;

/* ======================================================================
   老人改口
   ----------------------------------------------------------------------
   老人经常会回头纠正自己（或者纠正岁语记错的地方）：

     "那是1987年不是88年"
     "不对，是八七年"
     "说错了，应该是1987年"
     "不是88年，是87年"

   这些**不是新记忆**，是对已有记忆的修改。原来的做法直接把它当新事存下来
   —— 于是时间轴上冒出"1987 年 · 那是1987年不是88年"这么一条，
   而原来的 1988 纹丝不动，看着莫名其妙。

   这里只负责**认出来 + 解析出改什么**，具体怎么落库交给 engine。
   ====================================================================== */
const CORRECTION_MARK = /(不对|不是|说错|记错|搞错|弄错|应该是|改成|改一下|更正|讲错|念错)/;

/* 老人说年份爱用汉字："八七年""一九八七年"。先换成阿拉伯数字再解析。 */
const CN_DIGIT = { 〇: '0', 零: '0', 一: '1', 二: '2', 两: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9' };
function cnYears(s) {
  return String(s).replace(/[〇零一二两三四五六七八九]{2,4}(?=\s*年)/g, (m) => (
    m.split('').map((c) => CN_DIGIT[c] ?? c).join('')
  ));
}

/** 两位的年份补成四位：87 → 1987（按出生年判断是 19xx 还是 20xx） */
function fixYear(y, birthYear) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  const len = String(y).length;
  if (len === 4) return n;
  if (len !== 2) return null;
  const by = Number(birthYear) || 1948;
  return (1900 + n) >= by ? 1900 + n : 2000 + n;
}

/**
 * 这句话是不是在改口？是就返回改什么，不是返回 null。
 *
 * 两种：
 *   { kind: 'year', from, to }            —— 改年份（from 是那个错的，可能没提）
 *   { kind: 'word', from, to }            —— 改说法（"是印染厂不是纺织厂"）
 *
 * @param {string} text
 * @param {{birthYear?: number}} opts
 */
export function parseCorrection(text = '', { birthYear = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 30) return null;          // 长句子多半在讲事
  const s = cnYears(clean(raw));
  if (!s || !CORRECTION_MARK.test(s)) return null;

  const grab = (part) => {
    const m = /(1[89]\d{2}|20[0-4]\d|\d{2})\s*年/.exec(part);
    return m ? fixYear(m[1], birthYear) : null;
  };

  /* 两种语序都要认：
       "那是1987年不是88年"   → 对的在前，错的在"不是"后面
       "不是88年，是87年"     → 错的在前，对的在后 */
  const wrongPart = /不是([^，。！？、]{0,12})/.exec(s);
  const wrong = wrongPart ? grab(wrongPart[1]) : null;
  const rightPart = wrongPart ? s.replace(wrongPart[0], '') : s;
  const right = grab(rightPart);

  if (right !== null && right !== wrong) {
    return { kind: 'year', from: wrong, to: right, raw: raw.slice(0, 40) };
  }

  /* 没有年份，看看是不是改说法：
       "不对，是印染厂不是纺织厂"  → 对=印染厂 错=纺织厂
       "不是纺织厂，是印染厂"      → 错=纺织厂 对=印染厂  */
  if (right !== null) return null;                   // 只提了一个年份，就是它
  const m1 = /是([\u4e00-\u9fa5A-Za-z0-9]{1,8})不是([\u4e00-\u9fa5A-Za-z0-9]{1,8})/.exec(s);
  if (m1) return { kind: 'word', to: m1[1], from: m1[2], raw: raw.slice(0, 40) };
  const m2 = /不是([\u4e00-\u9fa5A-Za-z0-9]{1,8})[，,]?\s*(?:那)?是([\u4e00-\u9fa5A-Za-z0-9]{1,8})/.exec(s);
  if (m2) return { kind: 'word', from: m2[1], to: m2[2], raw: raw.slice(0, 40) };

  return null;
}

export function isRequest(text = '') {
  const t = clean(text);
  if (!t) return false;
  if (t.length > 20) return false;                       // 长句子一般是在讲事
  if (ASK_ME.test(t)) return true;                       // 帮我倒… / 给我拿…
  if (/^(麻烦|劳驾)/.test(t)) return true;               // 麻烦你把药拿来
  if (REQ_TAIL.test(t) && t.length <= 18) return true;   // 关上窗户好吗
  if (/^把[^，。]{1,10}(关|开|拿|放|收|倒|洗|扫|锁|递|端|弄|调|换)/.test(t)) return true;  // 把窗户关上
  // 光秃秃的祈使句：短、没主语、没讲任何具体的人和地方
  if (t.length <= 8 && !/^(我|咱|俺|他|她|你)/.test(t) && BARE_ASK.test(t)) return true;
  return false;
}

/* ------------------------------------------------------------------ *
 * 2) 切句
 * ------------------------------------------------------------------ */

/**
 * 这句话能不能独立成一条记忆？
 * 补语式的残句（"在北边那栋红砖楼""院子里有棵老槐树"）不能，
 * 它们该并进上一句，否则库里全是断句。
 */
export function requireSubject(text = '') {
  const t = String(text).trim();
  if (!/^(我|咱|俺|我们)/.test(t)) return false;              // 没主语
  if (/^(我|咱|俺)(在|到|去|从|跟|和|给|把)/.test(t) && t.length <= 12) return false; // "我在北边那栋红砖楼"
  const rest = t.replace(/^(我|咱|俺|我们)/, '');
  if (/^(们|家|这|那|的)/.test(rest)) return false;
  if (!/(住|干|当|学|进|上|结|分|搬|盖|买|种|养|挣|退|下|考|做|吃|穿|走|去世|生|抱|参加|认识|调|回|来|去|有)/.test(rest) && rest.length <= 6) return false;
  return true;
}

export function splitClauses(text = '') {
  const marked = String(text)
    .replace(/(后来|然后|接着|再后来|之后|结果|另外|还有)/g, '。$1')
    .replace(/([。！？!?；;])/g, '$1|');
  const parts = marked
    .split('|')
    .flatMap((p) => p.split(/，(?=[^，]{8,})/))
    .map((s) => clean(s).replace(/[，、；：]+$/, ''))   // 去掉切分留下的尾巴标点
    .filter((s) => s.length >= 4 && !isNonContent(s));
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    // 太短、或没主语的补语 → 并进上一句，不单独成条
    if (prev && (prev.length < 8 || p.length < 8 || !requireSubject(p))) {
      out[out.length - 1] = `${prev}，${p.replace(/^[，。]+/, '')}`;
    } else {
      out.push(p);
    }
  }
  return out.slice(0, 6);
}

/* ------------------------------------------------------------------ *
 * 3) 主句
 * ------------------------------------------------------------------ */

const FIRST_PERSON = /^(我|咱|俺|我们)/;

export const bare = (s = '') => String(s).replace(/[。！？!?，,、；;：:\s]+$/g, '').trim();

export function simplify(text = '') {
  let core = clean(text);
  if (!core) return '';
  core = core.replace(/(你说是不是|你说对吧|你说是吧|对吧|是吧|是不是啊|你知道吧)[。！？!?]?$/g, '');
  core = core.replace(/^(反正|其实|就是|不过|但是|要说|可说呢)[，,]?/, '');
  core = core.replace(new RegExp(`${TAIL.source}[。！？!?]?$`), '');
  if (core.length > 60) {
    const cut = core.slice(0, 60);
    const p = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'));
    core = p > 20 ? cut.slice(0, p) : cut;
  }
  // 补主语：只有**句子确实缺主语**（谓语开头）时才补。
  //
  //   "在厂里住宿舍"    → "我在厂里住宿舍"      ✓ 谓语开头，主语省了
  //   "跟老张去买苹果"  → "我跟老张去买苹果"    ✓
  //   "张师傅教我学手艺" → 原样（别人当主语）    ✓
  //
  // 不该补的：
  //   "帮我倒杯水"      → 请求句，是让岁语去干活
  //   "今天天气不错"    → 主语是"今天天气"，补成"我今天天气不错"就荒唐了
  //   "人老了没用了"    → 主语是"人"，补了反而别扭
  //
  // 所以改成**白名单**：只在以动词/介词开头时才补（那种句子主语确实省了）。
  const VERB_HEAD = /^(在|到|去|从|跟|和|给|把|被|正|成|学|干|做|当|住|买|卖|见|找|认|觉|想|要|喜欢|记得|忘|听说|考上|分到|调到|调到|进|退|搬|回)/;
  const IMPERATIVE = /^(帮|给|替|拿|倒|递|端|关|开|把|放|收|冲|换|洗|扫|锁|叫|喊|弄|调|连|打开|关上)/;
  if (!FIRST_PERSON.test(core) && core.length > 4 && VERB_HEAD.test(core) && !IMPERATIVE.test(core)) {
    const head = core.slice(0, 4);
    const headPerson = FAMILY_WORDS.has(core.slice(0, 3)) || FAMILY_WORDS.has(core.slice(0, 2))
      || KIN.some((k) => head.startsWith(k))
      || /^[\u4e00-\u9fa5](师傅|师父|大夫|医生|老师|工友|同事|战友|邻居|班长|厂长|会计|司机)/.test(head);
    const withMe = /^(一起|一块|一块儿|共同|合伙)/.test(core);
    if (headPerson && withMe) core = `我跟${core}`;
    else if (headPerson) core = core;                       // 别人当主语，保持原样
    else if (withMe) core = `我跟${core}`;
    else core = `我${core}`;
  }
  core = core.replace(TAIL, '');
  return `${bare(core)}。`;
}

/* ------------------------------------------------------------------ *
 * 4) 疑问形式
 * ------------------------------------------------------------------ */

export function askForms(statement, analysis = {}) {
  const s = bare(statement);
  const body = s.replace(FIRST_PERSON, '');
  const time = analysis.times?.[0]?.raw || '';
  const place = analysis.places?.[0] || '';
  const event = analysis.events?.[0] || '';
  const person = analysis.persons?.[0] || '';
  const kws = (analysis.keywords || []).filter((w) => w.length >= 2).slice(0, 3);
  const out = new Set();

  if (body.length <= 30) out.add(`我${body}，你还记得吗？`);
  if (person) out.add(`我${body.slice(0, 14)}的那个人是谁来着？`);
  // 时间式：句子里已经带了这个时间词就不再重复拼
  if (time && !body.startsWith(time)) out.add(`我${time}${event || kws[0] || '那阵子'}的事，你还记得吗？`);
  if (place && !body.startsWith(`那时候在${place}`)) out.add(`我那时候在${place}是啥情况来着？`);
  if (kws.length) out.add(`我${kws.slice(0, 2).join('')}那事你还记得吗？`);
  if (event) out.add(`我${event}的事，你还记得吗？`);
  if (person) out.add(`${person}那事儿你还记得不？`);

  return [...out].filter((x) => x && x.length >= 5).slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * 5) 抽取
 * ------------------------------------------------------------------ */

function findPersons(text) {
  const out = new Set();
  // 时间说法不是人名（"老时候""小时候"里的"老时""小时"会被误抓）
  const NOT_NAME = new Set(['老时', '老那', '小时', '老年', '老日', '小日', '老几']);
  // 去掉姓以后剩下的部分如果本身是地名/方位，这就不是人名（"胡同里""院子里""李家院"）
  const NOT_GIVEN = /^(胡同|院子|家庄|家院|厂里|村里|队里|城里|家里|地里|田里|山上|河边|门口|屋里|村人|庄上)/;
  // 名字里带方位字收尾的也不是人名（"同里""家院"）
  const NOT_GIVEN_TAIL = /(里|内|外|上|下|前|后|旁|边|中|口)$/;

  for (const t of KIN) {
    if (!text.includes(t)) continue;
    // 亲属称谓本身就算一个人物；职业称呼要带姓才算（张师傅、老李）
    if (FAMILY_WORDS.has(t)) out.add(t);
    else if (!ROLE_WORDS.has(t)) out.add(t);
  }
  // 单字亲属（娘、爹、哥、姐…）—— 老人最常说的就是这几个字，
  // 但 KIN 里配的是"哥哥/姐姐"这种双字，单字得单独捞一遍。
  for (const t of SINGLE_KIN) {
    if (text.includes(t)) out.add(t);
  }
  for (const m of text.matchAll(/[老小]([\u4e00-\u9fa5])/g)) {
    if (SURNAMES.includes(m[1]) && !NOT_NAME.has(`老${m[1]}`)) out.add(`老${m[1]}`);
  }
  for (const m of text.matchAll(/([\u4e00-\u9fa5])(师傅|师父|大夫|医生|老师|会计|司机|班长|厂长|书记|主任|工友|战友)/g)) {
    if (SURNAMES.includes(m[1])) out.add(`${m[1]}${m[2]}`);
    else out.add(m[2]);
  }
  for (const m of text.matchAll(/([\u4e00-\u9fa5])([\u4e00-\u9fa5]{1,2})(?=[，。！？、；：\s]|$|说|是|的|家)/g)) {
    // 姓 + 名：名不能是地名/方位（"西城区"里的"城区"、"胡同里"里的"同里"），
    // 也不能是身份称谓（"他是我的工友"里的"的工友"——"的"恰好在姓氏表里）
    const given = m[2];
    const isRole = ROLE_WORDS.has(given) || FAMILY_WORDS.has(given);
    if (SURNAMES.includes(m[1]) && !STOP.has(given) && !NOT_GIVEN.test(given) && !isRole) out.add(`${m[1]}${given}`);
  }
  for (const m of text.matchAll(/(?:名字叫|名叫|叫做|叫)([\u4e00-\u9fa5]{2,3})/g)) {
    if (!/^(什么|啥|他|她|我|小名|大名|外号)/.test(m[1])) out.add(m[1]);
  }
  // 有了"大儿子"就不必再记"儿子"（同一次讲述里）
  const GENERIC = { 大儿子: '儿子', 二儿子: '儿子', 小儿子: '儿子', 大女儿: '女儿', 二女儿: '女儿', 小女儿: '女儿', 大孙子: '孙子', 小孙子: '孙子' };
  for (const [spec, gen] of Object.entries(GENERIC)) if (out.has(spec)) out.delete(gen);
  const DESCRIPTOR = ['小名', '大名', '外号', '乳名', '名字'];
  // 光有称谓不算人物（要和姓或名一起出现才是人：老张 / 张师傅 / 张建国）
  //
  // ⚠️ 这里原来用的是 REL_WORDS —— 那张表只有"老伴/儿子/女儿/孙子"，
  // **没有"娘/爹/妈/爸/哥/姐"**。而老人恰恰最常说这几个字。
  // 结果"我娘在家给人缝衣裳""我爹是拉洋车的"整句被当成"没落脚点"扔掉，
  // 一句话都进不了库。现在合并 FAMILY_WORDS，亲属称谓一律算人物。
  const BARE_ROLE = new Set([...TITLE_SUFFIX, ...REL_WORDS, ...FAMILY_WORDS]);
  return [...out].filter((x) => {
    // 光有身份称谓（工友、战友、师傅…）不算一个人，要和姓在一起才算（张师傅、老李）
    if (ROLE_WORDS.has(x)) return false;
    // 单字亲属（娘、爹、哥…）—— 老人就这么说，得认
    if (x.length === 1) return SINGLE_KIN.includes(x);
    const rest = x.slice(1);
    // 两字：老X / 小X，或亲属称谓（老伴、儿子…）；三字以上：姓+名 / 姓+称谓
    const twoOk = /^[老小][\u4e00-\u9fa5]$/.test(x) || BARE_ROLE.has(x);
    const lenOk = x.length === 2 ? twoOk : x.length >= 3 && x.length <= 10;
    return lenOk
      && !NOT_NAME.has(x)
      && !NOT_GIVEN.test(rest)
      && !NOT_GIVEN_TAIL.test(rest)
      && !DESCRIPTOR.some((d) => x.startsWith(d) && x.length > d.length)
      && !/^[的了是在和跟有个这那]/.test(x);
  });
}

function findPlaces(text) {
  const out = new Set();
  const blocked = (v) => !v || v.length < 2 || v.length > 12 || PLACE_STOP.some((b) => v.includes(b)) || /^(我|你|他|她|咱)/.test(v);
  // 场所词后面跟着的动词（"仓库管料"→仓库，"食堂做饭"→食堂），不该算进地名里
  const trimAction = (v) => v.replace(/(管料|领料|记账|看门|值班|做饭|打饭|干活|上班|下班|做工|学徒|学手艺|当学徒|看仓库|开票|发货|收货)$/, '');

  for (const p of [...PLACE_KNOWN, ...PLACE_WORDS]) if (text.includes(p)) out.add(p);

  for (const m of text.matchAll(/(?:在|到|去|回|从|住|进|上|离开|搬到|调到)([\u4e00-\u9fa5]{2,10})/g)) {
    let v = m[1].split(/(?:进|上班|下班|干活|工作|念书|读书|上学|当兵|插队|下乡|结婚|生孩子|待|呆|住|吃|睡|，|。|、|的|了|过|跟|和|给|把|是)/)[0];
    v = v.replace(/[的了过上中下]+$/, (suf) => (/[里边面前后]/.test(suf.slice(-1)) ? suf.slice(-1) : ''));
    v = v.replace(/[分挣当去来到回进出干做种盖买娶嫁养修拉挑开教带帮看说想有是]{1,2}$/, '');
    v = trimAction(v).replace(/(里|里头|里边|中)$/, '');
    if (/[分挣当去来到回进出干做种盖买娶嫁养修拉挑开教带帮看说想吃睡]/.test(v)) continue;
    if (blocked(v)) continue;
    out.add(v);
  }
  /* 名字部分直接**不许含虚词**。
     原来用 [\u4e00-\u9fa5]{2,4}，于是 "进的国棉三厂" 会从"的"开始匹配成
     "的国棉三厂"（脏名字）；而且一旦这样匹配成功，正则就跳过了这一段，
     再也找不到正确的"国棉三厂"。
     排除掉虚词后，匹配只能从"国"开始，正好是"国棉三厂"。 */
  for (const m of text.matchAll(/([^\s，。、；：！？的了过着是在到去回上下不没们地得]{2,4}(?:省|市|县|区|镇|乡|村|屯|庄|厂|矿|队|局|站))(?![里民工的])/g)) {
    const v = m[1];
    if (!blocked(v) && !/[了过着是在到去回上下不没们的地得]/.test(v.slice(0, -1))) out.add(v);
  }
  // 省市地名表：老人讲"沈阳""哈尔滨"，前面没有"在/到"也要认出来
  for (const name of GEO_NAMES) if (name.length >= 2 && text.includes(name)) out.add(name);
  return [...out]
    .map((s) => s.trim().replace(/^在/, ''))
    .filter((s, i, a) => s.length >= 2
      && !/^(哪个|哪个儿|什么|啥|哪一|什么|怎么|咋)/.test(s)   // 疑问代词不是地名
      && a.findIndex((x) => x.includes(s) && x !== s) === -1)
    .sort((x, y) => y.length - x.length)                     // 具体的排前面
    .slice(0, 8);
}

function findTimes(text) {
  const out = [];
  const seen = new Set();
  for (const t of TIME_WORDS) {
    if (text.includes(t.raw) && !seen.has(t.label)) {
      seen.add(t.label);
      out.push({ raw: t.raw, label: t.label, kind: t.kind });
    }
  }
  for (const m of text.matchAll(/(1[89]\d{2}|20\d{2})\s*年?/g)) {
    const y = Number(m[1]);
    if (y >= 1900 && y <= 2035) out.push({ raw: m[0].trim(), label: `${y} 年`, kind: 'abs', year: y });
  }
  const CN = { 六: 6, 七: 7, 八: 8, 九: 9 };
  const D = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  for (const m of text.matchAll(/([六七八九])([零一二三四五六七八九])\s*年/g)) {
    const y = 1900 + CN[m[1]] * 10 + D[m[2]];
    out.push({ raw: m[0], label: `${y} 年`, kind: 'abs', year: y });
  }
  const uniq = [];
  const s2 = new Set();
  for (const t of out) {
    if (s2.has(t.label)) continue;
    s2.add(t.label);
    uniq.push(t);
  }
  return uniq.slice(0, 3);
}

function findEvents(text) {
  const out = new Set();
  for (const w of EVENT_WORDS) if (text.includes(w)) out.add(w);
  for (const [re, label] of EVENT_PATTERNS) if (re.test(text)) out.add(label);
  for (const [keep, drop] of EVENT_SUPPRESS) if (out.has(keep)) drop.forEach((d) => out.delete(d));
  const arr = [...out];
  return arr.filter((a) => !arr.some((b) => b !== a && b.includes(a) && b.length > a.length)).slice(0, 4);
}

/* ------------------------------------------------------------------ *
 * 6) 字面 n-gram 与关键词（检索主力）
 * ------------------------------------------------------------------ */

/**
 * 检索用的字面片段。
 * 只取 3–4 字：两字片段（"我在""在纺"）满库都是，会把不相关的问题也"对上"。
 * 三字以上才具备区分度（"纺织厂""挡车工""小时候""分房"）。
 */
export function grams(text = '', maxN = 4) {
  const s = String(text).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let n = 3; n <= maxN; n += 1) {
    for (let i = 0; i + n <= s.length; i += 1) out.add(s.slice(i, i + n));
  }
  if (!out.size) {
    // 太短的句子退化成双字，免得完全没法匹配
    for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  }
  return out;
}

export function keywords(text = '') {
  const t = clean(text).replace(/[，。！？、；：""''（）《》【】,.!?;:()\[\]\s]/g, ' ');
  const chunks = t.split(/\s+/).filter(Boolean);
  const out = new Set();
  const push = (w) => {
    if (w.length >= 2 && w.length <= 6 && !STOP.has(w) && !(w.length === 2 && STOP_CHARS.has(w[0]) && STOP_CHARS.has(w[1]))) out.add(w);
  };
  for (const chunk of chunks) {
    let cur = '';
    for (const ch of chunk) {
      if (STOP_CHARS.has(ch)) { push(cur); cur = ''; } else cur += ch;
    }
    push(cur);
    for (let n = 2; n <= Math.min(4, chunk.length); n += 1) {
      for (let i = 0; i + n <= chunk.length; i += 1) push(chunk.slice(i, i + n));
    }
  }
  const kept = [...out].filter((w) => !/^[的了是在和跟有个这那]/.test(w));
  kept.sort((a, b) => b.length - a.length);
  return kept.slice(0, 28);
}

/* ------------------------------------------------------------------ *
 * 7) 意图与情绪
 * ------------------------------------------------------------------ */

// 问句的特征词（只在句尾附近出现才算问，避免"零下三十度"里的"怎么"被误判）
const ASK_TAIL = /(啥情况|怎么回事|咋回事|发生过什么|是什么|在哪儿|在哪里|哪年|什么时候|多少岁|为啥|为什么|干什么|干啥|干吗|是谁|谁呀|怎么样|后来呢|后来怎么|是谁来着|叫什么来着|在哪儿来着|哪年来着|是什么来着)[呀啊呢吗？?]?$/;
// "……来着"是老人典型的回忆式问法
const ASK_LAIZHE = /来着[？?]?$/;
const ASK_ANY = /(还记得|记不记得|你记得|你知不知道|你知道|还记得吗)/;

export function classify(text = '') {
  const t = clean(text);
  if (isNonContent(t)) return { type: 'ack' };
  if (ASK_ANY.test(t)) return { type: 'recall' };
  if (/(你|岁语).{0,4}(是谁|叫什么)/.test(t)) return { type: 'agent' };

  const asksTail = ASK_TAIL.test(t) || /[？?]$/.test(t) || ASK_LAIZHE.test(t);
  const asksParticle = /(吗|呢|吧)[？?]?$/.test(t);
  // "哪儿 / 哪里 / 哪年 / 是谁 / 什么来着" 这类疑问词：出现就是在问，不是讲
  const asksWord = /(哪儿|哪里|哪个|哪年|哪阵子|是谁|什么来着|啥来着|叫什么)/.test(t);
  const question = asksTail || asksParticle || asksWord;

  // 讲述的特征：出现了明确的过去事（了/过/那年/时候/干了什么）
  const narrative = /(了|过|那年|那会儿|时候|当时|是[六七八九一二三]?[零一二三四五六七八九]?年)/.test(t) && t.length >= 10;

  if (question) return { type: 'ask' };      // 问句一律按"问"处理，绝不把提问当成记忆
  if (asksWord) return { type: 'ask' };
  if (/(唉|哎|难受|没意思|不想说|没事|挺好|算了)/.test(t) && t.length <= 12) return { type: 'mood' };
  return { type: 'tell' };
}

export function mood(text = '') {
  const t = clean(text);
  let score = 0;
  const hits = [];
  for (const w of NEG) {
    if (t.includes(w)) {
      score += w === '没事' ? 0.6 : 1;
      hits.push(w);
    }
  }
  const sighs = (t.match(/(唉|哎|嗨|咳)/g) || []).length;
  if (sighs) {
    score += Math.min(sighs, 3) * 0.8;
    hits.push('叹气');
  }
  return { level: score >= 2 ? 'low' : score >= 1 ? 'soft' : 'flat', score: Number(score.toFixed(2)), hits: [...new Set(hits)] };
}

export function mildMood(text = '') {
  const t = clean(text);
  let s = 0;
  for (const w of MILD) if (t.includes(w)) s += 1;
  return s;
}

/* ------------------------------------------------------------------ *
 * 身体不适的识别 —— 安全兜底用
 * ------------------------------------------------------------------
 * 目的很窄：判断老人是不是在说身体不舒服，以及是不是反复说。
 * 只是"要不要提醒他跟儿女说一声 / 去看看医生"的触发条件，
 * 引擎**不做任何医学判断**，也绝不往提示词里塞症状名去让模型猜。
 * ------------------------------------------------------------------ */

const BODY_SIGNS = [
  // 部位 + 症状
  /(头|脑袋|后脑勺)[^，。！？]{0,4}(疼|痛|晕|昏|涨|沉|蒙)/,
  /(腰|背|肩|脖子|颈椎|腿|膝盖|脚|胳膊|手指|关节)[^，。！？]{0,4}(疼|痛|酸|麻|肿|僵|使不上劲|没劲)/,
  /(肚子|胃|肠子)[^，。！？]{0,4}(疼|痛|胀|难受|不舒服|翻腾)/,
  /(胸|心口|心脏)[^，。！？]{0,4}(闷|慌|疼|痛|堵|跳得厉害)/,
  /(眼睛|耳朵|牙|嗓子|鼻子)[^，。！？]{0,4}(疼|痛|花|看不清|聋|听不见|肿|痒|干|难受)/,
  /(血压|血糖|血脂)[^，。！？]{0,4}(高|低|不稳|上来|下去|不好)/,
  // 独立症状
  /(咳嗽|发烧|发热|低烧|打摆子|发冷)/,
  /(恶心|想吐|吐了|拉肚子|腹泻|便秘|拉不出)/,
  /(睡不着|失眠|睡不好|夜里老醒|一宿没睡)/,
  /(喘不上|喘不过|气短|呼吸困难|上不来气|憋得慌)/,
  /(没力气|没劲儿|没劲|浑身发虚|乏力|吃不下饭|没胃口|不想吃饭)/,
  /(浑身|全身|整个人)[^，。！？]{0,4}(难受|不舒服|不得劲|没劲|发软)/,
];

// 说明这事不小
const SEVERE = /(厉害|严重|受不了|扛不住|好几天|好一阵|一直|老是|总是|几天了|一礼拜|半个月|夜里都|睡不了|起不来|走不动)/;

/**
 * 判断这句话里有没有身体不适。
 * @returns {{hit:boolean, severe:boolean, phrase:string}}
 */
export function healthSigns(text = '') {
  const t = clean(text);
  if (!t) return { hit: false, severe: false, phrase: '' };
  for (const re of BODY_SIGNS) {
    const m = t.match(re);
    if (m) {
      return { hit: true, severe: SEVERE.test(t), phrase: m[0].slice(0, 20) };
    }
  }
  return { hit: false, severe: false, phrase: '' };
}

/* ------------------------------------------------------------------ *
 * 总入口
 * ------------------------------------------------------------------ */

export function analyze(raw = '') {
  const cleaned = clean(raw);
  const persons = findPersons(cleaned);
  const places = findPlaces(cleaned);
  const times = findTimes(cleaned);
  const events = findEvents(cleaned);
  const statement = simplify(cleaned);
  const a = {
    raw,
    cleaned,
    statement,
    persons,
    places,
    times,
    events,
    intent: classify(cleaned),
    mood: mood(cleaned),
  };
  a.keywords = keywords(`${cleaned} ${persons.join(' ')} ${places.join(' ')} ${events.join(' ')}`);
  a.askForms = askForms(statement, a);
  a.grams = grams(`${cleaned} ${persons.join('')} ${places.join('')} ${events.join('')}`);
  return a;
}

export function personKey(name = '') {
  const n = clean(name);
  let m;
  if ((m = n.match(/^[老小]([\u4e00-\u9fa5])$/))) return `surname:${m[1]}`;
  if ((m = n.match(new RegExp(`^([\\u4e00-\\u9fa5])(${TITLE_SUFFIX.join('|')})$`)))) return `surname:${m[1]}`;
  if ((m = n.match(/^([\u4e00-\u9fa5])[\u4e00-\u9fa5]{1,2}$/)) && SURNAMES.includes(m[1])) return `surname:${m[1]}`;
  return `term:${n}`;
}

/* ------------------------------------------------------------------ *
 * 8) 话题类别：老人换着法儿问同一件事时的桥梁
 *
 * 老人不会总用原话问。他讲过"在纺织厂当挡车工"，之后可能问"我以前是干啥工作的"。
 * 这两句字面几乎不重合，纯字面检索答不出来 —— 所以再按"话题类别"对一次。
 * 类别词表是通用说法（工作/居住/上学…），不是编造的记忆内容：
 * 只有老人真的讲过"挡车工"这类词，那条记录才会被打上 work 类别。
 * ------------------------------------------------------------------ */

const KIND_RULES = [
  { kind: 'work', words: ['挡车工', '钳工', '车工', '电工', '焊工', '木工', '瓦工', '会计', '司机', '售货员', '营业员', '教员', '教师', '大夫', '护士', '保管员', '技术员', '进厂', '参加工作', '上班', '下岗', '学徒', '学手艺', '手艺', '种地', '下地', '挣工分', '开机床', '跑长途', '跑运输', '开车', '修机器', '放牛', '喂猪', '当班长', '当队长', '当厂长', '提干', '干活', '活计'] },
  { kind: 'live', words: ['住宿舍', '宿舍', '分房', '搬家', '盖房', '盖房子', '买房', '平房', '瓦房', '筒子楼', '院子里', '堂屋', '屋门口', '住处'] },
  { kind: 'study', words: ['上学', '念书', '读书', '考大学', '考上大学', '上大学', '高考', '上中专', '辍学', '小学', '中学', '大学', '学堂'] },
  { kind: 'army', words: ['当兵', '参军', '入伍', '退伍', '转业', '复员', '兵团', '部队'] },
  { kind: 'marry', words: ['结婚', '出嫁', '娶媳妇', '嫁人', '成家', '定亲', '老伴'] },
  { kind: 'child', words: ['生孩子', '生儿子', '生女儿', '儿子', '女儿', '闺女', '孙子', '孙女', '抱孙子', '外孙'] },
  { kind: 'move', words: ['搬家', '搬到', '调工作', '调动', '返城', '回城'] },
  { kind: 'health', words: ['生病', '住院', '做手术', '看病', '吃药'] },
];

/** 老人这句话在问哪一类事 */
export function queryKinds(text = '') {
  const t = clean(text);
  const out = new Set();
  if (/(干啥|干吗|干嘛|什么活|啥活|工作|上班|职业|营生|活计|工种|干活|手艺)/.test(t)) out.add('work');
  if (/(住哪儿|住哪|住在|住处|宿舍|房子)/.test(t)) out.add('live');
  if (/(念书|上学|读书|学校|文化|学历|学堂)/.test(t)) out.add('study');
  if (/(当兵|参军|部队)/.test(t)) out.add('army');
  if (/(结婚|成家|娶|嫁|老伴)/.test(t)) out.add('marry');
  if (/(孩子|儿子|闺女|女儿|孙子|孙女)/.test(t)) out.add('child');
  if (/(搬家|搬到|调动|返城)/.test(t)) out.add('move');
  if (/(生病|住院|手术|看病)/.test(t)) out.add('health');
  return [...out];
}

/** 这条主句属于哪些类别 —— 词必须真的出现在老人讲过的话里 */
export function sentenceKinds(row = {}) {
  const bag = [
    row.statement, row.time_label,
    ...(row.keywords || []), ...(row.persons || []), ...(row.places || []), ...(row.events || []),
  ].join(' ');
  const out = new Set();
  for (const { kind, words } of KIND_RULES) if (words.some((w) => bag.includes(w))) out.add(kind);
  return out;
}

export { STOP };
