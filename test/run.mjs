/**
 * 岁语 · 自测
 *   node test/run.mjs
 *
 * 就是按你要的四件事来验：
 *   一、像孩子一样细心应答
 *   二、老人说的话被整理简化后存进独立数据库
 *   三、老人再提起相关内容时，搜索主句库作答
 *   四、库里没有的绝不编造
 * 测试跑在项目自己的 data/ 里（开始前先清空），跑完你会看到库里的真实内容。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

// 测试跑在临时目录里，绝不碰 data/ 里的真实数据
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'seyo-test-'));
process.env.SEYO_DATA_DIR = TMP;
/* MySQL 版：测试用独立账号库，别动真实账号的数据。需要先启动 MySQL。 */
process.env.SEYO_MYSQL_ACCOUNT = process.env.SEYO_MYSQL_ACCOUNT || 'seyo_test';

const { resetAll, stats, listSentences, openCandidates, search, DB_FILE, addSentence, updateSentence, addPhoto, saveMed, deleteMed, confirmMed } = await import('../src/store.mjs');
const { medStatus } = await import('../src/meds.mjs');
const { handleTurn, opening, distill, getPersona, setPersona, session } = await import('../src/engine.mjs');
const { analyze, clean, simplify, splitClauses, askForms, bare } = await import('../src/text.mjs');

let pass = 0;
const fails = [];
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fails.push(`${name}${extra ? ` —— ${extra}` : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` —— ${extra}` : ''}`); }
};
const head = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

setPersona({ agent_name: '岁语', self_ref: '小孙子', elder_call: '爷爷', max_chars: 60 });
resetAll({ keepPersona: true });
console.log(`\n数据库：${DB_FILE}`);
console.log(`起始状态：主句库 ${stats().sentences} 条（应当是空的）`);

/* ================================================================
   一、整理简化：口语 → 主句 + 疑问形式
   ================================================================ */
head('一 · 整理简化（口语 → 主句 + 疑问形式）');
{
  const raw = '嗯……那个，我我我年轻时候啊，就在纺织厂当挡车工，一天站八个钟头，你说是不是';
  const c = clean(raw);
  ok(!/嗯|那个|我我我|…/.test(c), `去口癖与重复：${c}`);

  const statement = simplify(c);
  ok(statement.length > 6 && statement.endsWith('。'), `精简为主句：${statement}`);

  const parts = splitClauses('我二十来岁在纺织厂当挡车工，一天站八个钟头，后来调去仓库管料');
  ok(parts.length >= 1 && parts.length <= 3, `长句切分：${parts.length} 段（${parts.join(' ｜ ')}）`);

  const a = analyze('我八三年在厂里分了两间房，在北边那栋红砖楼');
  ok(a.persons.length + a.places.length + a.events.length + a.times.length > 0, '抽出人物/地点/时间/事件');
  ok(a.events.includes('分房'), `句式型事件"分了两间房"→ 分房（${JSON.stringify(a.events)}）`);
  ok(a.places.includes('厂里'), `地点抽取（${JSON.stringify(a.places)}）`);
  ok(a.times.some((t) => t.year === 1983), `时间归一化"八三年"→ 1983 年（${JSON.stringify(a.times)}）`);

  const asks = askForms(a.statement, a);
  ok(asks.length >= 2, `同一件事生成 ${asks.length} 种问法，例如：${asks[0]}`);
}

/* ================================================================
   二、存进独立数据库
   ================================================================ */
head('二 · 老人输入 → 整理简化 → 存进独立数据库');
let firstStatement = '';
{
  const r = await handleTurn({ text: '我二十来岁那年在纺织厂当挡车工，一天站八个钟头', sessionId: 't1' });

  ok(typeof r.reply === 'string' && r.reply.length >= 6, `岁语回应了：${r.reply}`);
  ok(r.stored.created.length >= 1, `整理入库 ${r.stored.created.length} 条主句`);
  ok(r.stats.utterances >= 1, `原话已留档（${r.stats.utterances} 句，一字未改）`);
  ok(r.stats.sentences >= 1, `主句库已有 ${r.stats.sentences} 条`);
  // 核对流程已砍掉：进库就是已记下，回话里不再缀"我记着了…没记错吧？"
  ok(r.stats.confirmed >= 1, `直接就记下了（已记下 ${r.stats.confirmed} 条）`);
  ok(r.stats.pending === 0, '不再有"待确认"这一档');
  ok(!/我记[着下上一条]/.test(r.reply), `回答里不再复述核对：${r.reply}`);

  const one = listSentences().find((s) => s.statement.includes('挡车工'));
  firstStatement = one.statement;
  ok(Boolean(one), `库里能读到这条：${one.statement}`);
  ok(one.keywords.length >= 3, `带了 ${one.keywords.length} 个关键词`);
  ok(one.asks.length >= 2, `带了 ${one.asks.length} 种疑问形式`);
  ok(one.confidence > 0.5, `置信度 ${one.confidence}`);
  ok(one.time_label === '二十岁上下' || one.time_raw === '二十来岁', `时间标签：${one.time_label || one.time_raw}`);

  /* 大模型补时间要靠 updateSentence 写 year。
     原来它只写 time_label —— 只改标签的话时间轴还是按"没有年份"归到"时间未定"，
     补了等于没补。 */
  const back = updateSentence(one.id, { year: 1968, time_label: '1968 年前后' });
  ok(back.year === 1968, `★ 能补年份（updateSentence 写进了 ${back.year}）`);
  ok(back.time_label === '1968 年前后', `★ 标签也一起改了：${back.time_label}`);
  // 再改回去，别影响后面的用例
  updateSentence(one.id, { year: null, time_label: one.time_label });
  ok(listSentences().find((s) => s.id === one.id).year === null, '年份能清回 null');
}

/* ================================================================
   三、老人再提起 → 搜索主句库作答
   ================================================================ */
head('三 · 老人再提起 → 搜索主句库作答');
{
  // 老人顺着往下说（核对流程已经砍掉，这里只是确认不影响后面的检索）
  const c = await handleTurn({ text: '对，是这么回事', sessionId: 't1' });
  ok(c.stats.confirmed >= 1, `已记下 ${c.stats.confirmed} 条`);

  // 换着法儿问同一件事（这才是关键：不能只认原话）
  const questions = [
    '我以前是干啥工作的来着？',
    '我年轻时候在哪儿上班来着？',
    '我那会儿干活累不累来着？',
    '我当挡车工那事儿你还记得吗？',
  ];
  for (const q of questions) {
    const r = await handleTurn({ text: q, sessionId: 't1' });
    const hit = r.recall[0];
    ok(hit && /挡车工/.test(hit.statement), `「${q}」→ 查到：${hit ? hit.statement : '（没查到）'}`);
    ok(r.strategy === 'answer' || r.strategy === 'answer_vague', `  作答策略 ${r.strategy}（相关度 ${hit ? hit.score : '-'}）`);
    ok(/挡车工/.test(r.reply), `  答出来了：${r.reply}`);
  }

  // 记忆挂了照片 → 老人问到这件事时，照片一起"发出来"
  {
    const row = listSentences().find((s) => /挡车工/.test(s.statement));
    if (!row) {
      ok(false, '照片测试需要一个"挡车工"记忆');
    } else {
      addPhoto({ sentenceId: row.id, file: 'test.png', mime: 'image/png' });
      // 用独立会话，别打乱 t1 后面的检索/兜底断言
      const withPhoto = await handleTurn({ text: '我当挡车工那事儿你还记得吗？', sessionId: 't1-photo' });
      ok(withPhoto.photos && withPhoto.photos.length === 1,
        `★ 问到挂了照片的记忆 → 照片一起发出来（${withPhoto.photos ? withPhoto.photos.length : 0} 张）`);
      ok(/^\/api\/photos\//.test((withPhoto.photos?.[0]?.url) || ''),
        `  照片地址可用：${withPhoto.photos?.[0]?.url || '（无）'}`);
      const missPhoto = await handleTurn({ text: '我小时候在哪个小学念书来着？', sessionId: 't1-photo-miss' });
      ok(!missPhoto.photos || missPhoto.photos.length === 0, '  没查到的记忆不会乱发照片');
      // 老人话里没提具体事，只问"有图片吗" —— 也要把照片发出来，而且不许说没有
      const askPhoto = await handleTurn({ text: '有图片吗', sessionId: 't1-photo' });
      ok(askPhoto.photos && askPhoto.photos.length >= 1, `★ 老人问"有图片吗" → 照片发出来（${askPhoto.photos ? askPhoto.photos.length : 0} 张）`);
      ok(!/(啥都没有|没图片|没照片|没有图片|没有照片)/.test(askPhoto.reply), `  不许说"我啥都没有"：${askPhoto.reply}`);
    }
  }

  // 检索的中间结果要能看见
  const a = analyze('我以前是干啥工作的来着？');
  const hits = search('我以前是干啥工作的来着？', a);
  ok(hits.length >= 1 && (hits[0].why.overlap > 0 || hits[0].why.kinds > 0 || hits[0].why.keywords > 0), `检索可解释：${hits[0]?.via}（字面重合 ${hits[0]?.why.overlap}，话题类别 ${hits[0]?.why.kinds}）`);

  // 问一件库里没有的
  const miss = await handleTurn({ text: '我小时候在哪个小学念书来着？', sessionId: 't1' });
  ok(miss.strategy === 'probe', `库里没有 → 老实说并请老人讲（${miss.strategy}）`);
  ok(/没|空白|没听/.test(miss.reply), `  没有编造：${miss.reply}`);
}

/* ================================================================
   四、不重复记、不打扰
   ================================================================ */
head('四 · 换种说法不重复记 · 情绪低落不打扰');
{
  const before = stats().sentences;
  const again = await handleTurn({ text: '我年轻时候在纺织厂当挡车工', sessionId: 't2' });
  ok(again.stored.merged.length >= 1 || again.stored.created.length === 0, '换种说法讲同一件事 → 合并，不重复存');
  ok(stats().sentences === before, `主句库仍是 ${stats().sentences} 条`);

  const low = await handleTurn({ text: '唉，家里就我一个人，没意思', sessionId: 't3' });
  ok(low.mode === 'companion', `情绪低落 → 陪伴模式`);
  ok(!/[？?]/.test(low.reply), `  不提问、不索取回忆：${low.reply}`);
  ok(low.stored.created.length === 0 || low.stored.created.every((x) => x.confidence <= 0.7), '  陪伴模式下不做打扰式采集');

  const stillQuiet = await handleTurn({ text: '不想说这个', sessionId: 't3' });
  ok(stillQuiet.mode === 'companion' && !/[？?]/.test(stillQuiet.reply), `  仍然只陪着：${stillQuiet.reply}`);

  const open = await opening({ sessionId: 'x' });
  ok(typeof open.text === 'string' && open.text.length > 6, `主动开口可用：${open.text}（${open.why}）`);
}

/* ================================================================
   五、老人短回答不许"一直问同一句"（这是实际发生过的循环 bug）
   ================================================================ */
head('五 · 老人短回答（"在北京""1950年"）不许死循环');
{
  resetAll({ keepPersona: true });
  const sid = 'loop';
  await opening({ sessionId: sid });                       // 第一次先自我介绍，再走正常开场
  const first = await opening({ sessionId: sid });          // 会问"您小时候是在哪儿长大的呀？"
  const r1 = await handleTurn({ text: '在北京', sessionId: sid });
  ok(r1.reply.length > 0, `答"在北京"有回应：${r1.reply}`);
  ok(!/哪儿长大/.test(r1.reply), '不再重复问"在哪儿长大"');
  ok(r1.stored.story && /北京/.test(r1.stored.story.statement), `把我问的 + 他答的合成一件事：${r1.stored.story?.statement}`);

  const r2 = await handleTurn({ text: '1950年', sessionId: sid });
  ok(r2.reply.length > 0, `答"1950年"有回应：${r2.reply}`);
  ok(!/哪一年/.test(r2.reply), `不再重复问"哪一年"：${r2.reply}`);

  const r3 = await handleTurn({ text: '在北京', sessionId: sid });
  ok(!/哪一年|在哪儿/.test(r3.reply), `再说"在北京"也不重复：${r3.reply}`);

  const rows = listSentences();
  ok(rows.length === 1, `碎片没有各存一条（现在 ${rows.length} 条）`);
  ok(/北京/.test(rows[0].statement), `这条记录带着地点：${rows[0].statement}`);
  ok(/1950/.test(rows[0].statement) || rows[0].year === 1950, `补充的年份没丢：${rows[0].statement}（year=${rows[0].year}）`);

  // 连续 8 轮，提问不许重复
  const asked = [];
  for (const t of ['嗯', '对', '我小时候住在胡同里', '我们院里有棵大槐树', '记不清了', '后来搬到东边去了', '我老伴叫秀兰', '对']) {
    const r = await handleTurn({ text: t, sessionId: sid });
    const q = (r.reply.match(/[^。！？]*[？]/g) || []).pop();
    if (q) asked.push(q.trim());
  }
  const dup = asked.filter((q, i) => asked.indexOf(q) !== i);
  ok(dup.length === 0, `连续 8 轮没有一个重复的提问（共问了 ${asked.length} 句）`, dup.join(' / '));
}

head('六 · 主动开口不再问"要不要核一下"（核对流程已砍掉）');
{
  // 原来这里有一个 bug：岁语主动问"我这儿有件事想跟您核一下——…"，
  // 老人回"是这样的"，却得到"您说，我听着呢"。
  // 现在整条核对链路都砍了，所以直接守"不要再冒出来"。
  resetAll({ keepPersona: true });
  const a = analyze('我八三年回到北京，在厂里分了两间房');
  addSentence({ ...a, statement: bare(a.statement), confidence: 0.8 }, { status: 'confirmed' });

  const sid = 'no-confirm';
  const o = await opening({ sessionId: sid });
  ok(!/想跟您核一下/.test(o.text), `主动开口不再请老人核对：${o.text}`);
  ok(typeof o.text === 'string' && o.text.length >= 4, `该开口还是照常开口：${o.text}`);

  // 老人顺口应一声，不该得到"您说，我听着呢"这种断裂的回答
  const r = await handleTurn({ text: '是这样的', sessionId: sid });
  ok(typeof r.reply === 'string' && r.reply.length >= 4, `应一声有回应：${r.reply}`);
  ok(!r.confirm, '返回值里没有核对结果了');
  const st = stats();
  ok(st.pending === 0, `库里没有待确认（${st.pending}）`);
}

head('七 · 开场白必须记进对话历史（否则老人一回答就牛头不对马嘴）');
{
  // 这个 bug 的现场：岁语主动开口问了句"您跟秀兰奶奶是在厂里认识的吧"，
  // 老人答"在厂里认识的"，模型却只看到一句孤零零的回答 —— 因为开场白
  // 从来没有进过 sess.history。于是它答得完全接不上。
  resetAll({ keepPersona: true });
  const sid = 'open-hist';
  const o = await opening({ sessionId: sid });
  ok(Boolean(o.text), `开场白生成了：${o.text}`);

  const hist = session(sid).history;
  const last = hist[hist.length - 1];
  ok(last?.role === 'agent' && last.text === o.text,
    `开场白已记进历史（最后一条：${last?.role}／${String(last?.text).slice(0, 24)}）`);

  // 老人顺着答一句，历史里应该能看到"被回答的那个问题"
  const r3 = await handleTurn({ text: '嗯，你来了', sessionId: sid });
  ok(r3.context.recent[0]?.startsWith('岁语：'),
    `模型能看到自己刚说的话：${r3.context.recent[0]}`);
  ok(r3.reply.length > 0, `正常作答：${r3.reply}`);
}

head('八 · 陪伴守望（情绪低落 / 太久没说话 → 主动关心）');
{
  const { due, markSpoken, claimSpoken, releaseSpoken, noteSpokenText, noteOpening, noteActivity, setMood, configure,
    snapshot, clearLog, state, cameraEveryMs } = await import('../src/watch.mjs');

  // 用很短的阈值测，别真等两小时
  // 用很短的阈值测，别真等两小时。
  // sadRepeatMs 给 1 分钟：够短（下面的用例好拨时间），又不为 0
  // （为 0 的话"刚安慰完"也会立刻重说，那是配置的问题不是逻辑的问题）。
  configure({ enabled: true, idleMs: 60_000, minGapMs: 0, sadRepeatMs: 60_000, debounceMs: 0, quietFrom: -1, quietTo: -1, cameraEnabled: false });
  clearLog();
  noteActivity();

  ok(due().speak === false, '刚说过话 → 不主动开口');

  // ① 情绪低落
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  const d1 = due();
  ok(d1.speak === true && d1.reason === 'low_mood', `情绪低落 → 主动安慰（${d1.reason}）`);

  /* ★ 这一条是补的坑：模型很有把握是"生气/烦躁"（消极 89%），
     但 P(难过) 只有 2% —— 老规则只认 P(难过)，于是判成"正常"，
     老人明明情绪不对，它当没看见。现在这种要判"看着不太对劲"，一样去关心。 */
  markSpoken('low_mood');
  setMood({ level: 'uneasy', score: 0.85, note: 'angry 85%', source: 'camera' });
  state.sadEpisode = false;
  state.lastMoodSpokenAt = 0;
  const dU = due();
  ok(dU.speak === true && dU.reason === 'low_mood',
    '★ "看着不太对劲"（生气/烦躁）也要主动关心，不能当成正常');

  markSpoken('low_mood');
  /* 刚安慰完不该**再生成**一句 —— 不会重复调大模型。
     但 due() 仍然返回 speak:true 并带上 replay/id：那是把**同一句**留着
     给还没显示过的页面（多标签页场景），内容一模一样，页面按 id 去重。
     所以这里要区分"重新生成"和"补发"。 */
  const dRep = due();
  ok(dRep.speak === true && dRep.replay === true,
    '刚安慰完不重复生成（只是把刚才那句留着给别的页面看）');
  ok(!!dRep.id, '★ 补发的这句带 id，页面靠它去重');

  // 关键：这是"难过就直接说"，不是"安慰过一次就锁 N 分钟"。
  // 把上次安慰时间拨回 sadRepeatMs 之前，模拟"老人一直闷着"。
  state.lastMoodSpokenAt = Date.now() - 2 * 60 * 1000;   // 2 分钟 > sadRepeatMs(1 分钟)
  const d1c = due();
  ok(d1c.speak === true && d1c.reason === 'low_mood',
    '一直闷着 → 过一阵再说一句（不锁死）');

  // 缓过来之后再难过 → 不用等 10 分钟，马上说
  markSpoken('low_mood');
  // ★ 要连续 3 次"非消极"才算这一波过去。
  //   模型逐帧在抖，只按 1 次判的话，恰好那一帧是 normal 就把难过抹掉了。
  setMood({ level: 'normal', score: 0, note: 'neutral 80%', source: 'camera' });
  ok(snapshot().sadEpisode === true, '★ 只看一帧正常不算缓过来（噪音而已）');
  setMood({ level: 'normal', score: 0, note: 'neutral 82%', source: 'camera' });
  ok(snapshot().sadEpisode === true, '第二帧正常也不够');
  setMood({ level: 'normal', score: 0, note: 'neutral 81%', source: 'camera' });
  ok(snapshot().sadEpisode === false, '★ 连续 3 帧正常 → 这一波才结束');
  setMood({ level: 'low', score: 0.9, note: 'sad 88%', source: 'camera' });
  const d1b = due();
  ok(d1b.speak === true && d1b.reason === 'low_mood', '缓过来之后又难过 → 立刻重新安慰');

  // ② 闲置
  markSpoken('low_mood');
  setMood({ level: 'normal', score: 0, note: '', source: 'camera' });
  const w = snapshot();
  ok(w.silentMinutes >= 0, `能算出闭嘴多久（${w.silentMinutes} 分钟）`);
  ok(w.nextIdleInMinutes >= 0, `能算出还有多久主动搭话（${w.nextIdleInMinutes} 分钟）`);

  // 手动把 lastActivity 拨回过去，模拟"两小时没说话"
  const past = Date.now() - 2 * 60 * 60 * 1000;
  state.lastActivity = past;
  state.lastSpokenAt = 0;
  const d2 = due();
  ok(d2.speak === true && d2.reason === 'idle', `闲置超阈值 → 主动搭话（${d2.reason}）`);
  ok(d2.silentMs >= 2 * 60 * 60 * 1000 - 1000, `闭嘴时长算得对（${Math.round(d2.silentMs / 60000)} 分钟）`);

  markSpoken('idle');
  const dIdleRep = due();
  ok(dIdleRep.speak === true ? dIdleRep.replay === true : true,
    '开口之后不连着再问（要再给也只是补发同一句）');

  // ③ 夜间不打扰
  configure({ minGapMs: 0, debounceMs: 0, quietFrom: 0, quietTo: 24 });   // 全天静默
  state.lastActivity = past; state.lastSpokenAt = 0;
  const d3 = due();
  ok(d3.speak === false && d3.reason === '夜间不打扰', `夜间不打扰（${d3.reason}）`);

  // ④ 低落时**不受**"闲置搭话的最小间隔"限制
  //    这是个真出现过的 bug：minGap 排在情绪判断前面，
  //    结果刚说完话就算看出低落也安慰不了。
  configure({ quietFrom: -1, quietTo: -1, minGapMs: 60 * 60 * 1000, sadRepeatMs: 0, debounceMs: 0 });
  state.lastSpokenAt = Date.now() - 1000;      // 一秒前刚说过话
  state.sadEpisode = false;
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  const d4 = due();
  ok(d4.speak === true && d4.reason === 'low_mood', '刚说完话也能安慰（不再被"搭话间隔"挡住）');

  // ⑤ 查得出是哪一条闸门拦下的（界面上要显示，不然只能猜）
  const tr = d1.trace;
  ok(Array.isArray(tr) && tr.length > 0, `每次判断都带闸门明细（${tr.length} 条）`);
  ok(tr.every((g) => typeof g.gate === 'string' && typeof g.pass === 'boolean' && g.detail),
    '闸门明细里有名称 / 通过与否 / 原因');

  /* ⑥ 看脸的间隔要自适应。
        原来写死 2 分钟，两个毛病：他刚皱眉要等快 2 分钟才发现；
        **更要命的是恢复也慢** —— "他缓过来了"是靠看到非消极读数判断的。
        现在：平常一档，情绪不对时自动提速。 */
  configure({ cameraIntervalMs: 15000, cameraFastMs: 5000 });
  setMood({ level: 'normal', score: 0, note: 'neutral 90%', source: 'camera' });
  ok(cameraEveryMs() === 15000, `平常每 ${cameraEveryMs() / 1000} 秒看一眼`);
  setMood({ level: 'uneasy', score: 0.85, note: 'angry 85%', source: 'camera' });
  ok(cameraEveryMs() === 5000, `★ 情绪不对自动提速到每 ${cameraEveryMs() / 1000} 秒`);
  setMood({ level: 'low', score: 0.8, note: 'sad 80%', source: 'camera' });
  ok(cameraEveryMs() === 5000, '难过时也是快的');
  setMood({ level: 'happy', score: 0.9, note: 'happy 90%', source: 'camera' });
  ok(cameraEveryMs() === 15000, '★ 缓过来之后自动恢复，不用手动切回来');

  /* ⑦ 第一次发现情绪不对 → **马上说**，不管上一句是什么时候说的。
        原来防抖排在情绪判断前面、写死 15 秒：岁语刚回答完老人一句话，
        摄像头紧接着就看出他脸色不对，却还得干等 15 秒。
        那恰恰是最该立刻开口的时候。 */
  configure({ debounceMs: 60 * 1000, firstMoodDebounceMs: 0, sadRepeatMs: 0,
              minGapMs: 0, quietFrom: -1, quietTo: -1, enabled: true });
  state.sadEpisode = false;
  state.lastMoodSpokenAt = 0;
  state.lastSpokenAt = Date.now() - 1000;          // 一秒前刚说过话
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  const d5 = due();
  ok(d5.speak === true && d5.reason === 'low_mood',
    '★ 第一次发现难过 → 就算一秒前刚说过，也马上说');
  ok(d5.trace.some((g) => g.gate === '防抖' && g.detail.includes('第一次发现情绪不对')),
    `闸门里写明了"第一次发现情绪不对 → 不等"`);

  // "不太对劲"第一次发现也一样
  state.sadEpisode = false;
  state.lastMoodSpokenAt = 0;
  state.lastSpokenAt = Date.now() - 1000;
  setMood({ level: 'uneasy', score: 0.85, note: 'angry 85%', source: 'camera' });
  ok(due().speak === true, '★ 第一次发现"不太对劲"同样不等');

  // 但同一波不重复说 —— 靠 sadEpisode 拦，不是靠防抖
  markSpoken('low_mood');
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  ok(due().speak === false, '安慰过之后，同一波仍然不重复');

  // 闲置搭话照旧守 15 秒防抖（只有"第一次情绪不对"才免等）
  configure({ debounceMs: 60 * 1000, firstMoodDebounceMs: 0, minGapMs: 0, sadRepeatMs: 0 });
  state.sadEpisode = false;
  // 连着喂 3 帧正常，确保上一波的消极状态真的清干净了
  for (let i = 0; i < 3; i++) setMood({ level: 'normal', score: 0, note: 'neutral 90%', source: 'camera' });
  state.lastSpokenAt = Date.now() - 1000;
  state.lastActivity = Date.now() - 10 * 60 * 1000;   // 十分钟没说话
  const d6 = due();
  ok(d6.speak === false && d6.reason === '刚说过',
    '情绪正常时，闲置搭话仍然守防抖（没被这次改动带跑）');

  /* ⑧ 并发保护：生成回话要一两秒，期间又轮询进来一次不该说两遍。
        现在改成"先占位、再生成，失败再还回去"。 */
  state.sadEpisode = false;
  state.lastMoodSpokenAt = 0;
  state.lastSpokenAt = 0;
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  const d7 = due();
  ok(d7.speak === true, '该开口');
  const snap = claimSpoken('low_mood');
  ok(state.sadEpisode === true, '★ claim 之后立刻标记成"这一波安慰过了"');
  ok(due().speak === false, '★ 并发的第二个请求进不来了（不会说两遍）');
  releaseSpoken(snap);
  ok(state.sadEpisode === false, '★ 生成失败 → 把机会还回去');
  ok(due().speak === true, '还回去之后下次还能开口');

  /* ⑨ 开口史要记得住 —— 界面靠它显示"上次主动开口是什么时候"。
        没有这个，页面上一句"该开口"却听不到声音时，分不清是
        没触发、触发了没显示、还是浏览器把页面冻住了。 */
  const before = snapshot().spokeCount;
  markSpoken('low_mood');
  noteSpokenText('爷爷，我陪您坐会儿');
  const snap2 = snapshot();
  ok(snap2.spokeCount === before + 1, `主动开口计数 +1（${before} → ${snap2.spokeCount}）`);
  const lastSpoke = snap2.spokeLog[snap2.spokeLog.length - 1];
  ok(lastSpoke && lastSpoke.reason === 'low_mood', '开口史里记了原因');
  ok(lastSpoke && lastSpoke.text === '爷爷，我陪您坐会儿', '★ 开口史里记了原话');

  // 占位了但生成失败 → 那条记录要撤掉，不能留个空壳
  const cnt0 = snapshot().spokeCount;
  const snap3 = claimSpoken('idle');
  ok(snapshot().spokeCount === cnt0 + 1, 'claim 时先占一条');
  releaseSpoken(snap3);
  ok(snapshot().spokeCount === cnt0, '★ 生成失败 → 那条记录也撤掉了');

  /* ⑩ "看着不太对劲"不能被自己清掉。
        原来写的是 `if (lv !== 'low') sadEpisode = false`，
        于是一个 uneasy 读数会把 sadEpisode 清掉，下一帧又成了"新的一波"，
        每 15 秒安慰一次，变成唠叨。 */
  markSpoken('low_mood');
  ok(state.sadEpisode === true, '安慰过"不太对劲"之后，这一波标记为已完成');
  setMood({ level: 'uneasy', score: 0.85, note: 'angry 85%', source: 'camera' });
  ok(state.sadEpisode === true, '★ 又一个 uneasy 读数不会把它清掉（否则会反复唠叨）');
  setMood({ level: 'normal', score: 0.2, note: 'neutral 80%', source: 'camera' });
  setMood({ level: 'normal', score: 0.2, note: 'neutral 80%', source: 'camera' });
  setMood({ level: 'normal', score: 0.2, note: 'neutral 80%', source: 'camera' });
  ok(state.sadEpisode === false, '看到他缓过来了，这一波才结束');

  // ⑪ 关掉整个功能
  configure({ quietFrom: -1, quietTo: -1, enabled: false });
  ok(due().speak === false, '关掉之后完全不主动开口');

  /* ⑫ 安静模式（页面上那个「🤝 只想有人陪」）—— 一句主动的话都不说。
        原来这个按钮只改了表情和气泡样式，守望照样会主动开口，等于没生效。
        它压过**所有**触发：看出情绪不好也不说，俩钟头没动静也不说。
        老人想说话时自己按话筒/打字，那时候照常回（这条只管"主动开口"）。 */
  configure({ enabled: true, companion: false, quietFrom: -1, quietTo: -1,
              debounceMs: 0, firstMoodDebounceMs: 0, minGapMs: 0, sadRepeatMs: 0, idleMs: 1 });
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  state.sadEpisode = false;
  state.lastSpokenAt = 0;
  state.lastActivity = Date.now() - 60 * 60 * 1000;
  ok(due().speak === true, '安静模式没开时，难过照样会主动关心');

  markSpoken('low_mood');
  configure({ companion: true });
  state.sadEpisode = false;
  state.lastSpokenAt = 0;
  state.lastActivity = Date.now() - 60 * 60 * 1000;   // 又难过又很久没说话
  const dQ = due();
  ok(dQ.speak === false && dQ.reason.includes('安静模式'),
    `★ 安静模式下，难过也不主动开口（${dQ.reason}）`);
  ok(dQ.trace.some((g) => g.gate === '安静模式' && g.pass === false),
    '闸门里写明了是安静模式拦下的');

  configure({ companion: false });
  ok(due().speak === true, '★ 关掉安静模式 → 马上恢复（不用刷新页面）');

  /* ⑬ 「看脸」和「说话」是两个节奏，必须分得开。
        原来 debounceMs（说话的节奏）和 cameraIntervalMs（看脸的节奏）**都是 15 秒**，
        摆在一起会让人以为"每 15 秒就可能说一句"，其实说话还要过其它闸门。
        现在说话最快要 5 分钟，看脸还是 15 秒 —— 这两个数不该再撞上。 */
  configure({ debounceMs: 5 * 60 * 1000, cameraIntervalMs: 15 * 1000, cameraFastMs: 5 * 1000 });
  const cf = snapshot().config;
  ok(cf.debounceMs === 300000, `主动开口最快每 ${cf.debounceMs / 60000} 分钟一次`);
  ok(cf.cameraIntervalMs === 15000, `看脸每 ${cf.cameraIntervalMs / 1000} 秒一次`);
  ok(cf.debounceMs !== cf.cameraIntervalMs, '★ 这两个数不一样了（以前都是 15 秒，容易看混）');
  ok(cf.debounceMs > cf.cameraIntervalMs, '★ 说话比看脸慢得多（看脸不打扰人）');

  /* ⑭ 打开页面时那句开场白，要算"我刚说过话"。
        不记的话会怎样 —— 真实踩到：
          页面一打开，开场问候刚冒出来，1.5 秒后守望判定"已经很久没人说话"，
          又主动搭一句，老人一次看到两条。
        开场白本身就已经是"我来了"。 */
  configure({ enabled: true, companion: false, quietFrom: -1, quietTo: -1,
              idleMs: 5 * 60 * 1000, minGapMs: 10 * 60 * 1000,
              debounceMs: 5 * 60 * 1000, firstMoodDebounceMs: 0, sadRepeatMs: 10 * 60 * 1000 });
  // 先喂 3 帧正常，把情绪清干净，只留"闲置"这一个条件
  for (let i = 0; i < 3; i++) setMood({ level: 'normal', score: 0, note: 'neutral', source: 'camera' });
  state.lastActivity = Date.now() - 60 * 60 * 1000;   // 一个钟头没人说话
  state.lastSpokenAt = 0;
  const dBoot = due();
  ok(dBoot.speak === true && dBoot.reason === 'idle', '很久没人说话 → 该主动搭话');

  noteOpening();          // ← 页面打开，岁语说了句开场白
  const dAfter = due();
  ok(dAfter.speak === false, '★ 开场白说过之后，不会紧接着再搭一句（一次只看到一条）');

  // "刚有过交流"就该重新算闲置计时，否则老人得再干等一整轮
  ok(snapshot().silentMinutes === 0, '★ 开场白也算有过交流，闲置计时重新开始');

  // 情绪那条：开场也算应付过这一波，但一直闷着的话过 sadRepeatMs 还会正式安慰
  setMood({ level: 'low', score: 0.9, note: 'sad 90%', source: 'camera' });
  noteOpening();
  ok(snapshot().sadEpisode === true, '开场白也算把这一波情绪应付过去了');
  // 模拟"又过了 11 分钟" —— 三个时间戳都得往前拨。
  // 只拨一个的话会被 5 分钟防抖拦住（那是另一道闸门，不是这里要验的）
  const elevenMinAgo = Date.now() - 11 * 60 * 1000;
  state.lastSpokenAt = elevenMinAgo;
  state.lastMoodSpokenAt = elevenMinAgo;
  state.lastActivity = elevenMinAgo;
  const dRepeat = due();
  ok(dRepeat.speak === true && dRepeat.reason === 'low_mood',
    '★ 他要是一直闷着，过 10 分钟还是会正经安慰一句（不会彻底哑掉）');


  // 还原默认，别影响别的用例
  configure({
    enabled: true, idleMs: 2 * 60 * 60 * 1000, minGapMs: 10 * 60 * 1000,
    sadRepeatMs: 10 * 60 * 1000, debounceMs: 5 * 60 * 1000, firstMoodDebounceMs: 0,
    quietFrom: 22, quietTo: 7,
  });
  clearLog();
  noteActivity();
}

head('九 · 安全兜底：老人说身体不舒服时要能认出来');
{
  // 这一条是"要不要提醒他跟儿女说一声"的触发条件。
  // 引擎本身不做医学判断，只负责认出"他在说身体不舒服"。
  const { healthSigns } = await import('../src/text.mjs');

  const should = [
    ['这两天腰疼得厉害', true],
    ['睡不着觉', true],
    ['胸口有点闷', true],
    ['我这两天有点咳嗽', true],
    ['头有点晕', true],
    ['血压又高了', true],
    ['吃不下饭', true],
    ['浑身不得劲', true],
    ['膝盖疼，走道都费劲', true],
  ];
  for (const [t, want] of should) {
    ok(healthSigns(t).hit === want, `认得出「${t}」`);
  }

  const shouldNot = [
    ['我今天挺高兴的', '情绪词不是身体症状'],
    ['想起以前在厂里的事了', '回忆'],
    ['我觉得没意思', '情绪低落 ≠ 身体不适'],
    ['你吃饭了吗', '寒暄'],
    ['我老伴叫秀兰', '人物'],
  ];
  for (const [t, why] of shouldNot) {
    ok(!healthSigns(t).hit, `不误判「${t}」（${why}）`);
  }

  ok(healthSigns('腰疼得厉害，好几天了').severe, '"厉害/好几天"算严重');
  ok(!healthSigns('腰有点酸').severe, '随口一句不算严重');

  // 会话里要能累计起来（提醒的触发条件是"反复提"）
  resetAll({ keepPersona: true });
  const sid = 'health-1';
  await handleTurn({ text: '这两天后腰有点疼', sessionId: sid });
  const s1 = session(sid);
  ok(s1.healthLog.length === 1, `第一次提记下了（${s1.healthLog.length} 条）`);
  ok(!s1.lastHealthNudge, '只提一次不提醒（避免唠叨）');

  await handleTurn({ text: '今天膝盖也疼', sessionId: sid });
  ok(session(sid).healthLog.length === 2, `第二次提也记下了（${session(sid).healthLog.length} 条）`);
  ok(session(sid).lastHealthNudge > 0, '反复提之后标记为"该提醒了"');
}

head('十 · 整理入库 → 直接存档（不再请老人核对）');
{
  // 这一节盯的是最核心的一条链：
  //   老人说一件事 → 整理简化 → **直接进库**，不再回头问"我没记错吧？"
  //
  // 之前这里是一整套"复述核对、老人点头才转正"，坏在几处：
  //   ① 接上大模型后整段跳过，一次都不问
  //   ② 只在"新建句子"时才问，补充细节时一次都不问 → 库里堆了 6 条没人核实
  //   ③ 老人从没点头，记忆却被标成"已确认"（implicit 分支直接转正）
  // 现在整条砍掉，所以下面这些用例是在守"不要再冒出来"。
  const LEAD = /我记[着下上一条]/;
  const TAG = /(没记错吧|是这么回事吧|我没听岔吧|没记岔吧)/;

  resetAll({ keepPersona: true });
  const sid = 'save-1';

  const r1 = await handleTurn({ text: '我小时候住在城西的剪子巷，门口有棵老槐树', sessionId: sid });
  ok(typeof r1.reply === 'string' && r1.reply.length >= 6, `岁语回应了：${r1.reply}`);
  ok(!LEAD.test(r1.reply) && !TAG.test(r1.reply), '★ 不再冒出一句"我记着了…没记错吧？"');
  ok(r1.stored.created.length + r1.stored.merged.length > 0,
    `事情真的进了库（新建 ${r1.stored.created.length} / 并入 ${r1.stored.merged.length}）`);
  ok(listSentences().every((s) => s.status === 'confirmed'),
    '★ 进库就是已记下，不再有"待确认"这一档');
  ok(!r1.confirm, '返回值里不再有核对结果');
  ok(openCandidates(10).length === 0, '不再产生"待核对"队列');
  ok(r1.stats.pending === 0, `统计里的待确认是 0（${r1.stats.pending}）`);

  // 关键：这几句以前会被整句扔掉（实体词表里没有"娘""爹"）
  const r2 = await handleTurn({ text: '我娘在家给人缝衣裳，一天挣两毛钱', sessionId: sid });
  ok(listSentences().some((s) => s.statement.includes('缝衣裳')),
    '★ "娘"这件事进了库（单字亲属要认得出来）');
  ok(!LEAD.test(r2.reply) && !TAG.test(r2.reply), '照样不核对');

  await handleTurn({ text: '我爹是拉洋车的，天不亮就出门', sessionId: sid });
  ok(listSentences().some((s) => s.statement.includes('拉洋车')),
    '★ "爹"这件事也进了库');

  await handleTurn({ text: '我在国棉三厂当挡车工', sessionId: sid });
  ok(listSentences().some((s) => s.statement.includes('挡车工')),
    '★ 厂名不在实体词表里，也能靠"第一人称完整叙述"兜住');

  // 补充细节：并进已经记着的那件事，不另起一条碎句
  const beforeCount = listSentences().length;
  const r5 = await handleTurn({ text: '就在剪子巷口，一帮孩子', sessionId: sid });
  ok(listSentences().length >= beforeCount, '补细节不会把已有记忆弄丢');
  ok(!LEAD.test(r5.reply) && !TAG.test(r5.reply), '补细节也不核对');

  const st = stats();
  ok(st.sentences >= 4, `库里攒下了 ${st.sentences} 条`);
  ok(st.confirmed === st.sentences, `全部都是"已记下"（${st.confirmed}/${st.sentences}）`);
  ok(st.pending === 0, '一条待确认都没有');
}

/* ================================================================
   吃药提醒：设定时间 → 快到点提醒 → 确认后停
   ================================================================ */
head('吃药提醒：设定时间 → 快到点提醒 → 确认后停');
{
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const nearMidnight = (now.getHours() === 23 && now.getMinutes() >= 55) || (now.getHours() === 0 && now.getMinutes() < 5);
  const dueAt = new Date(now.getTime() - 2 * 60000);
  const soonAt = new Date(now.getTime() + 3 * 60000);

  if (nearMidnight) {
    ok(true, '（正好在零点附近，跳过"到点/快到点"的状态断言）');
  } else {
    const saved = saveMed({ name: '降压药', dose: '1 片', times: [hhmm(dueAt), hhmm(soonAt)], note: '饭后吃' });
    ok(saved.ok && saved.med && saved.med.times.length === 2, '★ 能设定"每天几点吃什么药"（药名 / 剂量 / 多个时间点）');
    const s1 = medStatus();
    const dueItem = s1.items.find((i) => i.time === hhmm(dueAt));
    const soonItem = s1.items.find((i) => i.time === hhmm(soonAt));
    ok(dueItem && dueItem.state === 'due' && dueItem.minutes >= 1, `★ 过了点的这顿算"该吃了"（晚了 ${dueItem ? dueItem.minutes : '-'} 分钟）`);
    ok(soonItem && soonItem.state === 'soon', '★ 10 分钟内的下一顿算"快到时间了"');
    ok(s1.next && s1.next.medId === saved.med.id, `  下一顿排出来了（${s1.next ? s1.next.time + ' ' + s1.next.name : '无'}）`);

    // 老人确认吃过那一顿 → 这顿不再算"该吃"，另一顿照旧
    const done = confirmMed(saved.med.id, dueItem.slot);
    ok(done && done.slot === dueItem.slot, '★ 老人确认"这顿吃过了"能记住');
    const s2 = medStatus();
    ok(s2.items.find((i) => i.slot === dueItem.slot).state === 'done', '★ 确认过的那顿不再提醒');
    ok(s2.items.find((i) => i.slot === soonItem.slot).state === 'soon', '  别的顿数照常提醒');

    // 时间写错不入库
    const bad = saveMed({ name: '时间写错的药', times: ['25:99'] });
    ok(!bad.ok, '时间格式不对（25:99）不会被收下');

    deleteMed(saved.med.id);
    ok(!medStatus().meds.some((m) => m.id === saved.med.id), '能删掉这个药的提醒');
  }
}

/* ================================================================
   记事本：说"5 分钟后提醒我关火" → 记下 → 到点 → 确认
   ================================================================ */
head('记事本：说"5 分钟后提醒我关火" → 记下 → 到点 → 确认');
{
  const { parseReminder } = await import('../src/text.mjs');
  const { addReminder, listReminders, dueReminders, doneReminder, deleteReminder } = await import('../src/store.mjs');
  const { handleTurn } = await import('../src/engine.mjs');

  const cases = [
    ['5分钟后提醒我关火', 5, '关火'],
    ['五分钟后提醒我关火', 5, '关火'],
    ['半个小时后提醒我关火', 30, '关火'],
    ['一个小时后提醒我吃药', 60, '吃药'],
    ['过10分钟提醒我喝水', 10, '喝水'],
    ['提醒我5分钟后关火', 5, '关火'],
    ['一刻钟后提醒我关火', 15, '关火'],
  ];
  for (const [text, min, what] of cases) {
    const r = parseReminder(text);
    ok(r && Math.abs(Math.round(r.delayMs / 60000) - min) <= 1 && r.text === what,
      `「${text}」→ ${min} 分钟后提醒「${what}」`);
  }
  const abs = parseReminder('明天早上8点提醒我关火');
  ok(abs && abs.kind === 'absolute' && abs.text === '关火' && abs.dueAt > Date.now(), '★ 也能认「明天早上 8 点提醒我关火」');
  ok(parseReminder('今天天气不错') === null, '普通聊天不会被当成提醒');
  ok(parseReminder('我记得5分钟后要关火') === null, '「我记得…」是回忆，不会误记成提醒');

  // 入库 / 到点 / 确认 / 删除
  const dueItem = addReminder({ text: '关火', dueAt: Date.now() - 1000 });
  ok(dueItem && dueItem.text === '关火', '★ 提醒能存进库');
  ok(dueReminders().some((x) => x.id === dueItem.id), '★ 到点后能查出来');
  const done = doneReminder(dueItem.id);
  ok(done && done.doneAt, '点「知道了」→ 标记完成');
  ok(!dueReminders().some((x) => x.id === dueItem.id), '★ 确认过的提醒不再弹');

  const later = addReminder({ text: '喝水', dueAt: Date.now() + 10 * 60000 });
  ok(listReminders().some((x) => x.id === later.id && x.text === '喝水'), '记事本列出还没到点的提醒');
  ok(deleteReminder(later.id), '能从记事本里删掉');

  // 对话里直接说 → 引擎拦下来，不整理成往事
  const r = await handleTurn({ text: '5分钟后提醒我关火', sessionId: 'rem-test' });
  ok(r.strategy === 'reminder' && r.reply.includes('关火') && r.reply.includes('5 分钟后'),
    `★ 对话里说就会记下并回复：「${r.reply}」`);
  ok(r.reminder && r.reminder.dueAt > Date.now() + 4 * 60000, '提醒时间对得上');
  ok(r.stored.created.length === 0, '★ 提醒不是往事，不进记忆库');
  for (const x of listReminders()) deleteReminder(x.id);
  ok(listReminders().length === 0, '清理测试提醒');
}

/* ================================================================
   约 10% 的轮次：引导老人讲以前的事
   ================================================================ */
head('约 10% 的轮次引导老人讲以前的事');
{
  const { shouldInviteMemory, pickInviteTopic, INVITE_TOPICS } = await import('../src/engine.mjs');
  const { buildMessages } = await import('../src/prompts.mjs');

  ok(shouldInviteMemory({ rng: () => 0.05 }) === true, '★ 掷进 10% → 这一轮会引导旧事');
  ok(shouldInviteMemory({ rng: () => 0.5 }) === false, '10% 以外 → 不引导');
  ok(shouldInviteMemory({ companion: true, rng: () => 0.01 }) === false, '陪伴模式不引导（只陪着）');
  ok(shouldInviteMemory({ request: true, rng: () => 0.01 }) === false, '请求句不引导（先办事）');
  ok(shouldInviteMemory({ correction: { x: 1 }, rng: () => 0.01 }) === false, '改口时不引导');
  ok(shouldInviteMemory({ fragment: true, rng: () => 0.01 }) === false, '补充细节时不引导');
  ok(shouldInviteMemory({ healthHint: '说不舒服', rng: () => 0.01 }) === false, '身体不舒服不引导');
  ok(shouldInviteMemory({ mood: 'low', rng: () => 0.01 }) === false, '情绪低落不引导');

  // 引的是"新往事"的方向（小时候 / 上学 / 年轻时 / 成家…），不是库里的原话
  ok(INVITE_TOPICS.length >= 8, `方向池够用（${INVITE_TOPICS.length} 个）`);
  ok(INVITE_TOPICS.some((t) => /小时候/.test(t.ask)), '★ 有"小时候有什么好玩的"这种开放方向');
  const rows = [
    { statement: '我年轻时候在国棉三厂当挡车工', time_label: '青年时期' },
    { statement: '我小时候住在城西的剪子巷', time_label: '童年' },
  ];
  const sess = { history: [], recentInvites: [] };
  const picked = [pickInviteTopic(rows, sess), pickInviteTopic(rows, sess), pickInviteTopic(rows, sess)];
  ok(picked.every((t) => t && t.ask && t.key), '能挑出一个方向当话头');
  ok(new Set(picked.map((t) => t.key)).size === 3, `★ 方向不连着重复（${picked.map((t) => t.key).join(' / ')}）`);

  // 已经讲得很多的方向，不优先再问
  const heavy = [
    { statement: '我小时候在胡同里玩，上小学那会儿老师……', time_label: '童年' },
    { statement: '我小时候盼着过年', time_label: '童年' },
  ];
  ok(pickInviteTopic(heavy, { recentInvites: [] }).key !== 'child', '★ 已讲得多的方向排在后面');

  const withInvite = buildMessages({
    persona: getPersona(), confirmed: rows, text: '今天天气不错',
    inviteTopic: '小时候有什么好玩的、最盼着干什么（玩什么、跟谁玩）',
  }).map((m) => m.content).join('\n');
  ok(withInvite.includes('顺带引他讲讲以前的事') && withInvite.includes('小时候有什么好玩的'),
    '★ 提示词里带上引导方向');
  ok(withInvite.includes('不是让你复述记忆清单'), '★ 明确"不是复述以前说过的话"');
  const noInvite = buildMessages({ persona: getPersona(), confirmed: rows, text: '今天天气不错' })
    .map((m) => m.content).join('\n');
  ok(!noInvite.includes('顺带引他讲讲以前的事'), '没掷中的轮次，提示词里没有这段');
}

/* ================================================================
   收尾：把库里实际存了什么打出来
   ================================================================ */
head('库里现在存了什么（这就是你要的"独立数据库"里的内容）');
{
  const rows = listSentences();
  for (const s of rows) {
    console.log(`  #${s.seq} [${s.status === 'confirmed' ? '已确认' : '待确认'}] ${s.statement}`);
    console.log(`      老人可能会问：${s.asks.slice(0, 2).join(' ／ ')}`);
    console.log(`      人物 ${JSON.stringify(s.persons)} 地点 ${JSON.stringify(s.places)} 事件 ${JSON.stringify(s.events)} 时间 ${s.time_label || '—'} 置信 ${s.confidence}`);
  }
  const st = stats();
  console.log(`\n  统计：主句库 ${st.sentences} 条（已确认 ${st.confirmed} / 待确认 ${st.pending}）· 人物 ${st.persons} · 地点 ${st.places} · 原话 ${st.utterances} 句 · 索引词条 ${st.indexed}`);
  console.log(`  数据库文件：${st.dbFile}`);
  const dump = (await import('../src/store.mjs')).dumpIndex();
  console.log(`  可读快照：${dump.file}`);
}

/* ================================================================
   重置：记忆 / 照片 / 吃药记录一起清
   ================================================================ */
head('重置：记忆 / 照片 / 吃药记录一起清');
{
  const { recentPhotos, addReminder: addRem, listReminders: listRems } = await import('../src/store.mjs');
  const rows = listSentences();
  if (rows[0]) addPhoto({ sentenceId: rows[0].id, file: 'reset-test.png', mime: 'image/png' });
  saveMed({ name: '重置测试药', dose: '1 片', times: ['08:00'] });
  addRem({ text: '重置测试提醒', dueAt: Date.now() + 600000 });
  ok(recentPhotos(10).length > 0, '重置前照片记录在库里');
  ok(medStatus().meds.length > 0, '重置前吃药安排在库里');
  ok(listRems().length > 0, '重置前记事本提醒在库里');

  resetAll({ keepPersona: true });
  ok(stats().sentences === 0, '重置把记忆清空');
  ok(recentPhotos(10).length === 0, '★ 照片记录也一起清掉');
  ok(medStatus().meds.length === 0, '★ 吃药安排/记录也一起清掉');
  ok(listRems().length === 0, '★ 记事本提醒也一起清掉');
}

console.log('\n' + '─'.repeat(58));
if (fails.length) {
  console.log(`\x1b[31m失败 ${fails.length} 项\x1b[0m / 通过 ${pass} 项`);
  fails.forEach((f) => console.log(`  - ${f}`));
} else {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
}
console.log('─'.repeat(58));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exitCode = fails.length ? 1 : 0;