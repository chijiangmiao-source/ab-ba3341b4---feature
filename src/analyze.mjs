// analyze.mjs — 解析 + 判定 + 视图模型
import { parseSpec } from './parser.mjs';
import { diagnose, tarjan } from './diagnoser.mjs';
import { minimalMarkPlacement, evaluateMarks } from './placement.mjs';

export function analyze(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const result = diagnose(model);

  if (result.diagnosable) {
    return {
      ok: true,
      diagnosable: true,
      // 原规程本已可诊断：明确返回空布设，无需任何专属标记
      placement: { alreadyDiagnosable: true, size: 0, marks: [] },
      stats: {
        locations: model.locations.length,
        transitions: model.transitions.length,
        faultyTransitions: model.transitions.filter((t) => t.faulty).length,
        verifierStates: result.verifierStateCount,
      },
      checkedPairs: result.checkedPairs,
    };
  }

  const w = result.witness;
  const obsOf = (steps) =>
    steps.map((s) => s.receipt).filter((r) => r !== null);
  const prefixObs = obsOf(w.prefix);
  const loopObs = obsOf(w.loop);

  // 校验两侧可观察序列逐元素相同（理论上构造保证，此处再断言式核验）
  const seqF = [];
  const seqN = [];
  for (const s of [...w.prefix, ...w.loop]) {
    if (s.faultySide && !s.faultySide.silent && s.receipt !== null) seqF.push(s.receipt);
    if (s.normalSide && !s.normalSide.silent && s.receipt !== null) seqN.push(s.receipt);
  }
  const identical = seqF.join('') === seqN.join('');

  return {
    ok: true,
    diagnosable: false,
    stats: {
      locations: model.locations.length,
      transitions: model.transitions.length,
      faultyTransitions: model.transitions.filter((t) => t.faulty).length,
      verifierStates: result.verifierStateCount,
    },
    witness: {
      entry: w.entry,
      prefix: w.prefix,
      loop: w.loop,
      prefixObservable: prefixObs,
      loopObservable: loopObs,
      prefixReceiptLength: prefixObs.length,
      loopReceiptLength: loopObs.length,
      faultySideObservable: seqF,
      normalSideObservable: seqN,
      sequencesIdentical: identical,
    },
    checkedPairs: result.checkedPairs,
  };
}

function statsOf(model, verifierStates) {
  return {
    locations: model.locations.length,
    transitions: model.transitions.length,
    faultyTransitions: model.transitions.filter((t) => t.faulty).length,
    verifierStates,
  };
}

// 最小独立标记布设审计：只在原规程已判不可诊断后由值班工程师发起。
// 返回最少标记数、按迁移标识稳定裁决的标记集合、每个被选标记打断的
// 反例约束、任一更小集合仍保留的稳定反例，以及应用后的新裁决。
export function placementAudit(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const baseline = diagnose(model);
  if (baseline.diagnosable) {
    // 原规程本已可诊断：明确返回空布设
    return {
      ok: true,
      diagnosable: true,
      stats: statsOf(model, baseline.verifierStateCount),
      placement: {
        alreadyDiagnosable: true,
        size: 0,
        marks: [],
        baseline: null,
        perMarkConstraints: [],
        smallerSetWitnesses: [],
        trace: [],
        stats: { nodesVisited: 0, witnessChecks: 0, lowerBoundPrunes: 0, dedupSkips: 0, faultCandidates: 0 },
      },
    };
  }

  const placement = minimalMarkPlacement(model, tarjan);
  return {
    ok: true,
    diagnosable: false, // 原规程裁决
    stats: statsOf(model, baseline.verifierStateCount),
    placement, // 应用 placement.marks 后新裁决为可诊断（终裁已复核）
  };
}

// 工程师核对任意候选布设（通常是更小集合）下的裁决与稳定反例摘要
export function evaluatePlacement(specText, marks) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const ids = Array.isArray(marks) ? marks : [];
  const r = evaluateMarks(model, ids, tarjan);
  if (!r.ok) return { ok: false, invalid: r.invalid };
  return { ok: true, ...r };
}
