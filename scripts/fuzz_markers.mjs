// scripts/fuzz_markers.mjs — 最小独立标记布设的随机交叉验证
// 独立参照：暴力枚举故障迁移的全部子集，按大小升序、同大小按标识字典序
// 找到最小合格布设（以该集合标记后 diagnose 判可诊断）。
// 与 placeMarkers（约束生成 + 精确分支定界）的最少标记数与稳定裁决集合
// 逐一比对，零分歧；并复核最终裁决确实可诊断。
import { parseSpec } from '../src/parser.mjs';
import { diagnose } from '../src/diagnoser.mjs';
import { placeMarkers } from '../src/markers.mjs';

const cmpIds = (a, b) => a.localeCompare(b);
function cmpSortedSets(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    const d = cmpIds(a[i], b[i]);
    if (d !== 0) return d;
  }
  return 0;
}

function* combos(ids, k, start = 0, prefix = []) {
  if (prefix.length === k) { yield prefix; return; }
  for (let i = start; i <= ids.length - (k - prefix.length); i++) {
    yield* combos(ids, k, i + 1, [...prefix, ids[i]]);
  }
}

// 暴力参照：最小合格布设（标记全部故障迁移必然可诊断 ⇒ 必有解）
function bruteForceMin(model, faultyIds) {
  for (let k = 0; k <= faultyIds.length; k++) {
    const feasible = [];
    for (const c of combos(faultyIds, k)) {
      if (diagnose(model, new Set(c)).diagnosable) feasible.push(c);
    }
    if (feasible.length) {
      feasible.sort(cmpSortedSets);
      return { minCount: k, set: feasible[0] };
    }
  }
  throw new Error('不可达：标记全部故障迁移后 f 标志永不置 1，必然可诊断');
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomModel(rand, n) {
  const locs = Array.from({ length: n }, (_, i) => `L${i}`);
  const lines = [`init ${locs[0]}`, ...locs.map((l) => `loc ${l}`)];
  let id = 0;
  for (const src of locs) {
    const deg = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < deg; k++) {
      const dst = locs[Math.floor(rand() * n)];
      const kind = rand() < 0.32 ? 'F' : 'N';
      const rec = rand() < 0.3
        ? 'SILENT'
        : ['a', 'b', 'c'][Math.floor(rand() * 3)];
      lines.push(`trans t${id++} ${src} ${dst} ${kind} ${rec}`);
    }
  }
  return lines.join('\n');
}

const MAX_BRUTE_FAULTY = 10; // 子集枚举规模上限（2^10）
let seed = Number(process.argv[2] ?? 1);
const count = Number(process.argv[3] ?? 800);
let mismatches = 0;
let nonDiag = 0;
let skipped = 0;
let checked = 0;
for (let i = 0; i < count; i++) {
  const rand = rng(seed++);
  const n = 2 + Math.floor(rand() * 4);
  const text = randomModel(rand, n);
  const model = parseSpec(text);
  if (model.errors.length) continue;
  const faultyIds = model.transitions
    .filter((t) => t.faulty).map((t) => t.id).sort(cmpIds);
  if (faultyIds.length > MAX_BRUTE_FAULTY) { skipped++; continue; }
  checked++;

  const got = placeMarkers(model);
  const want = bruteForceMin(model, faultyIds);
  if (!got.baseDiagnosable) nonDiag++;

  const ok =
    got.minCount === want.minCount &&
    got.markers.length === want.set.length &&
    got.markers.every((x, j) => x === want.set[j]) &&
    got.finalVerdict.diagnosable === true &&
    got.baseDiagnosable === (want.minCount === 0);
  if (!ok) {
    mismatches++;
    if (mismatches <= 5) {
      console.log('MISMATCH seed=', seed - 1);
      console.log('  got :', JSON.stringify({
        minCount: got.minCount, markers: got.markers,
        baseDiagnosable: got.baseDiagnosable, final: got.finalVerdict.diagnosable,
      }));
      console.log('  want:', JSON.stringify(want));
      console.log(text);
      console.log('---');
    }
  }
}
console.log(`fuzz_markers: ${checked} models (${nonDiag} non-diagnosable, ` +
  `${skipped} skipped too large), ${mismatches} mismatches`);
process.exit(mismatches ? 1 : 0);
