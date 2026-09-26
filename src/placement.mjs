// placement.mjs — 最小独立可观察标记布设审计（仅在原规程已判不可诊断后发起）
//
// 命题：给哪些【故障迁移】加装专属可观察标记（加装后该迁移在故障侧的
// 回执成为只有它自己能产生的独立观测 m_t，正常副本不保留任何 F 迁移，
// 故没有任何正常执行能产出 m_t；规程其余部分一律不改写），才能使任何
// 已发生故障的无限执行都不再被始终正常的执行伪装。求全局最少标记数与
// 按迁移标识稳定裁决的标记集合，并给出应用该集合后的新裁决。
//
// 语义不变式（不改写原规程）：
//   marked=∅ 时遮罩 verifier 与 src/diagnoser.mjs 的原 verifier 逐边相同；
//   加装标记只“阻断”故障副本中实际经过被选 F 的同步配对，不新增、不重写
//   任何迁移。
//
// 求解（精确分支定界，绝不逐个试装后用有限回放猜测）：
//   对任一仍存活的无限伪装见证 W（合格双侧闭环：前缀 + 闭环内故障侧与
//   正常侧都无限移动、可观察回执逐元素相同），定义必须命中集合
//   H(W) = W 实际经过的故障迁移。任何能消灭 W 的布设都必须包含 H(W)
//   中至少一个迁移，于是：
//     · 分支：只沿 H(W) 的成员展开 D∪{t}，而非枚举全部迁移；
//     · 每个候选布设都【重新构造遮罩 verifier 并复核】是否仍存在合格
//       双侧闭环（SCC + 增强空间 mask=3 闭合游走），而非沿用上轮结论；
//     · 下界：子节点至少再多 1 个标记，d+1 ≥ 当前上界 L 时整支剪枝；
//       不同分支顺序会合到的同一子集用闭合表去重，只复核一次；
//     · 上界初始为“标记全部故障迁移”（f=1 再不可达，必然可诊断）。
//   搜索穷尽后 L 即全局最小布设尺寸；同尺寸平局取迁移标识序列字典序
//   最小者，裁决可复现。

// 二叉堆：按 (cost, key) 排序，供最短通路 / 合格闭环 Dijkstra 复用
function heap() {
  const a = [];
  const less = (x, y) => x[0] - y[0] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0);
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(a[i], a[p]) < 0) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < a.length && less(a[l], a[m]) < 0) m = l;
      if (r < a.length && less(a[r], a[m]) < 0) m = r;
      if (m === i) break;
      [a[i], a[m]] = [a[m], a[i]];
      i = m;
    }
  };
  return {
    push: (item) => { a.push(item); up(a.length - 1); },
    pop: () => { const t = a[0], l = a.pop(); if (a.length) { a[0] = l; down(0); } return t; },
    get size() { return a.length; },
  };
}

// 构造带标记遮罩的 verifier。marked 为已装专属标记的故障迁移标识集合。
// 与原 verifier 的唯一区别：被选故障迁移 t 在故障侧发出仅 t 可产生的
// 独有回执 m_t——正常副本（删除全部 F 迁移的同一自动机）没有任何迁移
// 能产出 m_t，故任何实际经过 t 的双侧配对都不可能回执逐元素相同，
// 含 t 的故障侧一步在同步积中不产生边（静默 t 被标记后同样不再静默）。
// marked=∅ 时本构造与原 verifier 逐边一致（规程零改写）。
export function buildMaskedVerifier(model, marked) {
  const { init, transitions } = model;
  const outF = new Map();
  const outN = new Map();
  // 故障副本：完整自动机；正常副本：删除全部 F 迁移（与原 verifier 相同）
  for (const t of transitions) {
    if (!outF.has(t.src)) outF.set(t.src, []);
    outF.get(t.src).push(t);
    if (t.faulty) continue;
    if (!outN.has(t.src)) outN.set(t.src, []);
    outN.get(t.src).push(t);
  }
  const fromF = (p) => outF.get(p) ?? [];
  const fromN = (q) => outN.get(q) ?? [];

  const states = new Map();
  const get = (p, q, f) => {
    const k = `${p} ${q} ${f}`;
    let s = states.get(k);
    if (!s) {
      s = { id: states.size, p, q, f, edges: [] };
      states.set(k, s);
    }
    return s;
  };

  let edgeSeq = 0;
  const queue = [];
  const addEdge = (s, ns, edge) => {
    s.edges.push({ seq: edgeSeq++, ...edge, to: ns });
    if (!ns.enqueued) { ns.enqueued = true; queue.push(ns); }
  };

  const start = get(init, init, 0);
  queue.push(start);
  for (let head = 0; head < queue.length; head++) {
    const s = queue[head];
    const a = fromF(s.p);
    const b = fromN(s.q);

    // F_SILENT：故障副本单独静默一步。
    // 已标记 F 的回执是独有 m_t（即便原为 SILENT），不可能与正常副本对齐，
    // 因此它不产生任何同步积边。
    for (const x of a) {
      if (!x.silent) continue;
      if (x.faulty && marked.has(x.id)) continue;
      const ns = get(x.dst, s.q, s.f | (x.faulty ? 1 : 0));
      addEdge(s, ns, { mode: 'F_SILENT', fTrans: x, nTrans: null, receipt: null });
    }

    // N_SILENT：正常副本单独静默一步（正常副本中已无 F）
    for (const y of b) {
      if (!y.silent) continue;
      const ns = get(s.p, y.dst, s.f);
      addEdge(s, ns, { mode: 'N_SILENT', fTrans: null, nTrans: y, receipt: null });
    }

    // SYNC：双侧非静默且回执相同。
    // 已标记 F 发出独有 m_t，正常副本没有任何匹配回执 ⇒ 跳过。
    for (const x of a) {
      if (x.silent) continue;
      if (x.faulty && marked.has(x.id)) continue;
      for (const y of b) {
        if (y.silent || x.receipt !== y.receipt) continue;
        const ns = get(x.dst, y.dst, s.f | (x.faulty ? 1 : 0));
        addEdge(s, ns, { mode: 'SYNC', fTrans: x, nTrans: y, receipt: x.receipt });
      }
    }
  }

  return { states: [...states.values()], start };
}

function reachable(start) {
  const seen = new Set([start]);
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    for (const e of q[h].edges) {
      if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  return seen;
}

const edgeKey = (e) =>
  `${e.fTrans?.id ?? ''}|${e.nTrans?.id ?? ''}|${e.mode}`;
const recvCount = (edges) => edges.filter((e) => e.receipt !== null).length;
const pathKey = (edges) => edges.map(edgeKey).join(',');
const edgeWeight = (e) => (e.mode === 'SYNC' ? 1 : 0);

function dijkstraAll(start) {
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: start, pathKey: '' };
  best.set(start.id, startRec);
  h.push([0, start, '']);
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(node.id);
    if (!rec || rec.cost !== cost) continue;
    for (const e of node.edges) {
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(e.to.id);
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: e.to, pathKey: nkey };
        best.set(e.to.id, nr);
        h.push([ncost, e.to, nkey]);
      }
    }
  }
  return best;
}

function recToEdges(rec) {
  const edges = [];
  for (let r = rec; r.parent; r = r.parent.rec) edges.push(r.parent.edge);
  return edges.reverse();
}

// 合格双侧闭环：s 出发回到 s，只走分量内部边，且环内既移动故障副本、
// 又移动正常副本（增强空间 (s, mask)，mask=3 为双侧都动过）
function qualifyingCycle(s, compOf, cid) {
  const startNode = { vs: s, mask: 0 };
  const keyOf = (n) => n.vs.id * 4 + n.mask;
  const h = heap();
  const best = new Map();
  const startRec = { cost: 0, parent: null, node: startNode, pathKey: '' };
  best.set(keyOf(startNode), startRec);
  h.push([0, startNode, '']);
  let goalRec = null;
  while (h.size) {
    const [cost, node] = h.pop();
    const rec = best.get(keyOf(node));
    if (!rec || rec.cost !== cost) continue;
    if (node.vs === s && node.mask === 3) { goalRec = rec; break; }
    for (const e of node.vs.edges) {
      if (compOf.get(e.to) !== cid) continue;
      const next = {
        vs: e.to,
        mask: node.mask | (e.fTrans ? 1 : 0) | (e.nTrans ? 2 : 0),
      };
      const ncost = cost + edgeWeight(e);
      const nkey = rec.pathKey + edgeKey(e) + ',';
      const known = best.get(keyOf(next));
      if (!known || ncost < known.cost ||
          (ncost === known.cost && nkey < known.pathKey)) {
        const nr = { cost: ncost, parent: { rec, edge: e }, node: next, pathKey: nkey };
        best.set(keyOf(next), nr);
        h.push([ncost, next, nkey]);
      }
    }
  }
  return goalRec ? recToEdges(goalRec) : null;
}

function stepView(e) {
  return {
    mode: e.mode,
    receipt: e.receipt,
    faultySide: e.fTrans ? {
      transId: e.fTrans.id,
      from: e.fTrans.src,
      to: e.fTrans.dst,
      faulty: e.fTrans.faulty,
      silent: e.fTrans.silent,
    } : null,
    normalSide: e.nTrans ? {
      transId: e.nTrans.id,
      from: e.nTrans.src,
      to: e.nTrans.dst,
      silent: e.nTrans.silent,
    } : null,
  };
}

// 在遮罩 marked 下寻找稳定的无限伪装见证；不存在（即可诊断）时返回 null。
// 稳定裁决与原审计一致：先比前缀回执长度、再比闭环回执长度、
// 平局按迁移标识拼接键。
// options.mustHit：若非空 Set，只保留【前缀或闭环实际经过其中某条故障
// 迁移】的见证（用于提取“某标记一旦撤下必复活、且必被该标记打断”的反例）；
// 此时会扫描全部入口而不仅是最短前缀入口。
export function findMasqueradeWitness(model, marked, tarjanImpl, options = {}) {
  const mustHit = options.mustHit ?? null;
  const v = buildMaskedVerifier(model, marked);
  const { compOf, comps } = tarjanImpl(v.states);
  const fromStart = reachable(v.start);

  const ambiguous = v.states.filter((s) => {
    if (s.f !== 1 || !fromStart.has(s)) return false;
    const c = comps[compOf.get(s)];
    return c.movesF && c.movesN;
  });
  if (ambiguous.length === 0) return null;

  const allBest = dijkstraAll(v.start);
  const byComp = new Map();
  for (const s of ambiguous) {
    const cid = compOf.get(s);
    if (!byComp.has(cid)) byComp.set(cid, []);
    byComp.get(cid).push(s);
  }

  const traverses = (prefix, loop) => {
    if (!mustHit || mustHit.size === 0) return true;
    for (const e of [...prefix, ...loop]) {
      if (e.fTrans?.faulty && mustHit.has(e.fTrans.id)) return true;
    }
    return false;
  };

  const candidates = [];
  for (const [cid, members] of byComp) {
    // 无 mustHit 时只考察最短前缀入口（与原审计一致）；
    // 有 mustHit 时必须遍历全部入口，因为命中该迁移的见证可能入口更长。
    let minCost = Infinity;
    for (const s of members) {
      const c = allBest.get(s.id)?.cost ?? Infinity;
      if (c < minCost) minCost = c;
    }
    for (const s of members) {
      if (!mustHit && (allBest.get(s.id)?.cost ?? Infinity) !== minCost) continue;
      const rec = allBest.get(s.id);
      const prefix = rec ? recToEdges(rec) : null;
      const loop = qualifyingCycle(s, compOf, cid);
      if (prefix && loop && traverses(prefix, loop)) {
        candidates.push({ entry: { p: s.p, q: s.q }, prefix, loop });
      }
    }
  }
  if (candidates.length === 0) return null; // 无（命中指定迁移的）合格双侧闭环

  candidates.sort((a, b) => {
    const d1 = recvCount(a.prefix) - recvCount(b.prefix);
    if (d1 !== 0) return d1;
    const d2 = recvCount(a.loop) - recvCount(b.loop);
    if (d2 !== 0) return d2;
    return `${pathKey(a.prefix)}#${pathKey(a.loop)}`.localeCompare(
      `${pathKey(b.prefix)}#${pathKey(b.loop)}`);
  });

  const win = candidates[0];
  const prefix = win.prefix.map(stepView);
  const loop = win.loop.map(stepView);

  // 见证实际经过的故障迁移：任何消灭该见证的布设都必须命中其中之一。
  // 存活见证不可能经过已标记 F（其独有回执在同步积中无匹配边）。
  const hit = new Set();
  for (const st of [...prefix, ...loop]) {
    if (st.faultySide && st.faultySide.faulty) hit.add(st.faultySide.transId);
  }
  return {
    entry: win.entry,
    prefix,
    loop,
    hitFaultTrans: [...hit].sort(),
    verifierStates: v.states.length,
  };
}

// 两侧可观察回执逐元素一致性核验（断言式，构造本身保证）
function withSequenceCheck(w) {
  const seqF = [];
  const seqN = [];
  for (const st of [...w.prefix, ...w.loop]) {
    if (st.faultySide && !st.faultySide.silent && st.receipt !== null) seqF.push(st.receipt);
    if (st.normalSide && !st.normalSide.silent && st.receipt !== null) seqN.push(st.receipt);
  }
  const prefixObs = w.prefix.map((s) => s.receipt).filter((r) => r !== null);
  const loopObs = w.loop.map((s) => s.receipt).filter((r) => r !== null);
  return {
    entry: w.entry,
    prefix: w.prefix,
    loop: w.loop,
    hitFaultTrans: w.hitFaultTrans,
    prefixObservable: prefixObs,
    loopObservable: loopObs,
    prefixReceiptLength: prefixObs.length,
    loopReceiptLength: loopObs.length,
    faultySideObservable: seqF,
    normalSideObservable: seqN,
    sequencesIdentical: seqF.join('') === seqN.join(''),
  };
}

// 精确分支定界求全局最小布设。
//
// 搜索节点即布设 D（子集）。每次在 D 下重新构造遮罩 verifier 复核：
//   · 仍有存活见证 W ⇒ 得到必须命中子句 H(W)（W 实际经过的故障迁移），
//     仅沿 H(W) 的成员分支（D∪{t}），而不是枚举全部迁移；
//   · 已无合格双侧闭环 ⇒ D 可行，更新全局上界。
// 重复子集（不同分支顺序会合到同一 D）用闭合表去重，只复核一次。
// 下界：任何子节点至少再含 1 个标记，故 d+1 ≥ L 整支剪枝。
// 同尺寸平局按迁移标识序列字典序取最小，裁决稳定。
export function minimalMarkPlacement(model, tarjanImpl) {
  const faultIds = [...new Set(
    model.transitions.filter((t) => t.faulty).map((t) => t.id),
  )].sort();

  const W0 = findMasqueradeWitness(model, new Set(), tarjanImpl);
  if (!W0) {
    // 原规程本已可诊断：空布设，不做任何加装
    return {
      alreadyDiagnosable: true,
      size: 0,
      marks: [],
      baseline: null,
      perMarkConstraints: [],
      smallerSetWitnesses: [],
      trace: [],
      stats: { nodesVisited: 1, witnessChecks: 1, lowerBoundPrunes: 0, dedupSkips: 0, faultCandidates: faultIds.length },
    };
  }

  // 上界：标记全部故障迁移（故障侧再无 F 可走，f=1 不可达，必然可诊断）
  let L = faultIds.length;
  let best = faultIds.slice();
  let nodesVisited = 0;
  let witnessChecks = 1; // W0
  let lowerBoundPrunes = 0;
  let dedupSkips = 0;
  const visited = new Set();
  const TRACE_CAP = 500;
  const trace = [];
  const recordTrace = (setArr, killed, hit) => {
    if (trace.length >= TRACE_CAP) return;
    trace.push({ size: setArr.length, set: setArr, killed, hitFaultTrans: hit });
  };
  const setKey = (arr) => arr.join(',');
  const lexLess = (a, b) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) return true;
      if (i >= b.length) return false;
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  };

  // 显式栈分支定界（故障迁移可能很多，避免递归栈溢出）。
  // 每个栈帧 { Dset, Darr, W }（W 为该布设下已复核的存活见证）。
  // 平局裁决与展开顺序无关：同尺寸可行解一律用 lexLess 比对取最小。
  const stack = [{ Dset: new Set(), Darr: [], W: W0 }];
  visited.add('');
  while (stack.length) {
    const { Dset, Darr, W } = stack.pop();
    nodesVisited++;
    const d = Darr.length;
    if (d >= L) {
      // 尺寸已达现界：子节点必更大，整支剪枝
      lowerBoundPrunes++;
      recordTrace(Darr, false, W.hitFaultTrans);
      continue;
    }
    recordTrace(Darr, false, W.hitFaultTrans);
    // 压栈顺序与处理顺序相反：用倒序压入使标识最小的候选先处理
    const children = W.hitFaultTrans;
    for (let i = children.length - 1; i >= 0; i--) {
      const t = children[i];
      if (d + 1 > L) { continue; } // 下界：子节点尺寸严格大于现界
      const D2arr = [...Darr, t].sort();
      const key = setKey(D2arr);
      if (visited.has(key)) { dedupSkips++; continue; }
      visited.add(key);
      const D2set = new Set(D2arr);
      const W2 = findMasqueradeWitness(model, D2set, tarjanImpl);
      witnessChecks++;
      if (!W2) {
        // 候选 D∪{t} 下持续复核确认：已无合格双侧闭环
        if (D2arr.length < L || (D2arr.length === L && lexLess(D2arr, best))) {
          L = D2arr.length;
          best = D2arr;
        }
        lowerBoundPrunes++;
        recordTrace(D2arr, true, []);
        continue;
      }
      stack.push({ Dset: D2set, Darr: D2arr, W: W2 });
    }
  }

  // 终裁复核：最优布设下必须确无合格双侧闭环
  const finalWitness = findMasqueradeWitness(model, new Set(best), tarjanImpl);
  witnessChecks++;
  if (finalWitness !== null) {
    throw new Error('内部错误：最小布设复核仍存在伪装见证');
  }

  // 每个被选标记打断的反例约束：撤掉任一单个标记，必能找到一条经过该
  // 标记的稳定反例复活（mustHit 强制），即该标记确实独立打断了一条
  // 无限伪装；否则该标记并非必要，与全局最小性矛盾。
  const perMarkConstraints = best.map((t) => {
    const rest = new Set(best.filter((x) => x !== t));
    const w = findMasqueradeWitness(model, rest, tarjanImpl, { mustHit: new Set([t]) });
    witnessChecks++;
    if (!w) throw new Error(`内部错误：标记 ${t} 不满足最小性（撤下后无经该迁移的反例）`);
    if (!w.hitFaultTrans.includes(t)) {
      throw new Error(`内部错误：撤掉 ${t} 后的反例不经过该迁移`);
    }
    return { mark: t, witness: withSequenceCheck(w) };
  });

  // 任一更小集合仍保留的稳定反例：最优集合按标识递增的每个真前缀
  const smallerSetWitnesses = [];
  for (let d = 0; d < best.length; d++) {
    const subset = best.slice(0, d);
    const w = findMasqueradeWitness(model, new Set(subset), tarjanImpl);
    witnessChecks++;
    if (!w) throw new Error('内部错误：更小前缀竟已可诊断，与全局最小矛盾');
    smallerSetWitnesses.push({ size: d, set: subset, witness: withSequenceCheck(w) });
  }

  return {
    alreadyDiagnosable: false,
    size: best.length,
    marks: best.slice(),
    baseline: withSequenceCheck(W0),
    perMarkConstraints,
    smallerSetWitnesses,
    trace,
    traceTruncated: trace.length >= TRACE_CAP,
    stats: {
      nodesVisited,
      witnessChecks,
      lowerBoundPrunes,
      dedupSkips,
      faultCandidates: faultIds.length,
      traceCap: TRACE_CAP,
    },
  };
}

// 查看任意布设下的裁决与稳定反例（供工程师核对更小集合）
export function evaluateMarks(model, ids, tarjanImpl) {
  const markedArr = [...new Set(ids.map(String))].sort();
  const known = new Set(model.transitions.map((t) => t.id));
  const faultIds = new Set(
    model.transitions.filter((t) => t.faulty).map((t) => t.id));
  const invalid = markedArr.filter((id) => !known.has(id) || !faultIds.has(id));
  if (invalid.length > 0) {
    return { ok: false, invalid };
  }
  const w = findMasqueradeWitness(model, new Set(markedArr), tarjanImpl);
  return {
    ok: true,
    marked: markedArr,
    diagnosable: w === null,
    witness: w ? withSequenceCheck(w) : null,
  };
}
