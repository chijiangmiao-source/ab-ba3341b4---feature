// markers.mjs — 最小独立标记布设审计
//
// 问题：故障闭环审计判为不可诊断后，选择最少的故障迁移加装
// “专属可观察标记”（其故障侧回执成为仅该迁移可产生的独立观测），
// 使任何已发生故障的无限执行都无法再被始终正常的执行无限伪装。
//
// 语义（见 diagnoser.mjs）：被标记迁移在 verifier 的故障副本中不可用
// ——它产生的独立观测正常侧永远无法匹配，经过它的故障执行立即暴露。
// 因此布设 M 合格 ⇔ 以 M 标记后的 verifier 可诊断。原规程不被改写。
//
// 求解（约束生成 + 精确分支定界；不逐个试装、不凭有限回放猜测）：
//   1) M ← 当前约束族的最小命中集（精确分支定界，按迁移标识稳定裁决）；
//   2) 以 M 标记后精确复核：若仍存在合格双侧闭环（无限伪装见证），
//      从该见证提取必须命中的故障迁移集合 C —— 见证前缀∪闭环故障侧的
//      全部 F 迁移。任何合格布设 M' 都必须命中 C：若 M' ∩ C = ∅，则该
//      见证的每条边在 M' 标记下全部保留（前缀自初态出发、闭环位于 f=1
//      分量且双侧移动），伪装依旧成立，矛盾；
//   3) 把 C 加入约束族，回到 1)。新约束与当前 M 不相交 ⇒ 与既有约束
//      互不相同 ⇒ 循环必终止；终止时 M 经精确复核合格，而任何合格布设
//      都不小于约束族最小命中集 ⇒ M 即全局最小布设。

import { diagnose } from './diagnoser.mjs';

const cmpIds = (a, b) => a.localeCompare(b);

// 两个已排序标识数组的稳定比较：先长度、再逐元素按迁移标识字典序
function cmpSortedSets(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = cmpIds(a[i], b[i]);
    if (d !== 0) return d;
  }
  return 0;
}

// 精确最小命中集：约束族 {C_i} 求最小 |H| 使 H ∩ C_i ≠ ∅；
// 平局按迁移标识排序后的字典序取最小（稳定裁决）。
// 约束保证非空（见证前缀必含至少一条 F 迁移，否则 f 标志不会置 1）。
export function minHittingSet(constraintSets) {
  // 规范化：排序去重、剔除重复约束与超集约束（命中子集必命中超集）
  const uniq = new Map();
  for (const raw of constraintSets) {
    const s = [...new Set(raw)].sort(cmpIds);
    if (s.length === 0) return null; // 空约束不可命中（调用方保证不发生）
    uniq.set(JSON.stringify(s), s);
  }
  let sets = [...uniq.values()];
  sets = sets.filter((s) =>
    !sets.some((o) => o !== s && o.length <= s.length && o.every((x) => s.includes(x))));

  if (sets.length === 0) return [];

  // 每个元素覆盖的约束下标
  const elemCover = new Map();
  sets.forEach((s, i) => {
    for (const x of s) {
      if (!elemCover.has(x)) elemCover.set(x, []);
      elemCover.get(x).push(i);
    }
  });
  const universe = [...elemCover.keys()].sort(cmpIds);

  let best = null; // 现任最优（已排序数组）
  const better = (cand) => best === null || cmpSortedSets(cand, best) < 0;

  // 贪心种子：反复选取覆盖最多未覆盖约束的元素（平局按标识），加速定界
  {
    const covered = new Array(sets.length).fill(false);
    let left = sets.length;
    const seed = [];
    while (left > 0) {
      let pick = null, pickGain = -1;
      for (const x of universe) {
        const gain = elemCover.get(x).filter((i) => !covered[i]).length;
        if (gain > pickGain) { pick = x; pickGain = gain; }
      }
      seed.push(pick);
      for (const i of elemCover.get(pick)) {
        if (!covered[i]) { covered[i] = true; left--; }
      }
    }
    best = seed.sort(cmpIds);
  }

  const covered = new Array(sets.length).fill(false);
  const chosen = [];

  // 下界：未覆盖约束的极大不相交装箱（每个约束需各自不同的元素）
  const lowerBound = () => {
    const used = new Set();
    let lb = 0;
    const order = [];
    for (let i = 0; i < sets.length; i++) if (!covered[i]) order.push(i);
    order.sort((a, b) => sets[a].length - sets[b].length);
    for (const i of order) {
      if (sets[i].every((x) => !used.has(x))) {
        lb++;
        for (const x of sets[i]) used.add(x);
      }
    }
    return lb;
  };

  const search = () => {
    const left = [];
    for (let i = 0; i < sets.length; i++) if (!covered[i]) left.push(i);
    if (left.length === 0) {
      const cand = [...chosen].sort(cmpIds);
      if (better(cand)) best = cand;
      return;
    }
    if (chosen.length + lowerBound() > best.length) return; // 定界剪枝
    // 失败优先：展开最小未覆盖约束，按迁移标识序分支（稳定）
    let branch = left[0];
    for (const i of left) if (sets[i].length < sets[branch].length) branch = i;
    for (const x of sets[branch]) {
      const hit = elemCover.get(x).filter((i) => !covered[i]);
      if (chosen.length + 1 > best.length) continue;
      chosen.push(x);
      for (const i of hit) covered[i] = true;
      search();
      for (const i of hit) covered[i] = false;
      chosen.pop();
    }
  };
  search();
  return best;
}

// 从无限伪装见证提取必须命中的故障迁移集合：
// 前缀∪闭环故障侧经过的全部 F 迁移（N 迁移不可加装标记）。
function constraintFromWitness(witness) {
  const ids = new Set();
  for (const step of [...witness.prefix, ...witness.loop]) {
    const f = step.faultySide;
    if (f && f.transId && f.faulty) ids.add(f.transId);
  }
  return [...ids].sort(cmpIds);
}

// 见证的稳定摘要（供页面展示每条反例约束）
function witnessSummary(witness) {
  const obs = (steps) => steps.map((s) => s.receipt).filter((r) => r !== null);
  const faultyIdsOf = (steps) =>
    [...new Set(steps
      .filter((s) => s.faultySide?.transId && s.faultySide.faulty)
      .map((s) => s.faultySide.transId))].sort(cmpIds);
  return {
    entry: witness.entry,
    prefixObservable: obs(witness.prefix),
    loopObservable: obs(witness.loop),
    prefixReceiptLength: obs(witness.prefix).length,
    loopReceiptLength: obs(witness.loop).length,
    faultyTransPrefix: faultyIdsOf(witness.prefix),
    faultyTransLoop: faultyIdsOf(witness.loop),
  };
}

// 最小独立标记布设审计主流程
export function placeMarkers(model) {
  const base = diagnose(model);
  if (base.diagnosable) {
    // 原规程本已可诊断 ⇒ 明确返回空布设
    return {
      baseDiagnosable: true,
      minCount: 0,
      markers: [],
      constraints: [],
      baseVerifierStates: base.verifierStateCount,
      finalVerdict: base,
    };
  }

  // 首条约束直接取自基础裁决的见证（避免一次冗余复核）
  const constraints = [{
    set: constraintFromWitness(base.witness),
    witness: witnessSummary(base.witness),
  }];
  for (;;) {
    const m = minHittingSet(constraints.map((c) => c.set));
    const verdict = diagnose(model, new Set(m));
    if (verdict.diagnosable) {
      return {
        baseDiagnosable: false,
        minCount: m.length,
        markers: m,
        constraints,
        baseVerifierStates: base.verifierStateCount,
        finalVerdict: verdict,
      };
    }
    // 仍有合格双侧闭环：提取必须命中的故障迁移集合，加入约束族
    constraints.push({
      set: constraintFromWitness(verdict.witness),
      witness: witnessSummary(verdict.witness),
    });
  }
}

// 标记集合合法性：必须都是规程中真实存在的 F 迁移
export function validateMarkerIds(model, ids) {
  const faulty = new Map(model.transitions.filter((t) => t.faulty).map((t) => [t.id, t]));
  const all = new Set(model.transitions.map((t) => t.id));
  for (const id of ids) {
    if (!all.has(id)) return `标记目标 ${id} 不是规程中的迁移标识`;
    if (!faulty.has(id)) return `标记目标 ${id} 不是故障迁移（只能给 F 迁移加装标记）`;
  }
  return null;
}
