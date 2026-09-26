// scripts/placement-fuzz.mjs — 最小布设分支定界的暴力交叉验证
// 参照解完全独立：
//   1) 自行构造带标记遮罩的同步积（不调用 placement.mjs 的任何函数）；
//   2) 用增强空间 (状态, 双侧移动掩码) 上的 BFS 闭合游走判据独立判定
//      某布设下是否仍有合格双侧闭环（与 tarjan+SCC+Dijkstra 无关）；
//   3) 按子集尺寸、迁移标识字典序枚举，第一个可诊断布设即全局最小且
//      字典序最小的解。
import { parseSpec } from '../src/parser.mjs';
import { tarjan } from '../src/diagnoser.mjs';
import { minimalMarkPlacement } from '../src/placement.mjs';

// 独立遮罩同步积：adj 为状态编号 -> 出边，边携带 f/n 移动掩码
function maskedProduct(model, marked) {
  const outF = new Map();
  const outN = new Map();
  for (const t of model.transitions) {
    if (!outF.has(t.src)) outF.set(t.src, []);
    outF.get(t.src).push(t);
    if (!t.faulty) {
      if (!outN.has(t.src)) outN.set(t.src, []);
      outN.get(t.src).push(t);
    }
  }
  const keyOf = (p, q, f) => `${p}|${q}|${f}`;
  const keyById = new Map();
  let nid = 0;
  const id = (p, q, f) => {
    const k = keyOf(p, q, f);
    if (!keyById.has(k)) { keyById.set(k, nid); byId.set(nid, k); nid++; }
    return keyById.get(k);
  };
  const byId = new Map();
  const adj = new Map();
  const add = (u, v, mv) => {
    if (!adj.has(u)) adj.set(u, []);
    adj.get(u).push({ to: v, mv });
  };
  const start = id(model.init, model.init, 0);
  const queue = [start];
  const seen = new Set([start]);
  for (let h = 0; h < queue.length; h++) {
    const u = queue[h];
    const [p, q, fs] = byId.get(u).split('|');
    const f = Number(fs);
    const a = outF.get(p) ?? [];
    const b = outN.get(q) ?? [];
    const enqueue = (np, nq, nf, mv) => {
      const v = id(np, nq, nf);
      add(u, v, mv);
      if (!seen.has(v)) { seen.add(v); queue.push(v); }
    };
    for (const x of a) {
      if (x.silent) {
        if (x.faulty && marked.has(x.id)) continue;
        enqueue(x.dst, q, f | (x.faulty ? 1 : 0), 1);
      }
    }
    for (const y of b) {
      if (y.silent) enqueue(p, y.dst, f, 2);
    }
    for (const x of a) {
      if (x.silent || (x.faulty && marked.has(x.id))) continue;
      for (const y of b) {
        if (!y.silent && x.receipt === y.receipt) {
          enqueue(x.dst, y.dst, f | (x.faulty ? 1 : 0), 3);
        }
      }
    }
  }
  const faultNodes = new Set();
  for (const [k, v] of keyById) {
    if (k.endsWith('|1') && seen.has(v)) faultNodes.add(v);
  }
  return { adj, start, faultNodes };
}

// 独立判据（与 scripts/fuzz.mjs 的参照同构）：存在可达 f=1 状态 s，
// 使增强空间 (节点, 双侧移动掩码) 上有非空闭合游走回到 (s,3)
function independentlyDiagnosable(model, markedSet) {
  const { adj, start, faultNodes } = maskedProduct(model, markedSet);
  const reach = new Set([start]);
  const q0 = [start];
  while (q0.length) {
    const u = q0.shift();
    for (const e of adj.get(u) ?? []) {
      if (!reach.has(e.to)) { reach.add(e.to); q0.push(e.to); }
    }
  }
  for (const s of faultNodes) {
    if (!reach.has(s)) continue;
    const depth = new Map([[`${s}:0`, 0]]);
    const q = [{ u: s, mask: 0, d: 0 }];
    while (q.length) {
      const n = q.shift();
      for (const e of adj.get(n.u) ?? []) {
        const mask = n.mask | e.mv;
        if (e.to === s && mask === 3 && n.d + 1 > 0) return false; // 仍有伪装
        const k = `${e.to}:${mask}`;
        if (!depth.has(k)) { depth.set(k, n.d + 1); q.push({ u: e.to, mask, d: n.d + 1 }); }
      }
    }
  }
  return true;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomModel(rand, n, nf) {
  const locs = Array.from({ length: n }, (_, i) => `L${i}`);
  const lines = [`init ${locs[0]}`, ...locs.map((l) => `loc ${l}`)];
  let id = 0;
  const faults = [];
  for (let k = 0; k < nf; k++) {
    const src = locs[Math.floor(rand() * n)];
    const dst = locs[Math.floor(rand() * n)];
    const rec = rand() < 0.5 ? 'SILENT' : ['a', 'b'][Math.floor(rand() * 2)];
    const fid = `f${id++}`;
    faults.push(fid);
    lines.push(`trans ${fid} ${src} ${dst} F ${rec}`);
  }
  for (const src of locs) {
    const deg = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < deg; k++) {
      const dst = locs[Math.floor(rand() * n)];
      const rec = rand() < 0.3
        ? 'SILENT'
        : ['a', 'b', 'c'][Math.floor(rand() * 3)];
      lines.push(`trans t${id++} ${src} ${dst} N ${rec}`);
    }
  }
  return { text: lines.join('\n'), faults };
}

function subsetsBySize(ids) {
  const out = [[]];
  for (const x of ids) {
    const len = out.length;
    for (let i = 0; i < len; i++) out.push([...out[i], x]);
  }
  out.sort((a, b) =>
    a.length - b.length || a.join(',').localeCompare(b.join(',')));
  return out;
}

const seed = Number(process.argv[2] ?? 31337);
const count = Number(process.argv[3] ?? 1000);
let rand = rng(seed);
let valid = 0;
let nonDiag = 0;
let mismatches = 0;

for (let i = 0; i < count; i++) {
  const n = 2 + Math.floor(rand() * 5);
  const nf = 1 + Math.floor(rand() * 5);
  const { text, faults } = randomModel(rand, n, nf);
  const m = parseSpec(text);
  if (m.errors.length) continue;
  valid++;
  const r = minimalMarkPlacement(m, tarjan);
  if (!r.alreadyDiagnosable) nonDiag++;

  let brute = null;
  for (const sub of subsetsBySize(faults.sort())) {
    if (independentlyDiagnosable(m, new Set(sub))) { brute = sub; break; }
  }
  if (r.size !== brute.length || JSON.stringify(r.marks) !== JSON.stringify(brute)) {
    mismatches++;
    if (mismatches <= 5) {
      console.log(`MISMATCH model=${i} bnb=${r.marks} brute=${brute}`);
      console.log(text);
      console.log('---');
    }
    continue;
  }
  // 结构不变式：per-mark 约束真实、更小集合反例真实
  if (!r.alreadyDiagnosable) {
    for (const c of r.perMarkConstraints) {
      if (!c.witness.hitFaultTrans.includes(c.mark) ||
          !c.witness.sequencesIdentical) {
        mismatches++;
        console.log(`MISMATCH model=${i} 标记 ${c.mark} 反例约束无效`);
        break;
      }
    }
    for (const row of r.smallerSetWitnesses) {
      if (!row.witness) {
        mismatches++;
        console.log(`MISMATCH model=${i} 更小集合 ${row.set} 缺少反例`);
        break;
      }
    }
  }
}

console.log(`placement-fuzz: ${count} 随机规程（${valid} 有效，${nonDiag} 原不可诊断），${mismatches} 分歧`);
process.exit(mismatches ? 1 : 0);
