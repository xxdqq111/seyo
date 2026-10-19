/**
 * 地理库：把老人讲过的地名对到经纬度，并按时间去过的顺序排出"足迹"
 *
 * 说明：这里是一张**地名对照表**（省 / 市 / 常见地方 + 少量老地名），
 * 不是编造内容——只有老人真的讲过某个地名，才会在地图上插旗。
 * 对不上的地名不会瞎标，会列在下面提示"没能定位"。
 */

/** 省 / 自治区 / 直辖市（省会坐标，用于只讲到省时） */
const PROVINCES = {
  北京: [116.41, 39.90], 天津: [117.20, 39.13], 上海: [121.47, 31.23], 重庆: [106.55, 29.56],
  河北: [114.50, 38.05], 山西: [112.55, 37.87], 内蒙古: [111.75, 40.84], 辽宁: [123.43, 41.80],
  吉林: [125.32, 43.90], 黑龙江: [126.63, 45.75], 江苏: [118.78, 32.06], 浙江: [120.15, 30.27],
  安徽: [117.28, 31.86], 福建: [119.30, 26.08], 江西: [115.89, 28.68], 山东: [117.00, 36.65],
  河南: [113.65, 34.76], 湖北: [114.30, 30.59], 湖南: [112.98, 28.19], 广东: [113.26, 23.13],
  广西: [108.32, 22.82], 海南: [110.35, 20.02], 四川: [104.07, 30.67], 贵州: [106.63, 26.65],
  云南: [102.71, 25.05], 西藏: [91.11, 29.97], 陕西: [108.95, 34.27], 甘肃: [103.82, 36.06],
  青海: [101.78, 36.62], 宁夏: [106.28, 38.47], 新疆: [87.62, 43.79], 台湾: [121.51, 25.04],
  香港: [114.17, 22.32], 澳门: [113.55, 22.20],
};

/** 城市与常见地方（老人故事里高频出现的那些） */
const CITIES = {
  // 东北
  沈阳: [123.43, 41.80], 大连: [121.62, 38.92], 鞍山: [122.99, 41.11], 抚顺: [123.96, 41.88],
  长春: [125.32, 43.90], 吉林市: [126.55, 43.84], 哈尔滨: [126.63, 45.75], 齐齐哈尔: [123.92, 47.35],
  大庆: [125.03, 46.59], 牡丹江: [129.62, 44.55], 佳木斯: [130.32, 46.80], 铁岭: [123.84, 42.29],
  锦州: [121.13, 41.10], 丹东: [124.38, 40.12],
  // 华北
  石家庄: [114.50, 38.05], 唐山: [118.18, 39.63], 保定: [115.48, 38.87], 邯郸: [114.49, 36.61],
  太原: [112.55, 37.87], 大同: [113.30, 40.08], 呼和浩特: [111.75, 40.84], 包头: [109.84, 40.66],
  天津: [117.20, 39.13], 北京: [116.41, 39.90], 张家口: [114.88, 40.82], 承德: [117.96, 40.99],
  // 华东
  济南: [117.00, 36.65], 青岛: [120.38, 36.07], 烟台: [121.45, 37.46], 潍坊: [119.16, 36.71],
  淄博: [118.05, 36.81], 南京: [118.78, 32.06], 苏州: [120.62, 31.32], 无锡: [120.30, 31.57],
  徐州: [117.28, 34.26], 常州: [119.97, 31.81], 南通: [120.89, 31.98], 扬州: [119.41, 32.39],
  杭州: [120.15, 30.27], 宁波: [121.55, 29.88], 温州: [120.70, 28.00], 绍兴: [120.58, 30.03],
  合肥: [117.28, 31.86], 芜湖: [118.38, 31.33], 蚌埠: [117.36, 32.94],
  福州: [119.30, 26.08], 厦门: [118.09, 24.48], 泉州: [118.68, 24.87], 南昌: [115.89, 28.68],
  九江: [116.00, 29.71], 赣州: [114.94, 25.83],
  // 华中 / 华南
  郑州: [113.65, 34.76], 洛阳: [112.45, 34.62], 开封: [114.31, 34.80], 新乡: [113.93, 35.30],
  武汉: [114.30, 30.59], 宜昌: [111.29, 30.69], 襄阳: [112.14, 32.04], 黄石: [115.04, 30.20],
  长沙: [112.98, 28.19], 株洲: [113.13, 27.83], 湘潭: [112.94, 27.83], 衡阳: [112.57, 26.89],
  广州: [113.26, 23.13], 深圳: [114.06, 22.55], 佛山: [113.12, 23.02], 东莞: [113.75, 23.02],
  珠海: [113.58, 22.27], 汕头: [116.68, 23.35], 湛江: [110.36, 21.27],
  南宁: [108.32, 22.82], 桂林: [110.29, 25.27], 柳州: [109.42, 24.33], 海口: [110.35, 20.02],
  // 西南 / 西北
  成都: [104.07, 30.67], 绵阳: [104.68, 31.47], 自贡: [104.78, 29.34], 攀枝花: [101.72, 26.58],
  重庆: [106.55, 29.56], 贵阳: [106.63, 26.65], 遵义: [106.93, 27.73], 昆明: [102.71, 25.05],
  大理: [100.23, 25.59], 丽江: [100.23, 26.86], 拉萨: [91.11, 29.97],
  西安: [108.95, 34.27], 宝鸡: [107.14, 34.36], 咸阳: [108.71, 34.33], 延安: [109.49, 36.60],
  兰州: [103.82, 36.06], 天水: [105.72, 34.58], 西宁: [101.78, 36.62], 银川: [106.28, 38.47],
  乌鲁木齐: [87.62, 43.79], 喀什: [75.99, 39.47], 伊宁: [81.32, 43.92],
};
// 带"市"的名字也认
for (const [k, v] of Object.entries(CITIES)) CITIES[`${k}市`] = v;
for (const [k, v] of Object.entries(PROVINCES)) { PROVINCES[`${k}省`] = v; PROVINCES[`${k}市`] = v; }

/** 老地名 / 区域俗称 */
const HISTORIC = {
  北大荒: [131.5, 47.0], 生产建设兵团: [131.5, 47.0], 兵团: [131.5, 47.0],
  铁西区: [123.34, 41.79], 铁西: [123.34, 41.79],
  城西: null, 城南: null, 城东: null, 城北: null,   // 相对的，定位不了
  关里: [117.0, 36.0], 关外: [124.0, 43.0], 东北: [125.0, 45.0], 华北: [114.5, 38.0],
  华东: [119.0, 31.5], 华南: [113.0, 23.0], 西北: [100.0, 38.0], 西南: [102.0, 28.0],
  中原: [113.6, 34.7], 江南: [120.0, 31.0], 塞北: [110.0, 41.0], 边疆: [85.0, 42.0],
  上海: [121.47, 31.23], 天津: [117.20, 39.13],
};

/** 后缀：去掉这些字再查（"沈阳县"→沈阳，"纺织厂"→厂在哪儿定位不了但先去掉修饰） */
const TAIL = /(省|市|县|区|镇|乡|村|屯|庄|街道|胡同|里弄|自治州|地区)$/;

/**
 * 查坐标
 * @returns {[number, number]|null} [经度, 纬度]
 */
export function lookup(name = '') {
  const n = String(name).trim();
  if (!n) return null;
  if (CITIES[n]) return CITIES[n];
  if (PROVINCES[n]) return PROVINCES[n];
  if (HISTORIC[n]) return HISTORIC[n];

  // 去后缀
  let base = n.replace(TAIL, '');
  while (base && base !== n) {
    if (CITIES[base]) return CITIES[base];
    if (PROVINCES[base]) return PROVINCES[base];
    if (HISTORIC[base]) return HISTORIC[base];
    const next = base.replace(TAIL, '');
    if (next === base) break;
    base = next;
  }
  // 包含式（"城西的胡同"→含"胡同"定位不了；但"沈阳铁西"→含"沈阳"）
  for (const [k, v] of Object.entries(CITIES)) {
    if (k.length >= 2 && n.includes(k)) return v;
  }
  for (const [k, v] of Object.entries(PROVINCES)) {
    if (k.length >= 2 && n.includes(k)) return v;
  }
  for (const [k, v] of Object.entries(HISTORIC)) {
    if (v && k.length >= 2 && n.includes(k)) return v;
  }
  return null;
}

/** 能不能定位 */
export const known = (name) => Boolean(lookup(name));

/**
 * 足迹顺序：按年份排；没有年份的排在最后
 *   1. 本身认得出坐标 → 用本身
 *   2. 认不出，但同句里提到了城市 → 落在那个城市，标签写"城市·地名"
 *   3. 都认不出，但设了老家 → 落在老家附近并错开，标签"老家·地名"，标明"按老家定位"
 *   4. 什么都没有 → 不插旗，列进"没能定位"
 * @param {object} dbi 数据库句柄
 * @param {{hometown?:string, hometownCoord?:[number,number]|null}} home 老家锚点
 */
export function footprints(dbi, { hometown = '', hometownCoord = null } = {}) {
  // 只要这条记忆还在，它涉及的年份就该给地点用上
  //   "我年轻时候在纺织厂…" 归一成 1966—1973，取区间起点 1966
  dbi.prepare(
    `UPDATE places SET (year, year_from, year_to) = (
       SELECT MIN(s.year), MIN(COALESCE(t.from_year, s.year)), MAX(COALESCE(t.to_year, s.year))
       FROM place_links l JOIN sentences s ON s.id = l.sentence_id
       LEFT JOIN time_links tl ON tl.sentence_id = s.id
       LEFT JOIN times t ON t.id = tl.time_id
       WHERE l.place_id = places.id
     )`,
  ).run();

  const places = dbi.prepare('SELECT * FROM places ORDER BY count DESC').all();
  const out = [];
  for (const p of places) {
    const rows = dbi.prepare(
      `SELECT s.seq, COALESCE(NULLIF(s.polished,''), s.statement) AS statement, s.year, s.time_label, s.status, s.created_at
       FROM place_links l JOIN sentences s ON s.id = l.sentence_id
       WHERE l.place_id = ? ORDER BY (s.year IS NULL), s.year ASC, s.seq ASC`,
    ).all(p.id);

    let lng = null;
    let lat = null;
    let basis = '';
    let display = p.name;
    let approx = false;
    let cityName = '';

    // 定位只算一次：先看地名自己，再看同句里提到的城市，最后退到老家附近
    const own = lookup(p.name) || cityIn(p.name)?.coord;
    if (own) {
      [lng, lat] = own;
      basis = '地名本身';
      cityName = lookup(p.name) ? p.name.replace(/(省|市|县|区)$/, '') : (cityIn(p.name)?.name || p.name);
      display = p.name;
    } else {
      let city = null;
      for (const r of rows) {
        const c = cityIn(r.statement);
        if (c) { city = c; break; }
      }
      if (city) {
        [lng, lat] = city.coord;
        basis = `同句中提到${city.name}`;
        cityName = city.name;
        display = p.name.includes(city.name) ? p.name : `${city.name}·${p.name}`;
      } else if (hometownCoord) {
        lng = hometownCoord[0];
        lat = hometownCoord[1];
        basis = `按老家（${hometown}）附近定位（大致）`;
        cityName = hometown;
        display = `${hometown}·${p.name}`;
        approx = true;
      }
    }

    const withYear = rows.filter((r) => r.year);
    const year = withYear.length ? Number(withYear[0].year)
      : (p.year_from ? Number(p.year_from) : null);
    const label = withYear.length ? (withYear[0].time_label || `${year} 年`) : (rows[0]?.time_label || '时间未定');
    out.push({
      id: p.id,
      name: p.name,
      label: display,
      city: cityName,
      count: p.count,
      memories: rows.map((r) => ({ seq: r.seq, statement: r.statement, year: r.year, status: r.status })),
      year,
      time_label: label,
      first_seq: rows[0]?.seq ?? 0,
      lng,
      lat,
      located: lng !== null,
      basis,
      approx,
    });
  }
  // 排序：有年份的按年份，同年按首次讲述顺序；无年份的按讲述顺序排后面
  out.sort((a, b) => {
    if (a.year && b.year) return a.year - b.year || a.first_seq - b.first_seq;
    if (a.year && !b.year) return -1;
    if (!a.year && b.year) return 1;
    return a.first_seq - b.first_seq;
  });

  // 同一座城只插一面旗：把"北京·胡同""北京·厂里"并成一面"北京"旗，
  // 具体地方列在旗子下面（spurs），免得几面旗挤在同一个点上分不清。
  const byCity = new Map();
  const merged = [];
  for (const p of out) {
    const key = p.located ? `c:${p.city || p.name}` : `un:${p.name}`;
    if (!byCity.has(key)) {
      byCity.set(key, { ...p, spurs: [], memories: [...p.memories] });
      merged.push(byCity.get(key));
      continue;
    }
    const host = byCity.get(key);
    if (p.name !== host.city && p.name !== host.name) {
      host.spurs.push({ name: p.name, year: p.year, time_label: p.time_label });
    }
    host.memories.push(...p.memories);
    host.count += p.count;
    if (!host.year && p.year) { host.year = p.year; host.time_label = p.time_label; }
    if (p.approx) host.approx = true;
  }
  for (const h of merged) {
    const uniq = [];
    for (const sp of h.spurs) if (sp.name && !uniq.some((x) => x.name === sp.name)) uniq.push(sp);
    h.spurs = uniq;
    h.label = h.city || h.name;                        // 旗子上只写城市名
    // 同一面旗下的记忆按年份排一下，看着顺
    h.memories.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.seq - b.seq);
  }
  merged.sort((a, b) => {
    if (a.year && b.year) return a.year - b.year || a.first_seq - b.first_seq;
    if (a.year && !b.year) return -1;
    if (!a.year && b.year) return 1;
    return a.first_seq - b.first_seq;
  });
  merged.forEach((p, i) => { p.order = i + 1; });
  return merged;
}

/** 经纬度 → 平面坐标（墨卡托，够画中国地图用） */
export function project(lng, lat, bbox, W, H, pad = 8) {
  const merc = (y) => Math.log(Math.tan(Math.PI / 4 + (y * Math.PI) / 360));
  const x0 = bbox[0];
  const x1 = bbox[2];
  const y0 = merc(bbox[3]);
  const y1 = merc(bbox[1]);
  const sx = (W - pad * 2) / (x1 - x0);
  const sy = (H - pad * 2) / (y1 - y0);
  const s = Math.min(sx, sy);
  const ox = pad + ((W - pad * 2) - (x1 - x0) * s) / 2;
  const oy = pad + ((H - pad * 2) - (y1 - y0) * s) / 2;
  return [ox + (lng - x0) * s, oy + (merc(lat) - y0) * s];
}

/**
 * 解 echarts 压缩地图
 *
 * 那份 china.json 不是标准 GeoJSON：坐标是变长编码的字符串，
 *   前两个字符是起点（码点 - 64），之后每两个字符是一对增量，
 *   取值 0–63，小于 32 表示这一位是正数、否则是负数（减 64 还原）；
 *   最后除以 1024 换成经纬度，再叠加 encodeOffsets 给的基准。
 * 这一步在服务端做完，浏览器拿到的就是普通经纬度数组。
 */
export function decodeEchartsMap(raw) {
  if (!raw || !Array.isArray(raw.features)) return raw;
  const features = raw.features.map((f) => {
    const g = f.geometry || {};
    if (!g.encodeOffsets) return f;              // 已经是普通坐标，原样返回
    let coords = g.coordinates;
    const isStr = (x) => typeof x === 'string';
    // 把各种嵌套写法统一成 [[ring, ring], [ring, ring]]（多边形 → 环 → 点）
    const polys = isStr(coords)
      ? [[coords]]                                   // 直接就是一条环
      : (isStr(coords[0]) ? [coords] : coords);      // [环,...] 还是 [多边形,...]
    const outPolys = polys.map((poly, pi) => {
      const rings = isStr(poly) ? [poly] : poly;
      return rings.map((ring, ri) => {
        if (!isStr(ring)) return ring;               // 已经是点数组
        const off = ((g.encodeOffsets[pi] || [])[ri]) || [0, 0];
        return decodeRing(ring, off[0], off[1]);
      });
    });
    coords = outPolys;
    return {
      type: 'Feature',
      properties: { ...(f.properties || {}) },
      geometry: { type: 'MultiPolygon', coordinates: coords },
    };
  });
  return { type: 'FeatureCollection', features };
}

/** 解一条环（ring）：返回 [[lng,lat], ...]；不合法的点直接丢掉 */
function decodeRing(str, originX, originY) {
  const pts = [];
  const code = (ch) => (ch === undefined ? NaN : ch.charCodeAt(0) - 64);
  const push = (x, y) => {
    const lng = (x + originX) / 1024;
    const lat = (y + originY) / 1024;
    // 只接受落在地球上的点，编码串里偶尔有异常字符会把坐标带飞
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < 70 || lng > 140 || lat < 3 || lat > 55) return;
    pts.push([Number(lng.toFixed(4)), Number(lat.toFixed(4))]);
  };
  let x = code(str[0]);
  let y = code(str[1]);
  push(x, y);
  for (let i = 2; i + 1 < str.length; i += 2) {
    let dx = code(str[i]);
    let dy = code(str[i + 1]);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) break;
    if (dx >= 32) dx -= 64;
    if (dy >= 32) dy -= 64;
    x += dx;
    y += dy;
    push(x, y);
  }
  return pts;
}

/** 求这份 GeoJSON 的经纬度包围盒
 * 注意：两种坐标写法都要认 —— 数组 [116.4, 39.9]，
 *      以及 echarts 地图里的字符串 "116.4,39.9"（不认出来会无限递归爆栈）
 */
export function bboxOf(geojson) {
  let x0 = 180; let y0 = 90; let x1 = -180; let y1 = -90;
  const take = (lng, lat) => {
    if (typeof lng !== 'number' || typeof lat !== 'number') return;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < x0) x0 = lng;
    if (lng > x1) x1 = lng;
    if (lat < y0) y0 = lat;
    if (lat > y1) y1 = lat;
  };
  const walk = (c) => {
    if (c === null || c === undefined) return;
    if (typeof c === 'string') {
      const parts = c.split(',').map(Number);
      if (parts.length >= 2) take(parts[0], parts[1]);
      return;
    }
    if (typeof c[0] === 'number' && typeof c[1] === 'number') return take(c[0], c[1]);
    if (Array.isArray(c)) { for (const x of c) walk(x); return; }
    if (typeof c === 'object') {
      if (Array.isArray(c.coordinates)) walk(c.coordinates);
      if (Array.isArray(c.geometry)) walk(c.geometry);
    }
  };
  for (const f of geojson.features || []) walk(f.geometry ? f.geometry.coordinates : f.coordinates);
  if (x0 > x1) return [73, 18, 135, 54];      // 没取到就用中国大致范围兜底
  return [x0, y0, x1, y1];
}


/** 所有认得的地名（给抽取用：句子里出现就算一个地点） */
export const GEO_NAMES = [
  ...Object.keys(CITIES).filter((k) => !k.endsWith('市')),
  ...Object.keys(PROVINCES).filter((k) => !k.endsWith('省') && !k.endsWith('市')),
  ...Object.keys(HISTORIC).filter((k) => HISTORIC[k]),
];

/**
 * 从一段话里找出它说的是哪儿（用于给"纺织厂""胡同"这种没坐标的地方找个落脚点）
 * @returns {{name:string, coord:[number,number]}|null}
 */
export function cityIn(text = '') {
  const t = String(text);
  const all = [
    ...Object.keys(CITIES).filter((k) => !k.endsWith('市')).map((k) => [k, CITIES[k]]),
    ...Object.keys(PROVINCES).filter((k) => !k.endsWith('省') && !k.endsWith('市')).map((k) => [k, PROVINCES[k]]),
  ].sort((a, b) => b[0].length - a[0].length);      // 长的优先（"哈尔滨"胜过"滨"）
  for (const [name, coord] of all) if (t.includes(name)) return { name, coord };
  return null;
}


/**
 * Douglas-Peucker 抽稀：把 16 万个点降到几万，形状基本不变
 * 主要去掉同一直线上的中间点，省的是浏览器画线和传输
 */
function rdp(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let far = -1;
    let farD = tol;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = points[i];
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) {
      keep[far] = true;
      stack.push([a, far], [far, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** 发地图前先抽稀；小地方（澳门、香港这种）要留细一点，否则会被抽没 */
export function simplifyMap(geojson, tol = 0.05) {
  if (!geojson || !Array.isArray(geojson.features)) return geojson;
  const isPoint = (x) => Array.isArray(x) && typeof x[0] === 'number';

  // 先量一下这一块有多大，再决定抽多狠：跨度小的地方用小容忍度
  const spanOf = (node) => {
    let x0 = 999; let y0 = 999; let x1 = -999; let y1 = -999;
    const walk = (n) => {
      if (!Array.isArray(n) || !n.length) return;
      if (isPoint(n[0])) {
        for (const p of n) {
          if (typeof p[0] !== 'number') continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
        return;
      }
      for (const c of n) walk(c);
    };
    walk(node);
    return x1 > x0 ? Math.max(x1 - x0, y1 - y0) : 0;
  };

  const walkRings = (node, t) => {
    if (!Array.isArray(node) || !node.length) return null;
    if (isPoint(node[0])) {
      // 闭合环的首尾是同一个点，先掐掉尾点再抽稀，否则整条环会被删光
      const closed = node.length > 1
        && node[0][0] === node[node.length - 1][0]
        && node[0][1] === node[node.length - 1][1];
      const open = closed ? node.slice(0, -1) : node;
      const thin = rdp(open, t);
      if (thin.length < 3) return null;
      return closed ? [...thin, thin[0]] : thin;
    }
    const out = [];
    for (const child of node) {
      const r = walkRings(child, t);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  };

  const features = geojson.features.map((f) => {
    const coords = (f.geometry || {}).coordinates;
    const span = spanOf(coords);
    // 跨度小于 3° 的（直辖市、港澳）最多缩到十分之一，保证形状还在
    const t = span > 0 && span < 3 ? Math.max(tol / 10, tol * (span / 3)) : tol;
    const rings = walkRings(coords, t);
    if (!rings) return null;
    return { type: 'Feature', properties: f.properties || {}, geometry: { type: 'MultiPolygon', coordinates: rings } };
  }).filter(Boolean);
  return { type: 'FeatureCollection', features };
}
