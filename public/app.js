// app.js — 前端交互：过期任务防护、错误定位、裁决与证据渲染
'use strict';

const $ = (id) => document.getElementById(id);
const ta = $('spec');
const gutter = $('gutter');
const errorsBox = $('errors');
const statusBox = $('status');
const resultBox = $('result');
const submitBtn = $('submit');
const placementBtn = $('placement');
const cancelBtn = $('cancel');
const dirtyFlag = $('dirty');

// 当前任务代次：只有最新一次提交/取消的结果允许落地渲染
let activeJobId = null;
let inflight = false;
let jobCounter = 0;
let lastResultStale = false; // 规程在得到结果后又被改动
let lastVerdictNondiag = false; // 最近一次裁决是否为不可诊断（布设审计入口）
let auditGen = 0; // 审计代次：草稿编辑/新提交后旧审计的迟到核对不得落地

const EX_SILENT = `# 静默双环：故障迁移 f1 无回执（SILENT），
# 故障后故障侧 (g1,g2) 与正常侧 (h1,h2) 回执序列都是 a,a,... 完全相同
loc 0
loc 1
loc 2
loc 3
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans h1 0 3 N a
trans h2 3 0 N a
`;

const EX_DIAG = `# 可诊断：故障回执 a 之后故障侧只能收到 b；
# 正常侧对 a 的唯一匹配止于汇点 2，无法无限执行，伪装不能持续
loc 0
loc 1
loc 2
init 0
trans f1 0 1 F a
trans t1 1 1 N b
trans n1 0 2 N a
`;

const EX_TWOFAULT = `# 双故障共伪装：f1 静默后故障侧在 1↔2 收到 a,a,...，
# 被正常环 0↔5 伪装；f2 静默后故障侧在 3↔4 收到 b,b,...，
# 被正常环 0↔7 伪装。只标记 f1 或 f2 都不够，最小布设需 2 个专属标记
loc 0
loc 1
loc 2
loc 3
loc 4
loc 5
loc 7
init 0
trans f1 0 1 F SILENT
trans g1 1 2 N a
trans g2 2 1 N a
trans f2 0 3 F SILENT
trans h1 3 4 N b
trans h2 4 3 N b
trans na1 0 5 N a
trans na2 5 0 N a
trans nb1 0 7 N b
trans nb2 7 0 N b
`;

function setText(v) { ta.value = v; ta.dispatchEvent(new Event('input')); }
$('load-silent').addEventListener('click', () => setText(EX_SILENT));
$('load-diag').addEventListener('click', () => setText(EX_DIAG));
$('load-twofault').addEventListener('click', () => setText(EX_TWOFAULT));

// ---- 行号槽 ----
function renderGutter(badLines = new Set()) {
  const n = ta.value.split('\n').length;
  gutter.innerHTML = '';
  for (let i = 1; i <= n; i++) {
    const d = document.createElement('div');
    d.textContent = i;
    if (badLines.has(i)) d.className = 'bad';
    gutter.appendChild(d);
  }
}
ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
ta.addEventListener('input', () => {
  renderGutter();
  auditGen++; // 草稿编辑：旧审计与其候选核对全部作废
  if (inflight) {
    invalidate('规程在计算期间被修改');
  } else if (activeJobId !== null) {
    lastResultStale = true;
    placementBtn.disabled = true;
    dirtyFlag.hidden = false;
  }
});

// ---- 过期任务处理 ----
async function invalidate(reason) {
  const old = activeJobId;
  inflight = false;
  activeJobId = null;
  submitBtn.disabled = false;
  placementBtn.disabled = true;
  cancelBtn.disabled = true;
  if (old) {
    try { await fetch(`/api/jobs/${encodeURIComponent(old)}`, { method: 'DELETE' }); } catch { /* 忽略 */ }
  }
  dirtyFlag.hidden = false;
  dirtyFlag.textContent = `${reason} · 已取消在途任务，旧结果保留但标记过期`;
  setStatus('idle', '在途任务已过期');
}

cancelBtn.addEventListener('click', () => invalidate('已手动取消'));

function setComputing(text) {
  inflight = true;
  submitBtn.disabled = true;
  placementBtn.disabled = true;
  cancelBtn.disabled = false;
  setStatus('computing', text);
}
function setIdleButtons() {
  inflight = false;
  submitBtn.disabled = false;
  cancelBtn.disabled = true;
  // 只有当前草稿与最近一次提交一致、且裁决为不可诊断时，布设审计才可发起
  placementBtn.disabled = !(lastVerdictNondiag && !lastResultStale);
}

function setStatus(kind, text, meta = '') {
  statusBox.className = `status ${kind}`;
  statusBox.textContent = text;
  if (meta) {
    const m = document.createElement('span');
    m.className = 'meta';
    m.textContent = meta;
    statusBox.appendChild(m);
  }
}

// ---- 提交 ----
submitBtn.addEventListener('click', submitSpec);
async function submitSpec() {
  // 新提交取代旧任务
  const previous = activeJobId;
  const jobId = `j${Date.now().toString(36)}-${++jobCounter}`;
  activeJobId = jobId;
  lastResultStale = false;
  lastVerdictNondiag = false;
  auditGen++; // 新判定代次：旧布设审计视图随提交刷新
  dirtyFlag.hidden = true;
  errorsBox.hidden = true;
  resultBox.innerHTML = '';
  setComputing('判定计算中…（verifier 同步积 + 环分析）');

  try {
    const resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, supersedes: previous, spec: ta.value }),
    });
    const payload = await resp.json();
    // 过期任务防护：只有仍是当前任务时才允许落地
    if (jobId !== activeJobId) return;
    setIdleButtons();

    // 409：该任务在服务端已被新规程取代或被取消，UI 已由新动作接管，静默
    if (resp.status === 409) return;
    if (!resp.ok) {
      renderFatal(payload.error ?? `请求失败 ${resp.status}`);
      return;
    }
    lastVerdictNondiag = payload.result?.ok && payload.result.diagnosable === false;
    renderResult(payload.result);
    setIdleButtons();
  } catch (err) {
    if (jobId !== activeJobId) return; // 取消导致的中断，忽略
    setIdleButtons();
    renderFatal(String(err));
  }
}

// ---- 最小独立标记布设审计 ----
placementBtn.addEventListener('click', submitPlacement);
async function submitPlacement() {
  const previous = activeJobId;
  const jobId = `p${Date.now().toString(36)}-${++jobCounter}`;
  activeJobId = jobId;
  const gen = ++auditGen;
  dirtyFlag.hidden = true;
  setComputing('布设审计中…（从存活见证提取必须命中迁移，精确分支定界）');

  try {
    const resp = await fetch('/api/placement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, supersedes: previous, spec: ta.value }),
    });
    const payload = await resp.json();
    if (jobId !== activeJobId || gen !== auditGen) return;
    setIdleButtons();
    if (resp.status === 409) return;
    if (!resp.ok) {
      renderFatal(payload.error ?? `请求失败 ${resp.status}`);
      return;
    }
    renderPlacement(payload.result, gen);
  } catch (err) {
    if (jobId !== activeJobId) return;
    setIdleButtons();
    renderFatal(String(err));
  }
}

// 工程师核对任意候选标记集合（通常是更小集合）下的裁决与稳定反例。
// gen：发起时的审计代次；草稿一旦被编辑/重新提交，迟到响应不再落地。
async function evalMarks(ids, gen, statusEl) {
  const jobId = `e${Date.now().toString(36)}-${++jobCounter}`;
  if (statusEl) statusEl.textContent = '核对中…';
  try {
    const resp = await fetch('/api/placement/eval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, spec: ta.value, marks: ids }),
    });
    const payload = await resp.json();
    if (gen !== auditGen) return null; // 草稿已变更：旧核对不得覆盖当前视图
    if (resp.status === 409) { if (statusEl) statusEl.textContent = '已过期'; return null; }
    if (!resp.ok) { if (statusEl) statusEl.textContent = `错误：${payload.error ?? resp.status}`; return null; }
    return payload.result;
  } catch (e) {
    if (gen !== auditGen) return null;
    if (statusEl) statusEl.textContent = `错误：${String(e)}`;
    return null;
  }
}

function renderFatal(msg) {
  setStatus('idle', '未裁决');
  resultBox.innerHTML = '';
  errorsBox.hidden = false;
  errorsBox.innerHTML = `<h3>服务错误</h3><ul><li>${escapeHtml(msg)}</li></ul>`;
}

// ---- 错误定位（同时清除旧结论）----
function renderErrors(errors) {
  // 清除旧结论
  resultBox.innerHTML = '';
  setStatus('idle', '规程非法，未进行裁决（旧结论已清除）');
  const badLines = new Set();
  errorsBox.hidden = false;
  errorsBox.innerHTML = '<h3>录入错误（点击定位）</h3>';
  const ul = document.createElement('ul');
  for (const e of errors) {
    if (e.line > 0) badLines.add(e.line);
    const li = document.createElement('li');
    const where = e.line > 0
      ? `<span class="loc" data-line="${e.line}" data-col="${e.column}">第 ${e.line} 行${e.column ? ` 第 ${e.column} 列` : ''}</span>：`
      : '';
    li.innerHTML = `${where}${escapeHtml(e.message)}`;
    ul.appendChild(li);
  }
  errorsBox.appendChild(ul);
  errorsBox.querySelectorAll('.loc').forEach((el) => {
    el.addEventListener('click', () => jumpTo(Number(el.dataset.line), Number(el.dataset.col)));
  });
  renderGutter(badLines);
}

function jumpTo(line, col) {
  const lines = ta.value.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  const lineText = lines[line - 1] ?? '';
  const start = offset + Math.max(0, (col || 1) - 1);
  ta.focus();
  ta.setSelectionRange(start, start + Math.max(1, (lineText.length - (col ? col - 1 : 0))));
  // 行高约 13px * 1.65，保证目标行滚动到可视区
  ta.scrollTop = Math.max(0, line - 6) * 13 * 1.65;
  gutter.scrollTop = ta.scrollTop;
}

// ---- 结果渲染 ----
function renderResult(r) {
  renderGutter();
  if (!r.ok) return renderErrors(r.errors);

  const s = r.stats;
  const meta = `位置 ${s.locations} · 迁移 ${s.transitions}（F ${s.faultyTransitions}）· verifier 状态 ${s.verifierStates}`;
  if (r.diagnosable) {
    setStatus('diagnosable', '可诊断：不存在被正常无限执行无限伪装的故障', meta);
    resultBox.innerHTML = checkedPairsCard(r.checkedPairs);
    return;
  }
  setStatus('nondiag', '不可诊断：存在已发生故障的无限执行与正常无限执行，回执序列完全相同', meta);
  resultBox.innerHTML = witnessCard(r.witness) + checkedPairsCard(r.checkedPairs, true);
}

// ---- 最小标记布设审计渲染 ----
function renderPlacement(r) {
  renderGutter();
  if (!r.ok) return renderErrors(r.errors);
  const p = r.placement;

  if (p.alreadyDiagnosable) {
    setStatus('diagnosable',
      '原规程本已可诊断：空布设，无需加装任何专属可观察标记',
      '最小布设 = ∅');
    resultBox.innerHTML = `
      <div class="card">
        <h3>布设裁决：空布设</h3>
        <div class="tabs">原 verifier 中不存在合格双侧闭环，任何已发生故障的执行
        最终都会产出正常执行无法逐元素复制的回执；不需要独立标记。</div>
      </div>`;
    return;
  }

  const s = p.stats;
  setStatus('nondiag',
    `最小布设需 ${p.size} 个专属标记：{ ${p.marks.map(escapeHtml).join(', ')} }；应用后裁决为可诊断`,
    `分支定界节点 ${s.nodesVisited} · 见证复核 ${s.witnessChecks} 次 · 剪枝 ${s.lowerBoundPrunes} · 去重 ${s.dedupSkips} · 候选故障迁移 ${s.faultCandidates}`);

  resultBox.innerHTML = [
    placementSummaryCard(p),
    perMarkCard(p),
    smallerSetsCard(p),
    interactiveEvalCard(),
    baselineTraceCard(p),
  ].join('');
  bindPlacementInteractions();
}

function placementSummaryCard(p) {
  const chips = p.marks.map((m) =>
    `<span class="tag F mark-chip"><code>${escapeHtml(m)}</code></span>`).join(' ');
  return `
  <div class="card">
    <h3>全局最小布设（按迁移标识稳定裁决）</h3>
    <div class="tabs">
      最少标记数 <b>${p.size}</b>；标记集合（标识字典序最小的最小解，重复审计可复现）：
    </div>
    <div style="margin:6px 0">${chips || '<span class="silent">∅</span>'}</div>
    <div class="tabs">
      语义：被选迁移故障侧回执变为仅该迁移可产生的独立观测 <code>m_t</code>，
      正常副本（删除全部 F 迁移）无任何执行能产出它；规程其余迁移零改写。
    </div>
    <div class="verdict-good">✓ 终裁复核：应用该集合后已无合格双侧闭环，新裁决＝<b>可诊断</b></div>
  </div>`;
}

function witnessDetails(w, { open = false, title = '' } = {}) {
  const seqP = w.prefixObservable.map((x) => escapeHtml(x)).join(' ');
  const seqL = w.loopObservable.map((x) => escapeHtml(x)).join(' ');
  const hit = (w.hitFaultTrans || []).map((x) =>
    `<span class="tag F"><code>${escapeHtml(x)}</code></span>`).join(' ') ||
    '<span class="silent">（无 F 迁移）</span>';
  const same = w.sequencesIdentical
    ? '<span style="color:var(--good)">✓ 双侧回执逐元素相同</span>'
    : '<span style="color:var(--bad)">✗ 序列核验失败</span>';
  return `
  <details class="witness-details"${open ? ' open' : ''}>
    <summary>${title}
      <span class="tabs" style="display:inline">
        前缀回执 ${w.prefixReceiptLength} · 闭环回执 ${w.loopReceiptLength} · 必须命中 ${hit}
      </span>
    </summary>
    <div class="seq" style="margin-top:6px">
      <span class="prefix-part">${seqP || '∅'}</span>
      <span class="loop-part"> [ ${seqL || 'ε'} ] ω</span>
    </div>
    <div class="tabs" style="margin-top:6px">${same}；入口对：故障侧
      <b>${escapeHtml(w.entry.p)}</b> × 正常侧 <b>${escapeHtml(w.entry.q)}</b></div>
    ${stepTable(w.prefix, w.loop)}
  </details>`;
}

function perMarkCard(p) {
  const blocks = p.perMarkConstraints.map((c) => `
    <div class="constraint">
      <div class="tabs">标记 <span class="tag F"><code>${escapeHtml(c.mark)}</code></span>
        打断的反例约束：撤下该标记（保留其余 ${p.size - 1} 个）后，必复活一条
        <b>实际经过 <code>${escapeHtml(c.mark)}</code></b> 的无限伪装——
        其必须命中集合含该标记，故该标记不可由其余标记替代。</div>
      ${witnessDetails(c.witness, { title: `反例约束 · ${escapeHtml(c.mark)}` })}
    </div>`).join('');
  return `
  <div class="card">
    <h3>每个被选标记打断的反例约束（${p.perMarkConstraints.length} 条）</h3>
    ${blocks}
  </div>`;
}

function smallerSetsCard(p) {
  const rows = p.smallerSetWitnesses.map((row) => {
    const setTxt = row.set.length
      ? row.set.map((x) => escapeHtml(x)).join(', ')
      : '∅（空布设＝原规程）';
    return `
      <div class="constraint">
        <div class="tabs">更小集合（${row.size} < ${p.size}）：<code>{ ${setTxt} }</code>
          —— 仍保留稳定反例，伪装未被消除。</div>
        ${witnessDetails(row.witness, {
          title: `稳定反例摘要 · 尺寸 ${row.size}`,
        })}
      </div>`;
  }).join('');
  return `
  <div class="card">
    <h3>任一更小集合仍保留的稳定反例（最优集合的全部真前缀）</h3>
    <div class="tabs">这些反例均由遮罩 verifier 上的合格双侧闭环给出（非有限回放猜测）；
      工程师还可在下方核对任意其它更小集合。</div>
    ${rows}
  </div>`;
}

function interactiveEvalCard() {
  return `
  <div class="card" id="eval-card">
    <h3>核对任意候选标记集合</h3>
    <div class="tabs">输入故障迁移标识（空白或逗号分隔），查看该布设下的裁决；
      若仍不可诊断，给出该集合下的稳定反例摘要。</div>
    <div class="toolbar">
      <input id="eval-input" type="text" placeholder="例如：f1 f2" spellcheck="false"
        class="eval-input" />
      <button id="eval-btn" type="button">核对该集合</button>
      <span id="eval-status" class="tabs"></span>
    </div>
    <div id="eval-out"></div>
  </div>`;
}

function baselineTraceCard(p) {
  const rows = p.trace.map((t) => {
    const setTxt = t.set.length ? t.set.map(escapeHtml).join(', ') : '∅';
    const hit = t.hitFaultTrans.length ? t.hitFaultTrans.map(escapeHtml).join(', ') : '—';
    return `<tr class="${t.killed ? 'killed' : ''}">
      <td>${t.size}</td>
      <td class="mono">{ ${setTxt} }</td>
      <td>${t.killed ? '<span style="color:var(--good)">伪装消灭</span>'
        : `必须命中 { ${hit} }`}</td>
    </tr>`;
  }).join('');
  return `
  <div class="card">
    <h3>分支定界过程${p.traceTruncated ? '（仅前 500 个节点）' : ''}</h3>
    <div class="tabs">每个节点都是一次“布设 → 重建遮罩 verifier → 复核合格双侧闭环”：
      从存活见证提取必须命中的故障迁移集合并沿其分支，被同一子集重复到达时去重。</div>
    <table>
      <tr><th>布设尺寸</th><th>候选布设</th><th>复核结果 / 必须命中集合</th></tr>
      ${rows}
    </table>
  </div>`;
}

function bindPlacementInteractions() {
  const gen = auditGen;
  const btn = $('eval-btn');
  const input = $('eval-input');
  const statusEl = $('eval-status');
  const out = $('eval-out');
  if (!btn) return;
  const run = async () => {
    const ids = input.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    btn.disabled = true;
    const r = await evalMarks(ids, gen, statusEl);
    if (gen !== auditGen) return;
    btn.disabled = false;
    if (!r) return;
    if (!r.ok) {
      statusEl.innerHTML = `非法标识：${r.invalid.map(escapeHtml).join(', ')}（只能是本规程的 F 迁移）`;
      return;
    }
    const setTxt = r.marked.length ? r.marked.map(escapeHtml).join(', ') : '∅';
    statusEl.innerHTML = r.diagnosable
      ? `<span style="color:var(--good)">集合 { ${setTxt} } 下裁决＝可诊断</span>`
      : `<span style="color:var(--bad)">集合 { ${setTxt} } 下仍不可诊断，稳定反例如下</span>`;
    out.innerHTML = r.diagnosable
      ? '<div class="tabs" style="margin-top:8px">遮罩 verifier 中已无 f=1 合格双侧闭环。</div>'
      : witnessDetails(r.witness, { open: true, title: `该集合下的稳定反例 · { ${setTxt} }` });
  };
  btn.addEventListener('click', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
}

function witnessCard(w) {
  const seqP = w.prefixObservable.map((x) => escapeHtml(x)).join(' ');
  const seqL = w.loopObservable.map((x) => escapeHtml(x)).join(' ');
  const same = w.sequencesIdentical
    ? '<span style="color:var(--good)">✓ 两侧可观察序列逐元素相同</span>'
    : '<span style="color:var(--bad)">✗ 内部校验失败：序列不一致</span>';
  return `
  <div class="card">
    <h3>最短共同前缀（公共可观察回执长度 ${w.prefixReceiptLength}）</h3>
    <div class="seq"><span class="prefix-part">${seqP || '∅（故障静默，前缀无任何回执）'}</span></div>
    <h3 style="margin-top:12px">可重复闭环（每轮回执长度 ${w.loopReceiptLength}，可无限重复）</h3>
    <div class="seq"><span class="loop-part">[ ${seqL} ] ω</span></div>
    <div class="tabs" style="margin-top:8px">${same}</div>
    <h3 style="margin-top:10px">两侧逐步迁移对应</h3>
    ${stepTable(w.prefix, w.loop)}
    <div class="tabs" style="margin-top:8px">
      入口对：故障侧 <b>${escapeHtml(w.entry.p)}</b> × 正常侧 <b>${escapeHtml(w.entry.q)}</b>；
      故障侧序列＝前缀后无限重复闭环（含 F 迁移）；正常侧序列＝同样回执的无限执行（全程 N）。
      <span class="tag fsilent">SILENT 步</span><span class="tag sync">同步回执步</span>
    </div>
  </div>`;
}

function stepTable(prefix, loop) {
  const row = (s, phase, i) => {
    const f = s.faultySide;
    const n = s.normalSide;
    const modeTag = s.mode === 'SYNC'
      ? '<span class="tag sync">同步</span>'
      : s.mode === 'F_SILENT'
        ? '<span class="tag fsilent">故障侧静默</span>'
        : '<span class="tag fsilent">正常侧静默</span>';
    const fKind = f.transId ? `<span class="tag ${f.faulty ? 'F' : 'N'}">${f.faulty ? 'F' : 'N'}</span>` : '';
    const side = (x) => x.transId
      ? `${escapeHtml(x.from)} → ${escapeHtml(x.to)} <code>${escapeHtml(x.transId)}</code>${x.silent ? ' <span class="silent">(静默)</span>' : ''}`
      : '<span class="silent">—（本步不动）</span>';
    return `<tr class="${phase === 'loop' ? 'looprow' : ''}">
      <td>${phase === 'prefix' ? `前缀${i + 1}` : `闭环${i + 1}`}</td>
      <td>${modeTag}${s.receipt !== null ? `<code>${escapeHtml(s.receipt)}</code>` : '<span class="silent">ε</span>'}</td>
      <td class="mono">${fKind}${side(f)}</td>
      <td class="mono">${n ? '<span class="tag N">N</span>' : ''}${side(n ?? { transId: null })}</td>
    </tr>`;
  };
  const p = prefix.map((s, i) => row(s, 'prefix', i)).join('');
  const l = loop.map((s, i) => row(s, 'loop', i)).join('');
  return `<table class="pair-table">
    <tr><th>阶段</th><th>可观察回执</th><th>故障侧执行（已发生故障）</th><th>正常侧执行（从未故障）</th></tr>
    ${p}${l}
  </table>`;
}

function checkedPairsCard(pairs, compact = false) {
  if (!pairs || pairs.length === 0) {
    return `<div class="card"><h3>已检查的诊断对</h3><div class="tabs">无 f=1 混淆对（系统中没有可被混淆的故障时刻）。</div></div>`;
  }
  const label = {
    ambiguous: '歧义（双侧无限）',
    acyclic: '无环 · 混淆有限',
    'normal-side-stalls': '正常侧停滞 · 非无限',
    'fault-side-stalls': '故障侧停滞',
  };
  const rows = pairs.map((x) =>
    `<tr><td class="mono">${escapeHtml(x.p)}</td><td class="mono">${escapeHtml(x.q)}</td>
     <td>${x.movesF ? '✓' : '—'}</td><td>${x.movesN ? '✓' : '—'}</td>
     <td>${label[x.verdict] ?? x.verdict}</td></tr>`).join('');
  return `<div class="card">
    <h3>已检查的诊断对摘要${compact ? '（节选全部 f=1 可达对）' : ''}</h3>
    <table>
      <tr><th class="mono">故障侧位置</th><th class="mono">正常侧位置</th><th>环内故障侧可动</th><th>环内正常侧可动</th><th>结论</th></tr>
      ${rows}
    </table>
  </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 初始化
renderGutter();
ta.value = EX_SILENT;
renderGutter();
