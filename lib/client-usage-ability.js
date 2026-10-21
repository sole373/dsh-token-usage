// ---- 本机模型能力排行（用量面板一行里的第四张）----
//
// 这张卡回答的问题与最下方的「模型权威排名」不同，两者不能混为一谈：
//   - 这里：**我实际用过**的模型，按能力分数排队。名次是「我的用量 × 榜单分数」。
//   - 那里：**我现在能用**的模型，按能力分数排队。名次是「本机清单 × 榜单分数」。
// 所以卡里必须写清「只统计本机实测用过的模型」，否则用户会问「榜单里那些更强的
// 模型为什么这里没有」。
//
// 数据是同一次 `/usage` 请求带回来的 `ranking` 字段——不为这一张卡再打一次网，
// 也不让它和后端两张表出现两个版本的口径。

/**
 * 这张卡显示几个模型。
 *
 * 5 个：卡高有限（四张图那行 210px），5 条排行 + 一行脚注刚好排满，
 * 名字也不会被挤成省略号。名次 6 以后对「该用哪个」这个问题意义不大——
 * 真正想看全量的去处是下方「模型权威排名」的总榜。
 */
const ABILITY_VISIBLE = 5

/** 占全部用量多少：`44.4%`。分母缺失时显示 `—`，不显示 `0%`。 */
function abilityShare(value) {
  if (!Number.isFinite(value)) return '—'
  return (value * 100).toFixed(1) + '%'
}

/**
 * 能力分数：一位小数。`null` 必须显示成 `—`，不能是 `0`——
 * 「榜单没收录这个模型」和「这模型智能指数是 0」是两件事，
 * 后者在这个榜上根本不存在，而前者在本机很常见（新模型还没上榜）。
 */
function abilityScore(value) {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(1)
}

/**
 * 本机模型能力排行。
 *
 * 行样式刻意沿用 `.tku-rank`：同一行里已经有「模型使用排行」用的是它，两张卡
 * 摆在一起时条形粗细、字重、间距都会自然对齐，读者不用在两套视觉里切换。
 * 区别只在右侧数值——这里是能力分数，不是 token 数，所以用等宽字体并加一个
 * 「分」单位，避免被误读成用量。
 */
function UsageAbilityRank(props) {
  const { ranking, zh, limit } = props
  const rows = ranking !== null && Array.isArray(ranking.rows) ? ranking.rows : []

  if (ranking !== null && ranking.enabled === false) {
    return h('div', { className: 'tku-empty' }, zh ? '榜单不可用，能力分数暂无' : 'Leaderboard unavailable')
  }
  if (rows.length === 0) {
    return h('div', { className: 'tku-empty' }, zh ? '暂无数据' : 'No data')
  }

  // 条形长度统一按**智能指数**的绝对值缩放（0~100 的分数，直接当百分比），
  // 而不是按「最强那个 = 满格」：能力分数是绝对量分，60 分的模型不该因为
  // 这一行里恰好有个 75 分的就画成 80% 长。分数缺失的行不画条，只留空槽。
  // 只显示前 limit 个（默认 5）：卡片高度有限，5 条刚好排满又看得清名字；
  // 排名是「按能力分数」，后面的名次对「该用哪个」这个问题意义不大。
  const shown = rows.slice(0, limit || ABILITY_VISIBLE)
  const top = rows.reduce((best, row) => (Number.isFinite(row.intel) && (best === null || row.intel > best) ? row.intel : best), null)

  const meta = ranking !== null && Number.isFinite(ranking.scored)
    ? (zh
      ? '已评分 ' + ranking.scored + ' / ' + rows.length + ' 个'
      : ranking.scored + ' of ' + rows.length + ' scored')
    : null

  const list = h('ul', { className: 'tku-rank' }, shown.map((row, index) => {
    const scored = Number.isFinite(row.intel)
    const pct = scored ? Math.max(2, Math.min(100, row.intel)) : 0
    return h('li', { key: row.provider + ':' + row.model }, [
      h('div', { key: 'top', className: 'tku-rank-top' }, [
        h('span', { key: 'n', className: 'tku-rank-name', title: row.label }, row.label),
        // 用量占比放在分数左边：这张卡的读者第一个问题通常是「这个模型我用得多不多」，
        // 分数是第二个问题。两个数分开列，谁也不替代谁。
        h('span', { key: 's', className: 'tku-ability-share tku-mono' }, abilityShare(row.share)),
        h('span', { key: 'v', className: 'tku-rank-val tku-mono' }, scored ? abilityScore(row.intel) : '—'),
      ]),
      h('div', { key: 'bar', className: 'tku-rank-bar' },
        h('span', {
          className: 'tku-rank-fill' + (scored ? '' : ' is-unknown'),
          style: { width: pct.toFixed(1) + '%', background: paletteOf(index) },
        })),
    ])
  }))

  // 脚注压成一句：条形是智能指数、右侧是用量占比、本机最高多少分——
  // 三件事里前两件已经在画面上看得见（条形长度、百分比列），真正需要说明的
  // 只有「条形不是用量」这一点和「本机最高多少分」。原来三句话会把卡片撑高，
  // 挤掉排行条目。标题属性里放完整版，悬停可看。
  const noteFull = zh
    ? '条形按智能指数（满分 100）画，不是按用量；中间是占全部用量的比例。'
      + (top === null ? '' : '本机最高 ' + abilityScore(top) + ' 分。')
      + '来源分布、使用排行统计的是全部历史，与上方时间窗无关。'
    : 'Bars are the intelligence index (0–100), not usage; the middle figure is the share of total usage. '
      + (top === null ? '' : 'Local best ' + abilityScore(top) + '. ')
      + 'This uses all-time history, independent of the window above.'
  const noteShort = zh
    ? '条形=智能指数，中列为用量占比'
      + (top === null ? '' : '，本机最高 ' + abilityScore(top) + ' 分')
    : 'Bar = intelligence index, middle = usage share'
      + (top === null ? '' : ', local best ' + abilityScore(top))

  return h('div', { className: 'tku-ability' }, [
    list,
    h('p', { key: 'note', className: 'tku-ability-note', title: noteFull }, noteShort),
    meta === null ? null : h('p', { key: 'meta', className: 'tku-ability-note tku-mono' }, meta),
  ])
}
