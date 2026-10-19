/**
 * 家人端预览数据
 *
 * 只在主句库为空时使用，**不写数据库**，纯内存返回，
 * 让家人在老人还没开始讲之前能看到界面长什么样。
 * 一旦库里有了真实记忆，这个接口就自动失效。
 */
export const PREVIEW = {
  preview: true,
  timeline: [
    {
      label: '1953—1960 年（童年）',
      items: [{ seq: 1, statement: '我小时候在城西的胡同里长大，院子里有棵老槐树', status: 'confirmed' }],
    },
    {
      label: '1966—1973 年（青年）',
      items: [
        { seq: 2, statement: '我年轻时候在纺织厂当挡车工，一天站八个钟头', status: 'confirmed' },
        { seq: 3, statement: '我跟张师傅学手艺，学了整三年', status: 'confirmed' },
      ],
    },
    {
      label: '1969 年',
      items: [{ seq: 4, statement: '我老伴叫秀兰，是六九年结的婚', status: 'confirmed' }],
    },
    {
      label: '1983 年',
      items: [{ seq: 5, statement: '我八三年在厂里分了两间房，在北边那栋红砖楼', status: 'confirmed' }],
    },
    {
      label: '时间未定',
      items: [{ seq: 6, statement: '我老伴走了三年了，我一个人在家', status: 'pending' }],
    },
  ],
  dimensions: {
    person: {
      label: '人物',
      items: [
        { id: 'p1', name: '张师傅', aliases: ['老张', '张师傅'], memories: 2, note: '工友/师父' },
        { id: 'p2', name: '老伴', aliases: ['秀兰', '老伴'], memories: 2, note: '妻子' },
      ],
    },
    time: {
      label: '时间',
      items: [
        { id: 't1', raw: '小时候', label: '1953—1960 年（童年）', memories: 1 },
        { id: 't2', raw: '年轻时候', label: '1966—1973 年（青年）', memories: 2 },
        { id: 't3', raw: '六九年', label: '1969 年', memories: 1 },
        { id: 't4', raw: '八三年', label: '1983 年', memories: 1 },
      ],
    },
    place: {
      label: '地点',
      items: [
        { id: 'l1', name: '纺织厂', memories: 2 },
        { id: 'l2', name: '城西的胡同', memories: 1 },
        { id: 'l3', name: '北边那栋红砖楼', memories: 1 },
      ],
    },
    event: {
      label: '事件',
      items: [
        { id: 'e1', name: '当挡车工', memories: 1 },
        { id: 'e2', name: '学手艺', memories: 1 },
        { id: 'e3', name: '结婚', memories: 1 },
        { id: 'e4', name: '分房', memories: 1 },
      ],
    },
  },
  sentences: [
    { seq: 1, statement: '我小时候在城西的胡同里长大，院子里有棵老槐树', asks: ['我小时候在哪儿长大的，你还记得吗？'], time_label: '1953—1960 年（童年）', year: 1955, status: 'confirmed', confidence: 0.9, asked_count: 0, told_count: 1, persons: [], places: ['城西的胡同'], events: [] },
    { seq: 2, statement: '我年轻时候在纺织厂当挡车工，一天站八个钟头', asks: ['我那时候在纺织厂是啥情况来着？'], time_label: '1966—1973 年（青年）', year: 1968, status: 'confirmed', confidence: 0.95, asked_count: 2, told_count: 2, persons: [], places: ['纺织厂'], events: [] },
    { seq: 3, statement: '我跟张师傅学手艺，学了整三年', asks: ['张师傅那事儿你还记得不？'], time_label: '1966—1973 年（青年）', year: 1967, status: 'confirmed', confidence: 0.88, asked_count: 1, told_count: 1, persons: ['张师傅'], places: [], events: ['学手艺'] },
    { seq: 4, statement: '我老伴叫秀兰，是六九年结的婚', asks: ['我老伴叫啥来着？'], time_label: '1969 年', year: 1969, status: 'confirmed', confidence: 0.92, asked_count: 1, told_count: 1, persons: ['老伴', '秀兰'], places: [], events: ['结婚'] },
    { seq: 5, statement: '我八三年在厂里分了两间房，在北边那栋红砖楼', asks: ['我分房那事儿你还记得吗？'], time_label: '1983 年', year: 1983, status: 'confirmed', confidence: 0.9, asked_count: 0, told_count: 1, persons: [], places: ['厂里', '北边那栋红砖楼'], events: ['分房'] },
    { seq: 6, statement: '我老伴走了三年了，我一个人在家', asks: ['老伴那事儿你还记得不？'], time_label: '', year: null, status: 'pending', confidence: 0.45, asked_count: 0, told_count: 1, persons: ['老伴'], places: [], events: ['走了'] },
  ],
  stats: { sentences: 6, confirmed: 5, pending: 1, utterances: 34, persons: 2, times: 4, places: 3, events: 4, indexed: 812, openCandidates: 1 },
};
