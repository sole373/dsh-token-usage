window.__ModuleLoader__.load({
  id: 'dsh-token-usage',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // 只 require 两个静态种子模块。宿主把 `react` / `react/jsx-runtime` 放进了
    // 静态模块表，不依赖任何其它插件的加载顺序；本包不需要 locale 服务
    // ——文案直接写死中英双语，少一个可能缺失的依赖就少一种开不出来页面的理由。
    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')

    /**
     * `h` 的适配层。
     *
     * `react/jsx-runtime` 的 `jsx(type, props, key?)` 只认两个参数：children 必须
     * 放在 `props.children` 里，**第三个参数是 key**，传数组过去会被当成 key
     * 静默忽略。本文件用 `h(type, { children })` 与 `h(type, props, children)`
     * 两种写法——两者在真机上的结果完全不同：后者在传数组时必须合进
     * props.children，否则会渲染出一个**只有外层 div、里面全空的壳**。
     *
     * 另：宿主的 jsx-runtime 是精简内联版，**不判 props 为 null**——`jsx('tr', null)`
     * 会直接抛 `Cannot read properties of null (reading 'key')`。所以 props 一律
     * 归一成对象再往下传。
     */
    const jsx = jsxRuntime.jsx
    const h = (type, props, children) => {
      const base = props ?? {}
      return children === undefined ? jsx(type, base) : jsx(type, { ...base, children })
    }

    const { useEffect, useMemo, useState, useCallback, useRef } = react

    // ---- 样式 ----
    //
    // 类名统一带 `chub-` 前缀：宿主没有 CSS Modules 给我们这种外部包，
    // 全局样式表里裸类名撞车的概率不低。
    const CSS = `
/* >>> usage-panel css（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>> */
/* Token 用量统计页 + 输入框余额徽标。类名继续沿用 tku- 前缀，颜色只吃 --dsw-alias-* 变量。 */

/* ---- 页面骨架 ---- */
.tku-upanel { gap: 16px; }
.tku-uhead { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; justify-content: space-between; }
.tku-uhead-text { display: flex; flex-direction: column; gap: 4px; flex: 1 1 320px; min-width: 0; }
.tku-uhead-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tku-ufoot { padding-top: 4px; }
/* 单行说明：面板头部的两段说明（来源说明 + 口径声明）合并后文字很长，
   不加这条它会按容器宽度折成三四行，把下面的内容整体往下推。
   这里压成严格一行、放不下就省略号——完整口径在面板里另有出处（meta 行与
   后端 availabilityNote），头部的定位是「一句话说清来源」，不是全文。
   省略号会让最后半句读不到，所以同时给它加 title（完整文本），
   鼠标悬停能看到全文。 */
.tku-oneline { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* ---- 天窗 / 模式切换 ---- */
.tku-modes { display: inline-flex; gap: 2px; padding: 2px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); }
.tku-mode { font: inherit; font-size: 12px; cursor: pointer; padding: 3px 9px; border-radius: 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #667); }
.tku-mode:hover { background: rgba(127,127,127,.1); }
.tku-mode.on { background: rgba(127,127,127,.16); color: var(--dsw-alias-label-primary); font-weight: 600; }

/* ---- 概览数字 ---- */
.tku-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tku-stat { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tku-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.tku-stat-value { font-size: 19px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }
.tku-stat-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tku-stat.warn { border-color: var(--dsw-alias-state-warning-primary, #d92); }
.tku-stat.bad { border-color: var(--dsw-alias-state-error-primary, #d33); }
.tku-stat.good { border-color: var(--dsw-alias-state-success-primary, #2e9e5b); }

/* ---- 卡片 ---- */
/* 三张卡片（消耗趋势 / 来源分布 / 模型使用排行）要长得一样高，所以配合
   .tku-ugrid 的 align-items: stretch：卡片撑满整行，卡片正文吃掉剩余高度。
   趋势图不必靠自然高度去凑——正文是 flex 容器，SVG 写死高度即可。 */
.tku-ucard { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; min-height: 0; overflow: hidden; }
.tku-ucard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tku-ucard-title { margin: 0; font-size: 13px; font-weight: 600; }
.tku-ucard-aside { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.tku-ucard-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; }
/* ---- 排行卡内部滚动 ----
   卡片高度由一行里最高的那张定死（等高要求），所以排行条目一多就会把卡片撑破或
   溢出到卡片外面。这里把排行卡（第三、四张）的 body 改成「高度锁死 + 内部滚动」：
   body 吃满剩余高度、不再按内容撑开，列表在内部滚。
   min-height: 0 是关键——flex 子项默认 min-height: auto 会拒绝收缩，滚动条不会出现。
   用 is-scroll（由 JS 加在 section 上）而不是 :has()：旧版 Chromium 没有 :has。 */
.tku-ucard.is-scroll .tku-ucard-body { min-height: 0; overflow: hidden; justify-content: flex-start; }
/* 列表自己成为滚动容器：撑满 body 高度，超出就滚。
   选择器写成后代（而不是 .body > .rank），因为能力卡的 .tku-rank 还多包了一层
   .tku-ability——用后代选择器两种结构都能命中。 */
.tku-ucard.is-scroll .tku-ucard-body .tku-rank { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; scrollbar-width: thin; }
.tku-ucard.is-scroll .tku-ucard-body .tku-rank::-webkit-scrollbar { width: 8px; }
.tku-ucard.is-scroll .tku-ucard-body .tku-rank::-webkit-scrollbar-track { background: transparent; }
.tku-ucard.is-scroll .tku-ucard-body .tku-rank::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }
.tku-ucard.is-scroll .tku-ucard-body .tku-rank::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-tertiary); }
/* 能力卡的列表外面还包了一层 .tku-ability（它带脚注），让这层也参与高度分配。 */
.tku-ucard.is-scroll .tku-ucard-body .tku-ability { min-height: 0; flex: 1 1 auto; }
/* 脚注不许被压掉：它是解释「分数不是用量」的唯一说明。 */
.tku-ability-note { flex: 0 0 auto; }

/* ---- 明细表内部滚动 ----
   来源条目本机有 27 行左右，全铺开会把整页拉到很长。这里给表体封一个高度上限，
   表头用 sticky 钉在框顶，往下滚的时候列名始终可见。
   上限 360 → 520px：四张图压矮后，明细表是页面里最占地方的表格，给它更多可视行，
   少拖几次滚动条。每行约 32px，520px 能看到约 15 行（原来只有 10 行）。 */
.tku-ucard.is-scroll-table .tku-ucard-body { min-height: 0; overflow: hidden; justify-content: flex-start; }
.tku-ucard.is-scroll-table .tku-table-wrap {
  min-height: 0;
  max-height: 520px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* 表头钉住：背景要盖住底下滚上来的行，否则字会叠在一起。 */
.tku-ucard.is-scroll-table .tku-utable thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #fff));
}
/* 滚动条样式与排行卡保持一致，避免页面上出现两种滚动条。 */
.tku-ucard.is-scroll-table .tku-table-wrap::-webkit-scrollbar { width: 8px; height: 8px; }
.tku-ucard.is-scroll-table .tku-table-wrap::-webkit-scrollbar-track { background: transparent; }
.tku-ucard.is-scroll-table .tku-table-wrap::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 999px; }
.tku-ucard.is-scroll-table .tku-table-wrap::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-tertiary); }
/* 三张卡的列宽可拖拽。默认值写在 JS 的 USAGE_COLS_DEFAULT 里（拖过之后由内联
   style 覆盖），这里只是没拿到宽度时的兜底：趋势图改柱状后需要更长的横轴，
   来源分布则是「196 环 + 一段图例」的固定宽度，所以中间列按内容收紧，
   省下来的宽度全给趋势图。窄屏由 minmax(300px, 1fr) 接管，自动折行。 */
/* 中列空白的两个来源，各让一半：
   1) max-content 取的是「环 196 + 间隙 + 图例」，而图例被 .tku-legend 的 flex-basis 撑宽了
      ——默认从 140 收到 116，剩下的空余让自动外边距分给左右两侧，环就能再往左挪一点；
   2) 环 196 上下各多出 38px 的空白（卡高 272），补一组窄屏断点把它缩到 160，
      让整个 body 的宽和高一起收，中列从 492 降到 ~420。 */
/* 一行四张卡。列宽按住 2:2.5:2.75:2.75 分，行高由 --tku-row-h 钉死：
   两张排行卡条目多，如果不钉高度，它们会把整行撑到上千像素，另两张跟着被拉长。
   钉死之后排行卡在内部滚动，四张卡永远等高。

   行高 380 → 300 → 250 → 210：让这四张卡更矮，把空间让给下面的明细表与排名区。
   下限受两处硬约束卡住（都不能被裁）：
     - 环形图 SVG 内在 120px（窄屏断点 1400px 以下是 100px），它不缩；
     - 趋势图 --tku-trend-h 130px。
   卡内固定开销 = padding 12×2 + 标题行 ~20 + gap 10 ≈ 54px，
   所以 210px 时 body 还剩 ~156px：环 120 放得下（余 36px），
   趋势图 130 也放得下（余 26px）。

   列宽 2:2:3:3 → 2:2.5:2.75:2.75：第二张（来源分布）原来只有 2fr，太窄了——
   环 + 间隙 10 + 图例排不下时，flex-wrap 会把图例折到环下方
   （看起来就是「图被压扁了」）。环缩到 120px 后并排所需宽度降到 250px，
   1200px 起就能并排；1400px 以下靠窄屏断点把环缩到 100px，需求降到 230px。
   省下的宽度给了第三、四张（两张排行卡）：它们一行最少要名字 60 + 占比 44 +
   数值 40 + 间距 ≈ 156px，1300px 下 body 有 324px，仍远够用。 */
.tku-ugrid { --tku-cols: minmax(0, 2fr) minmax(0, 2.5fr) minmax(0, 2.75fr) minmax(0, 2.75fr); --tku-row-h: 210px; position: relative; display: grid; grid-template-columns: var(--tku-cols); grid-auto-rows: var(--tku-row-h); gap: 12px; align-items: stretch; align-content: start; justify-content: start; }
/* 窄屏：**明确折成 2×2**，不能用 repeat(auto-fit, minmax(300px, 1fr))。
   auto-fit 只保证「每列至少 300」，一行放几张是浏览器自己算的——982px 时它算出
   3 列，第四张卡被挤到第二行；而卡片是 align-items: stretch 拉满整行高的，
   第二行就落到可见区域之外，用户看到的就是「第四张卡不见了」。
   显式两列让四张卡稳定排成 2×2，不依赖浏览器对 auto-fit 的取整。 */
/* 宽度不够才折行。四张卡按住不放，最小宽度加起来约 4×240 + 3×12 = 996，
   所以 1180 以下折成 2×2、再窄一列一张。注意这里不再带 :not(.is-resize)——
   拖拽把手已经整个移除，没有「用户手动调宽」这个状态了。 */
@media (max-width: 1180px) { .tku-ugrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
/* 更窄（手机竖屏）时一列一张，别再挤成两列。 */
@media (max-width: 620px) { .tku-ugrid { grid-template-columns: minmax(0, 1fr); } }
/* 窄屏把环缩到 100：第二张的 body 宽度不够放下「环 + 图例」，图例会被折到环下方。
   环从 196 缩到 120、并排需求降到 250px 之后，1400px 以上都用大环；
   只有 1400px 以下（body < 250px）才需要再缩一档到 100px，此时需求 230px，
   1200px 起就放得下。 */
@media (max-width: 1400px) {
  .tku-ugrid .tku-donut { width: 100px; height: 100px; }
  .tku-ugrid .tku-legend { font-size: 11px; }
}
/* 中列的 max-content 由图例的 min-width 撑着（没有它，min-content 会取最长那个名字，
   列宽随时变）。这条必须排在上面那个断点后面，否则窄屏时会被 font-size 那条打断覆盖。
   min-width 150 → 110：环缩到 120px 后，并排需要 环120+10+110 = 240px，
   1400px 以上 body 有 317px，1200px 起都放得下。图例里的名字是 flex:1 省略号
   那一位，收窄它不影响可读性。 */
@media (min-width: 1181px) {
  .tku-ugrid .tku-legend { min-width: 110px; }
}
/* 分宽把手绝对定位骑在两张卡的 12px 缝上。
   为什么不用负边距：把手是 grid 里的普通子元素时，一旦列窄到放不下「把手 + 卡片最小宽度」，
   grid 会把它整个挤到下一行（用户实测：伸长的趋势图把它顶到了第三行）。
   绝对定位让它不占布局位置，也就没有「被挤走」这回事；位置由 left 百分比给。
   位置写在 JS 的内联 style.left 上（每条缝留 0.6% 的富余，宁可差几个像素也不能
   因为算窄了一点就掉进下一行）。 */
.tku-resizer { position: absolute; top: 0; bottom: 0; z-index: 2; width: 9px; margin-left: -4.5px; cursor: col-resize; touch-action: none; -webkit-user-select: none; user-select: none; border-radius: 4px; transition: background-color .12s ease-out; }
.tku-resizer:hover, .tku-resizer:focus-visible { background: rgba(127,127,127,.16); outline: none; }
/* 握把：平时一小截竖条，悬停或拖动时变长变亮，提示「这里可以拖」。 */
.tku-resizer-grip { position: absolute; left: 50%; top: 50%; width: 3px; height: 28px; margin: -14px 0 0 -1.5px; border-radius: 999px; background: var(--dsw-alias-border-l2); transition: height .12s ease-out, background-color .12s ease-out; }
.tku-resizer:hover .tku-resizer-grip, .tku-resizer:focus-visible .tku-resizer-grip, .tku-resizing .tku-resizer-grip { height: 56px; margin-top: -28px; background: var(--dsw-alias-label-tertiary); }
/* 拖动途中整页不吃选区、指针保持 col-resize，划过卡片也不会变成文本光标。 */
.tku-resizing, .tku-resizing * { cursor: col-resize !important; user-select: none !important; }
/* 曾经有一条 .tku-ugrid > .tku-ucard:first-child { grid-column: 1 / -1 }，把
   趋势图强制占满整行。用户要的是「趋势图和下面两个图放在一行」，所以删掉——
   现在 auto-fit 会按列宽自动决定一行放几张（宽屏三张一行，窄屏自动折行）。
   注意：本段整体嵌在 client.js 的模板字符串里，注释里不能出现反引号或美元大括号。 */

/* ---- 柱状（消耗趋势）---- */
/* 趋势图高度由 --tku-trend-h 写死、宽度拉满卡片（SVG 用 preserveAspectRatio="none"，
   横向由 CSS 决定、纵向由画布决定），所以它不会因为列宽变宽就变高，也不会把
   「三张卡等高」连带拉高——三张卡的最终高度由内容最多的排行卡决定。
   150 → 130px：行高降到 210px 后 body 只剩 156px，130 放得下（余 26px）。
   坐标系与显示尺寸是解耦的（scaleX/scaleY 按 boxWidth/boxHeight 自洽反推），
   所以只改这里，文字仍会被拽回原形。 */
.tku-chart { width: 100%; --tku-trend-h: 130px; }
.tku-chart-svg { width: 100%; height: var(--tku-trend-h, 130px); display: block; overflow: visible; }
.tku-chart-grid { stroke: var(--dsw-alias-border-l2); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
.tku-chart-axis { fill: var(--dsw-alias-label-tertiary); font-size: 10px; }
/* 峰值气泡：贴在最高那根柱子的顶上。字比刻度略粗，它是要看懂「最高多少」的那个数；
   paint-order 让描边垫在字形底下当底色，正好把柱子和网格线遮住一截。 */
.tku-chart-peak { fill: var(--dsw-alias-label-secondary, #667); font-size: 10px; font-weight: 600; stroke: var(--dsw-alias-bg-layer-2, #fff); stroke-width: 3px; stroke-linejoin: round; paint-order: stroke fill; }
/* 柱子：底色不透、顶端描边随主题，深浅色下都不会糊在网格线上。 */
.tku-chart-bar { fill: var(--dsw-alias-state-business-primary, #4d6bfe); stroke: none; }
.tku-chart-bar.is-cumulative { fill: var(--dsw-alias-state-business-primary, #4d6bfe); opacity: .82; }

/* ---- 环形 + 图例 ---- */
/* 环放大到 196，图例跟上去贴住，两者之间的空隙收紧到 10px。
   自动外边距切三段：「环左 1 份、环与图例之间 10px、图例右 1 份」，
   分组左右留白相等，不会出现一边贴边一边空一大片。
/* body 是 flex 列：子项会被拉伸到整宽，wrap 必须显式 width:100%，
   否则按内容收缩（环 160 + 图例 150 就溢出）；再把图例按 170 的基准改窄，
   窄卡里两者才真能并排放下。 */
.tku-donut-wrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-start; width: 100%; }
/* 尺寸跟着 UsageDonut 里的 size 常量走（120）；和图例并排，图例在窄列里会自动折到环下方。 */
.tku-donut { width: 120px; height: 120px; flex: 0 0 auto; margin-left: auto; }
/* 卡片能被拖窄，而环形图是固定 120 的 flex 子项、拒绝收缩——窄卡时它会横向溢出，
   右边一大段弧正好被裁掉，看着像图没画完。拖进来时允许等比缩小。 */
@media (min-width: 1181px) { .tku-ucard-body .tku-donut { max-width: 100%; height: auto; } }
/* flex-basis 给 116 而不是原来的 140：max-content 列轨道是「图例的 max-content 宽度」
   说了算的，basis 越大中列越宽，环周围就空得越多。图例本身能缩（flex-shrink: 1），
   用 min-width: 164px 把图例的下限钉住（名字 + 数值 + 百分比一行放得下），避免列一紧就折成两行。 */
.tku-legend { list-style: none; margin: 0 0 0 auto; padding: 0; display: flex; flex-direction: column; gap: 6px; flex: 0 1 auto; min-width: 120px; }
/* 行内三段：色点、名字、数值+占比。名字吃掉多余宽度（数字列跟着靠右），另外两段不伸缩。 */
.tku-legend li { display: flex; align-items: center; gap: 6px; font-size: 12px; width: 100%; min-width: 0; }
.tku-legend-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; display: inline-block; }
.tku-legend-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tku-legend-val { flex: 0 0 auto; margin-left: 10px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #667); }
.tku-legend-pct { width: 42px; text-align: right; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary); }

/* ---- 排行条 ---- */
.tku-rank { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.tku-rank-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12px; }
.tku-rank-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tku-rank-val { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #667); flex: 0 0 auto; }
.tku-rank-bar { height: 6px; border-radius: 999px; background: rgba(127,127,127,.14); overflow: hidden; margin-top: 3px; }
.tku-rank-fill { display: block; height: 100%; border-radius: 999px; }

/* ---- 本机模型能力排行 ---- */
/* 行骨架直接复用 .tku-rank（同一条视觉语言，两张排行卡摆一起才不会各说各话），
   这里只补两处：用量占比这一列，以及「没有榜单分数」时画的那截虚条。 */
.tku-ability { display: flex; flex-direction: column; gap: 10px; }
/* 占比列固定宽度右对齐：八行叠起来时小数点要对得上，不能每行一个位置。 */
.tku-ability-share { flex: 0 0 auto; width: 44px; text-align: right; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
/* 没分数的行：不画填充条，只让底槽自己显形，再补一段很淡的短斜纹表示「无值」。
   绝不能给成满宽——满宽的条在两张排行卡里都表示「第一名、满格」，读者会直接把
   「榜单没收录这个模型」看成「这模型满分」。 */
.tku-rank-fill.is-unknown { width: 100% !important; background: repeating-linear-gradient(135deg, var(--dsw-alias-border-l2) 0 3px, transparent 3px 9px) !important; opacity: .5; }
.tku-ability-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }

/* ---- 明细表 ---- */
.tku-table-wrap { overflow-x: auto; }
.tku-utable td, .tku-utable th { white-space: nowrap; }
.tku-utable td:first-child { white-space: normal; }
.tku-utable .num { text-align: right; font-variant-numeric: tabular-nums; }
.tku-utable .strong { font-weight: 600; }
.tku-utable tbody tr:hover { background: rgba(127,127,127,.07); }

/* ---- 空态 ---- */
.tku-empty { padding: 18px 8px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }

/* ---- 模型权威排名（用量面板最下方）---- */
.tku-rsec { margin-top: 4px; }
.tku-rtable td:first-child { white-space: nowrap; }
/* 总榜表体的高度上限：它和「按来源明细」共用 is-scroll-table 那套机制，
   但行数少得多（总榜上限 12 行，约 414px；明细表本机 27 行，约 894px）。
   这里单独放宽：12 行一屏能看完（~414px），留些余量到 720px，
   以后把 RANK_LIMIT 调大时也仍能滚。
   注意这是**覆盖** is-scroll-table 的 520px，必须排在其后。 */
.tku-ucard.is-scroll-table.is-rank-table .tku-table-wrap { max-height: 720px; }
.tku-rnote { margin: 0; line-height: 1.6; }
.tku-rtasks { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.tku-rtask { border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.tku-rtask-head { display: flex; flex-direction: column; gap: 2px; }
.tku-rtask-title { font-size: 12px; font-weight: 600; }
/* 规则行原样展示「这个名次是怎么来的」，所以不折行成两行以上——宁可省略号也不截断语义。 */
.tku-rtask-rule { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tku-rtask-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.tku-rtask-list li { display: flex; align-items: baseline; gap: 6px; font-size: 12px; min-width: 0; }
.tku-rtask-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tku-rtask-prov { flex: 0 0 auto; font-size: 11px; }
.tku-rtask-val { flex: 0 0 auto; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #667); }
.tku-banner { padding: 8px 12px; border-radius: 8px; font-size: 12px; border: 1px solid var(--dsw-alias-border-l2); }
.tku-banner.warn { border-color: var(--dsw-alias-state-warning-primary, #d92); }
.tku-banner.bad { border-color: var(--dsw-alias-state-error-primary, #d33); }

/* ---- 输入框余额徽标 ---- */
.tku-credit-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); font-size: 11px; line-height: 1; color: var(--dsw-alias-label-secondary, #667); white-space: nowrap; font-variant-numeric: tabular-nums; }

/* 用量页左上角的前端版本自证行：比正文更淡，只在需要排查「改了没生效」时才值得看。 */
.tku-uver { font-size: 11px; opacity: .6; font-variant-numeric: tabular-nums; }

/* ---- 通用基类（从 dsh-agent-checkin 迁入：本插件的前端要自带全套基础样式，
   不能依赖另一个插件的 client.js 注入到页面里的 <style>） ---- */
.tku-table-wrap { overflow-x: auto; }
/* 面板根元素 = 宿主中栏（.BynINW_centerCol，overflow:hidden）里的那个滚动容器。
   宿主中栏不会替占用者滚动：官方面板（如 xz4KEq_scroll、qWvkEq_root）都是自己
   声明「占满 + 内部滚动」的。本插件原来没写，于是根元素按内容撑到 ~1700px，
   而中栏只有 ~950px 可视高度，超出部分被 overflow:hidden 直接剪掉——最下方的
   「模型权威排名」区块因此只露个边、且没有任何办法滚到它。
   这四行是修这一条：flex+min-height:0 让根元素吃满中栏高度，overflow-y:auto
   把滚动条交回本面板自己，于是**整个用量页面可滚动**（面板内容超出中栏高度时）。
   overscroll-behavior 用 auto 而非 contain：contain 会把滚动链锁死在本面板，
   滚到底时不再向外传递；auto 允许自然传递，外层若还能滚就接着滚。 */
.tku-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; color: var(--dsw-alias-label-primary); flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: auto; }
.tku-head { display: flex; flex-direction: column; gap: 4px; }
.tku-title { margin: 0; font-size: 15px; font-weight: 600; }
.tku-sub { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); line-height: 1.55; }
.tku-banner { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.6; }
.tku-banner.bad { border-color: var(--dsw-alias-state-error-primary, #d33); }
.tku-banner.warn { border-color: var(--dsw-alias-state-warning-primary, #d92); }
.tku-banner.info { border-color: var(--dsw-alias-border-l2); }
.tku-banner.nodeps { border-style: dashed; }
.tku-banner.nodeps code { background: rgba(127,127,127,.14); padding: 1px 4px; border-radius: 4px; }
.tku-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tku-grow { flex: 1 1 auto; }
.tku-btn { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }
.tku-btn:hover:not(:disabled) { background: rgba(127,127,127,.1); }
.tku-btn:disabled { opacity: .45; cursor: not-allowed; }
.tku-btn.primary { border-color: var(--dsw-alias-state-business-primary, #4a7); }
.tku-btn.primary:hover:not(:disabled) { background: rgba(74,170,119,.12); }
a.tku-link { display: inline-block; text-decoration: none; }
.tku-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.tku-table th, .tku-table td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2); vertical-align: top; }
.tku-table th { font-weight: 600; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.tku-name { font-weight: 600; }
.tku-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.tku-muted { color: var(--dsw-alias-label-tertiary); }

/* 任务卡正文容器：内容多时靠它承接剩余高度。 */
.tku-rtask-body { min-width: 0; }
/* <<< usage-panel css <<< */
`

    const CSS_TAG_ID = 'dsh-token-usage/client.css'
    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-token-usage'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- 与宿主半侧的通信 ----
    //
    // 面板**不**直接 spawn 子进程、也不读文件：那些都发生在宿主进程里，
    // 由 lib/index.js 注册的 `${prefix}/usage` 与 `${prefix}/model-rank` 路由承担。
    // 浏览器这一侧只发 HTTP，这样数据从头到尾没进过页面。
    const DEFAULT_PREFIX = '/dsh-token-usage'

// >>> usage-panel parts（由 scripts/sync-usage-parts.mjs 生成，勿手改本段） >>>
    // ---- client-usage-shared.js ----
/**
     * 用量统计页面（`main` slot）共用的工具与文案。
     *
     * 本文件是 dsh-token-usage 的前端片段，被 scripts/sync-usage-parts.mjs
     * 拼进 lib/client.js 的标记区。片段单独成文件（好读、好审、能 `node --check`），
     * 但运行期必须与 client.js 的 factory 同作用域——宿主只认 package.json
     * `exports` 里那一个 `./client` 入口。
     *
     * 图表全部是手写 SVG。理由不是洁癖：
     *   1. 这个插件的 client.js 只能 require `react` 与 `react/jsx-runtime`，
     *      引不进 ECharts / Recharts；把图表库塞进宿主 bundle 更不可能。
     *   2. 需要画的只有柱、环，SVG 路径足够，且颜色能直接吃
     *      `--dsw-alias-*` 主题变量——换主题时图表跟界面一起变，不需要重绘。
     */

    /** 当前界面语言是否为中文。与 client.js 的 `t()` 同一判据，避免两处各猜一次。 */
    function isZhUi() {
      return typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '')
    }

    /** 双语取词：中文界面取前一个，英文界面取后一个。 */
    function t(zh, en) {
      return isZhUi() ? zh : en
    }

    /**
     * 把响应体解析成 `{ok, ...}`。
     *
     * 宿主的路由对失败统一回 `{ ok: false, status, detail }`；网络层失败（DSH 没起来、
     * 插件被禁用）连响应都没有，此时合成一个同形状的对象，让上层只用一套判断。
     */
    async function callJson(url, options) {
      let response
      try {
        response = await fetch(url, options)
      } catch (error) {
        return {
          ok: false,
          status: 'network',
          detail: '无法连接 DSH 服务：' + String(error && error.message ? error.message : error),
        }
      }
      let body = null
      const text = await response.text()
      if (text !== '') {
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
      }
      if (body === null || typeof body !== 'object') {
        return {
          ok: false,
          status: 'bad-response',
          detail: '服务返回了无法解析的内容（HTTP ' + response.status + '）',
        }
      }
      // HTTP 失败而载荷里没带 ok 时补一个，让上层只用一套判断。
      if (response.ok === false && body.ok === undefined) body.ok = false
      return body
    }

    /** 统一的 token 数字格式：过万折成 `1.2万` / `12.3K`，保留一位小数。 */
    function formatTokens(value, zh) {
      if (!Number.isFinite(value) || value <= 0) return '0'
      if (zh) {
        if (value >= 1e8) return (value / 1e8).toFixed(2) + '亿'
        if (value >= 1e4) return (value / 1e4).toFixed(1) + '万'
        return String(Math.round(value))
      }
      if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M'
      if (value >= 1e3) return (value / 1e3).toFixed(1) + 'K'
      return String(Math.round(value))
    }

    /** 精确数字：带千位分隔符，用于 tooltip 与「精确」模式。 */
    function formatExact(value) {
      if (!Number.isFinite(value)) return '—'
      return Math.round(value).toLocaleString()
    }

    /**
     * 比率显示：`null`（分母为 0，读不到）显示「—」，**不显示 0%**。
     *
     * 这条与余额徽标是同一个口径：0% 是一个读数，「读不到」不是。把后者画成 0%
     * 会让人以为缓存完全没命中，而事实可能只是这批日志里没有缓存字段。
     */
    function formatRate(value, zh) {
      if (value === null || value === undefined || !Number.isFinite(value)) return '—'
      return (value * 100).toFixed(1) + '%'
    }

    /** 相对时间：「3 分钟前」。 */
    function sinceLabel(ms, zh) {
      const delta = Math.max(0, Date.now() - ms)
      const minute = 60_000
      if (delta < minute) return zh ? '刚刚' : 'just now'
      if (delta < 60 * minute) return Math.floor(delta / minute) + (zh ? ' 分钟前' : 'm ago')
      const hours = Math.floor(delta / (60 * minute))
      if (hours < 24) return hours + (zh ? ' 小时前' : 'h ago')
      return Math.floor(hours / 24) + (zh ? ' 天前' : 'd ago')
    }

    /** 把 provider id 翻成一个人类能读的名字；不认识的照原样显示，不猜。 */
    const PROVIDER_LABELS = {
      workbuddy: 'WorkBuddy',
      'workbuddy-global': 'WorkBuddy AI',
      trae: 'TRAE',
      'trae-global': 'TRAE AI',
      'qoder-cn': 'Qoder',
      'deepseek-account': 'DeepSeek（账号）',
      'deepseek-official': 'DeepSeek（官方）',
      siliconflow: 'SiliconFlow',
      xiaomi: '小米 MiMo',
      zai: '智谱 GLM',
      openrouter: 'OpenRouter',
      freeroute: 'FreeRoute',
      dumate: '百度搭子',
      lingxi: 'WPS 灵犀',
    }

    function providerLabel(id) {
      if (id === '') return '未知来源'
      return PROVIDER_LABELS[id] ?? id
    }

    /** 一条折线的坐标；`series` 是 `{day, total}` 数组。 */
    function linePath(values, width, height, max) {
      if (values.length === 0) return ''
      const step = values.length > 1 ? width / (values.length - 1) : 0
      return values
        .map((value, index) => {
          const x = index * step
          const y = max === 0 ? height : height - (value / max) * height
          return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
        })
        .join(' ')
    }

    /** 面积图：折线 + 到底边的闭合路径。 */
    function areaPath(values, width, height, max) {
      const line = linePath(values, width, height, max)
      if (line === '') return ''
      return `${line} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`
    }

    /** 环形图的一段扇形路径。 */
    function arcPath(cx, cy, radius, thickness, start, end) {
      const outer = radius
      const inner = radius - thickness
      const p = (r, angle) => {
        const a = angle - Math.PI / 2
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
      }
      const large = end - start > Math.PI ? 1 : 0
      const [x1, y1] = p(outer, start)
      const [x2, y2] = p(outer, end)
      const [x3, y3] = p(inner, end)
      const [x4, y4] = p(inner, start)
      return [
        `M${x1.toFixed(2)},${y1.toFixed(2)}`,
        `A${outer},${outer} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`,
        `L${x3.toFixed(2)},${y3.toFixed(2)}`,
        `A${inner},${inner} 0 ${large} 0 ${x4.toFixed(2)},${y4.toFixed(2)}`,
        'Z',
      ].join(' ')
    }

    /** 图表配色：全部取主题 token，深浅色主题自动跟随。 */
    const PALETTE = [
      'var(--dsw-alias-state-business-primary, #4d6bfe)',
      'var(--dsw-alias-state-success-primary, #2e9e5b)',
      'var(--dsw-alias-state-warning-primary, #d9921a)',
      'var(--dsw-alias-state-error-primary, #d9503f)',
      'var(--dsw-alias-label-tertiary, #8a8a95)',
      'var(--dsw-alias-label-secondary, #5f5f6b)',
    ]

    function paletteOf(index) {
      return PALETTE[index % PALETTE.length]
    }

    // ---- client-usage-charts.js ----
// ---- 图表：柱状（消耗趋势） / 环形（来源分布） ----
    //
    // 全部手写 SVG，不引图表库：client.js 只能 require react，而且用 --dsw-alias-*
    // 变量上色能让图表跟着主题（浅色 / 深色）一起变，不需要监听主题事件。
    //
    // 消耗趋势原本是折线 + 面积，用户要求改成柱状图（2026-10-20），所以
    // usageLinePath / usageAreaPath 一并删掉，避免留下没人调用的死代码。

    /**
     * 面板与侧栏共用的 slot id：两者同名，宿主才会把侧栏项和这块主面板联成一组。
     *
     * id 必须带本插件自己的前缀：slot id 是宿主侧的全局命名空间，撞上别的插件
     * 的 id 会让宿主把两个插件的侧栏项与主面板联成一组——点一个打开另一个。
     */
    const USAGE_SLOT_ID = 'dsh-token-usage-usage'

    /** 柱状图下沿的基线。`max <= 0` 时所有柱子压成零高，而不是除以零。 */
    function usageBarHeight(value, height, max) {
      if (max <= 0 || value <= 0) return 0
      return (value / max) * height
    }

    /** 环形图的一段扇形（外弧 → 内弧闭合）。 */
    function usageArcPath(cx, cy, radius, thickness, start, end) {
      const inner = radius - thickness
      const point = (r, angle) => {
        const a = angle - Math.PI / 2
        return (cx + r * Math.cos(a)).toFixed(2) + ',' + (cy + r * Math.sin(a)).toFixed(2)
      }
      const large = end - start > Math.PI ? 1 : 0
      return [
        'M' + point(radius, start),
        'A' + radius + ',' + radius + ' 0 ' + large + ' 1 ' + point(radius, end),
        'L' + point(inner, end),
        'A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + point(inner, start),
        'Z',
      ].join(' ')
    }

    function UsageTrendChart(props) {
      const { series, zh, mode } = props
      // 坐标系定在 360x150：柱子的槽宽按 series.length 均分，SVG 用
      // preserveAspectRatio="none" 横向拉满卡片、纵向写死高度（--tku-trend-h），
      // 所以 viewBox 的宽高比只决定「柱子画得细不细」，不决定实际尺寸。
      // 竖向刻度标签会画到 x = width + 6 之外，左右各留一点边距，否则数字被卡片裁掉。
      const width = 360
      const height = 150
      const values = series.map((point) => point.total)
      const max = values.reduce((a, b) => Math.max(a, b), 0)
      if (values.length === 0 || max === 0) {
        return h('div', { className: 'tku-empty' }, zh ? '这个区间还没有消耗记录' : 'No usage recorded in this range')
      }
      // 累计模式：把每日值累加，用来回答「一共花掉多少」。
      let running = 0
      const shown = mode === 'cumulative' ? values.map((value) => (running += value)) : values
      const shownMax = shown.reduce((a, b) => Math.max(a, b), 0)
      // 画布比绘图区高 topPad：顶端留给「当前值」气泡，不给气泡底下的柱子涂色
      // （工具栏的「累计」按钮就悬在那儿，柱子涂上去会把它顶得看不清）。
      const topPad = 12
      const plotHeight = height - topPad
      const ticks = [0, 0.5, 1].map((fraction) => ({ fraction, y: height - fraction * plotHeight, value: shownMax * fraction }))
      // 柱状图不再是「点连点」：每根柱子占一个等宽槽位，槽内按比例留白，形成柱间空隙。
      const slot = series.length > 0 ? width / series.length : 0
      const barWidth = Math.max(1, slot * 0.62)
      const labelEvery = Math.max(1, Math.floor(series.length / 6))

      // preserveAspectRatio="none" 会把坐标系非等比拉满卡片：图形和刻度的位置
      // 正好跟着走，笔画会被拉成椭圆、文字也会糊。SVG 里取不到自身尺寸，这里按
      // 「横轴拉满、纵轴等于 --tku-trend-h」反推两向缩放比，再用它把字拽回原形。
      // 刻度数字的字宽是按卡宽估的（见 scaleX），估宽用 0.9 折价，宁可字瘦一点也不让它
      // 顶出卡片——早先写的 0.86 让「4.35亿」横着吃掉了 60px，正好压在那根线上。
      // 峰值气泡和刻度数字挤在同一列，所以右边留 30 才够，留窄了两行字会叠在一起。
      const labelWidth = 30
      const boxWidth = width + labelWidth + 12
      const boxHeight = height + 22
      const scaleX = (boxWidth / (width + labelWidth + 12)).toFixed(3)
      const scaleY = (boxHeight / (height - 2 * 5)).toFixed(3)

      const gridLines = []
      const axisLabels = []
      for (const tick of ticks) {
        // 网格线止于绘图区右沿，右侧那一小截干净地留给刻度数字，不再从数字底下穿过去。
        gridLines.push(h('line', { key: 'g' + tick.fraction, x1: 0, x2: width, y1: tick.y, y2: tick.y, className: 'tku-chart-grid' }))
        axisLabels.push(h('text', {
          key: 't' + tick.fraction,
          x: width + 8,
          y: tick.y + 3.5,
          className: 'tku-chart-axis',
          transform: 'scale(' + scaleX + ',' + scaleY + ')',
        }, formatTokens(tick.value, zh)))
      }

      const xLabels = []
      series.forEach((point, index) => {
        if (index % labelEvery !== 0 && index !== series.length - 1) return
        xLabels.push(h('text', {
          key: 'x' + index,
          x: ((index * slot + slot / 2) / boxWidth * 100).toFixed(3) + '%',
          y: height + 15,
          className: 'tku-chart-axis',
          textAnchor: 'middle',
          transform: 'scale(' + scaleX + ',' + scaleY + ')',
        }, point.day.slice(5)))
      })

      // 每根柱子底部对齐 y=height，高度按 shownMax 归一。柱子用非缩放描边，
      // 横向被拉宽也不会把颜色拉糊。
      const shapes = shown.map((value, index) => {
        const barHeight = usageBarHeight(value, plotHeight, shownMax)
        if (barHeight <= 0) return null
        return h('rect', {
          key: 'b' + index,
          x: (index * slot + (slot - barWidth) / 2).toFixed(2),
          y: (height - barHeight).toFixed(2),
          width: barWidth.toFixed(2),
          height: barHeight.toFixed(2),
          className: mode === 'cumulative' ? 'tku-chart-bar is-cumulative' : 'tku-chart-bar',
        })
      }).filter(Boolean)

      // 最高那根柱子的数值直接写在柱子顶上，一来最高点常被裁在框线外，二来顺着柱子读比
      // 抬头对刻度更直观。字压在柱子上（柱子是不透明的），所以不会有「卡在线上」的问题；
      // 柱子太低时没有地方落脚，就不画。
      // 累计模式下最高点永远是最后一根、贴着右边框，所以气泡改成右对齐并往中间收一点，
      // 否则会和右侧刻度数字叠在一起。
      const cumulativeMode = mode === 'cumulative'
      const peakIndex = shown.indexOf(shownMax)
      const peak = shownMax > 0 ? shownMax : 0
      const peakLabel = peak > 0 && (peak / shownMax) * plotHeight > 18
        ? h('text', {
          key: 'peak',
          x: cumulativeMode
            ? (peakIndex * slot + slot / 2 - slot * 0.35).toFixed(2)
            : (peakIndex * slot + slot / 2).toFixed(2),
          y: (height - (peak / shownMax) * plotHeight - 5).toFixed(2),
          className: 'tku-chart-peak',
          textAnchor: cumulativeMode ? 'end' : 'middle',
          transform: 'scale(' + scaleX + ',' + scaleY + ')',
        }, formatTokens(peak, zh))
        : null

      const svg = h('svg', {
        viewBox: '0 0 ' + boxWidth + ' ' + boxHeight,
        preserveAspectRatio: 'none',
        className: 'tku-chart-svg',
        role: 'img',
        'aria-label': zh ? '消耗趋势' : 'usage trend',
      }, [
        h('g', { key: 'grid' }, gridLines),
        h('g', { key: 'axis' }, axisLabels),
        h('g', { key: 'bars' }, shapes),
        peakLabel,
        h('g', { key: 'xlabels' }, xLabels),
      ])

      return h('div', { className: 'tku-chart' }, svg)
    }

    function UsageDonut(props) {
      const { rows, zh } = props
      const total = rows.reduce((sum, row) => sum + row.total, 0)
      if (total === 0) {
        return h('div', { className: 'tku-empty' }, zh ? '暂无数据' : 'No data')
      }
      // 132 的时候和旁边 6 行图例一对比显得空；后来放大到 168、再放大到 196，
      // 环径占比一直保持「radius/size = 0.44」，视觉重量才和左右两张图对齐。
      // 配合 CSS 里的 .tku-donut { height } 一起改，两处尺寸必须一致。
      //
      // 196 → 156 → 120：四张卡的行高 380→300→250→210 后，body 只剩 156px，
      // 环必须同比缩小，否则会被卡片的 overflow:hidden 切掉底边。
      // 缩放系数 120/156 ≈ 0.769，radius 与 thickness 一起按比例走，
      // 环径占比仍是 0.44，视觉重量不变。环小了，并排所需宽度也从 356 降到 250px，
      // 1200px 起的窗口就能把图例和环并排放下。
      const size = 120
      const radius = 52
      const thickness = 13.5
      // viewBox 之外再留 4px 余量：右边那一大刀弧（R8）的边缘落在 svg 框外正好被裁掉，
      // overflow:hidden 的容器（可拖拽的窄卡）会把它削成一条竖切线。
      const pad = 4
      const box = size + pad * 2
      let angle = 0
      const arcs = []
      const legend = []
      rows.forEach((row, index) => {
        const span = (row.total / total) * Math.PI * 2
        arcs.push(h('path', {
          key: 's' + index,
          d: usageArcPath(size / 2 + pad, size / 2 + pad, radius, thickness, angle, angle + span),
          fill: paletteOf(index),
        }))
        angle += span
        legend.push(h('li', { key: 'l' + index }, [
          h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
          h('span', { key: 'n', className: 'tku-legend-name' }, providerLabel(row.provider)),
          h('span', { key: 'v', className: 'tku-legend-val' }, formatTokens(row.total, zh)),
          h('span', { key: 'p', className: 'tku-legend-pct' }, ((row.total / total) * 100).toFixed(1) + '%'),
        ]))
      })
      const track = h('circle', {
        cx: size / 2 + pad, cy: size / 2 + pad, r: radius - thickness / 2,
        fill: 'none', className: 'tku-chart-grid', strokeWidth: thickness,
      })
      return h('div', { className: 'tku-donut-wrap' }, [
        h('svg', { key: 'svg', viewBox: '0 0 ' + box + ' ' + box, className: 'tku-donut' }, [track, ...arcs]),
        h('ul', { key: 'legend', className: 'tku-legend' }, legend),
      ])
    }

    /** 模型使用排行：横向条形图，条宽按占比缩放。 */
    function UsageRank(props) {
      const { rows, zh, limit } = props
      const shown = rows.slice(0, limit || rows.length)
      const max = shown.reduce((a, row) => Math.max(a, row.total), 0)
      if (shown.length === 0 || max === 0) {
        return h('div', { className: 'tku-empty' }, zh ? '暂无数据' : 'No data')
      }
      return h('ul', { className: 'tku-rank' }, shown.map((row, index) => {
        const pct = max > 0 ? (row.total / max) * 100 : 0
        return h('li', { key: row.provider + ':' + row.model }, [
          h('div', { key: 'top', className: 'tku-rank-top' }, [
            h('span', { key: 'n', className: 'tku-rank-name', title: row.provider + ' / ' + row.model }, providerLabel(row.provider) + ' / ' + row.model),
            h('span', { key: 'v', className: 'tku-rank-val' }, formatTokens(row.total, zh)),
          ]),
          h('div', { key: 'bar', className: 'tku-rank-bar' },
            h('span', { className: 'tku-rank-fill', style: { width: pct.toFixed(1) + '%', background: paletteOf(index) } })),
        ])
      }))
    }

    // ---- client-usage-ability.js ----
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
      const shown = rows.slice(0, limit || rows.length)
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

      return h('div', { className: 'tku-ability' }, [
        list,
        h('p', { key: 'note', className: 'tku-ability-note' }, zh
          ? '名字后的条形按智能指数（满分 100）画，不是按用量；右侧是占全部用量的比例。'
            + (top === null ? '' : '本机最高 ' + abilityScore(top) + ' 分。')
            + '来源分布、使用排行统计的是全部历史，与上方时间窗无关。'
          : 'Bars are the intelligence index (0–100), not usage; the middle figure is the share of total usage. '
            + (top === null ? '' : 'Local best ' + abilityScore(top) + '. ')
            + 'This uses all-time history, independent of the window above.'),
        meta === null ? null : h('p', { key: 'meta', className: 'tku-ability-note tku-mono' }, meta),
      ])
    }

    // ---- client-usage.js ----
// ---- 统计页面（`main` slot）----
    //
    // 读的是 `${prefix}/usage`：宿主侧扫 DSH 自己的会话日志，按 provider / 模型归类。
    // 这一块只负责「把数画出来」，口径（哪条记录算一次调用、token 怎么加）全在后端，
    // 前端再算一遍只会出现两个都对不上数的版本。

    /** 持仓窗口可选项（天）。3650 = 「全部」，够长到覆盖任何真实使用史。 */
    const USAGE_WINDOWS = [7, 30, 90, 3650]

    // ---- 四张图的列宽 ----
    // 列宽**一律按比例（fr）分配**，不用 minmax(px)，也不再有拖拽把手：
    // 像素上下限一旦和宿主的实际可用宽度对不上，grid 就会把放不下的那一列折到下一行，
    // 用户看到的就是「第四张卡不见了」。比例列没有这个毛病——窗口多宽，四列就按
    // **20% / 20% / 30% / 30%**（即 2:2:3:3）分多宽，任何宽度都排得下。
    //
    // 为什么第三、四张各给 30%：它们是排行卡，一行要放下「模型名 + 数值」两列，
    // 比只画一根趋势柱、只放一个环的前两张更需要横向空间。
    const USAGE_COLS_DEFAULT = ['minmax(0, 2fr)', 'minmax(0, 2fr)', 'minmax(0, 3fr)', 'minmax(0, 3fr)']
    /** 一行里几张卡。加卡改这里。 */
    const USAGE_COL_COUNT = USAGE_COLS_DEFAULT.length

    /**
     * 用量页前端版本号。**每次改动这一页的布局或卡片时都要改**，页面左上角会显示它。
     * 作用只有一个：把「浏览器还在跑旧 bundle」这件事从猜测变成一眼可见——
     * 界面显示 4 就是加载到了四卡那版，显示别的（或这行根本不出现）就是旧代码。
     */
    const USAGE_UI_VERSION = 'ui-4card-5-row210-oneline'



    /** 拉一次用量文档。`refresh=1` 才会让宿主重扫文件；自动刷新走缓存。 */
    async function fetchUsage(days, refresh) {
      const query = '?days=' + String(days) + (refresh ? '&refresh=1' : '')
      return callJson(DEFAULT_PREFIX + '/usage' + query, { cache: 'no-store' })
    }

    function UsageStat(props) {
      return h('div', { className: 'tku-stat' + (props.tone ? ' ' + props.tone : '') }, [
        h('div', { key: 'l', className: 'tku-stat-label' }, props.label),
        h('div', { key: 'v', className: 'tku-stat-value' }, props.value),
        props.hint ? h('div', { key: 'h', className: 'tku-stat-hint', title: props.hint }, props.hint) : null,
      ])
    }

    function UsageCard(props) {
      const aside = props.aside ? h('div', { key: 'a', className: 'tku-ucard-aside' }, props.aside) : null
      // scroll 分两种，样式在 CSS 里各自处理：
      //   true      —— 排行卡：body 内部滚动，条目本身是 li 列表；
      //   'table'   —— 明细表：表体滚动、表头钉住（sticky）。
      const scrollClass = props.scroll === 'table' ? ' is-scroll-table' : (props.scroll ? ' is-scroll' : '')
      // extraClass：给某个具体卡片补一个专属类，用来覆盖共用样式。
      // 「模型权威排名」的总榜和「按来源明细」共用 is-scroll-table（360px 上限），
      // 但两者行数差很多（12 行 vs 27 行），总榜要单独放宽高度——靠这个参数挂上
      // is-rank-table。不引入它就得在 CSS 里按 DOM 顺序猜测哪张是总榜，太脆。
      const extraClass = props.extraClass ? ' ' + props.extraClass : ''
      return h('section', { className: 'tku-ucard' + scrollClass + extraClass }, [
        h('header', { key: 'h', className: 'tku-ucard-head' }, [
          h('h3', { key: 't', className: 'tku-ucard-title' }, props.title),
          aside,
        ]),
        h('div', { key: 'b', className: 'tku-ucard-body' }, props.children),
      ])
    }

    function UsageTable(props) {
      const { doc, zh } = props
      if (doc.sources.length === 0) {
        return h('div', { className: 'tku-empty' }, zh ? '还没有任何用量记录' : 'No usage recorded yet')
      }
      const headCells = [
        h('th', { key: 'p' }, zh ? '来源' : 'Source'),
        h('th', { key: 'i', className: 'num' }, zh ? '输入' : 'Input'),
        h('th', { key: 'c', className: 'num' }, zh ? '缓存读' : 'Cache read'),
        h('th', { key: 'w', className: 'num' }, zh ? '缓存写' : 'Cache write'),
        h('th', { key: 'o', className: 'num' }, zh ? '输出' : 'Output'),
        h('th', { key: 't', className: 'num' }, zh ? '合计' : 'Total'),
        h('th', { key: 'n', className: 'num' }, zh ? '调用' : 'Calls'),
        // 效率列：全部由左边那几列当场算出，不引入任何新数据源。缺数就留空（`—`）。
        h('th', { key: 'r', className: 'num' }, zh ? '命中率' : 'Hit rate'),
        h('th', { key: 'a', className: 'num' }, zh ? '均次' : 'Per call'),
        h('th', { key: 's', className: 'num' }, zh ? '输出占比' : 'Output share'),
      ]
      const bodyRows = doc.sources.map((row, index) => {
        const name = row.provider === '' ? (zh ? '未知来源' : 'unknown') : row.provider
        const model = row.model === '' ? null : h('span', { key: 'm', className: 'tku-mono tku-muted' }, ' / ' + row.model)
        // 行级口径与面板总计一致：命中率分母是「喂进去的上下文」，不含 output。
        const billed = row.input + row.cacheRead + row.cacheWrite
        const hitRate = billed > 0 ? row.cacheRead / billed : null
        const perCall = row.calls > 0 ? row.total / row.calls : null
        const outShare = row.total > 0 ? row.output / row.total : null
        return h('tr', { key: 'r' + index }, [
          h('td', { key: 'p' }, [
            h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
            h('span', { key: 'n', className: 'tku-name' }, name),
            model,
          ]),
          h('td', { key: 'i', className: 'num tku-mono' }, formatTokens(row.input, zh)),
          h('td', { key: 'c', className: 'num tku-mono' }, formatTokens(row.cacheRead, zh)),
          h('td', { key: 'w', className: 'num tku-mono' }, formatTokens(row.cacheWrite, zh)),
          h('td', { key: 'o', className: 'num tku-mono' }, formatTokens(row.output, zh)),
          h('td', { key: 't', className: 'num tku-mono strong' }, formatTokens(row.total, zh)),
          h('td', { key: 'n', className: 'num tku-mono tku-muted' }, formatExact(row.calls)),
          h('td', { key: 'r', className: 'num tku-mono' }, formatRate(hitRate, zh)),
          h('td', { key: 'a', className: 'num tku-mono' }, perCall === null ? '—' : formatTokens(perCall, zh)),
          h('td', { key: 's', className: 'num tku-mono tku-muted' }, formatRate(outShare, zh)),
        ])
      })
      return h('div', { className: 'tku-table-wrap' },
        h('table', { className: 'tku-table tku-utable' }, [
          h('thead', { key: 'h' }, h('tr', {}, headCells)),
          h('tbody', { key: 'b' }, bodyRows),
        ]))
    }

    function UsagePanel() {
      const zh = isZhUi()
      const [days, setDays] = useState(30)
      const [trendMode, setTrendMode] = useState('daily')
      const [state, setState] = useState({ loading: true, error: null, doc: null })
      // 列宽现在是纯 CSS 的比例（20/20/30/30），不再有拖拽状态、也没有 localStorage 存档。
      // gridWidth 仍然保留：只是为了让面板知道当前是不是窄屏（决定要不要压缩留白）。
      const [gridWidth, setGridWidth] = useState(0)
      const gridRef = useRef(null)

      useEffect(() => {
        const node = gridRef.current
        if (!node || typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
        // 只测宽度：列宽由 CSS 的 fr 决定，这里不再反推任何像素位置。
        const observer = new window.ResizeObserver(() => {
          const width = node.getBoundingClientRect().width
          if (typeof width !== 'number') return
          setGridWidth(width)
        })
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      const load = useCallback(async (refresh) => {
        setState((prev) => ({ loading: true, error: null, doc: prev.doc }))
        const result = await fetchUsage(days, refresh)
        if (result.ok !== true) {
          setState({ loading: false, error: String(result.detail ?? result.status ?? 'unknown'), doc: null })
          return
        }
        setState({ loading: false, error: null, doc: result })
      }, [days])

      useEffect(() => {
        load(false)
      }, [load])

      const doc = state.doc
      const totals = doc?.totals
      const scan = doc?.scan

      const windowButtons = USAGE_WINDOWS.map((value) => h('button', {
        key: 'w' + value,
        type: 'button',
        className: 'tku-mode' + (value === days ? ' on' : ''),
        onClick: () => setDays(value),
      }, value === 3650 ? (zh ? '全部' : 'All') : value + (zh ? ' 天' : 'd')))

      const head = h('header', { key: 'head', className: 'tku-uhead' }, [
        h('div', { key: 't', className: 'tku-uhead-text' }, [
          h('h2', { key: 'h', className: 'tku-title' }, zh ? 'Token 用量统计' : 'Token usage'),
          // 说明与版本自证合成一行：原来各占一段（两行高度），现在用「｜」隔开。
          // 版本自证必须留着——浏览器缓存了旧的 client bundle 时，磁盘和后端都已是新代码，
          // 界面上跑的却还是旧的，表现就是「改了没生效」。这行让那种情况自己说出来，
          // 不必打开开发者工具（桌面版没有入口）。
          // tku-oneline 保证它只占一行（放不下走省略号），title 里放完整文本供悬停查看。
          h('p', { key: 's', className: 'tku-sub tku-oneline', title: zh
            ? '数据来自 DSH 自己的会话日志，按模型来源（provider / 模型）归类；统计范围是本机所有 workspace 的全部会话。｜前端 ' + USAGE_UI_VERSION
            : 'Sourced from DSH session logs, grouped by provider and model, across every workspace on this machine. | front-end ' + USAGE_UI_VERSION },
          zh
            ? '数据来自 DSH 自己的会话日志，按模型来源（provider / 模型）归类；统计范围是本机所有 workspace 的全部会话。'
              + '｜前端 ' + USAGE_UI_VERSION
            : 'Sourced from DSH session logs, grouped by provider and model, across every workspace on this machine.'
              + ' | front-end ' + USAGE_UI_VERSION),
        ]),
        h('div', { key: 'a', className: 'tku-uhead-actions' }, [
          h('div', { key: 'w', className: 'tku-modes' }, windowButtons),
          h('button', {
            key: 'r',
            type: 'button',
            className: 'tku-btn primary',
            disabled: state.loading === true,
            onClick: () => load(true),
          }, state.loading === true ? (zh ? '扫描中…' : 'Scanning…') : (zh ? '刷新' : 'Refresh')),
        ]),
      ])

      if (state.error !== null && doc === null) {
        return h('div', { className: 'tku-root tku-upanel' }, [
          head,
          h('div', { key: 'e', className: 'tku-banner bad' }, (zh ? '读取失败：' : 'Failed: ') + state.error),
        ])
      }

      const stats = h('div', { key: 'stats', className: 'tku-stats' }, [
        h(UsageStat, {
          key: 'all',
          label: zh ? '累计消耗' : 'Total',
          value: totals ? formatTokens(totals.all, zh) : '—',
          hint: totals?.firstDay ? (zh ? '自 ' + totals.firstDay + ' 起' : 'since ' + totals.firstDay) : null,
        }),
        h(UsageStat, {
          key: 'today',
          label: zh ? '今日' : 'Today',
          value: totals ? formatTokens(totals.today, zh) : '—',
          hint: totals?.todayDay ?? null,
        }),
        h(UsageStat, {
          key: 'week',
          label: zh ? '近 7 天' : 'Last 7 days',
          value: totals ? formatTokens(totals.week, zh) : '—',
          hint: null,
        }),
        h(UsageStat, {
          key: 'calls',
          label: zh ? '调用次数' : 'Calls',
          value: totals ? formatExact(totals.calls) : '—',
          hint: totals ? (zh
            ? totals.providers + ' 个来源 · ' + totals.sources + ' 个模型'
            : totals.providers + ' providers · ' + totals.sources + ' models') : null,
        }),
        // 缓存三指标。口径写在 hint 里，因为「命中率」的分母不是所有人默认的那一个：
        // 分母是 input + cacheRead + cacheWrite（喂进去的上下文），**不含 output**
        // ——output 是生成出来的，把它算进分母会让命中率凭空变好看。
        h(UsageStat, {
          key: 'hit',
          label: zh ? '缓存命中' : 'Cache hits',
          value: totals?.cacheHit !== undefined ? formatTokens(totals.cacheHit, zh) : '—',
          hint: zh ? '命中缓存的输入 token' : 'input tokens served from cache',
        }),
        h(UsageStat, {
          key: 'miss',
          label: zh ? '缓存未命中' : 'Cache misses',
          value: totals?.cacheMiss !== undefined ? formatTokens(totals.cacheMiss, zh) : '—',
          hint: zh ? '输入 + 写入缓存' : 'input + cache write',
        }),
        h(UsageStat, {
          key: 'rate',
          label: zh ? '缓存命中率' : 'Cache hit rate',
          value: totals ? formatRate(totals.cacheHitRate, zh) : '—',
          hint: zh ? '命中 ÷（输入 + 命中 + 写入），不含输出' : 'hits ÷ (input + hits + writes), excluding output',
          tone: totals?.cacheHitRate === null ? null : 'good',
        }),
      ])

      const trendToggle = h('div', { className: 'tku-modes' }, [
        h('button', {
          key: 'd',
          type: 'button',
          className: 'tku-mode' + (trendMode === 'daily' ? ' on' : ''),
          onClick: () => setTrendMode('daily'),
        }, zh ? '每日' : 'Daily'),
        h('button', {
          key: 'c',
          type: 'button',
          className: 'tku-mode' + (trendMode === 'cumulative' ? ' on' : ''),
          onClick: () => setTrendMode('cumulative'),
        }, zh ? '累计' : 'Cumulative'),
      ])

      const trendCard = h(UsageCard, { key: 'trend', title: zh ? '消耗趋势' : 'Usage trend', aside: trendToggle },
        doc ? h(UsageTrendChart, { series: doc.series, zh, mode: trendMode }) : null)

      const donutCard = h(UsageCard, { key: 'donut', title: zh ? '来源分布' : 'By provider' },
        doc ? h(UsageDonut, { rows: doc.providers.slice(0, 6), zh }) : null)

      // 排行卡：条目数不设限（原来的 limit: 8 会把第 9 名以后的模型直接丢掉），
      // 多出来的靠卡片内部滚动看。scope 传进 UsageRank 只为在标题旁标出总数。
      const rankCard = h(UsageCard, {
        key: 'rank',
        title: zh ? '模型使用排行' : 'Top models',
        scroll: true,
        aside: doc ? h('span', { className: 'tku-ucard-aside tku-mono' }, (zh ? '共 ' : '') + doc.sources.length + (zh ? ' 个' : '')) : null,
      }, doc ? h(UsageRank, { rows: doc.sources, zh }) : null)

      // 第四张：本机实测模型的能力排行。数据跟 `doc` 同一次请求回来（后端 `ranking`），
      // 名次是「用量 × 榜单分数」，与页面最下方「模型权威排名」（本机可用清单）分工不同，
      // 卡头副标题把这一点写死，免得两张表被当成同一个东西。
      const abilityCard = h(UsageCard, {
        key: 'ability',
        title: zh ? '本机模型能力排行' : 'Local model capability',
        scroll: true,
        aside: h('span', { className: 'tku-ucard-aside' }, zh ? '实际用过的' : 'as actually used'),
      }, doc ? h(UsageAbilityRank, { ranking: doc.ranking ?? null, zh }) : null)

      const tableCard = h(UsageCard, {
        key: 'table',
        title: zh ? '按来源明细' : 'Sources',
        // 明细表行数随来源数增长（本机 27 行），高度必须封顶，否则会把整页拉得很长。
        // is-scroll-table 让表体在自己的框里上下滚动，表头始终可见。
        scroll: 'table',
        aside: doc ? h('span', { className: 'tku-mono' }, (zh ? '共 ' : '') + doc.sources.length + (zh ? ' 个来源 · ' : '') + (zh ? '更新于 ' : 'updated ') + sinceLabel(Date.parse(doc.generatedAt), zh)) : null,
      }, doc ? h(UsageTable, { doc, zh }) : null)

      let footer = null
      if (scan) {
        const megabytes = Math.round(scan.bytes / 1048576)
        footer = h('div', { key: 'foot', className: 'tku-sub tku-ufoot' }, zh
          ? '扫描 ' + scan.files + ' 个会话文件（' + megabytes + ' MB，本次重扫 ' + scan.scannedFiles + ' 个）· '
            + formatExact(scan.messages) + ' 条计费消息 · 耗时 ' + scan.elapsedMs + ' ms'
            + (scan.partial ? ' · 本次因超时未扫完' : '')
            + (scan.unknownSource > 0 ? ' · ' + scan.unknownSource + ' 条记录没有来源信息（已归入「未知来源」）' : '')
          : 'Scanned ' + scan.files + ' session files (' + megabytes + ' MB, ' + scan.scannedFiles + ' rescanned) · '
            + formatExact(scan.messages) + ' billed messages · ' + scan.elapsedMs + ' ms')
      }

      return h('div', { className: 'tku-root tku-upanel' }, [
        head,
        stats,
        // 四张卡。列宽固定 20% / 20% / 30% / 30%（2:2:3:3 的 fr），不再提供拖拽把手：
        // 比例自适应比手动像素更省心，也不会出现「拖过一次之后窗口一变就排不下」。
        h('div', {
          key: 'charts',
          className: 'tku-ugrid',
          ref: gridRef,
        }, [
          trendCard,
          donutCard,
          rankCard,
          abilityCard,
        ]),
        tableCard,
        // 模型权威排名放在最下方：它是「接下来用哪个」的问题，与上面的「过去用了多少」
        // 是两件事，所以独立成一块，也套自己的错误边界。
        h(ModelRankSafe, { key: 'modelrank' }),
        footer,
      ])
    }

    /**
     * 面板的错误边界。
     *
     * 为什么必须有：`main` slot 里的组件一旦在渲染期抛异常，宿主会把整个面板
     * 渲染成空白/回退，**浏览器控制台里那行错误用户看不到**（桌面版没有 devtools
     * 入口），表现就是「点了侧栏按钮什么都没发生」。有了这个边界，同一个故障
     * 会变成页面上的一行红字，用户能直接把原因读给我。
     *
     * React 的错误边界只能用 class 实现（getDerivedStateFromError 是类专有的
     * 生命周期，函数组件没有等价物）。
     */
    class UsageErrorBoundary extends react.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        const { error } = this.state
        if (error !== null && error !== undefined) {
          const detail = String((error && error.message) || error)
          return h('div', { className: 'tku-root tku-upanel' }, [
            h('div', { key: 't', className: 'tku-title' }, 'Token 用量统计'),
            h('div', { key: 'e', className: 'tku-banner bad' },
              '面板渲染失败：' + detail + '（请把这行文字发给维护者）'),
          ])
        }
        return this.props.children
      }
    }

    /** `main` slot 的入口：面板本体套在错误边界里。 */
    function UsagePanelSafe(props) {
      return h(UsageErrorBoundary, null, h(UsagePanel, props))
    }

    // ---- client-model-rank.js ----
// ---- 模型权威排名（用量面板最下方）----
    //
    // 读的是 `${prefix}/model-rank`。两件事在这里汇合，但来源严格分开：
    //   - **能力分数**：公开榜单（后端拉取并缓存），本插件自己不编。
    //   - **有哪些模型**：本机客户端清单 ∩ 你在「平台与模型」里的勾选。
    //
    // 所以页面必须同时写清两句话：分是谁给的、榜里为什么只有这些模型。
    // 尤其不能让人以为「进榜 = 我的账号有权调用」——客户端目录不按订阅过滤。

    /** 上下文窗口：`128K` / `1M`。比 formatTokens 更贴近这个领域的习惯写法。 */
    function formatCtx(value, zh) {
      if (!Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1e6) return (value / 1e6).toFixed(value >= 1e7 ? 0 : 1) + 'M'
      if (value >= 1e3) return Math.round(value / 1e3) + 'K'
      return String(Math.round(value))
    }

    /** 榜单价格：后端已折成「每百万输入 token 美元」。 */
    function formatPrice(value) {
      if (!Number.isFinite(value)) return '—'
      if (value === 0) return '免费'
      if (value < 0.01) return '$' + value.toFixed(4)
      return '$' + value.toFixed(2)
    }

    /** 指数类分数：一位小数。`null`（榜单没给）显示「—」，不显示 0。 */
    function formatScore(value) {
      if (!Number.isFinite(value)) return '—'
      return value.toFixed(1)
    }

    /** 任务卡里的「度量值」列，按该任务的度量单位渲染。 */
    function formatMetric(value, metric, zh) {
      if (!Number.isFinite(value)) return '—'
      if (metric === 'tokens') return formatCtx(value, zh)
      if (metric === 'usd') return formatPrice(value)
      return formatScore(value)
    }

    async function fetchModelRank(refresh) {
      return callJson(DEFAULT_PREFIX + '/model-rank' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' })
    }

    /** 一个模型在榜里的完整能力行。列宽固定，便于纵向比较。 */
    function ModelRankTable(props) {
      const { rows, zh } = props
      if (!Array.isArray(rows) || rows.length === 0) {
        return h('div', { className: 'tku-empty' }, zh ? '没有可排名的模型' : 'Nothing to rank')
      }
      const headCells = [
        h('th', { key: 'n', className: 'num' }, '#'),
        h('th', { key: 'm' }, zh ? '模型' : 'Model'),
        h('th', { key: 'p' }, zh ? '可用平台' : 'Available via'),
        h('th', { key: 'i', className: 'num' }, zh ? '智能' : 'Intel'),
        h('th', { key: 'c', className: 'num' }, zh ? '编码' : 'Coding'),
        h('th', { key: 'g', className: 'num' }, zh ? '智能体' : 'Agentic'),
        h('th', { key: 'x', className: 'num' }, zh ? '上下文' : 'Context'),
        h('th', { key: 'r', className: 'num' }, zh ? '价格/百万' : '$/1M'),
      ]
      const bodyRows = rows.map((row, index) => h('tr', { key: 'r' + index }, [
        h('td', { key: 'n', className: 'num tku-mono tku-muted' }, String(index + 1)),
        h('td', { key: 'm' }, [
          h('span', { key: 'd', className: 'tku-legend-dot', style: { background: paletteOf(index) } }),
          h('span', { key: 'l', className: 'tku-name' }, row.name),
          row.image === true ? h('span', { key: 'v', className: 'tku-mono tku-muted' }, zh ? ' · 图片' : ' · image') : null,
          // 倍率是客户端给的，不是榜单给的——用倍率符号区分，免得被当成分数的一部分。
          Number.isFinite(row.multiplier) ? h('span', { key: 'k', className: 'tku-mono tku-muted' }, ' · x' + row.multiplier) : null,
        ]),
        h('td', { key: 'p', className: 'tku-mono tku-muted' }, providerLabel(row.provider)),
        h('td', { key: 'i', className: 'num tku-mono' }, formatScore(row.intel)),
        h('td', { key: 'c', className: 'num tku-mono' }, formatScore(row.coding)),
        h('td', { key: 'g', className: 'num tku-mono' }, formatScore(row.agentic)),
        h('td', { key: 'x', className: 'num tku-mono' }, formatCtx(row.ctx, zh)),
        h('td', { key: 'r', className: 'num tku-mono' }, formatPrice(row.price)),
      ]))
      return h('div', { className: 'tku-table-wrap' },
        h('table', { className: 'tku-table tku-utable tku-rtable' }, [
          h('thead', { key: 'h' }, h('tr', {}, headCells)),
          h('tbody', { key: 'b' }, bodyRows),
        ]))
    }

    /** 一个任务类型的推荐卡：规则写在卡里，让「为什么它排第一」可当场验证。 */
    function ModelTaskCard(props) {
      const { task, zh } = props
      const rows = Array.isArray(task.rows) ? task.rows : []
      const rule = zh ? task.zhRule : task.enRule
      const label = zh ? task.zhLabel : task.enLabel
      const body = rows.length === 0
        ? h('div', { className: 'tku-empty' }, zh ? '本机可用模型里没有符合这个任务条件的' : 'No locally available model matches this task')
        : h('ol', { className: 'tku-rtask-list' }, rows.map((row, index) => h('li', { key: 'r' + index }, [
          h('span', { key: 'n', className: 'tku-rtask-name' }, row.name),
          h('span', { key: 'p', className: 'tku-rtask-prov tku-mono tku-muted' }, providerLabel(row.provider)),
          h('span', { key: 'v', className: 'tku-rtask-val tku-mono' }, formatMetric(row.value, task.metric, zh)),
        ])))
      return h('div', { className: 'tku-rtask' }, [
        h('div', { key: 'h', className: 'tku-rtask-head' }, [
          h('span', { key: 'l', className: 'tku-rtask-title' }, label),
          h('span', { key: 'r', className: 'tku-rtask-rule', title: rule }, rule),
        ]),
        h('div', { key: 'b', className: 'tku-rtask-body' }, body),
      ])
    }

    function ModelRankSection() {
      const zh = isZhUi()
      const [state, setState] = useState({ loading: true, error: null, doc: null })

      const load = useCallback(async (refresh) => {
        setState((prev) => ({ loading: true, error: null, doc: prev.doc }))
        const result = await fetchModelRank(refresh)
        if (result.ok !== true) {
          setState({
            loading: false,
            error: String(result.detail ?? result.status ?? 'unknown'),
            doc: null,
          })
          return
        }
        setState({ loading: false, error: null, doc: result })
      }, [])

      useEffect(() => {
        load(false)
      }, [load])

      const doc = state.doc
      const counts = doc?.counts

      const aside = h('div', { className: 'tku-uhead-actions' }, [
        doc?.fetchedAt
          ? h('span', { key: 't', className: 'tku-mono tku-muted' },
            (zh ? '榜单 ' : 'board ') + sinceLabel(Date.parse(doc.fetchedAt), zh))
          : null,
        h('button', {
          key: 'r',
          type: 'button',
          className: 'tku-btn',
          disabled: state.loading === true,
          onClick: () => load(true),
        }, state.loading === true ? (zh ? '拉取中…' : 'Loading…') : (zh ? '刷新榜单' : 'Refresh board')),
      ])

      // 头部说明压成一行：原来副标题与下面的「口径声明」各占一段，两段加起来占掉
      // 四行高度，把总榜往下推。现在合成一段（中间用「｜」分隔），不折行时只占一行。
      // 两段都是「事实来源」的说明，放在一起读反而更顺：分数从哪来 + 榜里为什么是这些模型。
      const head = h('header', { key: 'head', className: 'tku-uhead' }, [
        h('div', { key: 't', className: 'tku-uhead-text' }, [
          h('h2', { key: 'h', className: 'tku-title' }, zh ? '模型权威排名' : 'Model leaderboard'),
          h('p', { key: 's', className: 'tku-sub tku-oneline', title: zh
            ? '能力分数来自公开榜单（Artificial Analysis 指数，经 OpenRouter 公开接口取回）；「有哪些模型」只看本机客户端清单与你自己的勾选。两者都不是本插件自己估的。｜进榜的模型都来自本机客户端清单（当前登录的那个区），并已套用你在「平台与模型」里的勾选。客户端目录是产品名册，不按账号订阅过滤，所以某个模型进榜不等于你已有权调用它。'
            : 'Capability scores come from a public leaderboard (Artificial Analysis indices, fetched via OpenRouter\'s public API); "which models exist" comes only from the local client catalog plus your own selections. Neither is estimated by this plugin. | Only models present in the local client catalog (the region you are signed in to) are ranked, after your platform/model selections are applied. That catalog is a product roster, not an entitlement check, so being listed here does not by itself mean your account may call it.' },
          zh
            ? '能力分数来自公开榜单（Artificial Analysis 指数，经 OpenRouter 公开接口取回）；'
              + '「有哪些模型」只看本机客户端清单与你自己的勾选。两者都不是本插件自己估的。'
              + '｜进榜的模型都来自本机客户端清单（当前登录的那个区），并已套用你在「平台与模型」里的勾选。'
              + '客户端目录是产品名册，不按账号订阅过滤，所以某个模型进榜不等于你已有权调用它。'
            : 'Capability scores come from a public leaderboard (Artificial Analysis indices, fetched via OpenRouter\'s public API); '
              + '"which models exist" comes only from the local client catalog plus your own selections. Neither is estimated by this plugin.'
              + ' | Only models present in the local client catalog (the region you are signed in to) are ranked, after your platform/model selections are applied. '
              + 'That catalog is a product roster, not an entitlement check, so being listed here does not by itself mean your account may call it.'),
        ]),
        aside,
      ])

      if (state.error !== null && doc === null) {
        return h('section', { className: 'tku-ucard tku-rsec' }, [
          head,
          h('div', { key: 'e', className: 'tku-banner bad' },
            (zh ? '榜单读取失败：' : 'Leaderboard failed: ') + state.error
              + (zh ? '（下面的排名需要联网；本机清单不受影响）' : ' (ranking needs network; the local catalog is unaffected)')),
        ])
      }

      if (doc === null) {
        return h('section', { className: 'tku-ucard tku-rsec' }, [head])
      }

      // 榜单读取成功但一条都对不上：不是错误，是事实。必须说清楚，否则用户会
      // 以为本机真的没有模型，或者以为排名坏了。
      if (counts && counts.matched === 0) {
        return h('section', { className: 'tku-ucard tku-rsec' }, [
          head,
          h('div', { key: 'w', className: 'tku-banner warn' }, zh
            ? '本机可用模型（' + counts.local + ' 个）在榜单里一个都没匹配上——可能榜单还没收录这些新模型。'
            : 'None of the ' + counts.local + ' locally available models matched the leaderboard — it may not list them yet.'),
        ])
      }

      const banner = doc.stale === true
        ? h('div', { key: 'stale', className: 'tku-banner warn' },
          (zh ? '本次刷新失败，下面是上次成功拉取的榜单：' : 'Refresh failed; showing the last successful fetch: ')
            + String(doc.error ?? ''))
        : null

      // 原来这里还有一个独立的 note 段（口径声明），已合并进头部副标题压成一行。
      const meta = h('div', { key: 'meta', className: 'tku-sub tku-ufoot' }, zh
        ? '本机清单 ' + counts.local + ' 个模型 · 榜单匹配上 ' + counts.matched + ' 个 · 有智能指数的 '
          + counts.scored + ' 个'
          + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' 个未匹配' : '')
        : 'Local catalog ' + counts.local + ' models · ' + counts.matched + ' matched · '
          + counts.scored + ' with an intelligence index'
          + (counts.unmatched > 0 ? ' · ' + counts.unmatched + ' unmatched' : ''))

      const overall = h(UsageCard, {
        key: 'overall',
        title: zh ? '总榜（按智能指数）' : 'Overall (by intelligence index)',
        aside: h('span', { className: 'tku-mono' }, zh ? '本机可用范围内' : 'within local availability'),
        // scroll: 'table' —— 总榜是张表（8 列、12 行），不给这个参数它就只继承
        // .tku-table-wrap 的 overflow-x:auto，纵向不滚：行多时下半截被 .tku-ucard
        // 的 overflow:hidden 剪掉，用户看到「总榜只显示一半，且滚不动」。
        // 复用明细表那套机制：表体封 max-height、内部纵向滚动、表头 sticky 钉住。
        scroll: 'table',
        // extraClass：总榜行数远少于明细表，单独放宽表体高度上限（480px），
        // 12 行能一屏看完，条目更多时仍可滚。
        extraClass: 'is-rank-table',
      }, h(ModelRankTable, { rows: doc.entries, zh }))

      const tasks = h('div', { key: 'tasks', className: 'tku-rtasks' },
        (doc.tasks ?? []).map((task) => h(ModelTaskCard, { key: task.id, task, zh })))

      return h('section', { className: 'tku-ucard tku-rsec' }, [
        head,
        banner,
        overall,
        h('div', { key: 'th', className: 'tku-ucard-title' }, zh ? '按任务类型推荐' : 'Recommendations by task'),
        tasks,
        meta,
      ])
    }

    /** 排名区套在自己的错误边界里：它坏了不能把上面的用量统计一起变成空白。 */
    function ModelRankSafe() {
      return h(UsageErrorBoundary, null, h(ModelRankSection, null))
    }
    // <<< usage-panel parts <<<

    // ---- 注册 ----

    const inject = ['slots']

    /**
     * 注册进 Web 客户端。
     *
     * 宿主没有「在左侧导航加一级菜单」的 slot；官方给的等价做法是
     * `sidebar.panellist` 放一个入口，再往 `main` 注册同 key 的面板
     * ——两者用同一个 id，宿主才会在点侧栏项时把主区域切到这块面板。
     *
     * 用 `ctx.slots.inject` 而不是直接 register：宿主若没声明这个 slot
     * （老版本、或被裁剪的构建），注入不会发生也就不会抛错；直接 register
     * 会在插件激活阶段失败。
     *
     * 注意：sidebar.panellist 的条目必须带一个组件（第三个参数），
     * 宿主用它渲染侧栏里的图标/文字按钮。只传配置不传组件 = 静默不显示。
     */
    function apply(ctx) {
      try {
        ensureCss()
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[dsh-token-usage] css injection failed:', error)
      }

      function UsageSidebarIcon(props) {
        const size = props?.size ?? 16
        const active = props?.active === true
        return h('svg', {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: active ? 'var(--dsw-alias-label-primary, #ffffff)' : 'var(--dsw-alias-label-secondary, #5f5f6b)',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }, [
          h('path', { key: 'p1', d: 'M3 3v18h18' }),
          h('path', { key: 'p2', d: 'M18 17V9' }),
          h('path', { key: 'p3', d: 'M13 17V5' }),
          h('path', { key: 'p4', d: 'M8 17v-3' }),
        ])
      }

      // 侧栏入口与主面板**分开**注册：一个失败不能拖垮另一个。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: USAGE_SLOT_ID,
          order: 90,
          label: () => t('Token 用量', 'Token usage'),
          locale: 'dsh-token-usage',
        }, UsageSidebarIcon))
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[dsh-token-usage] sidebar entry failed to register:', error)
      }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: USAGE_SLOT_ID,
          locale: 'dsh-token-usage',
        }, UsagePanelSafe))
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[dsh-token-usage] usage panel failed to register:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
