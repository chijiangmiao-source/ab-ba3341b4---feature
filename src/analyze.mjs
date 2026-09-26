// analyze.mjs — 解析 + 判定 + 视图模型（判定 / 标记布设 / 子集探查）
import { parseSpec } from './parser.mjs';
import { diagnose } from './diagnoser.mjs';
import { placeMarkers, validateMarkerIds } from './markers.mjs';

const statsOf = (model, verifierStates) => ({
  locations: model.locations.length,
  transitions: model.transitions.length,
  faultyTransitions: model.transitions.filter((t) => t.faulty).length,
  verifierStates,
});

function witnessView(result) {
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
  const identical = seqF.join('') === seqN.join('');

  return {
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
  };
}

function analyzeModel(model) {
  const result = diagnose(model);
  if (result.diagnosable) {
    return {
      ok: true,
      diagnosable: true,
      stats: statsOf(model, result.verifierStateCount),
      checkedPairs: result.checkedPairs,
    };
  }
  return {
    ok: true,
    diagnosable: false,
    stats: statsOf(model, result.verifierStateCount),
    witness: witnessView(result),
    checkedPairs: result.checkedPairs,
  };
}

export function analyze(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  return analyzeModel(model);
}

// 最小独立标记布设审计：返回最少标记数、按迁移标识稳定裁决的标记集合、
// 每条反例约束及其见证摘要，以及应用该集合后的新裁决。
export function place(specText) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const r = placeMarkers(model);
  const faultyIds = model.transitions
    .filter((t) => t.faulty).map((t) => t.id)
    .sort((a, b) => a.localeCompare(b));
  const finalView = {
    diagnosable: r.finalVerdict.diagnosable,
    verifierStates: r.finalVerdict.verifierStateCount,
    checkedPairs: r.finalVerdict.checkedPairs,
  };
  if (r.baseDiagnosable) {
    // 原规程本已可诊断 ⇒ 明确的空布设
    return {
      ok: true,
      baseDiagnosable: true,
      minCount: 0,
      markers: [],
      constraints: [],
      faultyTransitions: faultyIds,
      stats: statsOf(model, r.baseVerifierStates),
      finalVerdict: finalView,
    };
  }
  const chosen = new Set(r.markers);
  return {
    ok: true,
    baseDiagnosable: false,
    minCount: r.minCount,
    markers: r.markers,
    constraints: r.constraints.map((c, i) => ({
      index: i + 1,
      set: c.set,
      hitBy: c.set.filter((x) => chosen.has(x)),
      witness: c.witness,
    })),
    faultyTransitions: faultyIds,
    stats: statsOf(model, r.baseVerifierStates),
    finalVerdict: finalView,
  };
}

// 子集探查：以给定（更小）标记集合复核，返回该集合下仍保留的稳定反例
export function probe(specText, markedIds) {
  const model = parseSpec(specText);
  if (model.errors.length > 0 || model.init === null) {
    return { ok: false, errors: model.errors };
  }
  const bad = validateMarkerIds(model, markedIds);
  if (bad) return { ok: false, markerError: bad };
  const marked = new Set(markedIds);
  const result = diagnose(model, marked);
  if (result.diagnosable) {
    return {
      ok: true,
      marked: [...marked].sort((a, b) => a.localeCompare(b)),
      diagnosable: true,
      stats: statsOf(model, result.verifierStateCount),
      checkedPairs: result.checkedPairs,
    };
  }
  return {
    ok: true,
    marked: [...marked].sort((a, b) => a.localeCompare(b)),
    diagnosable: false,
    stats: statsOf(model, result.verifierStateCount),
    witness: witnessView(result),
    checkedPairs: result.checkedPairs,
  };
}

// 任务分发（Worker 线程与进程内共用）
export function dispatchJob(payload) {
  const kind = payload?.kind ?? 'analyze';
  if (kind === 'place') return place(payload.spec);
  if (kind === 'probe') return probe(payload.spec, payload.marked ?? []);
  return analyze(payload.spec);
}
