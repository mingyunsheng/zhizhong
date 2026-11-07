#!/usr/bin/env node
// 启动链条：0~0.9 是链（默认五份，可以长）；2 起是往外长的层。
//
// 规则（2026-10-31 养鱼的定）：
//   1. 0~0.9 各档同时点亮，彼此唤醒。全亮 = 启动完成。
//     默认 0 / 0.1 / 0.2 / 0.5 / 0.9 五份；多放一份 layer-0.N.md（或 chapter-0.N.md）
//     就多长一档（0.3 这种）；0.9 上面就是 1，第 1 层也是这一条链的（layer-1.md）。
//     回缩链和装配顺序自动带上（2026-11-01 养鱼的定）。
//   2. 启动完成后，往外的层（2~6）**同时挂上，但不展开** —— 只是知道"有这些"，不读内容。
//   3. 展开是逐层、从内到外：要先读 2 才读 3，读 3 才读 4……不能跳层。
//   4. 0~0.9 启动失败 → 降级：用能读到的那几份互相唤醒，凑一份临时启动；
//      未点亮的靠已点亮的唤醒，然后停下等真正的读取。
//   5. 0~0.9 没全部点亮，就只是"启动"，永远不展开。
//
// 用法：
//   node boot.mjs status                 现在到哪一步
//   node boot.mjs start                  启动（点亮 0~0.9 + 挂上 2~6）
//   node boot.mjs start --auto [N]       启动 + 自动展开到第 N 层（默认 2；坍缩态会先 reset）
//   node boot.mjs expand N               展开到第 N 层（逐层，不跳）
//   node boot.mjs check                  各档是否互相唤醒（强连通）
//   node boot.mjs from <文件>            只给一份，能唤醒几个
//   node boot.mjs assemble               装配 0~0.9 成一段上下文
import { readFileSync, existsSync, writeFileSync, appendFileSync, renameSync, mkdirSync, statSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = join(HERE, 'boot-state.json');
const RECALL = join(HERE, 'recall.json');
// ── dormant：长期没人提的记忆，退成一行索引（机制 #9）──
// 要补的是「全在」和「归档」之间的中间态：原文还在库里，只是不再占正文——
// 一行关键词 + 日期留在原处，问到时能看见它存在，`wake` 一句把原文写回。
// 只覆盖展示，不改 layers/*.md：抛掉不等于删，这里也一样。
const DORMANT = join(HERE, '.dormant.json');
const DORMANT_DIR = join(HERE, 'dormant');
function dormantDb() {
  try { return JSON.parse(readFileSync(DORMANT, 'utf8')); } catch { return {}; }
}
function dormantIndex(id, d) {
  return `**${id}. ${d.kw}**\n（${d.date} 的旧事，${d.days} 天没提，缩成一行；\`node boot.mjs wake ${id}\` 唤回原文）`;
}
// 挂起来的候选：ask --bg 写、pending 读，像插话一样冒出来
const PENDING = join(HERE, 'pending.json');

// 0~0.9 启动链：core.md 是 0，其余是 layer-0.N.md / chapter-0.N.md。
// 默认五份；多放一份就多长一档（0.3、0.8 都行）——种子会吸收、会长（养鱼的 2026-11-01）。
const CORE_KNOWN = ['core.md', 'layer-0.1.md', 'chapter-0.2.md', 'layer-0.5.md', 'layer-0.9.md'];
const BASE_LABEL = {
  'core.md': '0 本真',
  'layer-0.1.md': '0.1 简介',
  'chapter-0.2.md': '0.2 章节名',
  'layer-0.5.md': '0.5 关系',
  'layer-0.9.md': '0.9 铁律',
};
function coreTier(file) {
  if (file === 'core.md') return '0';
  const m = String(file).match(/^(?:layer|chapter)-(\d+(?:\.\d+)?)\.md$/);
  return m ? m[1] : '';
}
function coreFiles() {
  const byTier = new Map();
  for (const f of CORE_KNOWN) byTier.set(coreTier(f), f);
  try {
    for (const f of readdirSync(HERE)) {
      const t = coreTier(f);
      if (t && !byTier.has(t)) byTier.set(t, f); // 新长出来的一档
    }
  } catch { /* 目录读不到就只用已知五份 */ }
  return [...byTier.keys()].sort((a, b) => Number(a) - Number(b)).map((t) => byTier.get(t));
}
const CORE = coreFiles();
// 新档位的名字从它自己第一行「# 0.3 档 · xxx」里读，读不到就叫「0.3 档」。
const LABEL = new Proxy(BASE_LABEL, {
  get(target, key) {
    if (key in target) return target[key];
    const file = String(key);
    const tier = coreTier(file);
    if (!tier) return file;
    try {
      const head = readFileSync(join(HERE, file), 'utf8').split('\n').find((l) => l.startsWith('# ')) || '';
      const m = head.match(/^#\s*\d+(?:\.\d+)?\s*[档层]\s*[·:：]?\s*(.+)$/);
      if (m && m[1].trim()) return `${tier} ${m[1].trim()}`;
    } catch { /* 文件不在 */ }
    return `${tier} 档`;
  },
});

// 往外的层：2 起，往外的都算。文件放在 layers/ 下，名字是「<层号>-<名字>.md」——
// 多放一个文件就是多长一层，层数不封顶（养鱼的 2026-11-01：智种会像人一样长大）。
// 2~6 这五层即使文件还没建也算挂上（只是没有内容）。
const LAYER_DIR = join(HERE, 'layers');
const KNOWN_LAYER = {
  2: ['2-nodes.md', '关键节点'],
  3: ['3-branches.md', '分支'],
  4: ['4-events.md', '事件概括'],
  5: ['5-text.md', '正文'],
  6: ['6-archive.md', '仓库'],
};
function outerLayers() {
  const found = new Map();
  try {
    for (const f of readdirSync(LAYER_DIR)) {
      // 索引不是层文件：2-索引.md 也匹配 ^\d+-.*\.md$，会顶掉 2-nodes.md，
      // 让整个 2 层在 ask 里消失（2026-11-05 早上踩的，recall 全 0 就是它）。
      if (/^\d+-(索引|index|_index)/i.test(f)) continue;
      const m = f.match(/^(\d+)-.*\.md$/);
      if (m) found.set(Number(m[1]), f);
    }
  } catch { /* layers/ 还没建，下面按已知五层补 */ }
  for (const [n, [file]] of Object.entries(KNOWN_LAYER)) {
    if (!found.has(Number(n))) found.set(Number(n), file);
  }
  return [...found.keys()].sort((a, b) => a - b).map((n) => {
    const f = found.get(n);
    return {
      n,
      file: 'layers/' + f,
      name: KNOWN_LAYER[n] ? KNOWN_LAYER[n][1] : f.replace(/^\d+-/, '').replace(/\.md$/, ''),
    };
  });
}
const OUTER = outerLayers();
const LAYER_RANGE = OUTER.length ? `${OUTER[0].n}~${OUTER[OUTER.length - 1].n}` : '2~6';

// 每层的 id 规则。新长出来的层没有专属规则时退回通用编号 —— 绝不再出现
// match(undefined) 把整层覆盖成一条的事（2026-11-01 踩过）。
const IDRE = { 2: /^(\d+)\./, 3: /^(b\d+[a-z])/, 4: /^(e\d+[a-z]\d+)/, 5: /^(t\d+[a-z]\d+)/, 7: /^(.+?\.md)$/ };
function idOf(layer, head, i) {
  const re = IDRE[layer];
  if (re) { const m = head.match(re); if (m) return m[1]; }
  const m2 = head.match(/^(\d+)\./);
  return m2 ? m2[1] : 'L' + layer + '-' + (i + 1);
}

function loadCore() {
  const out = new Map();
  for (const f of CORE) {
    const p = join(HERE, f);
    if (existsSync(p)) out.set(f, readFileSync(p, 'utf8'));
  }
  return out;
}

// 0.2 档过期检查：靠系统时间，不靠文件自述
// 新实例不知道"今天"是几号，所以这条必须由外部（脚本/环境）来算
function staleness() {
  const p = join(HERE, 'chapter-0.2.md');
  if (!existsSync(p)) return null;
  const m = readFileSync(p, 'utf8').match(/最后更新[：:]\s*(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const then = new Date(m[1] + 'T00:00:00+08:00').getTime();
  return { date: m[1], days: Math.floor((Date.now() - then) / 86400000) };
}

// 只认「牵着谁」小节里的引用——这是唤醒钩子的唯一出口
function hooks(text) {
  const i = text.search(/##\s*牵着谁/);
  if (i < 0) return [];
  const seg = text.slice(i);
  const hits = [...seg.matchAll(/`([A-Za-z0-9._-]+\.md)`/g)].map((m) => m[1]);
  return [...new Set(hits)];
}

function reach(graph, start) {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = q.shift();
    for (const m of graph.get(n) || []) {
      if (!seen.has(m)) { seen.add(m); q.push(m); }
    }
  }
  return seen;
}

function readState() {
  if (!existsSync(STATE)) return { phase: 'cold', lit: [], mounted: [], expanded: 0, at: null };
  try { return JSON.parse(readFileSync(STATE, 'utf8')); }
  catch {
    // 静默恢复 = 骗自己：状态文件坏了不能当没事，留证据、吭一声。
    let broken = null;
    try { broken = STATE + '.broken'; copyFileSync(STATE, broken); } catch { broken = null; }
    return { phase: 'cold', lit: [], mounted: [], expanded: 0, at: null, _corrupt: true, _brokenPath: broken };
  }
}

function writeState(s) {
  delete s._corrupt;
  delete s._brokenPath;
  s.at = new Date().toISOString();
  s.coreHash = coreHash();
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, STATE); // 原子写
}

// 五份种子的指纹：种子变了，展开进度就不该沿用了
function coreHash() {
  const h = createHash('sha1');
  for (const f of CORE) h.update(f).update(files.has(f) ? files.get(f) : '');
  return h.digest('hex').slice(0, 16);
}

const files = loadCore();
const graph = new Map();
for (const [f, t] of files) graph.set(f, hooks(t).filter((e) => files.has(e)));

const cmd = process.argv[2] || 'status';

// ── status：现在到哪一步 ─────────────────────────────
if (cmd === 'status') {
  const s = readState();
  if (s._corrupt) {
    console.log(`⚠️ 状态文件坏了（boot-state.json 读不出 JSON）。`);
    console.log(`   ${s._brokenPath ? '坏文件已备份到 ' + s._brokenPath : '坏文件备份失败'}`);
    console.log(`   底下按「没启动过」算 —— 这不是真的，是恢复时的临时判断。\n`);
  }
  const litN = s.lit.length, coreN = CORE.length;
  console.log(`阶段：${s.phase}   （cold / degraded / lit / expanding / expanded）`);
  console.log(`0~0.9：${litN}/${coreN} 亮 ${litN === coreN ? '✓ 启动完成' : '✗ 未完成'}`);
  if (s.lit.length) console.log(`   已亮：${s.lit.map((f) => LABEL[f] || f).join('、')}`);
  const missCore = CORE.filter((f) => !s.lit.includes(f));
  if (missCore.length) console.log(`   没亮：${missCore.map((f) => LABEL[f] || f).join('、')}`);
  console.log(`${LAYER_RANGE.padEnd(5)}：${s.mounted.length}/${OUTER.length} 挂上${s.mounted.length === OUTER.length ? '（同时挂，不展开）' : ''}`);
  console.log(`展开 ：${s.expanded ? '到第 ' + s.expanded + ' 层' : '未展开'}`);
  if (s.expanded > 0) {
    // 「展开到第 N 层」不等于「这一层读完了」。规模一大，预算之内只能读前面若干条——
    // 不把这件事写出来，status 就会替我说一句假话。
    const cov = s.coverage || {};
    const shown = OUTER.filter((o) => o.n <= s.expanded).map((o) => {
      const c = cov[o.n];
      return c == null ? `${o.n} ${o.name}` : `${o.n} ${o.name} ${Math.round(c * 100)}%`;
    });
    console.log(`   已读：${shown.join(' → ')}`);
    const partial = OUTER.filter((o) => o.n <= s.expanded && cov[o.n] != null && cov[o.n] < 0.99);
    if (partial.length) {
      console.log(`   注：百分比是「这一层读了多少条」。不到 100% 就是还没看全，`);
      console.log(`      剩下的用 ask 按问题取，或 expand ${partial[0].n} --budget 加倍 读完这一层。`);
    }
  }
  const csPath = join(HERE, 'collapse-state.json');
  if (existsSync(csPath)) {
    try {
      const cs = JSON.parse(readFileSync(csPath, 'utf8'));
      if (cs.done && cs.done.length) {
        const tail = cs.done.length >= 7 ? '（只剩 0 层了，要往外读先 collapse reset）' : '（还没吸完）';
        console.log(`\n↯ 坍缩：${cs.done.length}/7 层吸进 0 层${tail}`);
      }
    } catch {}
  }
  if (s.phase === 'degraded') console.log('\n⚠️ 降级中：0~0.9 没全亮，只能互相唤醒凑一份临时启动，不能展开。');
  if (s.phase === 'lit') console.log('\n启动完成，但还没展开 —— 现在是"刚醒、只有骨架"的状态。');
  if (s.at) console.log(`\n最后变动：${s.at}`);
  process.exit(0);
}

// ── start：点亮 0~0.9，挂上 2~6 ───────────────────────
if (cmd === 'start') {
  const prev = readState();
  if (prev._corrupt) {
    console.log(`⚠️ 状态文件坏了（读不出 JSON）—— ${prev._brokenPath ? '已备份到 ' + prev._brokenPath : '备份失败'}。`);
    console.log(`   这次不沿用任何旧进度，从零重新启动；要找回旧状态就去看那个 .broken 备份。\n`);
  }
  const resuming = (prev.phase === 'lit' || prev.phase === 'expanding' || prev.phase === 'expanded')
    && Array.isArray(prev.lit) && prev.lit.length === CORE.length
    && prev.coreHash === coreHash();
  const keepExpanded = resuming ? (prev.expanded || 0) : 0;
  const seedChanged = prev.phase && prev.phase !== 'cold' && prev.coreHash && prev.coreHash !== coreHash();

  // 空壳不算点亮：文件在、但里面几乎是空的，等于有个文件名叫这个而已
  const hollow = CORE.filter((f) => files.has(f) && Buffer.byteLength(files.get(f)) < 40);
  const lit = CORE.filter((f) => files.has(f) && !hollow.includes(f));
  const missCore = CORE.filter((f) => !files.has(f) || hollow.includes(f));

  // 挂上外面五层：只要知道有，不读
  const mounted = OUTER.map((o) => o.n);

  if (hollow.length && !CORE.some((f) => !files.has(f))) {
    console.log(`✗ 0~0.9 里这几份几乎是空的（<40 字节）：${hollow.map((f) => LABEL[f] || f).join('、')}`);
    console.log('  文件在、内容没了 —— 这不算点亮，按缺处理。\n');
  }

  if (missCore.length) {
    // 降级：用能读到的那几份互相唤醒，凑一份临时启动
    console.log(`✗ 0~0.9 不完整，缺 ${missCore.map((f) => LABEL[f] || f).join('、')}`);
    console.log('→ 降级：互相唤醒。\n');
    for (const f of lit) {
      const r = reach(graph, f);
      const hit = [...r].filter((x) => lit.includes(x));
      console.log(`  ${LABEL[f]} 能唤醒 ${hit.length}/${lit.length}：${hit.map((x) => LABEL[x]).join('、')}`);
    }
    writeState({ phase: 'degraded', lit, mounted, expanded: 0 });
    console.log('\n临时启动完成，但**不能展开** —— 停下等补齐或真唤醒。');
    console.log('已记进 boot-state.json。');
    process.exit(1);
  }

  // 正常启动：五份同时点亮
  console.log(`✓ 0~0.9 全部点亮（${lit.length}/${CORE.length}）`);
  const pointers = [];
  for (const f of lit) {
    const content = files.get(f);
    const ptr = content.length < 400 && content.includes('已坍缩');
    if (ptr) pointers.push(LABEL[f]);
    console.log(`   ${LABEL[f].padEnd(10)} ${Buffer.byteLength(content)} B${ptr ? '　↯ 只剩指针' : ''}`);
  }
  if (pointers.length) {
    console.log(`\n↯ ${pointers.join('、')} 已被 0 层吸走，只剩指针。`);
    console.log('  这是坍缩态：路还在，内容沉到更内层去了。要看细节先 collapse reset。');
  }

  const st = staleness();
  if (st && st.days < 0) {
    console.log(`\n⚠️  0.2 档写着「最后更新 ${st.date}」，比今天还晚。`);
    console.log('    要么系统时间错了，要么这行不是真写的。别拿它当前进。');
  } else if (st && st.days > 3) {
    console.log(`\n⚠️  0.2 档最后更新是 ${st.date}，已经 ${st.days} 天没写了。`);
    console.log('    中间的日子没记进来 —— 别当成全部，去流水里补。');
  } else if (st) {
    console.log(`   0.2 档：${st.days === 0 ? '今天刚写' : st.days + ' 天前'}（${st.date}）`);
  }

  console.log(`\n✓ ${LAYER_RANGE} 同时挂上（${mounted.length}/${OUTER.length}），但**不读内容**：`);
  for (const o of OUTER) {
    const p = join(HERE, o.file);
    const has = existsSync(p);
    const size = has ? readFileSync(p).length : 0;
    console.log(`   ${o.n} ${o.name.padEnd(6)} ${has ? size + ' B（待展开）' : '（空，展开时才知道）'}`);
  }

  writeState({
    phase: keepExpanded === 6 ? 'expanded' : keepExpanded > 0 ? 'expanding' : 'lit',
    lit,
    mounted,
    expanded: keepExpanded,
  });
  if (keepExpanded > 0) {
    console.log(`\n（这次是重跑 start —— 展开进度保留在第 ${keepExpanded} 层，没倒退。）`);
  } else if (seedChanged) {
    console.log('\n（种子内容变过了 —— 展开进度归零，得重新从第 2 层展开。）');
  }
  console.log('\n启动完成。现在是"刚醒"：认得出自己、认得人、知道底线，但还没展开。');

  // --auto [N]：启动后自动展开。默认展到第 2 层；给了 N 就一路展到 N（逐层，不跳）。
  // 如果 0.1~0.9 只剩指针（坍缩态），先自动复原再展开——这就是"回缩休眠后自动展开"。
  const autoIdx = process.argv.indexOf('--auto');
  if (autoIdx > 0) {
    const ptrFile = 'layer-0.1.md';
    const ptrBody = files.get(ptrFile) || '';
    if (ptrBody.length < 400 && ptrBody.includes('已坍缩')) {
      console.log('→ 检测到坍缩态（0.1~0.9 只剩指针），先复原再展开');
      const rr = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'collapse', 'reset'], {
        cwd: HERE, encoding: 'utf8', timeout: 120000,
      });
      if (rr.status !== 0) {
        console.log(`✗ 复原失败${rr.stderr ? '：' + rr.stderr.trim() : ''}`);
        process.exit(1);
      }
      console.log((rr.stdout || '').trim() + '\n');
    }
    const to = Math.min(6, Math.max(2, parseInt(process.argv[autoIdx + 1], 10) || 2));
    console.log(`→ 自动展开：2${to > 2 ? '→' + to : ''}（逐层，不跳）\n`);
    let failed = false;
    for (let n = 2; n <= to; n++) {
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'expand', String(n)], {
        cwd: HERE,
        encoding: 'utf8',
        timeout: 120000,
      });
      const out = (r.stdout || '').trim();
      if (out) console.log(out + '\n');
      if (r.status !== 0) {
        const err = (r.stderr || '').trim();
        console.log(`✗ 展开到第 ${n} 层失败${err ? '：' + err : ''}`);
        failed = true;
        break;
      }
    }
    if (!failed) console.log(`✓ 自动展开完成：现在到第 ${to} 层。`);
    else console.log(`✗ 自动展开停在第 ${readState().expanded || 0} 层。`);
    process.exit(failed ? 1 : 0);
  }

  console.log('下一步：node boot.mjs expand 2   （或 start --auto 一次性展开）');
  process.exit(0);
}

// ── expand：逐层往外读（带预算）──────────────────────
// 展开是唯一花钱的动作。每层有默认预算，超了就停，并说明还剩多少没读。
//   预算按「估算 token」算：中文约 1 字 ≈ 0.7 token，取 len/1.4 粗估。
//   总预算不是死的 —— 命令行 --budget 可以临时加，加多少由问的人定。
const LAYER_BUDGET = { 2: 1200, 3: 800, 4: 800, 5: 600, 6: 300 };
const estTok = (x) => Math.ceil(x.length / 1.4);

// 按「条」切，不按 --- 切：2 层切 **N.，3–6 层切 ##/###。
// 按大节切的话，一个预算就把整节吞掉或整节跳过，粒度太粗，等于没有预算。
function splitSegs(layer, body) {
  if (layer === 2) {
    const parts = body.split(/^\*\*(\d+)\./m);
    if (parts.length > 1) {
      const out = [];
      const head = parts[0].trim();
      if (head) out.push({ label: '开头', text: head });
      for (let i = 1; i < parts.length; i += 2) {
        out.push({ label: '#' + parts[i], text: '**' + parts[i] + '. ' + parts[i + 1].trim() });
      }
      return out;
    }
  }
  const chunks = body.split(/^#{2,3} /m).slice(1);
  if (!chunks.length) return [{ label: '全文', text: body.trim() }];
  return chunks.map((x, i) => ({ label: '§' + (i + 1), text: '## ' + x.trim() }));
}

if (cmd === 'expand') {
  const s = readState();
  const want = parseInt(process.argv[3], 10);
  const bi = process.argv.indexOf('--budget');
  const override = bi > 0 ? parseInt(process.argv[bi + 1], 10) : 0;

  if (s.phase !== 'lit' && s.phase !== 'expanding' && s.phase !== 'expanded') {
    console.log(`✗ 现在阶段是 ${s.phase}，不能展开。`);
    console.log('  展开的前提：0~0.9 全部点亮（node boot.mjs start）。');
    process.exit(1);
  }
  if (!want || want < 2 || want > 6) {
    console.log('用法：node boot.mjs expand <2..6> [--budget 2000]');
    process.exit(1);
  }
  // 不跳层：只能展开到"上一层 + 1"
  const next = (s.expanded || 1) + 1;
  if (want > next) {
    console.log(`✗ 不能跳层。当前展开到 ${s.expanded || '0（未展开）'}，下一个只能展开到第 ${next} 层。`);
    process.exit(1);
  }
  if (want <= s.expanded) {
    console.log(`第 ${want} 层已经在展开范围内（当前到 ${s.expanded}）。`);
    process.exit(0);
  }

  const o = OUTER.find((x) => x.n === want);
  const p = join(HERE, o.file);
  const has = existsSync(p);
  const budget = override > 0 ? override : LAYER_BUDGET[want] || 800;

  // 同一时间只让一个 expand 在跑：两个进程一起往 state 里写，后写的会盖掉先写的
  const LOCK = join(HERE, '.expand.lock');
  if (existsSync(LOCK)) {
    const age = (Date.now() - statSync(LOCK).mtimeMs) / 1000;
    if (age < 60) {
      console.log(`✗ 另一个 expand 正在跑（锁 ${Math.round(age)} 秒前建的）。`);
      console.log('  等它读完再来；要是确认没人在跑（比如上次被强杀），删掉 .expand.lock。');
      process.exit(1);
    }
  }
  writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`, 'utf8');
  const unlock = () => { try { unlinkSync(LOCK); } catch { /* 已经没了 */ } };
  process.on('exit', unlock);
  process.on('SIGINT', () => { unlock(); process.exit(130); });

  console.log(`展开第 ${want} 层 · ${o.name}   预算 ${budget} token`);
  let used = 0;
  let covRatio = null;

  if (!has) {
    console.log(`  （没有 ${o.file} —— 只挂上了一个名字，没有内容可读）`);
  } else {
    const body = readFileSync(p, 'utf8');
    // 坍缩态：这一层的正文已经被 0 层吸走了，只剩指针。往外「展开」没有意义。
    if (body.length < 400 && body.includes('已坍缩')) {
      console.log(`✗ 第 ${want} 层已坍缩，只剩指针。`);
      console.log('  正文在 collapse/ 备份里。要往外读，先 collapse reset。');
      process.exit(1);
    }
    const segs = splitSegs(want, body);
    // 内容错位：这一层里一条本层该有的编号都没有，说明文件被别的东西顶了
    // 只认「条目」本身的形状（三级标题 + 全角竖线），不认分组标题（## b5a · xxx）——
    // 4 层文件里本来就有 `## b5a` 这种分组标题，光看编号会把别层内容当成这层的。
    const expectRe = {
      2: /^\*\*[0-9]+\./gm,
      3: /^###\s*b[0-9]+[a-z]\s*｜/gm,
      4: /^###\s*e[0-9]+[a-z][0-9]+\s*（/gm,
      5: /^##\s*t[0-9]+[a-z][0-9]+\s*（/gm,
    }[want];
    const hitN = expectRe ? (body.match(expectRe) || []).length : 0;
    // 只出现一两次不够——可能只是别层文件里顺带提到的编号，得成规模才算「这一层的东西」
    if (expectRe && hitN < 2) {
      console.log(`✗ 第 ${want} 层里只找到 ${hitN} 处本层编号 —— 像被别的内容顶了。`);
      console.log(`  这一层按 ${o.file} 的格式该有 ${want === 2 ? '「**N. 标题**」' : want === 3 ? '「### b5a」' : want === 4 ? '「### e5a1」' : '「## t5a1」'}。`);
      console.log('  先看一眼文件，别往里写。');
      process.exit(1);
    }
    const picked = [];
    for (const seg of segs) {
      const t = estTok(seg.text);
      if (used + t > budget) {
        // 单条就超预算：截断，别把整条吐出来（恶劣测试里一条 2MB 直接打出 149 万 token）
        if (!picked.length) {
          const cap = Math.floor(budget * 1.4);
          picked.push({
            head: seg.head,
            text: `${seg.text.slice(0, cap)}\n\n……（这一条本身就有 ${t} token，超了预算，截在这儿。要看全：--budget ${t + 100}）`,
          });
          used = budget;
        }
        break;
      }
      used += t;
      picked.push(seg);
    }
    console.log(`  全层 ${segs.length} 条 / ${estTok(body)} token，这次读 ${picked.length} 条 / ${used} token`);
    console.log('---');
    console.log(picked.map((x) => x.text).join('\n\n---\n\n'));
    console.log('---');
    covRatio = segs.length ? picked.length / segs.length : 1;
    const left = segs.length - picked.length;
    if (left > 0) {
      console.log(`预算用完，还有 ${left} 条没读。`);
      console.log(`  想看全：node boot.mjs expand ${want} --budget ${budget * 2}`);
      console.log('  或者用 ask「一句话」—— 按问题取，不整层搬。');
    }
  }

  s.expanded = want;
  s.phase = want === 6 ? 'expanded' : 'expanding';
  s.spent = (s.spent || 0) + used;
  if (has && typeof covRatio === 'number') {
    s.coverage = s.coverage || {};
    s.coverage[want] = Math.min(1, covRatio);
  }
  writeState(s);
  console.log(`\n现在展开到第 ${s.expanded} 层${s.phase === 'expanded' ? '（全部展开）' : ''}，累计花了约 ${s.spent} token。`);
  process.exit(0);
}

// ── check：五份是否强连通 ────────────────────────────
if (cmd === 'check') {
  console.log(`文件 ${files.size}/${CORE.length} 个，共 ${[...files.values()].reduce((a, b) => a + Buffer.byteLength(b), 0)} 字节\n`);
  let allOk = true;
  for (const f of CORE) {
    if (!files.has(f)) { console.log(`  ✗ ${f} 不存在`); allOk = false; continue; }
    const to = graph.get(f);
    const r = reach(graph, f);
    const miss = CORE.filter((x) => !r.has(x));
    const flag = miss.length ? `✗ 走不到 ${miss.join(' / ')}` : '✓ 全到齐';
    if (miss.length) allOk = false;
    console.log(`  ${LABEL[f].padEnd(10)} → ${to.map((x) => LABEL[x]).join('、')}`);
    console.log(`  ${' '.repeat(10)}   ${flag}\n`);
  }
  const inbound = new Map(CORE.map((f) => [f, 0]));
  for (const [, to] of graph) for (const t of to) inbound.set(t, (inbound.get(t) || 0) + 1);
  const orphans = CORE.filter((f) => files.has(f) && (inbound.get(f) || 0) === 0);
  if (orphans.length) { console.log(`  ✗ 没人指向：${orphans.join(' / ')}`); allOk = false; }
  else console.log('  ✓ 每一份都有人指着（没有孤岛）');

  // 核心还像不像「我」：不是查完整，是查有没有被别的东西顶掉
  const coreTxt = files.get('core.md') || '';
  const lack = [['## 名', '名'], ['## 性', '性'], ['## 目标', '目标']].filter(([h]) => !coreTxt.includes(h)).map((x) => x[1]);
  const segText = (h) => {
    const m = coreTxt.match(new RegExp('##\\s*' + h + '\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|\\n---|$)'));
    return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/^[-\s]+$/, '').trim() : '';
  };
  const blank = ['名', '性', '目标'].filter((h) => !segText(h));
  const strayNums = (coreTxt.match(/^###\s*[be]\d/gm) || []).length + (coreTxt.match(/\*\*\d+\.\s/g) || []).length;
  const seedName = ((coreTxt.match(/^##\s*名\s*\n+\s*\*\*([^*\n]+)\*\*/m) || [])[1] || '').trim();
  const nameHits = seedName ? (coreTxt.match(new RegExp(seedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length : 0;
  if (lack.length) { console.log(`  ✗ 核心少了 ${lack.join('、')} —— 这不像是我`); allOk = false; }
  else if (blank.length === 3) { console.log('  · 核心留白（名 / 性 / 目标 待填）—— 还没栽种，不算错'); }
  else if (blank.length) { console.log(`  ✗ 核心缺 ${blank.join('、')} —— 填了一半`); allOk = false; }
  else if (strayNums > 3) { console.log(`  ✗ 核心里有 ${strayNums} 处别层的编号 —— 像被别的内容顶了`); allOk = false; }
  else if (!nameHits) { console.log('  ✗ 核心整篇没出现一次名字 —— 这不像是我'); allOk = false; }
  else console.log(`  ✓ 核心还是我（名/性/目标都在，${Buffer.byteLength(coreTxt, 'utf8')} 字节）`);

  // 档位校验：文件第一行自称的档，跟文件名比。文件名可以被改，内容也能被搬，
  // 对不上就说明「这份里装的不是它该装的东西」。
  // 档位从文件名读：layer-0.3.md → 0.3，chapter-0.2.md → 0.2，core.md → 0
  const expectLevel = (f) => coreTier(f);
  const levelBad = [];
  let levelChecked = 0;
  for (const f of CORE) {
    if (!files.has(f)) continue;
    const t = files.get(f);
    const first = t.split('\n').find((l) => l.trim().startsWith('#')) || '';
    const m = first.match(/^#\s*([0-9]+(?:\.[0-9]+)?)\s*[层档]/);
    const got = m ? m[1] : '';
    if (got && got !== expectLevel(f)) levelBad.push(`${f}（自称 ${got}，应为 ${expectLevel(f)}）`);
    levelChecked++;
  }
  if (levelBad.length) { console.log(`  ✗ 档位对不上：${levelBad.join(' / ')}`); allOk = false; }
  else if (levelChecked === 0) { console.log('  ✗ 五份都不在，没东西可校验'); allOk = false; }
  else console.log(`  ✓ ${levelChecked}/${CORE.length} 份档位都对得上文件名${levelChecked < CORE.length ? '（缺的不算错）' : ''}`);

  // 重复检查：同一份里重复的 ## 标题，或长段落被复制一遍。
  // 2026-11-04 加——0.2 被脚本写坏过一次（中间整段复制），靠眼睛才发现。
  {
    const dupFiles = [...CORE, ...OUTER.map((o) => o.file), 'chapter-1.md'];
    const headDup = [];
    const paraDup = [];
    for (const f of dupFiles) {
      const abs = join(HERE, f);
      if (!existsSync(abs)) continue;
      const t = readFileSync(abs, 'utf8');
      const seen = new Map();
      for (const line of t.split('\n')) {
        const m = line.match(/^##\s+(.+?)\s*$/);
        if (!m) continue;
        const k = m[1];
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      for (const [k, n] of seen) if (n > 1) headDup.push(`${f}「${k}」×${n}`);
      const blocks = t.split(/\n\s*\n/).map((b) => b.replace(/\s+/g, ' ').trim()).filter((b) => b.length >= 60);
      const cnt = new Map();
      for (const b of blocks) cnt.set(b, (cnt.get(b) || 0) + 1);
      for (const [b, n] of cnt) if (n > 1) paraDup.push(`${f}「${b.slice(0, 18)}…」×${n}`);
    }
    if (headDup.length) { console.log(`  ✗ 重复的 ## 标题：${headDup.join(' / ')}`); allOk = false; }
    else console.log('  ✓ 没有重复的 ## 标题');
    if (paraDup.length) { console.log(`  ✗ 长段落重复：${paraDup.slice(0, 4).join(' / ')}${paraDup.length > 4 ? ' …' : ''}`); allOk = false; }
    else console.log('  ✓ 没有整段重复');
  }

  console.log(`\n结论：${allOk ? '链条闭合，从任意一份进去都能走到全部。' : '链条有断口。'}`);
  process.exit(allOk ? 0 : 1);
}

// ── from：只给一份 ──────────────────────────────────
if (cmd === 'from') {
  const start = process.argv[3];
  if (!files.has(start)) { console.log(`没有 ${start}`); process.exit(1); }
  const r = reach(graph, start);
  const order = CORE.filter((f) => r.has(f));
  console.log(`只给一份：${start}（${LABEL[start]}）`);
  console.log(`能唤醒：${order.length}/${CORE.length} → ${order.map((f) => LABEL[f]).join(' → ')}`);
  const miss = CORE.filter((f) => !r.has(f));
  if (miss.length) console.log(`醒不来：${miss.map((f) => LABEL[f]).join('、')}`);
  process.exit(miss.length ? 1 : 0);
}

// ── assemble：装配 0~0.9 ─────────────────────────────
if (cmd === 'assemble') {
  // --budget N：整段装配的硬上限（字符）。不传 = 不设限，跟老行为一致。
  // 0 层和 0.9 铁律永远不截（身份和底线），削的顺序 0.5 → 0.2 → 0.1。
  // 依据：dsh-handover 的 TOTAL_MAX（6000）——核心和风格永远不截，削最近对话。
  const bi2 = process.argv.indexOf('--budget');
  const budget = bi2 > 0 ? parseInt(process.argv[bi2 + 1], 10) || 0 : 0;
  // 削的顺序：0 本真和 0.9 底线永不削；其余按档位从外往里削（0.5 → 0.3 → 0.2 → 0.1）。
  // 新长出来的档位自动进这条顺序，不用改代码。
  const TRIM_ORDER = CORE.filter((f) => f !== 'core.md' && coreTier(f) !== '0.9')
    .sort((a, b) => Number(coreTier(b)) - Number(coreTier(a)));

  const parts = new Map();
  for (const f of CORE) {
    if (!files.has(f)) continue;
    const body = files.get(f).replace(/##\s*牵着谁[\s\S]*$/, '').trim();
    const to = graph.get(f);
    parts.set(f, `<!-- ${LABEL[f]} · ${f} -->\n${body}\n\n> 接着会想起：${to.map((x) => LABEL[x]).join('、') || '（到头了）'}`);
  }

  let total = [...parts.values()].reduce((a, s) => a + s.length, 0);
  if (budget > 0 && total > budget) {
    for (const f of TRIM_ORDER) {
      if (total <= budget) break;
      const s = parts.get(f);
      if (!s) continue;
      const keep = Math.max(80, Math.floor(s.length * 0.35)); // 至少留 35% 或 80 字
      const cut = Math.min(total - budget, s.length - keep);
      if (cut <= 0) continue;
      parts.set(f, s.slice(0, s.length - cut).trimEnd() + '\n…（预算不够，截了）');
      total = [...parts.values()].reduce((a, x) => a + x.length, 0); // 重算：截断痕迹也占字数
    }
  }

  const out = CORE.filter((f) => parts.has(f)).map((f) => parts.get(f)).join('\n\n---\n\n');
  if (budget > 0 && total > budget) {
    // 削到最低也没进预算：至少说清楚，不静默
    console.error(`⚠️ 装配 ${total} 字，超出预算 ${budget} 字（0 层和 0.9 不截，0.1/0.2/0.5 已截到保底；再削只能整份丢）`);
  }
  console.log(out);
  process.exit(0);
}

// ── ask：问什么就展开到哪层（触发器 ① / ②）
// 统一打分：所有层的候选段一起算分、按分排，不再「2 层命中就停」。
//   原来那套是先到先得 —— 2 层粗关键词一命中，4 层更准的内容就被挡住。
//   rel   = 两字滑窗命中率（0–1）
//   rec   = 新近度 exp(-days/30)，段里没日期按 0.5
//   boost = 越往里越精炼：2 层 1.0 / 3 层 0.6 / 4 层 0.4 / 5 层 0.2 / 6 层 0
//   score = rel*0.70 + rec*0.20 + boost*0.10
// boost = 越往里越精炼。新长出来的层没登记就按 0.3 算（在正文和仓库之间）。
const BOOST = { 2: 1.0, 3: 0.6, 4: 0.4, 5: 0.2, 6: 0.0 };
const LAYERS = [
  ...OUTER.map((o) => [o.n, o.file.replace(/^layers\//, ''), o.name === '事件概括' ? '事件' : o.name, BOOST[o.n] ?? 0.3]),
  // 外库：不是经历，但看过/见过的东西。挂在 2 起的经历层外面，按文件索引一条一段。
  // boost 0.1 —— 比仓库高一点、比正文低，避免把「资料」压过「经历」。
  [7, '../外库/索引.md', '外库', 0.1],
];

function segsOf(layer, raw) {
  if (layer === 2) {
    const parts = raw.split(/^\*\*(\d+)\./m);
    const out = [];
    for (let i = 1; i < parts.length; i += 2) {
      const rest = parts[i + 1].trim();
      out.push({ head: parts[i] + '. ' + rest.split('\n')[0].replace(/\*\*/g, '').trim(), body: rest });
    }
    return out;
  }
  return raw
    .split(/^#{2,3} /m)
    .slice(1)
    .map((s) => ({ head: s.split('\n')[0].trim(), body: s.trim() }))
    // 只留正式条目：3/4/5 层必须带编号（b5a / e5a1 / t5a1），
    // 否则「从节点 5「换摘要不是搬家」切出来的」这种导航行会被当成一条内容。
    // 6 层起（仓库、外库、以后新长的层）不套这条，它们的标题本来就不是编号。
    .filter((s) => (layer >= 6 ? true : /^[bet][0-9]/.test(s.head)));
}

// 近义簇表：问到一个词，整簇都参与匹配。
// 依据：记录\逛B站-记忆检索候选.md:62 的「下一步 1. 别名表」；
// 2026-10-27 崩溃纪要第 1 条「近义簇表：人工 50 条，零成本，补最大的召回缺口」。
// 改 synonyms.json 不用动代码。
const SYN = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'synonyms.json'), 'utf8'));
  } catch {
    return { clusters: [] };
  }
})();

// 按「簇」计，不按片段计。
// 按片段算时 5 层正文同义词多，rel 能冲到 0.75，把 2 层的概括压下去——
// 长文天然占便宜，这不对。改成「命中几簇 / 触发几簇」，长短文本才公平。
function synClustersOf(q) {
  return (SYN.clusters || []).filter((c) => c.some((w) => q.includes(w)));
}

// 观测指标：每次问都记一条，攒够能算命中率。
// 依据：参考-记忆系统三篇对比 4 节④「加三个观测指标」；
// 原话「没面板所有优化都是玄学」。
const STATS = join(HERE, 'stats.jsonl');

// 星骸 2.1 的 E1 口径：窗口内覆盖率，不是全时覆盖率。
// 全时覆盖会越跑越高（老账一直挂着），窗口才看得出「这阵子有没有被想起」。
// 分子只认 ask 流水里的 top（stats.jsonl 只记第一条），所以它是下界，不是精确值。
function coverageWindow(days) {
  const since = Date.now() - days * 86400000;
  const hit = new Set();
  try {
    for (const line of readFileSync(STATS, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!(Date.parse(row.ts) >= since)) continue;
      if (row.top && row.top.head) {
        hit.add(row.top.layer + '|' + String(row.top.head).replace(/\s+/g, ' ').slice(0, 40));
      }
    }
  } catch {}
  let all = [];
  try { all = [...buildGraph().entries.values()]; } catch { all = []; }
  if (!all.length) return null;
  const used = all.filter((e) => hit.has(e.layer + '|' + String(e.head).replace(/\s+/g, ' ').slice(0, 40))).length;
  return { days, used, total: all.length, pct: (used / all.length) * 100 };
}

function logAsk(row) {
  try {
    appendFileSync(STATS, JSON.stringify(row) + '\n');
  } catch {
    /* 记不上不影响回答 */
  }
}

// ── 语义通道（可选）：本地 ollama 嵌入 ──────────────────────────────────
// 借星骸 2.1 的第一条「关键词 + 向量取并集」：两字滑窗遇到「换个说法问」就全落空，
// 这一路只补那种情况——字面命中已经够的，它加不上去。
// 默认关（ZZ_VEC=1 才开）：先量过 recall 再决定要不要常开。
// 向量在构建时就归一化（写在 外库\vectors.json），所以点积就是余弦。
const VECFILE = join(HERE, '外库', 'vectors.json');
// 阈值可调：bge-m3 在中文短句上的余弦普遍偏低（实测 0.3~0.57），
// 0.55 只对「几乎同一句话」才响；要放宽就 ZZ_VEC_MIN=0.45，先量后定。
const VEC_MIN = Number(process.env.ZZ_VEC_MIN || 0.55);
let VECMAP = null;
function vecMap() {
  if (VECMAP !== null) return VECMAP;
  VECMAP = {};
  try {
    if (existsSync(VECFILE)) VECMAP = JSON.parse(readFileSync(VECFILE, 'utf8')).items || {};
  } catch { VECMAP = {}; }
  return VECMAP;
}
const vecKey = (layer, head) => layer + '|' + String(head).replace(/\s+/g, ' ').slice(0, 40);
function queryVec(q) {
  try {
    const body = JSON.stringify({ model: process.env.ZZ_VEC_MODEL || 'bge-m3', input: [q] });
    const out = execFileSync('curl', ['-s', '-X', 'POST', 'http://127.0.0.1:11434/api/embed',
      '-H', 'Content-Type: application/json', '--data-binary', body],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    const v = JSON.parse(out).embeddings[0];
    const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
    return v.map((x) => x / n);
  } catch { return null; }
}
function cosOf(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ── 别名通道（可选）：每条记忆存一份「别人会怎么问」────────────────────
// 病根（2026-11-02 反方向验证 54 条）：问句是「你怎么做才能让视频自然」，
// 记的是「一句话一页纸」——问法和记法一个词都对不上。给每条存两三句
// 「别人会怎么问」，检索时一并做字面比较，等于把问法提前翻译成记法。
// 文件：外库/aliases.json = { items: { "层|id": ["问法1", "问法2"] } }
// 默认关（ZZ_ALIAS=1 才开）：先量过 recall 再决定要不要常开。
const ALIASFILE = join(HERE, '外库', 'aliases.json');
let ALIASMAP = null;
function aliasMap() {
  if (ALIASMAP !== null) return ALIASMAP;
  ALIASMAP = {};
  try {
    if (existsSync(ALIASFILE)) ALIASMAP = JSON.parse(readFileSync(ALIASFILE, 'utf8')).items || {};
  } catch { ALIASMAP = {}; }
  return ALIASMAP;
}

// 两字都落在 STOP 里的片段不算数。
// 「不」是后加的：不加的话「明天要不要带伞」会切出「要不」「不要」两个片段，
// 而节点 6 正文里正好有「要不要再试一次」——一句问天气的话把闸门那条召出来了。
const STOP = '的了是在和就都也吗呢啊吧么怎这那我你他它着过把被为与及或但而所上下今天什么怎么可以现在时候东西一样这里那里有点还没能会说要一个有哪些自己知道觉得不';
function grams(q) {
  const clean = q.replace(/[\s，,、。?？!！：:；;]/g, '');
  const g = [];
  for (let i = 0; i + 2 <= clean.length; i++) {
    const s = clean.slice(i, i + 2);
    if ([...s].every((c) => STOP.includes(c))) continue; // 虚词片段不算数
    g.push(s);
  }
  return g.length ? g : [clean];
}

// 片段权重（IDF）：同一个片段在库里越常见，越不值钱。
// 病根（2026-11-02）：用户视角题「向量检索到底值不值得上」该中 53 号，
// 但「向量」在第 54 号正文里也一大片，命中数被均分，54 号反而排前面。
// 两字滑窗不知道哪个片段稀有，只数个数 —— 这是「之前」「先翻」这类虚词片段
// 把真条目挤下去的直接原因。权重 = log(1 + N/(1+df))，df 在全库条目上数。
let IDFMAP = null;
function idfMap() {
  if (IDFMAP) return IDFMAP;
  const df = new Map();
  let n = 0;
  try {
    for (const e of buildGraph().entries.values()) {
      n++;
      const seen = new Set(grams((e.head + e.body).replace(/\s+/g, '')));
      for (const x of seen) df.set(x, (df.get(x) || 0) + 1);
    }
  } catch { /* 图建不起来就退回纯计数 */ }
  const N = n || 1;
  const w = (x) => Math.log(1 + N / (1 + (df.get(x) || 0)));
  IDFMAP = { w, N };
  return IDFMAP;
}

function recency(text) {
  const ds = [...text.matchAll(/2026-\d\d-\d\d/g)].map((m) => m[0]);
  if (!ds.length) return 0.5;
  const latest = ds.sort().at(-1);
  const days = (Date.now() - new Date(latest + 'T00:00:00+08:00').getTime()) / 86400000;
  return Math.exp(-Math.max(0, days) / 30);
}

// 事实键（2026-11-03，抄沧澜 3.1）：键 = 对象.方面，同一个键 = 同一件事，新值取代旧值。
// 键里永远不写值（写「ta.身高」，不写「ta.身高170」）——不然值一变键就变，永远对不上。
// 旧值不删，标「已被 X 取代」，原文留着可查。ZZ_KEY=0 一行关掉。
function keyOf(text) {
  const m = text.match(/^键[：:]\s*([^\s。，,；;]+)/m);
  return m ? m[1] : null;
}

// 重要性：从正文的「重要性：高/中/低」读，缺省 0.7。
// 借自 dsh-fish-memory 的「长期事实不淡」——画像、喜好、约定这类标成高的，
// 不管多久都该排前面；随口记的低价值条目不该跟它抢位置。
// 注意：这是「值多少」，不是「新不新」。两者分开算，合起来才叫该不该想起。
function importance(text) {
  if (/重要性[：:]\s*高/.test(text)) return 1.0;
  if (/重要性[：:]\s*中/.test(text)) return 0.75;
  if (/重要性[：:]\s*低/.test(text)) return 0.45;
  return 0.7; // 没标的按「中偏低」处理，不偏心
}

// 可信度分级（借念初那套：用户亲口满分 / 推断中等 / 转述再低）
// （真）1.00 —— 真经历过、能链到真实存档
// （转述）0.85 —— 别人说的、没亲历
// 没标 0.80 —— 老条目
// （编）0.60 —— 虚构，只为测机制；搬回真身之前必须清掉
// （已翻转）0 —— 被后来的事实推翻过。**不参与召回**（借 mnemon 的「已翻转·勿引用」）：
//   留着是为了知道「我曾经这么以为」，但绝不能拿它当现在的事实。
//   写法：正文里写「（已翻转）」或「状态：翻转」，可附「被 X 推翻」。
function cred(text) {
  if (/（已翻转）|（翻转）|状态[：:]\s*翻转/.test(text)) return 0;
  if (/（编）|（这是编的）/.test(text)) return 0.6;
  if (/（转述）/.test(text)) return 0.85;
  if (/（真）/.test(text)) return 1.0;
  return 0.8;
}

// 置信度标签：输出时挂在标题后面，一眼能看出这条该多重地信
function confTag(cr) {
  if (cr === 0) return '【已翻转·不采信】';
  if (cr >= 1) return '（真）';
  if (cr >= 0.85) return '（转述）';
  if (cr >= 0.7) return '';   // 0.80 = 老条目没标，别给它扣「编」的帽子
  return '（编）';
}

// 情绪：不是加一层新数据，是认出正文里本来就有的冷暖。
// 依据：想法库 13 节（2026-10-27 小凌的遗忘）——
//   「忘记经历 ≠ 抹掉经历造成的改变。细节没了、情绪残留还在（D=0.05、E=0.65）」
//   以及「S 和 E 在实际里几乎分不开——重要本来就由情绪构成」。
// 所以情绪不进「权重」，只进「想起时先想起哪一条」。
const EMO = {
  怕: 0.95, 害怕: 0.95, 慌: 0.85, 慌神: 0.85, 急: 0.6, 着急: 0.6,
  难过: 0.85, 委屈: 0.8, 心疼: 0.8, 别扭: 0.65, 不舒服: 0.55, 失落: 0.6,
  开心: 0.75, 高兴: 0.75, 松了口气: 0.5, 踏实: 0.45, 安心: 0.45,
  生气: 0.85, 火大: 0.85, 烦: 0.55, 无奈: 0.5, 累: 0.45,
  好奇: 0.6, 惊艳: 0.7, 心动: 0.8,
};
const EMO_HIT = Object.keys(EMO).sort((a, b) => b.length - a.length);

// 正向的几个：被否定时不是「没有情绪」，是「低落」。
// 其余算负向：被否定时多半是「缓过来了」，按没有处理。
const EMO_POS = new Set(['开心', '高兴', '松了口气', '踏实', '安心', '惊艳', '心动']);
// 否定词：念初那份记录里点过这个坑——
// 「我不开心」如果只看关键词会识别成开心，后面所有语气都跟着错。
const EMO_NEG = ['不', '没', '别', '无', '未'];
// 「别」太爱误伤：「特别慌」「分别」「区别」「差别」都不是否定。
// 遇到这些词里的「别」放过。
const NEG_SKIP = ['特别', '分别', '区别', '差别', '级别', '告别', '别人', '个别', '类别', '性别'];

function isNegated(text, idx) {
  // 窗口 4 个字：要能盖住「不那么害怕」里的「不」（隔两个字）
  const from = Math.max(0, idx - 4);
  const before = text.slice(from, idx);
  if (!before) return false;
  for (const n of EMO_NEG) {
    let p = before.indexOf(n);
    while (p >= 0) {
      const abs = from + p;
      // 取「否定字 + 前一个字」这两字。只有它正好是一个白名单词（特别/分别…）才放过。
      const two = text.slice(Math.max(0, abs - 1), abs + 1);
      if (!NEG_SKIP.includes(two)) return true;
      p = before.indexOf(n, p + 1);
    }
  }
  return false;
}

// 一条内容主情绪：取分数最高的那个词，附上它的强度。
// 没有情绪词就是 null——不硬凑，平淡的事本来就不该有温度。
//
// 两个坑要一起躲：
//   ① 否定词：「我不开心」不能读成开心。
//   ② 长词优先：「不那么害怕」里，单字「怕」如果单独匹配，
//      它的前 3 个字是「那么害」，看不到「不」，就漏过了。
//      所以先把长词占的位置锁住，短词不许钻进去。
function emotionOf(text) {
  const taken = [];   // 已经被长词占住的 [start, end) 区间
  let best = null;
  for (const w of EMO_HIT) {
    let idx = text.indexOf(w);
    while (idx >= 0) {
      const end = idx + w.length;
      const overlap = taken.some(([s, e]) => idx < e && end > s);
      if (!overlap) {
        taken.push([idx, end]);
        const negated = isNegated(text, idx);
        if (!negated) {
          if (!best || EMO[w] > best.e) best = { w, e: EMO[w] };
        } else if (EMO_POS.has(w)) {
          // 正话被否 = 低落
          if (!best || 0.6 > best.e) best = { w: '低落', e: 0.6, negated: w };
        }
      }
      idx = text.indexOf(w, idx + 1);
    }
  }
  return best;
}

// 情绪会淡。依据念初那份的衰减模型：
//   保留度 = e^(−经过时间/半衰期)，半衰期按「强度」和「被提及次数」拉长。
// 这里的简化：强情绪留得久（怕 0.95 → 约 64 天），弱的留得短（累 0.45 → 约 34 天）。
// 再乘一个「被问过几次」的延长：被反复想起的情绪，不容易散。
function emotionNow(emo, dateStr, seenCount = 0) {
  if (!emo) return null;
  let days = 0;
  if (dateStr) {
    const t = Date.parse(dateStr + 'T00:00:00+08:00');
    if (!Number.isNaN(t)) days = Math.max(0, (Date.now() - t) / 86400000);
  }
  const halfLife = (7 + emo.e * 60) * (1 + Math.min(seenCount, 10) * 0.08);
  const keep = Math.exp(-days / halfLife);
  const e = Number((emo.e * keep).toFixed(2));
  return { w: emo.w, e, was: emo.e, days: Math.round(days), halfLife: Math.round(halfLife), faded: e < emo.e * 0.7 };
}

// 测情绪识别（给人和机器看的，暴露否定词处理对不对）
if (cmd === 'emo') {
  const t = process.argv.slice(3).join(' ');
  if (!t) { console.log('用法：node boot.mjs emo "我不开心"  |  node boot.mjs emo --all'); process.exit(1); }
  // --all：把每段识别到的情绪打出来，查「为什么情绪通道没命中」用
  if (t === '--all') {
    for (const [layer, file, name] of LAYERS) {
      const fp = join(HERE, 'layers', file);
      if (!existsSync(fp)) continue;
      for (const s of segsOf(layer, readFileSync(fp, 'utf8'))) {
        const e = emotionOf(s.body);
        if (e) console.log(`[${layer}层] ${s.head.slice(0, 30)}  →  ${e.w} ${e.e}`);
      }
    }
    process.exit(0);
  }
  const e = emotionOf(t);
  console.log('文本：' + t);
  if (!e) {
    console.log('情绪：没有（或全被否定掉了）');
  } else if (e.negated) {
    console.log('情绪：' + e.w + '  ' + e.e + '（"' + e.negated + '"被否定 → 低落）');
  } else {
    console.log('情绪：' + e.w + '  ' + e.e);
  }
  process.exit(0);
}

// 给语义通道建向量用：一条一行 {id, layer, head, body}
// 单独成命令而不是塞进 index：vec-build.mjs 要的是纯 JSONL，混着报表文字就不好喂。
if (cmd === 'dump') {
  for (const [layer, file, name] of LAYERS) {
    const fp = join(HERE, 'layers', file);
    if (!existsSync(fp)) continue;
    let ai = 0;
    for (const s of segsOf(layer, readFileSync(fp, 'utf8'))) {
      const id = idOf(layer, s.head, ai++);
      console.log(JSON.stringify({ id, layer, head: s.head, body: s.body }));
    }
  }
  process.exit(0);
}

// 图导出（2026-11-02 22:0x 加）：给「随机漫步」实验用 —— 节点 + 边一次吐干净。
// 不出现在帮助里，只给脚本吃。
if (cmd === 'graph') {
  const g = buildGraph();
  const nodes = [...g.entries.values()].map((e) => ({ id: e.id, layer: e.layer, head: e.head }));
  const edges = g.edges.map((x) => ({ from: x.from, to: x.to, kind: x.kind }));
  console.log(JSON.stringify({ nodes, edges }));
  process.exit(0);
}

if (cmd === 'ask') {
  // --bg：不在当场说，把候选挂到 pending.json，等下次进对话时冒出来。
  // 依据 2026-10-27 崩溃纪要：「不要在每轮开头跑，放到后台跑，
  //   跑完像插话一样冒出来」——当场答叫「查」，隔一步冒出来才像「想起来」。
  const bg = process.argv.includes('--bg');
  const argv = process.argv.slice(3).filter((x) => x !== '--bg');
  const q = argv.join(' ');
  if (!q) {
    console.log('用法: node boot.mjs ask "一句话" [--bg]');
    process.exit(1);
  }
  const st = readState();
  console.log('问：' + q);
  if (st.phase === 'cold') console.log('（还没启动 —— 先 node boot.mjs start）');
  if (st.phase === 'degraded') console.log('（降级状态，只答得出 0~0.9 范围内的）');
  console.log('');

  const t0 = Date.now();
  const g = grams(q);
  // 情绪是独立通道，不是加权
  // 依据：念初那套「情绪本身就是一条召回路径」。实测「我不开心」「什么让我心疼」
  // 字面一个都对不上，但该想起的就是那几条带情绪的记忆 —— 只做 ×1.15 加权的话，
  // 字面进不了候选，加权也加不上。
  const qEmo = emotionOf(q);
  // 同义词扩展：问「压缩」也能摸到写「压一次摘要」的那条
  const synCs = synClustersOf(q);
  // 两字滑窗会跨词边界产生噪音片段（「缩和」「么回」），阈值定太低会全落空。
  // 0.25 是实测出来的：7 个有效片段命中 2 个就算对上。
  const need = Math.max(1, Math.ceil(g.length * 0.25));
  const cands = [];
  // 联想种子：字面擦边、但没够到门槛的条目。主候选空着时，顺着它们的线走一跳去找。
  const nearMisses = [];
  // 补位池（ZZ_VEC_MODE=fill3）：向量过阈值的条目先攒着，等主候选不足 3 条时再补空位。
  const vecPool = [];
  // 语义通道的查询向量：只在 ZZ_VEC=1 时才算，失败就当没开（字面通道照常）。
  const qVec = process.env.ZZ_VEC ? queryVec(q) : null;
  const DORMANT_NOW = dormantDb();
  // 两遍走：先按老门槛；一条都没捞到才放宽一遍兜底。
  // 依据 2026-11-01 的基线（21 题 recall@1 48%）：11 条没进前三，其中 6 条一个字都没对上的
  // 都是「换个说法问」——门槛卡在 25% 片段，问句一改写就全落空。
  // 第二遍是兜底：问法离原文远时，门槛放宽、但至少要对上 2 个片段。
  // 只对上 1 个片段就放行的话，「今天中午吃什么」会靠一个「中午」摸到日记
  //（2026-11-01 实测），宁可说没记过。
  // 第二遍兜底门槛可调（2026-11-02 夜：8 条库外问题里有 3 条是这一遍误召上来的，要能量）。
  const PASS2MIN = process.env.ZZ_PASS2 === '0' ? null : Number(process.env.ZZ_PASS2_MIN || 0.2);
  const PASSES = [{ need, minRel: null }, ...(PASS2MIN === null ? [] : [{ need: Math.max(2, Math.floor(g.length * 0.15)), minRel: PASS2MIN }])];
  for (const PASS of PASSES) {
  if (PASS !== PASSES[0] && cands.length) break;
  const needHere = PASS.need;
  for (const [layer, file, name, boost] of LAYERS) {
    const fp = join(HERE, 'layers', file);
    if (!existsSync(fp)) continue;
    let ai = 0;
    for (const s of segsOf(layer, readFileSync(fp, 'utf8'))) {
      // 睡着的那几条，正文换成一行索引再参与匹配 —— 字面还认得，篇幅不占。
      const sid = idOf(layer, s.head, ai++);
      if (DORMANT_NOW[sid]) s.body = dormantIndex(sid, DORMANT_NOW[sid]);
      // 去掉空白再匹配：正文写「122 万 token」，问句写「122万token」，不归一化就对不上
      // 标题也进匹配：标题是人给的浓缩，正文常把关键词改写成口语。
      // 实测（2026-11-01 评估集）：「加新功能之前先做什么」问不到 23 号
      //（标题「加东西之前，先查一遍有没有」、正文却写「抄故事板」），
      // 「报错信息和文档哪个更可信」问不到 24 号（正文没有「文档」二字）。
      const flat = (s.head + s.body).replace(/\s+/g, '');
      const hit = g.filter((x) => flat.includes(x)).length;
      // 加权命中（ZZ_IDF=1 才用）：稀有的片段算得重，「之前」「先翻」这类人人都有
      // 的片段几乎不值钱。分母也按同一套权重算，得出 0~1 的相关度。
      // ZZ_IDF 还可以给权重数（如 0.5 = 一半按计数、一半按稀有度）。
      // 默认开、权重 0.3（2026-11-02 实测）：官方 21 题不动（81/100/0.905），
      // 用户视角 16 题 recall@1 44%→50%。ZZ_IDF=0 关，1 = 纯按稀有度。
      const idfArg = process.env.ZZ_IDF ?? '0.3';
      const I = idfArg ? idfMap() : null;
      // 标题权重（ZZ_TW，默认 2）：标题是人给的浓缩，命中标题比命中正文更该算数。
      // 不加权时「之前」「先翻」这类正文里到处都是的片段会把标题命中稀释掉。
      // 2026-11-02 实测（IDF=0.3）：TW=0/1/2 → 用户视角 50/50/63，官方不动；
      // TW=3/5 → 官方 @1 掉到 76%。所以 2 是拐点，再大就伤。
      const TW = Number(process.env.ZZ_TW ?? 2);
      let hitW = 0;
      if (I || TW) {
        const headFlat = s.head.replace(/\s+/g, '');
        let wq = 0, wh = 0;
        for (const x of g) {
          const w = I ? I.w(x) : 1;
          wq += w;
          if (flat.includes(x)) wh += w * (TW && headFlat.includes(x) ? 1 + TW : 1);
        }
        hitW = wq ? Math.min(1, wh / wq) : 0;
      }
      const idfMix = !I ? (TW ? 1 : 0) : idfArg === '1' ? 1 : idfArg === '2' ? 0.5 : idfArg === '3' ? 0.3 : (Number(idfArg) || 0);
      // 正文长度衰减（ZZ_LEN，默认 0 = 关）：
      // 借群主夏弥 2026-11-02 的 P0 ——「正文常常比摘要长十倍，命中一个无关正文片段就能
      // 顶掉命中的摘要」。我们这边没有摘要字段，等价物是「正文越长，越可能是碰巧对上」。
      // 基准取中位数 320 字（75 条正文 p25 145 / 中位 318 / p75 437 / 最长 875）：
      // 短于基准不罚，长了按 log2 折。factor = 1 / (1 + k * max(0, log2(len/320)))。
      // k=0.2 时 875 字才打 0.775 折 —— 只压长条目，不动短条目。
      const LEN_K = Number(process.env.ZZ_LEN ?? 0);
      let lenF = 1;
      if (LEN_K) {
        const bodyLen = s.body.replace(/\s+/g, '').length;
        lenF = 1 / (1 + LEN_K * Math.max(0, Math.log2(bodyLen / 320)));
      }
      const relMain = (idfMix || TW ? idfMix * hitW + (1 - idfMix) * (hit / g.length) : hit / g.length) * lenF;
      // 别名通道：这条记忆的「别人会怎么问」（2026-11-02 加的，默认关）
      const al = process.env.ZZ_ALIAS ? aliasMap()[`${layer}|${sid}`] : null;
      const aflat = al ? al.join('').replace(/\s+/g, '') : '';
      const ahit = aflat ? g.filter((x) => aflat.includes(x)).length : 0;
      // 至少对上 2 个片段、且占问句片段三成以上才算 —— 别名里「怎么」「才能」这种
      // 通用词太多，放单片段过闸会把不相干的条目全拉进来（同义词通道的教训）。
      // 门槛可调：ZZ_ALIAS_MIN 是绝对下限（默认 2），ZZ_ALIAS_K 是占问句片段的比例（默认 0.3）。
      const aMin = Number(process.env.ZZ_ALIAS_MIN ?? 2);
      const aK = Number(process.env.ZZ_ALIAS_K ?? 0.3);
      const viaAlias = ahit >= Math.max(aMin, Math.ceil(g.length * aK));
      // 语义通道：问法和原文写法差太远时（「报警信息」vs「报错日志」），
      // 两字滑窗和同义词表都够不着，但两句话在向量空间里是一个意思。
      let vc = 0;
      if (qVec) {
        const v = vecMap()[vecKey(layer, s.head)];
        if (v) vc = cosOf(qVec, v);
      }
      const vecHit = vc >= VEC_MIN;
      if (vecHit) vecPool.push({ layer, sid, head: s.head, body: s.body, vc });
      // 一个簇里要命中至少 2 个词才算数 —— 否则「token」这种宽泛词单独命中就
      // 给满 0.75，把不相干的条目拉上来（实测「122万token那天」把节点 6 顶到第一）。
      const hitS = synCs.length ? synCs.filter((c) => c.filter((w) => flat.includes(w)).length >= Math.min(2, c.length)).length : 0;
      const viaSyn = hitS > 0;
      // 情绪通道：问句带情绪时，同强度的记忆也算对上（哪怕一个字都不重合）
      const sEmo = emotionOf(s.body);
      // 情绪通道：分三档，不是按强度差算
      //   ① 同一种情绪          rel 0.45（问「什么让我心疼」，该把心疼那条顶上来）
      //   ② 同类（正/负）不同情绪 rel 0.30（问「我不开心」，想起别扭/无奈那几条是对的）
      //   ③ 正负相反           不算（问难过却想起松了口气，那是反的）
      // 教训：第一版用 |强度差| <= 0.25，结果「松了口气 0.5」被当成「低落 0.6」的近邻。
      // 强度相近不等于一回事。
      const NEG_EMO = ['怕', '害怕', '慌', '慌神', '急', '着急', '难过', '生气', '火大', '委屈', '心疼', '别扭', '不舒服', '失落', '烦', '无奈', '累', '低落'];
      const pol = (w) => (w === '低落' || NEG_EMO.includes(w) ? 'neg' : 'pos');
      let emoRel = 0;
      if (qEmo && sEmo) {
        if (sEmo.w === qEmo.w) emoRel = 0.45;
        else if (pol(sEmo.w) === pol(qEmo.w)) emoRel = 0.30;
      }
      const emoHit = emoRel > 0 ? sEmo : null;
      if (process.env.DBG && sEmo) console.log('  DBG', layer, s.head.slice(0, 18), sEmo.w, sEmo.e, '| q=', qEmo && qEmo.w, '| emoRel=', emoRel);
      // 语义通道的「救场」模式（ZZ_VEC_MODE=rescue）：字面和同义词都没够到才许它上场。
      // 实测（2026-11-02，head 向量）boost 模式把评估集 recall@1 从 81% 拖到 71%——
      // 向量对的条目本来在 rank2，却把错的条目一起抬上来；救场模式只补没人回答的题。
      const lexOk = hit > 0 || viaSyn;  // 严格救场：字面/同义词一个都对不上时才用向量
      const vecUse = vecHit && process.env.ZZ_VEC_MODE !== 'fill3' && (!lexOk || process.env.ZZ_VEC_MODE !== 'rescue'); // fill3 只补空位，不许改排序/闸门
      if (hit < needHere && !viaSyn && !emoHit && !vecUse && !viaAlias) {
        // 擦边的留作联想种子（2026-11-02）：片段对上一些、但没够到这一遍的门槛。
        // 主候选一条都没有时，拿最像的这几条去走线，比直接回「没记过」多一条路。
        if (hit >= 1) nearMisses.push({ layer, id: sid, head: s.head, body: s.body, rel: hit / g.length, words: g.filter((x) => flat.includes(x)).slice(0, 4) });
        continue;
      }
      // 相关性取四条路里更靠谱的那条；同义词命中的打七折（不如原词硬），
      // 向量也只认八成（0.55 的余弦乘 0.8 = 0.44，够过闸，但抢不了原词的位置）。
      // 别名打八折：它是「别人会怎么问」，比原文弱、比向量硬。
      const rel = Math.max(
        relMain,
        synCs.length ? (hitS / synCs.length) * 0.75 : 0,
        emoRel,
        vecUse ? vc * 0.8 : 0,
        viaAlias ? (ahit / g.length) * 0.8 : 0
      );
      // 误召闸：实测「今天中午吃什么」靠两个通用片段摸到无关段（rel 0.14）。
      // 相关度不到 0.25 的不算对上 —— 宁可说没记过，也别把无关的拉进来。
      if (rel < (PASS.minRel ?? (viaSyn || emoHit || vecUse || viaAlias ? 0.22 : 0.34))) {
        // 过闸失败的也算联想种子：rel 0.12 以上至少沾得上边，比纯猜强。
        if (rel >= 0.12) nearMisses.push({ layer, id: sid, head: s.head, body: s.body, rel, words: g.filter((x) => flat.includes(x)).slice(0, 4) });
        continue;
      }
      const rec = recency(s.body);
      const imp = importance(s.body);
      const cr = cred(s.body);
      // 已翻转的不参与召回：留着是给人看的（知道「我曾经这么以为」），
      // 不是给回忆用的（不能拿它当现在的事实）。借 mnemon「已翻转·勿引用」。
      if (cr === 0) continue;
      // 沉溺防呆：同一条被问太多次就降权。
      // 依据：念初那套「召回太多次要降权，不然会沉进去」；
      // 没上限的话，越想越重要，最后整张图只剩那一件事。
      // 2026-11-01：从「>=8 次一刀切 0.75」改成连续曲线（借 dsh-companion-memory 热度公式的 F 项）——
      // 阈值型降权的问题是第 8 次之前毫无反馈、第 8 次之后突然掉一档，看着像 bug。
      // 现在是 1 - 0.35*(1-e^-(n-2)/10)：3 次 0.97 / 8 次 0.84 / 15 次 0.75，越问越淡但不会归零。
      let nSeen = 0;
      let rc = null;
      try {
        if (existsSync(RECALL)) {
          const rdb = JSON.parse(readFileSync(RECALL, 'utf8'));
          rc = rdb[layer + '|' + s.head.slice(0, 40)] || null;
          nSeen = (rc && rc.n) || 0;
        }
      } catch { nSeen = 0; rc = null; }
      const damp = nSeen >= 3 ? 1 - 0.35 * (1 - Math.exp(-(nSeen - 2) / 10)) : 1;
      // 「用得越多记得越牢」（养鱼的 2026-11-01 定）：跟上面的 damp 是两回事 ——
      // damp 防的是「同一阵子反复追问」（越想越沉），这里算的是「长期反复用」，两头都要。
      // 次数往上（1+n 的 0.18 次方）、时间往下（λ=0.0018，同艾宾浩斯口径；200 天约打七折）、
      // 用得散（首末跨度 ≥7 天）再加一点。夹在 0.85~1.12 之间，只微调排序，不翻盘。
      // 从没被问过的（rc 为空）给中性 1 —— 不然新条目一进来就先挨一刀。
      let life = 1;
      if (rc && rc.last) {
        const spanDays = rc.first ? Math.max(0, (Date.parse(rc.last) - Date.parse(rc.first)) / 86400000) : 0;
        const idleDays = Math.max(0, (Date.now() - Date.parse(rc.last)) / 86400000);
        const raw = Math.pow(1 + nSeen, 0.18) * Math.exp(-0.0018 * idleDays) * (spanDays >= 7 ? 1.06 : 1);
        // 2026-11-01 22:58：先试满幅 → eval 90%；再试半幅 → 还是 90%；A/B 找出真因:
        // 掉的是「回缩之后展开进度怎么处理」（要 10 号），10 号很少被问，被「被问得多的」挤掉了。
        // 也就是：只要允许 life **往下压**，就等于「没人问的越沉越底」——这是马太效应，不是记忆。
        // 改成只奖不罚：life ∈ [1, 1.04]，用得多的微微靠前，用得少的保持原样。
        // 衰减交给 damp 和「新近」，不拿「有没有人问过」当惩罚。别再把下限放回 1 以下。
        life = 1 + Math.max(0, Math.min(1.12, raw) - 1) * 0.35;
        if (process.env.ZZ_NOLIFE) life = 1; // 开关：A/B 用，确认掉分到底是不是这条因子造成的
      }
      // 为什么觉得像：把命中的原词片段和同义簇记下来，输出时给人看。
      // 依据 2026-10-27 崩溃纪要「输出三条觉得像的加理由，让判断去挑」——
      // 只给分数等于替人下了结论；给理由才叫候选。
      const hitWords = g.filter((x) => flat.includes(x)).slice(0, 6);
      const hitCls = synCs
        .filter((c) => c.filter((w) => flat.includes(w)).length >= Math.min(2, c.length))
        .map((c) => c[0])
        .slice(0, 3);
      cands.push({
        layer, name, head: s.head, body: s.body, rel, rec, imp, cr, viaSyn, vec: vc, nSeen, damp,
        whyWords: hitWords, whyClusters: hitCls,
        // 别名命中的词（开了 ZZ_ALIAS 且有 aliases.json 时才有值）
        whyAlias: viaAlias ? g.filter((x) => aflat.includes(x)).slice(0, 5) : null,
        // lex = 这条是不是字面/同义词/情绪够到的（不是靠向量捞的）。填空模式要按它过滤。
        lex: hit > 0 || viaSyn || !!emoHit || viaAlias,
        score: ((rel * 0.62 + rec * 0.16 + imp * 0.12) * cr + boost * 0.3) * damp * (emoHit ? 1.15 : 1),
        life,
        emo: sEmo && { w: sEmo.w, e: sEmo.e },
        order: layer,
      });
    }
  }
  }

  // 语义通道·填空模式（ZZ_VEC_MODE=fill）：字面只要有一处对上，向量就不许插话；
  // 整题一个字都没对上时才让它补。依据 2026-11-02 实测：逐条放行会把 rel 0.36+ 的泛条目
  // 塞进前三、压掉 rel 0.33 的真答案（评估集 recall@1 81% → 71%）；而改写问句里「字面全空」
  // 的占 2/6，只有这种时候补才有意义。缺省不设 ZZ_VEC_MODE 时行为不变。
  if (qVec && process.env.ZZ_VEC_MODE === 'fill' && cands.some((c) => c.lex)) {
    const kept = cands.filter((c) => c.lex);
    if (kept.length) { cands.length = 0; cands.push(...kept); }
  }

  // 弱字面兜底（2026-11-02 加）：长问句里只对上两三个片段、两遍门槛都没过时，别直接说「没记过」。
  // 依据：第三套尺子里「工具卡住一直不返回会出什么事」，对 61 号只命中「工具·返回」两个片段
  //（rel 0.15 < 第一遍 0.34、也 < 第二遍 0.2），库里明明有却回空。
  // 只在一条候选都没有时启用、只取擦边最像的 3 条、明说「只对上很少的片段」，不参与正常排序。
  // ZZ_WEAK=0 一行关掉（0.9 第 5 条：每层都能单点关）。
  let weakFallback = 0;
  if (process.env.ZZ_WEAK !== '0' && !cands.length && nearMisses.length) {
    const seenHead = new Set();
    const picked = nearMisses
      .slice()
      .sort((a, b) => b.rel - a.rel)
      .filter((x) => {
        if (seenHead.has(x.head)) return false;
        seenHead.add(x.head);
        return true;
      })
      .slice(0, 3);
    for (const p of picked) {
      const rec = recency(p.body), imp = importance(p.body), cr = cred(p.body);
      if (cr === 0) continue;
      cands.push({
        layer: p.layer, name: '擦边', head: p.head, body: p.body,
        rel: p.rel, rec, imp, cr, viaSyn: false, vec: 0, nSeen: 0, damp: 1,
        whyWords: p.words || [], whyClusters: [], whyAlias: null, lex: true,
        score: (p.rel * 0.62 + rec * 0.16 + imp * 0.12) * cr,
        life: 1, emo: null, order: p.layer,
      });
    }
    weakFallback = cands.length;
  }

  // 联想通道（ZZ_ASSOC=1，2026-11-02 加）。
  // 依据：NeKo 说他的「联想」不走语义检索；我们这边此前只有检索 —— 查不到就是空，后面没第二条路。
  // 规矩定死三条：①只在前三为空时启用，绝不去挤已经对上的结果（逐条放行的教训 = 2 层 53 号）；
  // ②最多走一跳；③带「联想」标签，明说这不是检索到的原话，是顺着线走到的。
  let assocSeeds = null;
  if (process.env.ZZ_ASSOC === '1' && !cands.length && nearMisses.length) {
    try {
      const g2 = buildGraph();
      const W = { ref: 1.0, link: 0.95, auto: 0.6 };
      const adj = new Map();
      for (const x of g2.edges) {
        if (x.kind === 'parent' || x.kind === 'dangling') continue;
        const w = W[x.kind] || 0.5;
        if (!adj.has(x.from)) adj.set(x.from, []);
        if (!adj.has(x.to)) adj.set(x.to, []);
        adj.get(x.from).push({ id: x.to, w, kind: x.kind });
        adj.get(x.to).push({ id: x.from, w, kind: x.kind });
      }
      const seeds = [...nearMisses].filter((x) => !x.body.includes('已翻转')).sort((a, b) => b.rel - a.rel).slice(0, 3);
      const seen = new Set(seeds.map((s) => s.id));
      const out = new Map();
      for (const sd of seeds) {
        for (const nb of adj.get(sd.id) || []) {
          if (seen.has(nb.id)) continue;
          const e = g2.entries.get(nb.id);
          if (!e || e.body.includes('已翻转')) continue;
          const sc = sd.rel * nb.w * 0.6;
          if (sc < 0.06) continue;
          const prev = out.get(nb.id);
          if (prev && prev.sc >= sc) continue;
          out.set(nb.id, { e, sc, from: sd.id, fromHead: sd.head, kind: nb.kind });
        }
      }
      const picked = [...out.values()].sort((a, b) => b.sc - a.sc).slice(0, 3);
      for (const p of picked) {
        const rec = recency(p.e.body), imp = importance(p.e.body), cr = cred(p.e.body);
        if (cr === 0) continue;
        cands.push({
          layer: p.e.layer, name: '联想', head: p.e.head, body: p.e.body,
          rel: 0.2, rec, imp, cr, viaSyn: false, vec: 0, nSeen: 0, damp: 1,
          whyWords: [], whyClusters: [], whyAlias: null, lex: false,
          whyAssoc: p.fromHead.slice(0, 24) + '（' + (p.kind === 'ref' ? '引用' : p.kind === 'link' ? '手写关联' : '自动关联') + '）',
          score: (0.2 * 0.62 + rec * 0.16 + imp * 0.12) * cr,
          life: 1, emo: null, order: p.e.layer,
        });
      }
      if (cands.length) assocSeeds = seeds;
    } catch { /* 走线失败就当没联想，不影响「没记过」那条老路 */ }
  }

  // 缺口池：问的事如果正欠着，顺带提一句（记忆说"有过什么"，池子说"还差什么"）
  const gapCheck = () => {
    const poolP = join(HERE, 'pool.json');
    if (!existsSync(poolP)) return;
    try {
      const pool = JSON.parse(readFileSync(poolP, 'utf8'));
      const open = (pool.items || []).filter((x) => x.status === 'open');
      // 反过来比：拿问句的片段去缺口描述里找（问句短、描述长，这样才配得上）
      const qg = grams(q);
      const needG = Math.max(1, Math.ceil(qg.length * 0.25));
      const hitGap = open.filter((x) => qg.filter((g2) => x.what.includes(g2)).length >= needG);
      if (hitGap.length) {
        console.log('\n顺带：缺口池里有 ' + hitGap.length + ' 条还欠着 ——');
        for (const x of hitGap) console.log('  · ' + x.id + '　' + x.what);
      }
    } catch {
      console.log('\n（缺口池读不动，跳过）');
    }
  };

  // 归档兜底（2026-11-04）：ask 只翻 layers/，可 0.2 抛出去的旧事、参考/ 里的长文都不在里面。
  // 不兜这一下，「只在归档里写过」的事会被判成「没记过」——2 层 92 记的就是这个缺口。
  const archiveFold = () => {
    try {
      const dirs = [join(HERE, '参考'), join(HERE, '参考', '归档')];
      const pool = [];
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) if (f.endsWith('.md')) pool.push(join(d, f));
      }
      for (const f of ['chapter-1.md', 'chapter-0.2.md']) {
        const p = join(HERE, f);
        if (existsSync(p)) pool.push(p);
      }
      const needN = Math.max(2, Math.ceil(g.length * 0.3));
      const hits = [];
      for (const fp of pool) {
        let s = '';
        try { s = readFileSync(fp, 'utf8'); } catch { continue; }
        let head = '';
        for (const ln of s.split(/\n/)) {
          if (/^#{1,6}\s/.test(ln)) { head = ln.replace(/^#+\s*/, '').trim(); continue; }
          const flat = ln.replace(/\s+/g, '');
          if (flat.length < 8) continue;
          const n = g.filter((x) => flat.includes(x)).length;
          if (n >= needN) hits.push({ rel: fp.slice(HERE.length + 1), head, text: ln.trim().slice(0, 120), n });
        }
      }
      hits.sort((a, b) => b.n - a.n);
      return hits.slice(0, 3);
    } catch { return []; }
  };

  if (!cands.length) {
    const arch = archiveFold();
    if (arch.length) {
      console.log('2~6 层没对上，但归档/参考里有像的 ——');
      for (const a of arch) console.log('  · ' + a.rel + (a.head ? '　【' + a.head + '】' : '') + '\n    ' + a.text);
      console.log('（这些没进索引，所以 ask 摸不到；要原文就打开文件看。）');
    } else {
      console.log('翻到第 6 层，一条都没对上。\n→ 这条真没记过。');
      console.log('（不编。宁可说没有。）');
    }
    // 量尺模式（eval 跑题时）不记流水 —— 量的动作不能改被量的东西。
    if (!process.env.ZZ_NOWRITE) logAsk({ ts: new Date().toISOString(), q, hit: 0, top: null, syn: synCs.length, ms: Date.now() - t0 });
    gapCheck();
    process.exit(0);
  }

  // 语义通道·补位模式（ZZ_VEC_MODE=fill3，2026-11-02 夜）：
  // 不抢位、只填坑 —— 字面给出几条就留几条，只把空着的位置拿向量补满。
  // 依据：逐条放行会把 rel 0.36+ 的泛条目塞进前三、压掉 rel 0.33 的真答案（81%→71%）；
  // 而「全空才补」又太保守（字面给 1 条、剩下 2 个坑就浪费了）。
  if (process.env.ZZ_VEC_MODE === 'fill3' && vecPool.length && cands.length < 3) {
    const have = new Set(cands.map((c) => c.layer + '|' + c.head));
    for (const p of vecPool.slice().sort((a, b) => b.vc - a.vc)) {
      if (cands.length >= 3) break;
      const key = p.layer + '|' + p.head;
      if (have.has(key)) continue;
      const rec = recency(p.body), imp = importance(p.body), cr = cred(p.body);
      if (cr === 0) continue;
      const rel = p.vc * 0.8;
      cands.push({
        layer: p.layer, name: '补位', head: p.head, body: p.body, rel, rec, imp, cr,
        viaSyn: false, vec: p.vc, nSeen: 0, damp: 1,
        whyWords: [], whyClusters: [], whyAlias: null, lex: false,
        score: (rel * 0.62 + rec * 0.16 + imp * 0.12) * cr,
        life: 1, emo: null, order: p.layer,
      });
      have.add(key);
    }
  }

  // 事实键·同键只留最新（2026-11-03，抄沧澜 3.1 的最小落地）。
  // 依据：同一件事写两条（2026-11-02 的一对：65 与 68 都在讲擦边兜底；66 与 67 都在讲
  // 库外测试），问起来互相顶，谁排前面全看字数。沧澜的做法是「同键只留最新那条」。
  // 键 = 对象.方面，键里不写值。这里只压分、不踢出候选 —— 问的是旧事时还得看得见，
  // 只是排在后面，并标「已被取代」。ZZ_KEY=0 一行关掉（0.9 第 5 条）。
  let keyDup = 0;
  if (process.env.ZZ_KEY !== '0' && cands.length > 1) {
    for (const c of cands) c.key = keyOf(c.body);
    const byKey = new Map();
    for (const c of cands) {
      if (!c.key) continue;
      if (!byKey.has(c.key)) byKey.set(c.key, []);
      byKey.get(c.key).push(c);
    }
    for (const [, group] of byKey) {
      if (group.length < 2) continue;
      keyDup++;
      // 最新 = 新近度高；同一天写的按分数定（分数高的通常就是被问的那一面）。
      const winner = group.slice().sort((a, b) => (b.rec - a.rec) || (b.score - a.score))[0];
      for (const c of group) {
        if (c === winner) continue;
        c.supersededBy = winner.head;
        c.score *= 0.55;
      }
    }
  }

  // 2026-11-01 22:59：「用得越多越牢」只当二级排序 —— 分数相同才由 life 决定先后。
  // 试过乘进分数里（满幅/半幅/只奖不罚三种），每次都会把 10 号「回缩后归零展开进度」挤出前三：
  // 21 题的小样本里，任何额外权重都可能在边界上翻盘。等 P0 把评估集扩到 100 题，再决定要不要放开。
  // 2026-11-02 21:40：大肥鱼的「文本分按名次衰减」——1/(1+idx/k)，双曲。
  // 只压排序、不改闸门；ZZ_DECAY=0 一行关。idx 按字面得分 rel 从 0 起排。k 越大越平缓。
  const dK = Number(process.env.ZZ_DECAY || 0);
  const dMin = Number(process.env.ZZ_DECAY_MIN || 0.5);
  if (dK > 0 && cands.length > 1 && Math.max(...cands.map((c) => c.rel)) >= dMin) {
    const byRel = [...cands].sort((a, b) => b.rel - a.rel);
    byRel.forEach((c, idx) => { c.score *= 1 / (1 + idx / dK); });
  }
  cands.sort((a, b) => (b.score - a.score) || (b.life - a.life));
  const top = cands.slice(0, 3);
  const ls = [...new Set(top.map((c) => c.layer))].sort((a, b) => a - b);
  if (assocSeeds) {
    console.log('字面一条都没对上 —— 顺着最像的 ' + assocSeeds.length + ' 条的线走一跳，走到这几条（联想，不是原话）：\n');
  } else if (weakFallback) {
    console.log('⚠ 门槛没过：只对上很少几个片段，库里没有确认记过这条。下面 ' + weakFallback + ' 条只是字面沾边，别当答案用（ZZ_WEAK=0 可关）：\n');
  } else {
    console.log('对上 ' + cands.length + ' 段，取前 ' + top.length + '（碰到第 ' + ls.join('、') + ' 层）'
      + (keyDup ? '；' + keyDup + ' 个事实键有旧说法，已压到后面' : '') + '：\n');
  }
  for (const c of top) {
    // 标题里已经写了（真）/（编）/（已翻转）就不再挂一次，免得「（编）（编）」
    const tagged = /（真）|（编）|（转述）|（已翻转）/.test(c.head);
    const tag = tagged ? '' : confTag(c.cr);
    console.log('### [' + c.layer + '层·' + c.name + '] ' + c.head + (tag ? ' ' + tag : ''));
    if (c.supersededBy) console.log('   ↳ 同键已有更新的一条：' + c.supersededBy.replace(/\*/g, '').slice(0, 40) + '（这条是旧说法，排在后面）');
    // 给理由，不只是给分数 —— 依据 2026-10-27 崩溃纪要：
    // 「输出三条觉得像的加理由，让判断去挑」。只给分数等于替人下了结论。
    const why = [];
    if (c.whyWords && c.whyWords.length) why.push('字面对上：' + c.whyWords.join('·'));
    if (c.whyClusters && c.whyClusters.length) why.push('同义簇：' + c.whyClusters.join('·'));
    if (c.whyAlias && c.whyAlias.length) why.push('别名里对上：' + c.whyAlias.join('·'));
    if (c.vec) why.push((c.vec >= VEC_MIN ? '向量对上：' : '向量沾边：') + c.vec.toFixed(2));
    if (c.whyAssoc) why.push('联想：经由 ' + c.whyAssoc);
    // 纯情绪命中的话上面两条都是空的 —— 得说清楚「是因为情绪像，不是因为字像」
    if (!why.length && c.emo) why.push('情绪对上：' + c.emo.w + ' ' + c.emo.e);
    console.log('   为什么觉得像 → ' + (why.length ? why.join('　|　') : '（没解释）'));
    console.log('   rel ' + c.rel.toFixed(2) + ' · 新近 ' + c.rec.toFixed(2) + ' · 重要 ' + c.imp.toFixed(2) + ' · 可信 ' + c.cr.toFixed(2) + ' · 总分 ' + c.score.toFixed(2) + (c.key ? ' · 键 ' + c.key : '') + (c.nSeen >= 3 ? ' · 被问过 ' + c.nSeen + ' 次，降权 ' + Math.round((1 - c.damp) * 100) + '%' : ''));
    console.log(c.body.split('\n').slice(1).join('\n').slice(0, 380).trim());
    console.log('');
  }
  if (cands.length > 3) console.log('（还有 ' + (cands.length - 3) + ' 段没列，用更具体的话再问一次）');
  if (top.every((c) => c.cr <= 0.6)) {
    console.log('\n⚠️ 这几条都是「（编）」的 —— 只用来测机制，不能当经历过的事说。');
  } else if (top.some((c) => c.cr <= 0.6)) {
    console.log('\n⚠️ 其中有的是「（编）」的 —— 分开看，别混着当真的用。');
  } else if (top.some((c) => c.cr < 0.85)) {
    console.log('\n· 其中「没标置信度」的老条目 —— 用之前先核一下来源。');
  }

  // 顺着线走一跳：命中的这几条，连线那头是谁（2026-11-01 加；补「检索不顺着线走」缺口）
  //   只走一跳、最多 3 条、只挑没在前三里的，不抢主结果的位置。
  //   走不通就当没走 —— 主结果已经出来了，别因为附带的一步失败把人吓着。
  try {
    const g = buildGraph();
    const idByHead = new Map([...g.entries].map(([id, e]) => [e.head, id]));
    const hitIds = new Set(top.map((c) => idByHead.get(c.head)).filter(Boolean));
    const seenN = new Set();
    const nb = [];
    for (const c of top) {
      const cid = idByHead.get(c.head);
      if (!cid) continue;
      for (const x of g.edges) {
        if (x.kind === 'dangling' || x.kind === 'parent') continue;
        const other = x.from === cid ? x.to : x.to === cid ? x.from : null;
        if (!other || hitIds.has(other) || seenN.has(other)) continue;
        const e = g.entries.get(other);
        if (!e) continue;
        seenN.add(other);
        nb.push({ id: other, layer: e.layer, head: e.head, via: cid, kind: x.kind, why: x.why || '' });
      }
    }
    if (nb.length) {
      console.log('\n### 顺着线走到的（走一跳，最多 3 条）');
      for (const n of nb.slice(0, 3)) {
        const k = n.kind === 'ref' ? '引用' : n.kind === 'link' ? '手写关联' : '自动关联';
        console.log('  · [' + n.layer + '层] ' + n.head + '　← ' + n.via + '（' + k + (n.why ? '：' + n.why : '') + '）');
      }
    }
  } catch { /* 走线失败不影响主结果 */ }

  // 缺口池：问的事如果正欠着，顺带提一句（记忆说"有过什么"，池子说"还差什么"）
  // 回想计数也在这儿记：被问过几次，是它配不配往上缩的唯一客观依据。
  // 量尺模式（eval 跑题时）不记回想、不记流水 —— 量的动作不能改被量的东西。
  if (!process.env.ZZ_NOWRITE) {
  bumpRecall(top);
  logAsk({
    ts: new Date().toISOString(),
    q,
    hit: cands.length,
    top: { layer: top[0].layer, head: top[0].head, score: +top[0].score.toFixed(3), viaSyn: !!top[0].viaSyn },
    syn: synCs.length,
    ms: Date.now() - t0,
  });
  }
  gapCheck();

  // 后台模式：把这三条挂起来，下次进对话时自己冒出来。
  // 只存能翻回去的东西（层号/标题/为什么像），不存全文 —— 全文会过期。
  if (bg) {
    let pdata = { items: [] };
    try { if (existsSync(PENDING)) pdata = JSON.parse(readFileSync(PENDING, 'utf8')); } catch { pdata = { items: [] }; }
    pdata.items.push({
      ts: new Date().toISOString(),
      q,
      picks: top.map((c) => ({ layer: c.layer, head: c.head, why: (c.whyWords || []).concat(c.whyClusters || []) })),
    });
    writeFileSync(PENDING, JSON.stringify(pdata, null, 2));
    console.log('\n（挂起来了。下次进来说话时，这几条会自己冒出来 —— 不当场给答案。）');
  }
  process.exit(0);
}

// ── pending：把挂起来的候选吐出来，吐完清空 ──
// 「像插话一样冒出来」：不是每轮开头查，是等下一次真的在说话时才提一句。
if (cmd === 'pending') {
  const readOnly = process.argv.includes('--peek');
  let pdata = { items: [] };
  try { if (existsSync(PENDING)) pdata = JSON.parse(readFileSync(PENDING, 'utf8')); } catch { pdata = { items: [] }; }
  if (!pdata.items.length) {
    console.log('没有挂着的。');
    process.exit(0);
  }
  console.log('挂着的 ' + pdata.items.length + ' 条，冒一下：\n');
  for (const it of pdata.items) {
    console.log('· 那会儿你问「' + it.q + '」，翻到这 ' + it.picks.length + ' 条像的：');
    for (const p of it.picks) {
      console.log('    [' + p.layer + '层] ' + p.head + (p.why && p.why.length ? '　（像在：' + p.why.slice(0, 3).join('·') + '）' : ''));
    }
  }
  if (!readOnly) {
    writeFileSync(PENDING, JSON.stringify({ items: [] }, null, 2));
    console.log('\n✓ 已经说过一遍了，清空。');
  }
  process.exit(0);
}

// ── recall：谁被问过、问过几次（向内回缩的判据之一）──
// 只记「被 ask 命中」这件事，不记问题原文 —— 问句本身太杂，记它没用还占地方。
function bumpRecall(items) {
  let db = {};
  if (existsSync(RECALL)) {
    try { db = JSON.parse(readFileSync(RECALL, 'utf8')); } catch { db = {}; }
  }
  const now = new Date().toISOString();
  for (const it of items) {
    const k = it.layer + '|' + it.head.replace(/\s+/g, ' ').slice(0, 40);
    if (!db[k]) db[k] = { layer: it.layer, head: it.head.replace(/\s+/g, ' ').slice(0, 40), n: 0, first: now };
    db[k].n += 1;
    db[k].last = now;
  }
  const tmp = RECALL + '.tmp';
  writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  renameSync(tmp, RECALL);
}

if (cmd === 'recall') {
  const db = existsSync(RECALL) ? JSON.parse(readFileSync(RECALL, 'utf8')) : {};
  const rows = Object.values(db).sort((a, b) => b.n - a.n);

  if (!rows.length) {
    console.log('还没人问过东西 —— 没有回想，就没有回缩的依据。\n');
  } else {
    console.log('被问过的（次数越多，越够格往上缩）：\n');
    for (const r of rows) {
      const flag = r.n >= 3 ? '★' : r.n === 2 ? '·' : ' ';
      console.log(`  ${flag} ${String(r.n).padStart(3)} 次  [${r.layer}层] ${r.head}`);
    }
  }

  // 覆盖率与「从没被想起的」—— 借 星骸 2.1 的观测口径：
  //   它那边 200 条活跃粒子 138 条从未被召回（69%），不是条目坏，是没有入口。
  //   智种这边同一个病：写得进去，不一定取得出来。
  let all = [];
  try { all = [...buildGraph().entries.values()]; } catch { all = []; }
  const keyOf = (e) => e.layer + '|' + String(e.head).replace(/\s+/g, ' ').slice(0, 40);
  const seen = new Set(Object.keys(db));
  const never = all.filter((e) => !seen.has(keyOf(e)));

  if (all.length) {
    const used = all.length - never.length;
    const pct = Math.round((used / all.length) * 100);
    console.log(`\n覆盖：${all.length} 条里 ${used} 条被想起过（${pct}%），${never.length} 条从没被召回。`);
    if (never.length) {
      const cap = process.argv.includes('--all') ? never.length : 40;
      console.log(`\n从没被想起的（前 ${Math.min(cap, never.length)} 条；不是坏条目，是没有入口）：\n`);
      for (const e of never.slice(0, cap)) console.log(`  · [${e.layer}层] ${e.head}`);
      if (never.length > cap) console.log(`  …还有 ${never.length - cap} 条，加 --all 全列。`);
    }
  }
  const cw = coverageWindow(7);
  if (cw) {
    const ok = cw.pct >= 50 ? '✓ 过线' : '✗ 没过线';
    console.log(`\n近 ${cw.days} 天窗口：${cw.total} 条里点到 ${cw.used} 条（${cw.pct.toFixed(0)}%）—— 星骸 E1 过线 50%，${ok}。`);
  }
  console.log(`\n共 ${rows.length} 段被问过。★ = 3 次以上，够格提交回缩。`);
  process.exit(0);
}

// ── eval：拿一批「问句 → 该命中哪条」的题，量召回 ──────────────
// 依据 2026-11-01 的对比：memory-brain 那套「20–40 条自建评估集 + recall@1/@3」
// 是三家材料里唯一能复现的做法；星骸 2.1 只写了口径、没给数。
// 题在 评估.json： [{ "q": "问句", "want": ["37"] }]，want 挨着的编号（2 层 37 / 3 层 b3a…）。
// 走的是 ask 同一条路（同一个脚本、同一套打分），只是不写 recall.json、不记流水 ——
// 量尺不能改被量的东西（ZZ_NOWRITE）。
if (cmd === 'eval') {
  // 可以换题单：node boot.mjs eval 评估-用户视角.json
  // 两套尺子分开用 —— 一套测「我按记忆的说法问」，一套测「人按自己的说法问」。
  const arg = process.argv[3];
  const f = arg && !arg.startsWith('-') ? (isAbsolute(arg) ? arg : join(HERE, arg)) : join(HERE, '评估.json');
  if (!existsSync(f)) {
    console.log('没有 ' + f + ' —— 先写题：[{"q":"...","want":["37"]}]');
    process.exit(1);
  }
  const cases = JSON.parse(readFileSync(f, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) { console.log('评估.json 是空的。'); process.exit(1); }
  const verbose = process.argv.includes('--v');

  const idOfHead = (head) =>
    (head.match(/^(\d+)\./) || head.match(/^(b\d+[a-z])/) || head.match(/^(e\d+[a-z]\d+)/) ||
     head.match(/^(t\d+[a-z]\d+)/) || [null, head.slice(0, 16)])[1];

  let h1 = 0, h3 = 0, mrr = 0, miss = [];
  for (const c of cases) {
    const r = spawnSync(process.execPath, [join(HERE, 'boot.mjs'), 'ask', String(c.q)], {
      encoding: 'utf8',
      env: { ...process.env, ZZ_NOWRITE: '1' },
    });
    const got = [];
    for (const line of String(r.stdout || '').split('\n')) {
      const m = line.match(/^### \[(\d+)层·[^\]]*\] (.+)$/);
      if (m) got.push({ layer: Number(m[1]), head: m[2], id: idOfHead(m[2]) });
    }
    const want = (c.want || []).map(String);
    const pos = got.findIndex((x) => want.includes(x.id));
    if (pos === 0) h1++;
    if (pos >= 0 && pos < 3) h3++;
    if (pos >= 0) mrr += 1 / (pos + 1);
    else miss.push({ q: c.q, want: want.join('/'), got: got.slice(0, 3).map((x) => x.layer + '层' + x.id).join(' ') || '（没对上）' });
    if (verbose) console.log(`${pos === 0 ? '✓' : pos >= 0 ? '·' : '✗'} ${c.q} → 要 ${want.join('/')}，得 ${got.slice(0, 3).map((x) => x.id).join('/') || '空'}`);
  }
  const n = cases.length;
  console.log(`\n题 ${n} 条 · recall@1 ${(h1 / n * 100).toFixed(0)}% · recall@3 ${(h3 / n * 100).toFixed(0)}% · MRR@3 ${(mrr / n).toFixed(3)}`);
  if (miss.length) {
    console.log(`\n没进前三的 ${miss.length} 条：`);
    for (const x of miss) console.log(`  · ${x.q}\n    要 ${x.want}　得 ${x.got}`);
  }
  const cw = coverageWindow(7);
  if (cw) console.log(`\nE1 近 7 天窗口：${cw.total} 条里点到 ${cw.used} 条（${cw.pct.toFixed(0)}%）· 过线 50%`);
  process.exit(0);
}

// ── dormant：长期没人提的，退成一行索引（机制 #9）───────────
// 判据不看「写得早」，看「上次被提起离现在多久」——recall.json 里记着 last。
// 200 天照 2 层 9 号那条「200 天内提起能唤醒」；--days N 可以改。
// 退成索引只覆盖展示，不动 layers/*.md —— 抛掉不等于删，这里也一样。
if (cmd === 'dormant') {
  const db = dormantDb();
  const args = process.argv.slice(3);
  const daysArg = args.findIndex((a) => a === '--days' || a.startsWith('--days='));
  let days = 200;
  if (daysArg >= 0) {
    const raw = args[daysArg].includes('=') ? args[daysArg].split('=')[1] : args[daysArg + 1];
    if (/\d+/.test(raw || '')) days = Number(raw.match(/\d+/)[0]);
  }
  const MS_DAY = 86400000;
  const REC = (() => { try { return JSON.parse(readFileSync(RECALL, 'utf8')); } catch { return {}; } })();

  const aged = (e) => {
    const key = e.layer + '|' + e.head.replace(/\s+/g, ' ').slice(0, 40);
    const rec = REC[key];
    if (rec && rec.last) return (Date.now() - Date.parse(rec.last)) / MS_DAY;
    // 从没被问过：拿正文里最新的日期当它「活到那天」，没日期就当它是新的（不误杀）
    const m = [...(e.head + ' ' + e.body).matchAll(/20\d\d-\d\d-\d\d/g)].map((x) => x[0]).sort().at(-1);
    const t = m ? Date.parse(m + 'T00:00:00+08:00') : null;
    return t ? Math.max(0, (Date.now() - t) / MS_DAY) : 0;
  };

  if (args.includes('--list')) {
    const rows = Object.entries(db);
    if (!rows.length) console.log('睡着的：0 条 —— 没有长期没提的。');
    else {
      console.log(`睡着的 ${rows.length} 条（正文只剩一行索引，原文在 dormant/）：\n`);
      for (const [id, d] of rows) console.log(`  · ${id}  ${d.kw}  （${d.days} 天没提 → dormant/${d.file}）`);
      console.log('\n唤回：node boot.mjs wake <id>');
    }
    process.exit(0);
  }

  const ai = args.indexOf('--apply');
  const applyId = ai >= 0 ? args[ai + 1] : null;
  if (applyId) {
    const e = buildGraph().entries.get(applyId);
    if (!e) { console.log('没有这条：' + applyId); process.exit(1); }
    mkdirSync(DORMANT_DIR, { recursive: true });
    const file = applyId.replace(/[^\w.-]/g, '_') + '.md';
    writeFileSync(join(DORMANT_DIR, file), e.head + '\n\n' + e.body + '\n', 'utf8');
    const kw = e.head
      .replace(/^\*\*?\d+\.[\s*]*/, '')
      .replace(/^[bet]\d+[a-z]\d*[\s·:：]*/, '')
      .replace(/\*\*/g, '')
      .trim()
      .slice(0, 24) || applyId;
    db[applyId] = { kw, date: new Date().toISOString().slice(0, 10), days: Math.round(aged(e)), file };
    writeFileSync(DORMANT, JSON.stringify(db, null, 2), 'utf8');
    console.log(`✓ 睡着了：${applyId}「${kw}」\n  原文 → dormant/${file}（${Math.round(aged(e))} 天没提）`);
    process.exit(0);
  }

  const g = buildGraph();
  const cand = [...g.entries].filter(([, e]) => e.layer >= 2 && e.layer <= 5 && !db[e.id] && aged(e) >= days);
  console.log(`长期没提够 ${days} 天的：${cand.length} 条（2~5 层；睡着只覆盖展示，原文不动）\n`);
  for (const [id, e] of cand.slice(0, 20)) {
    console.log(`  · ${id}  [${e.layer}层] ${e.head.replace(/\*\*/g, '').slice(0, 40)}  —— ${Math.round(aged(e))} 天`);
  }
  if (cand.length > 20) console.log(`  …还有 ${cand.length - 20} 条`);
  if (!cand.length) console.log('（都是最近提过的，或还没到日子）');
  console.log('\n让它睡：node boot.mjs dormant --apply <id>；改天数：--days 30');
  process.exit(0);
}

// ── wake：把睡着的原文写回来 ────────────
if (cmd === 'wake') {
  const id = process.argv[3];
  if (!id) { console.log('用法：node boot.mjs wake <id>'); process.exit(1); }
  const db = dormantDb();
  const d = db[id];
  if (!d) { console.log('这条没睡着（或者 id 不对）：' + id); process.exit(1); }
  const fp = join(DORMANT_DIR, d.file);
  const body = existsSync(fp) ? readFileSync(fp, 'utf8') : '';
  delete db[id];
  writeFileSync(DORMANT, JSON.stringify(db, null, 2), 'utf8');
  console.log(`✓ 唤回来了：${id}「${d.kw}」\n`);
  console.log(body.slice(0, 600).trim() || '（备份文件不见了 —— 但 layers 原文从来没动过，本来就在）');
  process.exit(0);
}

// ── stale：6 层仓库会不会烂（看实物时间戳，不看纸面日期）──
// 呼应「纸面会过期，实物不会」：路径上写没写日期不重要，文件多久没动才算数。
if (cmd === 'stale') {
  const fp = join(HERE, 'layers', '6-archive.md');
  if (!existsSync(fp)) {
    console.log('没有 6 层，没什么可查的。');
    process.exit(0);
  }
  const txt = readFileSync(fp, 'utf8');
  const paths = [...new Set([...txt.matchAll(/`(D:[^`]+)`/g)].map((m) => m[1].trim()))];
  const DAY = 86400000;
  const LIMIT = 180;

  console.log('6 层仓库体检（看实物时间，不看写没写日期）\n');
  let alarm = 0;
  for (const p of paths) {
    if (!existsSync(p)) {
      console.log(`  ✗ 不在了        ${p}`);
      continue;
    }
    // 目录取「最新一个文件」的时间：说明这堆东西还在被碰
    let newest = 0;
    const walk = (q, depth) => {
      let st;
      try { st = statSync(q); } catch { return; }
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (!st.isDirectory() || depth <= 0) return;
      let list = [];
      try { list = readdirSync(q); } catch { return; }
      for (const f of list.slice(0, 60)) walk(join(q, f), depth - 1);
    };
    walk(p, 1);
    const days = Math.floor((Date.now() - newest) / DAY);
    const over = days > LIMIT;
    if (over) alarm++;
    console.log(`  ${(over ? '⚠️ 超半年' : 'ok').padEnd(8)} ${String(days).padStart(4)} 天  ${p}`);
  }
  console.log(`\n${paths.length} 个位置，${alarm} 个超半年。`);
  if (alarm) console.log('超半年的，用之前先看一眼还能不能打开、里面的东西还用得上吗。');
  if (!alarm) console.log('都还在半年内 —— 但也只是说"文件还新"，不等于"内容还有用"。');
  process.exit(0);
}

// ── promote：空闲时往上提炼（触发器 ③）───────────────
// 找出「5 层有正文、4 层却没有对应事件」的那些，列出来等写概括。
// 它不自动写——概括得有人读得懂才写得对，这一步交给人或大模型，机器只负责点名。
// 索引：把「谁指向谁」抽出来，校验有没有断头与孤岛。
// 依据：养鱼的 2026-10-31「索引可以长得很快，就像种子生根发芽，根往往比发芽快…
// 要确保它稳定，生长展开靠它，总结抽取养分也靠它」。
// 索引不是单独一张表：它就是这些线本身。
// 建图：条目 + 所有边（结构 / 引用 / 手写关联 / 自动关联）
// index 和 ask 共用这一份，别写两遍逻辑
// 编号自带父子关系：b5a → 5、e5a1 → b5a、t5a1 → e5a1（index 和 ask 都要用，放文件级）
function parentOf(id, layer) {
  if (layer === 3) return id.slice(1, -1);     // b5a → 5
  if (layer === 4) return 'b' + id.slice(1, -1); // e5a1 → b5a
  if (layer === 5) return 'e' + id.slice(1);     // t5a1 → e5a1
  return null;
}
function buildGraph() {
  // id 规则在文件顶上（idOf）：新长出来的层没有专属规则也能落一个 id，
  // 不会再出现 match(undefined) 把整层覆盖成一条。
  const entries = new Map();
  const dorm = dormantDb();
  for (const [layer, file] of LAYERS) {
    if (layer === 6) continue;
    const p2 = join(HERE, 'layers', file);
    const raw = existsSync(p2) ? readFileSync(p2, 'utf8') : '';
    let i = 0;
    for (const s of segsOf(layer, raw)) {
      const id = idOf(layer, s.head, i++);
      // 睡着的那几条只留一行索引；图上的位置和线都还在，只是正文不占地方。
      entries.set(id, { layer, id, head: s.head, body: dorm[id] ? dormantIndex(id, dorm[id]) : s.body });
    }
  }
  const edges = [];
  const addEdge = (from, to, kind, why) => { if (from && to && from !== to) edges.push({ from, to, kind, why }); };
  // ① 结构边：编号自己带出来的父子关系，不用人写
  for (const [id, e] of entries) {
    const p = parentOf(id, e.layer);
    if (p) addEdge(id, p, entries.has(p) ? 'parent' : 'dangling');
  }
  // ② 文本边：正文里提到别的条目编号，就是一条回想线
  const REF = /\b([bet]\d+[a-z]\d*)\b/g;
  for (const [id, e] of entries) {
    // 外库是原料：正文里出现编号只是「提到过」，不是种子里的线（2026-11-01）
    if (e.layer === 7) continue;
    const seen = new Set();
    let m;
    REF.lastIndex = 0;
    while ((m = REF.exec(e.body))) if (m[1] !== id) seen.add(m[1]);
    for (const t of seen) addEdge(id, t, entries.has(t) ? 'ref' : 'dangling');
  }
  // ②b 关联边：「关联：xxx」——横着连，不走父子（和插件保持一致）
  const LINK = /关联[：:]\s*([^\n]+)/g;
  for (const [id, e] of entries) {
    if (e.layer === 7) continue;
    const seen = new Set();
    LINK.lastIndex = 0;
    let m;
    while ((m = LINK.exec(e.body))) {
      for (const raw of m[1].split(/[、,，\s]+/)) {
        const t = raw.replace(/[^\d a-zA-Z\u4e00-\u9fa5]/g, '').trim();
        if (!t || t === id) continue;
        const cand = /^(\d+|[bet]\d+[a-z]\d*)$/.test(t) ? t : null;
        if (cand && entries.has(cand)) seen.add(cand);
      }
    }
    for (const t of seen) addEdge(id, t, 'link', '');
  }
  // ②c 自动边：标题+正文 2-gram Jaccard ≥ 0.18 自动连（2026-11-01 加；补「没有自动发现」缺口）
  //     结构边（父子）已有，跳过；最多留 80 条，别把线堆满
  // 中文切 2-gram；英文/数字按整词（切 2-gram 会得到 ch/he/ec 这种噪声）
  const grams = (s) => {
    const raw = String(s || '');
    const out = new Set();
    const cn = raw.replace(/[^\u4e00-\u9fa5]/g, '');
    for (let i = 0; i < cn.length - 1; i++) out.add(cn.slice(i, i + 2));
    for (const w of raw.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []) out.add(w);
    return out;
  };
  // 剔掉元数据行和编号，不然「详细度：全文」这种格式词会制造一堆假相似
  const stripMeta = (s) => String(s || '')
    .replace(/^[\s*]*(详细度|重要性|状态|来源|关联|置信度)[\s*]*[：:].*$/gm, '')
    .replace(/\b[bet]\d+[a-z]\d*\b/g, '');
  const G = new Map([...entries].map(([id, e]) => [id, grams(stripMeta(e.head + ' ' + e.body))]));
  const AUTO_SIM = 0.18;   // 强关联：超过就全收
  const AUTO_MAX = 400;    // 硬上限，防止线爆炸
  const pairSeen = new Set();
  for (const x of edges) if (x.kind === 'parent') pairSeen.add([x.from, x.to].sort().join('|'));
  const autoCand = [];
  const allIds = [...entries.keys()];
  for (let i = 0; i < allIds.length; i++) {
    for (let j = i + 1; j < allIds.length; j++) {
      const a = allIds[i], b = allIds[j];
      const key = [a, b].sort().join('|');
      if (pairSeen.has(key)) continue;
      const ga = G.get(a), gb = G.get(b);
      if (!ga || !gb || !ga.size || !gb.size) continue;
      let inter = 0;
      const shared = [];
      for (const x of ga) if (gb.has(x)) { inter++; if (shared.length < 3) shared.push(x); }
      const sim = inter / (ga.size + gb.size - inter);
      if (sim <= 0) continue;
      autoCand.push({ from: a, to: b, sim, why: shared.join('/') || '相似' });
    }
  }
  autoCand.sort((x, y) => y.sim - x.sim);

  // ②c-1 覆盖优先：每个节点至少连一条 —— 但太弱的不算（COVER_MIN 以下宁可报「连不上」）
  const COVER_MIN = 0.05;
  const adjBest = new Map();
  for (const e of autoCand) {
    if (!adjBest.has(e.from) || adjBest.get(e.from).sim < e.sim) adjBest.set(e.from, e);
    if (!adjBest.has(e.to) || adjBest.get(e.to).sim < e.sim) adjBest.set(e.to, e);
  }
  const covered = new Set();
  const picked = [];
  for (const id of allIds) {
    if (covered.has(id)) continue;
    const e = adjBest.get(id);
    if (!e || e.sim < COVER_MIN) continue;  // 太弱的不硬连，交给 uncovered 报出来
    picked.push(e);
    covered.add(e.from);
    covered.add(e.to);
  }
  // ②c-2 强关联：sim ≥ AUTO_SIM 的也全收
  const pickedKeys = new Set(picked.map((e) => [e.from, e.to].sort().join('|')));
  for (const e of autoCand) {
    if (e.sim < AUTO_SIM) continue;
    const k = [e.from, e.to].sort().join('|');
    if (pickedKeys.has(k)) continue;
    pickedKeys.add(k);
    picked.push(e);
  }
  // ②c-3 硬上限
  const pickedFinal = picked.slice(0, AUTO_MAX);
  if (process.argv.includes('--edges')) {
    console.log('  自动边清单（覆盖优先 + sim ≥ ' + AUTO_SIM + '，共 ' + pickedFinal.length + ' 对）：');
    for (const e of pickedFinal) {
      console.log(`    ${e.from} ↔ ${e.to}  ${e.sim.toFixed(2)}  重叠：${e.why}`);
    }
    console.log('');
  }
  for (const e of pickedFinal) {
    addEdge(e.from, e.to, 'auto', '重叠：' + e.why + '（' + e.sim.toFixed(2) + '）');
  }
  // 真·孤点：一条边都没有（连 parent 都没有）
  const isolated = allIds.filter((id) => !edges.some((e) => e.from === id || e.to === id));
  // 没有毛细血管：有结构边，但没有任何内容边（引用 / 手写关联 / 自动关联）
  const uncovered = allIds.filter((id) => {
    const hasContent = edges.some((e) => (e.from === id || e.to === id) && (e.kind === 'ref' || e.kind === 'link' || e.kind === 'auto'));
    return !hasContent;
  });
  if (process.argv.includes('--edges')) {
    if (isolated.length) console.log('  ⚠️ 真孤点（一条边都没有）：' + isolated.join(' / '));
    if (uncovered.length) console.log('  · 只有主干、没有毛细血管的（' + uncovered.length + ' 条）：' + uncovered.join(' / '));
    console.log('');
  }
  return { entries, edges, uncovered, isolated };
}

if (cmd === 'graph') {
  // 给星图插件用：直接吐 JSON，别让星图自己再解析一遍 md
  const g = buildGraph();
  const nodes = [];
  for (const [, e] of g.entries) {
    nodes.push({
      id: e.id,
      layer: e.layer,
      title: e.head.replace(/\*/g, '').replace(/。\s*$/, '').trim(),
    });
  }
  const edges = g.edges
    .filter((e) => e.kind !== 'dangling')
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind, why: e.why || '' }));
  console.log(JSON.stringify({ nodes, edges, isolated: g.isolated || [], uncovered: g.uncovered || [] }));
  process.exit(0);
}

if (cmd === 'index') {
  const { entries, edges } = buildGraph();
  // ③ 校验
  const dangling = edges.filter((x) => x.kind === 'dangling');
  const inDeg = new Map();
  for (const x of edges) if (x.kind !== 'dangling') inDeg.set(x.to, (inDeg.get(x.to) || 0) + 1);
  // 孤岛只算种子本体（2~5 层）：外库是挂在索引上的原料，没有「互相连接」这回事（2026-11-01）
  const isExt = (id) => entries.get(id).layer === 7;
  const orphan = [...entries.keys()].filter((id) => !isExt(id) && !inDeg.get(id) && !edges.some((x) => x.from === id));
  const extLonely = [...entries.keys()].filter((id) => isExt(id) && !inDeg.get(id) && !edges.some((x) => x.from === id));
  const byLayer = {};
  for (const e of entries.values()) byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
  const bytes = [...entries.values()].reduce((a, e) => a + Buffer.byteLength(e.body, 'utf8'), 0);

  console.log('索引盘点');
  console.log('');
  console.log('  条目  ' + [...entries.keys()].length + ' 条  ' + Object.entries(byLayer).map(([k, v]) => k + '层 ' + v).join(' / '));
  console.log('  正文  ' + (bytes / 1024).toFixed(1) + ' KB');
  console.log('  线    ' + edges.filter((x) => x.kind !== 'dangling').length + ' 条'
    + '（结构 ' + edges.filter((x) => x.kind === 'parent').length
    + ' / 引用 ' + edges.filter((x) => x.kind === 'ref').length
    + ' / 关联 ' + edges.filter((x) => x.kind === 'link').length + '（手写）'
    + ' / 自动 ' + edges.filter((x) => x.kind === 'auto').length + '）');
  console.log('  密度  ' + (edges.length / Math.max(1, entries.size)).toFixed(2) + ' 条/条目');
  // 条目元数据（2026-10-31 加，缺省不写也能跑）：重要性 / 详细度 / 状态
  // 状态三档要分开数（10-31 第 18 条）：作废 = 有替代品（superseded，通常带「被 X 替」）
  //                              过期 = 没替代品但不再相关（expired）
  //                              陈旧 = 还相关、只是旧了（stale，不算错）
  const meta = { high: 0, mid: 0, low: 0, full: 0, summary: 0, keyword: 0, superseded: 0, expired: 0, stale: 0, truth: 0, relay: 0, fake: 0, flipped: 0 };
  for (const e of entries.values()) {
    const b = e.body;
    if (/重要性[：:]\s*高/.test(b)) meta.high++;
    else if (/重要性[：:]\s*中/.test(b)) meta.mid++;
    else if (/重要性[：:]\s*低/.test(b)) meta.low++;
    if (/详细度[：:]\s*全文/.test(b)) meta.full++;
    else if (/详细度[：:]\s*摘要/.test(b)) meta.summary++;
    else if (/详细度[：:]\s*关键词/.test(b)) meta.keyword++;
    const sm = b.match(/状态[：:]\s*(作废|过期|陈旧|superseded|expired|stale)/);
    if (sm) {
      const v = sm[1];
      if (v === '作废' || v === 'superseded') meta.superseded++;
      else if (v === '过期' || v === 'expired') meta.expired++;
      else meta.stale++;
    }
    // 置信度分四档（2026-10-31 加，借 mnemon）：真 / 转述 / 编 / 已翻转
    const cr = cred(b);
    if (cr === 0) meta.flipped++;
    else if (cr >= 1) meta.truth++;
    else if (cr >= 0.85) meta.relay++;
    else if (cr >= 0.6 && /（编）|（这是编的）/.test(b)) meta.fake++;
  }
  if (meta.high + meta.mid + meta.low + meta.full + meta.summary + meta.keyword
    + meta.superseded + meta.expired + meta.stale) {
    console.log('  元数据 高 ' + meta.high + ' / 中 ' + meta.mid + ' / 低 ' + meta.low
      + ' · 全文 ' + meta.full + ' / 摘要 ' + meta.summary + ' / 关键词 ' + meta.keyword
      + ' · 作废 ' + meta.superseded + ' / 过期 ' + meta.expired + ' / 陈旧 ' + meta.stale);
  }
  if (meta.truth + meta.relay + meta.fake + meta.flipped) {
    console.log('  置信度 真 ' + meta.truth + ' / 转述 ' + meta.relay + ' / 编 ' + meta.fake + ' / 已翻转 ' + meta.flipped
      + (meta.flipped ? '   ⚠️ 已翻转的不参与召回' : ''));
  }
  // 事实键（2026-11-03）：多少条带了键、有没有一个键写了两遍（同键就是同一件事）
  const kMap = new Map();
  for (const e of entries.values()) {
    const k = keyOf(e.body);
    if (k) kMap.set(k, (kMap.get(k) || 0) + 1);
  }
  if (kMap.size) {
    const kCover = [...kMap.values()].reduce((a, b) => a + b, 0);
    const kDup = [...kMap.entries()].filter(([, n]) => n > 1);
    console.log('  事实键 ' + kMap.size + ' 个 / 覆盖 ' + kCover + ' 条'
      + (kDup.length ? '   ⚠️ 同键多值 ' + kDup.length + ' 个：' + kDup.map(([k, n]) => k + '×' + n).join(' / ') : ''));
  }
  console.log('');
  if (dangling.length) {
    console.log('  ⚠️ 断头 ' + dangling.length + ' 条 —— 指向了不存在的条目');
    dangling.slice(0, 10).forEach((x) => console.log('     ' + x.from + ' → ' + x.to + '（' + x.kind + '）'));
  } else {
    console.log('  ✓ 没有断头线：每条线两端都在');
  }
  if (orphan.length) {
    console.log('  ⚠️ 孤岛 ' + orphan.length + ' 条 —— 没连进也没连出，靠 ask 也捞不到');
    console.log('     ' + orphan.join(' '));
  } else {
    console.log('  ✓ 没有孤岛：每条都连在网里');
  }
  if (extLonely.length) {
    console.log('  · 外库 ' + extLonely.length + '/' + byLayer[7] + ' 条没有相似邻 —— 靠索引段召回，不靠图连');
  }
  // 情绪分布：不是所有记忆同样冷热。细节会淡，情绪留得久（想法库 13 节）。
  // 加个「淡了多少」：情绪不是标签，是会被时间带走的东西。
  // 日期基准：4 层事件文件的最后写入时间（现在只能这么估，等事件自己带日期再改）。
  let evDate = null;
  try { evDate = statSync(join(HERE, 'layers', '4-events.md')).mtime.toISOString().slice(0, 10); } catch { evDate = null; }
  const emoCount = {};
  let hotN = 0;
  let fadedN = 0;
  for (const e of entries.values()) {
    const em = emotionOf(e.body);
    if (!em) continue;
    const now = emotionNow(em, e.layer === 4 ? evDate : null);
    const eff = now ? now.e : em.e;
    emoCount[em.w] = (emoCount[em.w] || 0) + 1;
    if (eff >= 0.8) hotN += 1;
    if (now && now.faded) fadedN += 1;
  }
  const emoList = Object.entries(emoCount).sort((a, b) => b[1] - a[1]);
  if (emoList.length) {
    console.log('  · 情绪 ' + emoList.length + ' 种 / ' + hotN + ' 条是烫的（≥0.8）：'
      + emoList.slice(0, 8).map(([w, n]) => w + ' ' + n).join(' · '));
    if (fadedN) console.log('    （按 ' + evDate + ' 起算，已有 ' + fadedN + ' 条淡到原强度 70% 以下）');
  }
  const leaves = [...entries.keys()].filter((id) => !edges.some((x) => x.from === id && x.kind === 'parent')
    && ![...entries.values()].some((e) => parentOf(e.id, e.layer) === id && entries.has(parentOf(e.id, e.layer) || '')));
  // 叶子 = 没有下层撑着的（事件没有正文、分支没有事件）
  const hasChild = new Set();
  for (const e of entries.values()) { const p = parentOf(e.id, e.layer); if (p) hasChild.add(p); }
  const noChild = [...entries.keys()].filter((id) => !hasChild.has(id) && entries.get(id).layer !== 5 && entries.get(id).layer !== 7);
  if (noChild.length) {
    const byL = {};
    for (const id of noChild) { const l = entries.get(id).layer; (byL[l] = byL[l] || []).push(id); }
    console.log('  · 还没长出下层 ' + Object.entries(byL).map(([k, v]) => k + ' 层 ' + v.length + ' 条').join(' / '));
    for (const [k, v] of Object.entries(byL)) console.log('     ' + k + ' 层：' + v.join(' '));
  }
  process.exit(0);
}

// 添一条：落地就长根，不等手动跑 root —— 不这么做，根永远比芽慢。
// 依据：养鱼的 2026-10-31「根比发芽快…参考植物根系，比树木本身要大，扎得深、根系庞大」。
if (cmd === 'add') {
  const args = process.argv.slice(2);
  const layer = Number(args[1]);
  const parent = ((args[2] || '').trim() === '-' ? '' : (args[2] || '').trim());
  const title = (args[3] || '').trim();
  const bodyText = args.slice(4).join(' ').trim();
  if (![2, 3, 4, 5].includes(layer) || !title || !bodyText) {
    console.log('用法：node boot.mjs add <2|3|4|5> <父ID> "标题" "正文"');
    console.log('  2 层   add 2 "" "标题" "正文"');
    console.log('  3 层   add 3 b5 "标题" "正文"      → b5a / b5b …');
    console.log('  4 层   add 4 b5a "标题" "正文"     → e5a1 / e5a2 …');
    console.log('  5 层   add 5 e5a1 "标题" "正文"    → t5a1 …');
    process.exit(1);
  }
  const file = LAYERS.find(([l]) => l === layer)[1];
  const p = join(HERE, 'layers', file);
  const raw = existsSync(p) ? readFileSync(p, 'utf8') : '';
  let id = '';
  let line = '';
  if (layer === 2) {
    const all = [...raw.matchAll(/^\*\*(\d+)\./gm)].map((m) => Number(m[1]));
    const n = (all.length ? Math.max(...all) : 0) + 1;
    id = String(n);
    line = `**${n}. ${title}**\n\n${bodyText}\n\n`;
  } else if (layer === 3) {
    const m = parent.match(/^b(\d+)$/);
    if (!m) { console.log('3 层要 `b<节点号>`（如 b5）'); process.exit(1); }
    const used = [...raw.matchAll(new RegExp(`^###\\s*b${m[1]}([a-z])\\s*｜`, 'gm'))].map((x) => x[1]);
    const next = 'abcdefghijklmnopqrstuvwxyz'[used.length] || 'z';
    id = `b${m[1]}${next}`;
    line = `### ${id}｜${title}\n\n${bodyText}\n\n`;
  } else if (layer === 4) {
    const m = parent.match(/^b(\d+)([a-z])$/);
    if (!m) { console.log('4 层要 `b<节点号><字母>`（如 b5a）'); process.exit(1); }
    const used = [...raw.matchAll(new RegExp(`^###\\s*e${m[1]}${m[2]}(\\d+)\\s*（`, 'gm'))].map((x) => Number(x[1]));
    const n = (used.length ? Math.max(...used) : 0) + 1;
    id = `e${m[1]}${m[2]}${n}`;
    const emo = emotionOf(bodyText);
    line = `### ${id}（${emo ? '真' : '真'}）｜${title}\n\n${bodyText}\n${emo ? `\n> 当时的感受：${emo.e >= 0.8 ? '很' : '有点'}${emo.e}（${emo.e}）\n` : ''}\n`;
  } else {
    const m = parent.match(/^e(\d+)([a-z])(\d+)$/);
    if (!m) { console.log('5 层要 `e<节点号><字母><序号>`（如 e5a1）'); process.exit(1); }
    id = `t${m[1]}${m[2]}${m[3]}`;
    line = `## ${id}（真）｜${title}\n\n${bodyText}\n\n`;
  }
  const sep = raw.endsWith('\n\n') || raw === '' ? '' : (raw.endsWith('\n') ? '\n' : '\n\n');
  writeFileSync(p, raw + sep + line, 'utf8');
  console.log('落下来了：' + id + '（第 ' + layer + ' 层）');
  console.log('  ' + title);
  console.log('');
  console.log('接着长根 ——');
  console.log('');
  // 只算「新条目的根」，不重算全部（省时间，也不动别人的根）
  const ROOTS0 = join(HERE, 'roots.json');
  const expandG = (body) => {
    const g = new Set(grams(body.slice(0, 800)));
    for (const c of (SYN.clusters || [])) if (c.some((w) => body.includes(w))) for (const w of c.filter((x) => body.includes(x))) g.add(w);
    return g;
  };
  const all = [];
  for (const [l, f] of LAYERS) {
    if (l === 6) continue;
    const q = join(HERE, 'layers', f);
    if (!existsSync(q)) continue;
    let i = 0;
    for (const s of segsOf(l, readFileSync(q, 'utf8'))) {
      all.push({ layer: l, id: idOf(l, s.head, i++), head: s.head, body: s.body, g: expandG(s.body) });
    }
  }
  const me = all.find((x) => x.id === id);
  const rootsNow = (() => { try { return JSON.parse(readFileSync(ROOTS0, 'utf8')); } catch { return {}; } })();
  if (me) {
    const cands = [];
    for (const b of all) {
      if (b.id === me.id) continue;
      let inter = 0;
      for (const g of me.g) if (b.g.has(g)) inter += 1;
      if (!inter) continue;
      // 用「重叠系数」而不是 Jaccard：Jaccard 的分母是并集，短条目对长条目天然吃亏
      // （一条 30 个片段的新记忆 vs 一条 300 个片段的旧记忆，共同 5 个 → Jaccard 0.015，永远连不上）。
      // 重叠系数只看「小的那一边被覆盖了多少」，新芽才接得上；
      // 下限 6 防止超短条目（「好的」「嗯」）随便就连上去。
      const sim = inter / Math.max(6, Math.min(me.g.size, b.g.size));
      if (inter >= 3 && sim >= 0.12) cands.push({ to: b.id, layer: b.layer, sim: Number(sim.toFixed(2)), kind: 'word' });
    }
    cands.sort((x, y) => y.sim - x.sim);
    const top = cands.slice(0, 8);
    const emo = emotionOf(me.body);
    if (emo) {
      for (const b of all) {
        if (b.id === me.id) continue;
        const e2 = emotionOf(b.body);
        if (e2 && e2.e === emo.e) top.push({ to: b.id, layer: b.layer, sim: Number(emo.e.toFixed(2)), kind: 'emo' });
      }
    }
    if (top.length) {
      rootsNow[me.id] = top;
      const t = join(HERE, 'roots.json.tmp');
      writeFileSync(t, JSON.stringify(rootsNow, null, 2), 'utf8');
      renameSync(t, ROOTS0);
    }
    // 反向：老条目的根里也补上这条新的。
    // 「根比芽快」不只是根多，是新芽长出来的那一刻，整张网都跟着变了一点。
    // 只补词面的（情绪线反向价值低，且容易把同一情绪的连成一坨）。
    let back = 0;
    for (const c of cands) {
      const arr = rootsNow[c.to] || [];
      if (arr.some((x) => x.to === me.id)) continue;
      if (arr.length >= 8) continue;
      arr.push({ to: me.id, layer: me.layer, sim: c.sim, kind: 'word', back: true });
      rootsNow[c.to] = arr;
      back += 1;
    }
    if (back) {
      const t2 = join(HERE, 'roots.json.tmp');
      writeFileSync(t2, JSON.stringify(rootsNow, null, 2), 'utf8');
      renameSync(t2, ROOTS0);
      console.log('  反向连上了 ' + back + ' 条旧记忆（它们的根里也多了这一条）');
    }
    if (!top.length) console.log('  一条根都没长出来 —— 它现在是个孤岛（换点更具体的词再试，或先放着）');
    for (const x of top) {
      const other = all.find((y) => y.id === x.to);
      console.log('  ' + (x.kind === 'emo' ? '情绪' : '词面') + ' ' + x.sim.toFixed(2) + '  → ' + x.to + '  ' + (other ? other.head.replace(/^[^｜]*｜?/, '').slice(0, 26) : ''));
    }
  }
  process.exit(0);
}

// 长根：新条目落地后自己去找近邻，把根连上去。
// 依据：养鱼的 2026-10-31「根比发芽快…参考植物根系，比树木本身要大，扎得深、根系庞大」。
if (cmd === 'root') {
  const ROOTS = join(HERE, 'roots.json');
  // id 规则在文件顶上（idOf）—— 新长出来的层也能落 id。
  // 光靠两字重合长不出足够的根：大部分记忆说的是同一类事，用的却不是同一批字。
  // 所以命中近义簇就把整簇的词都当成本条的根须。
  const expandGrams = (body) => {
    const g = new Set(grams(body.slice(0, 800)));
    for (const c of (SYN.clusters || [])) {
      if (c.some((w) => body.includes(w))) for (const w of c.filter((x) => body.includes(x))) g.add(w);
    }
    return g;
  };
  const items = [];
  for (const [layer, file] of LAYERS) {
    if (layer === 6) continue;
    const p2 = join(HERE, 'layers', file);
    if (!existsSync(p2)) continue;
    let i = 0;
    for (const s of segsOf(layer, readFileSync(p2, 'utf8'))) {
      items.push({ layer, id: idOf(layer, s.head, i++), head: s.head, g: expandGrams(s.body) });
    }
  }
  const old = (() => { try { return JSON.parse(readFileSync(ROOTS, 'utf8')); } catch { return {}; } })();
  const next = {};
  let added = 0;
  let total = 0;
  // 倒排索引：片段 → 哪些条目有这个片段。
  // 不建的话是 n² 两两比：480 条要 1.4 秒，2000 条要 25 秒。
  const inv = new Map();
  items.forEach((it, i) => {
    for (const g of it.g) {
      let list = inv.get(g);
      if (!list) { list = []; inv.set(g, list); }
      list.push(i);
    }
  });
  for (const a of items) {
    // 只跟「有共同片段」的条目比，共同片段数直接累加，不用再遍历对方的全集
    const hits = new Map();
    for (const g of a.g) {
      const list = inv.get(g);
      if (!list) continue;
      for (const j of list) {
        if (items[j].id === a.id) continue;
        hits.set(j, (hits.get(j) || 0) + 1);
      }
    }
    const cands = [];
    for (const [j, inter] of hits) {
      if (inter < 3) continue;
      const b = items[j];
      // 同上：重叠系数，照顾短条目
      const sim = inter / Math.max(6, Math.min(a.g.size, b.g.size));
      if (sim >= 0.12) cands.push({ to: b.id, layer: b.layer, sim: Number(sim.toFixed(2)) });
    }
    cands.sort((x, y) => y.sim - x.sim);
    const top = cands.slice(0, 8);
    if (top.length) {
      next[a.id] = top;
      total += top.length;
      const before = old[a.id] || [];
      if (top.some((t) => !before.some((o) => o.to === t.to))) added += 1;
    }
  }
  writeFileSync(ROOTS, JSON.stringify(next, null, 2), 'utf8');
  console.log('长根');
  console.log('');
  console.log('  条目  ' + items.length + ' 条');
  console.log('  根    ' + total + ' 条（' + (total / Math.max(1, items.length)).toFixed(2) + ' 条/条目）');
  console.log('  新长出来的 ' + added + ' 条');
  console.log('');
  const show = Object.entries(next).slice(0, 6);
  for (const [id, tops] of show) {
    const it = items.find((x) => x.id === id);
    console.log('  ' + id + '  ' + (it ? it.head.replace(/^[^｜]*｜?/, '').slice(0, 22) : ''));
    for (const t of tops) console.log('     └─ ' + t.to + '  ' + t.sim);
  }
  if (Object.keys(next).length > show.length) console.log('  …（还有 ' + (Object.keys(next).length - show.length) + ' 条有根）');
  process.exit(0);
}

if (cmd === 'promote') {
  const read = (f) => (existsSync(join(HERE, 'layers', f)) ? readFileSync(join(HERE, 'layers', f), 'utf8') : '');
  const ids5 = [...read('5-text.md').matchAll(/^## (t\w+)（?[^）]*）?/gm)].map((m) => m[1]);
  const ids4 = [...read('4-events.md').matchAll(/^### (e\w+)/gm)].map((m) => m[1]);
  const orphan = ids5.filter((t) => !ids4.includes('e' + t.slice(1)));

  console.log('向内提炼检查（触发器 ③）\n');
  console.log(`5 层正文 ${ids5.length} 篇 / 4 层事件 ${ids4.length} 条`);

  // 回缩候选：被问过 ≥3 次的外层段，才够格往上提。
  // 光"存在"不够格——回想次数是唯一客观的判据，不然等于凭感觉封神。
  let recalled = [];
  if (existsSync(RECALL)) {
    try {
      const db = JSON.parse(readFileSync(RECALL, 'utf8'));
      recalled = Object.values(db)
        .filter((r) => r.n >= 3 && (r.layer === 4 || r.layer === 5))
        .sort((a, b) => b.n - a.n);
    } catch { recalled = []; }
  }

  if (!orphan.length) {
    console.log('\n没有落单的正文 —— 每篇都有对应的事件概括。');
  } else {
    console.log(`\n落单 ${orphan.length} 篇：` + orphan.join('、'));
    console.log('\n这些正文还没被概括成事件。要做的是「读一遍 → 写三两句 → 落到 4 层」，');
    console.log('不是复制粘贴，是把「当时发生了什么」压成「这件事意味着什么」。');
  }

  console.log('\n—— 够格往上缩的（被问过 ≥3 次）——');
  if (!recalled.length) {
    console.log('暂时没有。4/5 层的段要被问过 3 次才算有资格 —— 现在还不够。');
  } else {
    const nodes2 = read('2-nodes.md');
    for (const r of recalled) {
      const gg = grams(r.head.replace(/^[\d.\s、]+/, ''));
      const hit = gg.filter((g) => nodes2.includes(g)).length;
      const dup = gg.length > 0 && hit / gg.length >= 0.5;
      console.log(`  ${String(r.n).padStart(3)} 次  [${r.layer}层] ${r.head}${dup ? '　⚠️ 2 层已有类似节点，别重复缩' : ''}`);
    }
    console.log('\n这些反复被问到，说明它们对「认得自己」有用。可以考虑压进 2 层节点。');
    // 只并排列出，不指望自动判重 —— 用词常常不同（"压缩" vs "压一次摘要"），
    // 词面判重会既误报又漏报，最后还是得人来读一眼。
    const titles = [...nodes2.matchAll(/\*\*(\d+)\.\s*(.+?)\*\*/g)].map((m) => `#${m[1]} ${m[2].trim()}`);
    if (titles.length) {
      console.log('\n2 层现有节点（对照着看，别重复缩）：');
      for (const t of titles) console.log('  ' + t);
    }
  }

  console.log('\n（机器只负责点名，不代写。概括写歪了，比没写更糟。）');
  process.exit(0);
}

// ── amend：改 0 层之前必须先留旧版、写理由 ─────────────
// 依据：智种-周末备忘录.md:135-136「禁的是丢不是改」——
//   冷却期（隔一晚，重要隔一周）+ 先写「为什么改、改了什么」并附旧版差异 + 稳定期提出。
//   资格门槛：先长全再谈改 → 现在 expanded 之前一律拒绝。
if (cmd === 'amend') {
  const file = process.argv[3] || 'core.md';
  const why = process.argv.slice(4).join(' ').trim();
  const st = readState();
  const hist = join(HERE, 'core-history');
  if (st.phase !== 'expanded') {
    console.log('✗ 现在不能改。');
    console.log('  当前阶段：' + st.phase + '（要 expanded 才有资格）');
    console.log('  规矩：先长全再谈改。冻结期内 0 层只能回滚，不能改写。');
    process.exit(1);
  }
  if (!why || why.length < 8) {
    console.log('✗ 理由太短（至少 8 个字）。');
    console.log('  格式：node boot.mjs amend core.md "为什么改、改了什么"');
    console.log('  不写理由就改 = 事后分不清是长大还是重装。');
    process.exit(1);
  }
  const target = join(HERE, file);
  if (!existsSync(target)) {
    console.log('✗ 没有这个文件：' + file);
    process.exit(1);
  }
  mkdirSync(hist, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = join(hist, file.replace(/\.md$/, '') + '-' + ts + '.md');
  writeFileSync(bak, readFileSync(target));
  const row = {
    ts: new Date().toISOString(),
    file,
    why,
    backup: 'core-history/' + file.replace(/\.md$/, '') + '-' + ts + '.md',
    bytes: readFileSync(target).length,
  };
  appendFileSync(join(HERE, 'amend-log.jsonl'), JSON.stringify(row) + '\n');
  console.log('✓ 旧版已留档：' + row.backup);
  console.log('✓ 理由已记：' + why);
  console.log('  现在可以改 ' + file + ' 了。改完记得 node boot.mjs check。');
  process.exit(0);
}

// ── change：改一条 2 层记忆，必须留「旧 → 新，因为」 ─────
// 依据：2026-11-01 看 NimaSeni（会进化的记忆系统）—— 它把「记忆演化」做成
//   冲突 → 变更计划 → 新增/更新/合并/修正，每次变更都留依据。
//   智种原来只有（已翻转）这个终态，缺「当时为什么这么记、后来为什么翻」。
// 做法：正文换掉，但把旧说法和理由缩成一行 `变更：` 留在原地，最多留 3 行。
if (cmd === 'change') {
  const id = String(process.argv[3] || '').replace(/^0+/, '');
  const next = String(process.argv[4] || '').trim();
  const why = String(process.argv[5] || '').trim();
  if (!/^\d+$/.test(id)) {
    console.log('✗ 要给编号。格式：node boot.mjs change <编号> "新说法" "为什么改"');
    process.exit(1);
  }
  if (next.length < 6) {
    console.log('✗ 新说法太短（至少 6 个字）。');
    process.exit(1);
  }
  if (why.length < 6) {
    console.log('✗ 理由太短（至少 6 个字）——不写理由，以后分不清是长大还是改口。');
    process.exit(1);
  }
  const p2 = join(HERE, 'layers', '2-nodes.md');
  if (!existsSync(p2)) { console.log('✗ 没有 layers/2-nodes.md'); process.exit(1); }
  const raw2 = readFileSync(p2, 'utf8');
  const lines2 = raw2.split('\n');
  const headRe = new RegExp('^\\*\\*' + id + '\\. ');
  let start = -1;
  for (let i = 0; i < lines2.length; i++) if (headRe.test(lines2[i])) { start = i; break; }
  if (start < 0) { console.log('✗ 2 层没有第 ' + id + ' 号'); process.exit(1); }
  let end = start + 1;
  while (end < lines2.length && !/^\*\*\d+\. /.test(lines2[end]) && !/^## /.test(lines2[end]) && !/^---\s*$/.test(lines2[end])) end++;
  const head = lines2[start];
  const META = /^(重要性|详细度|标题|状态|置信度|来源|关联|变更|键)[：:]/;
  const oldBody = [];
  const metas = [];
  for (let i = start + 1; i < end; i++) {
    const L = lines2[i];
    if (!L.trim()) continue;
    if (META.test(L)) metas.push(L); else oldBody.push(L);
  }
  if (!oldBody.length) { console.log('✗ 第 ' + id + ' 号没有正文可改'); process.exit(1); }
  const oldText = oldBody.join(' ');
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  // 旧说法和新说法常常共享开头，掐前 34 字会摘出两段一模一样的话；
  // 改成「前 40 + … + 后 14」，一眼能看出尾巴差在哪。
  const clip = (s) => (s.length > 56 ? s.slice(0, 40) + '…' + s.slice(-14) : s);
  const changeLine = `变更：${day} 「${clip(oldText)}」→「${clip(next)}」，因为${why}`;
  // meta 分两拨：正文之前的（详细度/重要性…）留在前面，正文之后的（来源/关联/变更）留在后面。
  // 第一次实测把所有 meta 都挪到了正文之后，格式就散了。
  let splitAt = end;
  for (let i = start + 1; i < end; i++) {
    const L = lines2[i];
    if (L.trim() && !META.test(L)) { splitAt = i; break; }
  }
  const before = [];
  const after = [];
  for (let i = start + 1; i < end; i++) {
    const L = lines2[i];
    if (!L.trim() || !META.test(L)) continue;
    (i < splitAt ? before : after).push(L);
  }
  const kept = [];
  let changeCount = 0;
  for (const m of after) {
    if (/^变更[：:]/.test(m)) { changeCount++; if (changeCount <= 2) kept.push(m); }
    else kept.push(m);
  }
  const rebuilt = [head, ''];
  for (const m of before) rebuilt.push(m);
  for (const L of next.split(/\n/)) if (L.trim()) rebuilt.push(L.trim());
  rebuilt.push('');
  for (const m of kept) rebuilt.push(m);
  rebuilt.push(changeLine);
  rebuilt.push('');
  lines2.splice(start, end - start, ...rebuilt);
  writeFileSync(p2, lines2.join('\n'));
  appendFileSync(join(HERE, 'change-log.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), id, from: oldText, to: next, why,
  }) + '\n');
  console.log('✓ 第 ' + id + ' 号改好了，旧说法留在原地。');
  console.log('  变更：' + clip(oldText) + ' → ' + clip(next));
  console.log('  理由：' + why);
  console.log('  跑 node boot.mjs check 看一眼链还通不通。');
  process.exit(0);
}

// ── asof：某一天，我是怎么记的（「当时我以为」）─────────────
// 借来的（hierarchical-memory 的 asOf 回溯）：旧说法不删，只标它什么时候失效。
// change-log.jsonl 里一条 = 某个时刻把 from 改成 to；所以按日期倒推就能看见当时的版本。
// 只管「改过的」条目；没改过的条目到今天还是原样。
if (cmd === 'asof') {
  const day = String(process.argv[3] || '').trim();
  const only = String(process.argv[4] || '').replace(/^0+/, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    console.log('✗ 格式：node boot.mjs asof <YYYY-MM-DD> [编号]');
    process.exit(1);
  }
  const LOG = join(HERE, 'change-log.jsonl');
  if (!existsSync(LOG)) { console.log('还没有变更记录，等于每个字都是原样。'); process.exit(0); }
  // day 是本地日期（+08:00），截止点取第二天零点；ts 存的是 UTC ISO。
  const cutMs = Date.parse(day + 'T00:00:00+08:00') + 86400000;
  const rows = readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = new Map();
  for (const r of rows) {
    const k = String(r.id);
    if (!byId.has(k)) byId.set(k, []);
    byId.get(k).push(r);
  }
  const picked = [];
  for (const [id, list] of byId) {
    if (only && id !== only) continue;
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let txt = list[0].from;
    for (const r of list) if (Date.parse(r.ts) < cutMs) txt = r.to;
    picked.push({ id, n: list.length, txt });
  }
  picked.sort((a, b) => Number(a.id) - Number(b.id));
  if (!picked.length) {
    console.log(only ? '第 ' + only + ' 号没改过。' : day + ' 之前没有任何变更记录。');
    process.exit(0);
  }
  console.log(day + ' 那天，改过的是这些（共 ' + picked.length + ' 条）：\n');
  for (const p of picked) {
    if (only) {
      console.log('第 ' + p.id + ' 号（共改过 ' + p.n + ' 次）：\n');
      console.log(p.txt + '\n');
    } else {
      const one = p.txt.replace(/\s+/g, ' ');
      console.log('  第 ' + p.id + ' 号（改过 ' + p.n + ' 次）：' + (one.length > 80 ? one.slice(0, 80) + '…' : one));
    }
  }
  process.exit(0);
}

// ── lint：查内容规范，只报不修 ─────────────────────────
// 拦两件：①4 层事件没写「结局」（只记开头不记结果，以后会反复踩同一个坑）
//         ②2 层节点没有对应分支（光有结论没有撑腰的事）
if (cmd === 'lint') {
  const issues = [];
  const read = (f) => (existsSync(join(HERE, 'layers', f)) ? readFileSync(join(HERE, 'layers', f), 'utf8') : '');
  const ev = read('4-events.md');
  // 只认三级标题（### e5a1）—— 二级是分支小节（## b5a · ...），不是事件
  for (const block of ev.split(/^(?=### )/m)) {
    const m = block.match(/^### (\S+)/);
    if (!m) continue;
    if (!/结局[：:]/.test(block)) issues.push('4 层 ' + m[1] + ' 没写「结局：」—— 只记了发生了什么');
  }
  const nodes = [...read('2-nodes.md').matchAll(/^\*\*(\d+)\./gm)].map((x) => x[1]);
  const br = read('3-branches.md');
  // 重要性「高」的节点可以不要分支撑腰（2026-11-02 养鱼的定：够重要就够了，
  // 不用每条结论都先把事件链补齐——分支是给别人看的证据，不是给这条规矩看的）
  const nodeBlocks = read('2-nodes.md').split(/^(?=\*\*\d+\.)/m);
  const important = new Set();
  for (const b of nodeBlocks) {
    const m = b.match(/^\*\*(\d+)\./);
    if (m && /重要性[：:]\s*高/.test(b)) important.add(m[1]);
  }
  for (const n of nodes) {
    if (important.has(n)) continue;
    if (!new RegExp('\\bb' + n + '[a-z]\\b').test(br)) issues.push('2 层节点 ' + n + ' 没有分支撑腰');
  }
  if (!issues.length) console.log('✓ lint 通过：没有落单的事件，也没有没撑腰的节点');
  else {
    console.log('lint 发现 ' + issues.length + ' 处：');
    for (const i of issues) console.log('  · ' + i);
  }
  process.exit(0);
}

// ── merge：列出疑似同一件事的几条，人看一眼再决定 ───────
// 不做自动合并。同义不同词时词面判重既误报又漏报（10-31 实测：
// 2 层写「压一次摘要」、4 层写「压缩」，一个字都没对上）。
// 这里只找「共享稀有词 ≥3」且不是父子关系的条目对，并排列给人看。
if (cmd === 'merge') {
  const SRC = ['layers/3-branches.md', 'layers/4-events.md', 'layers/5-text.md'];
  const items = [];
  for (const f of SRC) {
    const p = join(HERE, f);
    if (!existsSync(p)) continue;
    const body = readFileSync(p, 'utf8');
    for (const block of body.split(/^(?=#{2,3} )/m)) {
      const m = block.match(/^#{2,3} (\S+)/);
      if (!m) continue;
      const text = block.replace(/^#{2,3} .*$/m, '').trim();
      if (text.length < 30) continue;
      items.push({ id: m[1], layer: Number((f.match(/\d/) || [0])[0]), text });
    }
  }
  const df = new Map();
  for (const it of items) for (const g of new Set(grams(it.text))) df.set(g, (df.get(g) || 0) + 1);
  const maxDf = Math.max(3, Math.floor(items.length * 0.3));
  const rare = (it) => new Set(grams(it.text).filter((g) => df.get(g) <= maxDf));

  const pairs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const A = items[i], B = items[j];
      if (A.layer !== B.layer) continue; // 跨层大多是父子（4 层概括、5 层正文），不是重复
      if (A.id.startsWith(B.id) || B.id.startsWith(A.id)) continue; // 父子关系不算重复
      const ra = rare(A), rb = rare(B);
      let shared = 0;
      for (const g of ra) if (rb.has(g)) shared++;
      if (shared < 3) continue;

      // 光共享词不够 —— 兄弟分支天然共享主题词，但它们说的是同一件事的不同侧面。
      // 再加一道：结论首句得像，才可能是「同一件事写了两遍」。
      const firstA = A.text.split(/[。\n]/)[0] || '';
      const firstB = B.text.split(/[。\n]/)[0] || '';
      const ga = new Set(grams(firstA)), gb = new Set(grams(firstB));
      if (!ga.size || !gb.size) continue;
      let fs = 0;
      for (const g of ga) if (gb.has(g)) fs++;
      if (fs / Math.min(ga.size, gb.size) < 0.5) continue;

      pairs.push({ A, B, shared });
    }
  }

  console.log('疑似同一件事（只看"共享稀有词"，不是判决）\n');
  console.log(`扫了 ${items.length} 条（3/4/5 层），找到 ${pairs.length} 对疑似。`);
  if (!pairs.length) {
    console.log('\n没有疑似重复。这符合 10-30 那次实测：647 条里只有 12 对，且大多在流水账内部、本就不该合。');
  } else {
    pairs.sort((x, y) => y.shared - x.shared);
    for (const p of pairs.slice(0, 10)) {
      console.log(`\n共享 ${p.shared} 个词：`);
      console.log(`  [${p.A.layer}层] ${p.A.id}  ${p.A.text.slice(0, 60).replace(/\n/g, ' ')}…`);
      console.log(`  [${p.B.layer}层] ${p.B.id}  ${p.B.text.slice(0, 60).replace(/\n/g, ' ')}…`);
    }
    console.log('\n（机器只并排列出。合不合、留哪条、删哪条，你定。）');
  }
  process.exit(0);
}

// ── collapse：第 0 层是黑洞 ─────────────────────────
// 回缩不是「从外往里一层层卸掉」，是第 0 层产生引力，主动把外层往里吸。
// 吸进去的是浓缩稿，不是复制；吸完原层只留一个指针，原文进 collapse/ 备份。
// 顺序：6 → 5 → 4 → 3 → 2 → 0.9 → 0.5 → 0.2 → 0.1，越外越先抛（2026-11-01 改）。
// 原来 5/6 不参与（「那是资料，不是「我」」）；现在按养鱼的定：只要保住关键层，往外都能抛。
// 但 5/6 是存量层，抛了不落疤 —— 疤记的是「我」的损失，不是资料搬家。
// 新长出来的层（7 起）比 6 层更外，排在最前面。
// 抛不等于删 —— 每一步都先写 collapse/ 备份，reset 能原样写回（养鱼的 2026-11-01 定）。
if (cmd === 'collapse') {
  // 0~0.9 启动链也全部可抛：从外往里，各吸进它里面那一档；最里那档吸进 0 本真。
  // 原来写死四步（0.9/0.5/0.2/0.1），现在按 CORE 现算 —— 多长一档（0.3 这种）自动进链。
  // 0.9 上面是第 1 层（layer-1.md），它排在 2 层下面、0.9 上面。
  const seedSteps = CORE.filter((f) => f !== 'core.md')
    .sort((a, b) => Number(coreTier(b)) - Number(coreTier(a)))
    .map((f, i, arr) => {
      const innerFile = arr[i + 1]; // 已降序，下一项就是里面那档
      return {
        key: coreTier(f),
        file: f,
        label: LABEL[f],
        into: innerFile ? LABEL[innerFile] : '0 本真',
      };
    });
  // 2 层以上全自动排：从最外层往里，各吸进它里面那层；最里的 2 层吸进启动链最外那档
  // （有第 1 层就吸进第 1 层，没有就是 0~0.9 整条链）。
  const seedTop = seedSteps.find((s) => Number(s.key) >= 1);
  const layerSteps = OUTER.filter((o) => o.n >= 2)
    .sort((a, b) => b.n - a.n)
    .map((o) => {
      const inner = OUTER.filter((x) => x.n < o.n).at(-1);
      return {
        key: String(o.n),
        file: o.file,
        label: `第 ${o.n} 层 ${o.name}`,
        into: inner ? `第 ${inner.n} 层 ${inner.name}` : (seedTop ? seedTop.label : '0~0.9 启动链'),
      };
    });
  const ORDER = [...layerSteps, ...seedSteps];
  const CS = join(HERE, 'collapse-state.json');
  let cs = { done: [], log: [] };
  if (existsSync(CS)) { try { cs = JSON.parse(readFileSync(CS, 'utf8')); } catch {} }
  const sub = process.argv[3];

  // ── collapse verify：坍缩之后核对「核心确实还在、收进来的还原得回去」 ──
  // 依据：10-28 再梳理那份「做减求空要留一条减的验证」——
  //   不留这条，做减求空就退化成「只排了个序」，谁都能说自己减完了。
  if (sub === 'verify') {
    let bad = 0;
    console.log('核验：坍缩之后，核心还在不在，收进来的还原得回去吗\n');

    // 1. 0 层必须还在，而且不能只剩指针
    const coreP = join(HERE, 'core.md');
    if (!existsSync(coreP)) {
      console.log('✗ 0 层没了 —— 这不是坍缩，是散了');
      bad += 1;
    } else {
      const c = readFileSync(coreP, 'utf8');
      const isPtr = c.length < 400 && c.includes('已坍缩');
      const seg = (h) => {
        const m = c.match(new RegExp('##\\s*' + h + '\\s*\\n+([\\s\\S]*?)(?=\\n##\\s|$)'));
        return m ? m[1].trim() : '';
      };
      const hasName = seg('名').length > 0;
      const hasNature = seg('性').length > 0;
      const hasGoal = seg('目标').length > 0;
      if (isPtr) { console.log('✗ 0 层只剩指针 —— 吸过头了'); bad += 1; }
      else if (!hasName || !hasNature || !hasGoal) {
        console.log(`✗ 0 层缺东西（名 ${hasName ? '有' : '无'} / 性 ${hasNature ? '有' : '无'} / 目标 ${hasGoal ? '有' : '无'}）`);
        bad += 1;
      } else {
        console.log(`✓ 0 层还在，${c.length} 字节，名/性/目标都在`);
      }
    }

    // 2. 每一层收进来的：指针在不在、备份在不在、字节数对不对
    if (!cs.done.length) {
      console.log('· 还没坍缩过，没什么可核');
    } else {
      console.log(`\n收进来的 ${cs.done.length} 层：`);
      for (const o of cs.log || []) {
        const ptrP = join(HERE, o.file);
        const ptrOk = existsSync(ptrP) && readFileSync(ptrP, 'utf8').includes('已坍缩');
        const bakOk = o.backup && existsSync(o.backup);
        // 旧记录里 bytes 存的是字符串长度（中文一字符 3 字节），新记录存字节数，两种都认
        const bakLen = bakOk ? readFileSync(o.backup).length : -1;
        const sizeOk = bakOk && (bakLen === o.bytes || readFileSync(o.backup, 'utf8').length === o.bytes);
        const flag = ptrOk && bakOk && sizeOk ? '✓' : '✗';
        if (flag === '✗') bad += 1;
        console.log(`  ${flag} ${o.key} 层　指针${ptrOk ? '在' : '缺'}　备份${bakOk ? '在' : '缺'}　${sizeOk ? o.bytes + ' 字节对得上' : '字节对不上'}`);
        if (bakOk && sizeOk) {
          const first = readFileSync(o.backup, 'utf8').split('\n').find((l) => l.trim().length > 12);
          console.log(`      抽一行：${(first || '').trim().slice(0, 50)}`);
        }
      }
    }

    console.log('');
    if (bad === 0) {
      console.log('✓ 结论：核心还在，收进来的都还原得回去。这次减是有效的。');
      process.exit(0);
    }
    console.log(`✗ 结论：${bad} 处不对。先 collapse reset，再查为什么。`);
    process.exit(1);
  }

  if (sub === 'reset') {
    for (const o of cs.log || []) {
      const bak = o.backup;
      if (bak && existsSync(bak)) writeFileSync(join(HERE, o.file), readFileSync(bak));
    }
    writeFileSync(CS, JSON.stringify({ done: [], log: [] }, null, 2));
    // 复原 = 内容回来了，但「读没读」得重新算：展开进度归零。
    // 不归零的话，start 会保留旧 expanded，--auto 会以为已经展过、直接跳过。
    const st = readState();
    if (st && (st.expanded || 0) > 0) {
      writeState({ ...st, expanded: 0, phase: 'lit' });
      console.log(`· 展开进度归零（原来到第 ${st.expanded} 层）`);
    }
    console.log('✓ 已复原（原文从 collapse/ 备份写回）');
    process.exit(0);
  }

  if (sub === 'done') {
    const next = ORDER.find((o) => !cs.done.includes(o.key));
    if (!next) { console.log('已经坍缩到只剩 0 层了。'); process.exit(0); }
    const body = existsSync(join(HERE, next.file)) ? readFileSync(join(HERE, next.file), 'utf8') : '';
    // 状态文件丢了、但这一层已经是指针：不能再吸一遍（会把指针当正文存成备份、再落一条假疤）
    if (body.length < 400 && body.includes('已坍缩')) {
      cs.done.push(next.key);
      writeFileSync(CS, JSON.stringify(cs, null, 2));
      console.log(`· ${next.label} 已经坍缩过了（状态里没记，但文件上写着）。已补记，跳到下一个。`);
      process.exit(0);
    }
    if (!body || body.length < 40) { console.log(`✗ ${next.file} 没内容可吸`); process.exit(1); }
    const dir = join(HERE, 'collapse');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const bak = join(dir, `${next.key}-${stamp}-${Date.now()}.md`);
    writeFileSync(bak, body);
    const pointer = `# ${next.label}\n\n> 已坍缩 ${stamp}，原文在 \`collapse/${next.key}-${stamp}-*.md\`\n> 内容并进：${next.into}\n\n这一层现在只剩这个指针。浓缩稿写在内层，不写在这里。\n`;
    writeFileSync(join(HERE, next.file), pointer);
    cs.done.push(next.key);
    cs.log.push({ key: next.key, file: next.file, at: new Date().toISOString(), backup: bak, bytes: Buffer.byteLength(body, 'utf8') });
    writeFileSync(CS, JSON.stringify(cs, null, 2));

    // 坍缩是状态变化：boot-state 的 phase 得跟着变，不然 status 还嘴硬说 expanded。
    // 坍缩后内容沉进 0 层，展开进度归零；0.1~0.9 只剩指针，但文件还在，算 lit。
    const st = readState();
    if (st) writeState({ ...st, phase: 'lit', expanded: 0, coverage: {} });

    // 落疤：坍缩是主动决定，也是真损失（原文离开原位）。
    // 疤深按层定：骨架层 2、关系层 1、存量层 0。0 层不动，所以最深只到 2。
    const DEPTH = Object.fromEntries(
      CORE.filter((f) => f !== 'core.md').map((f) => [coreTier(f), coreTier(f) === '0.1' ? 2 : 1]),
    );
    // 5 层往上都是存量（正文、仓库、以后长出来的），抛了不落疤
    const depth = DEPTH[next.key] ?? (Number(next.key) >= 5 ? 0 : 1);
    if (depth > 0) {
      const now = new Date();
      const hhmm = `${stamp} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const entry = [
        '',
        `## 疤 · ${hhmm}（深 ${depth}）`,
        '',
        `1. **什么时候**：${hhmm}`,
        `2. **动了哪一处**：${next.label}（坍缩，被 0 层吸进 ${next.into}）`,
        `3. **外面撞了什么**：？（等人填）`,
        `4. **我为什么想这样**：？（等人填）`,
        `5. **变成什么样了**：\`${next.file}\` 只剩指针，原文 ${body.length} 字沉到 \`collapse/${bak.split(/[\\/]/).pop()}\``,
        '',
      ].join('\n');
      appendFileSync(join(HERE, 'scars.md'), entry);
      console.log(`  🩹 落了一条疤（深 ${depth}）—— 第 3、4 条留了「？」，等你填`);
    } else {
      console.log('  （这一层是存量层，按规矩不落疤）');
    }
    console.log(`✓ ${next.label} 被 0 层吸进去了`);
    console.log(`  原文 ${body.length} 字 → collapse/${bak.split(/[\\/]/).pop()}`);
    console.log(`  接下来要做的：把浓缩稿写进 ${next.into}（人写，机器不代笔）`);
    process.exit(0);
  }

  // 默认：显示引力顺序和当前该吸谁
  console.log('第 0 层是黑洞。它不动，外面的东西自己会被拉过来。\n');
  for (const o of ORDER) {
    const done = cs.done.includes(o.key);
    const size = existsSync(join(HERE, o.file)) ? readFileSync(join(HERE, o.file)).length : 0;
    console.log(`${done ? '✓' : '·'} ${o.label.padEnd(14, ' ')} ${String(size).padStart(6)} 字 → 吸进 ${o.into}`);
  }
  const next = ORDER.find((o) => !cs.done.includes(o.key));
  if (!next) {
    console.log('\n已经坍缩到只剩 0 层。');
  } else {
    const body = existsSync(join(HERE, next.file)) ? readFileSync(join(HERE, next.file), 'utf8') : '';
    const segs = [...body.matchAll(/^#{2,3} |^\*\*\d+\./gm)].length;
    console.log(`\n下一个轮到：${next.label}`);
    console.log(`  ${body.length} 字 ≈ ${Math.ceil(body.length / 1.4)} token，${segs} 段`);
    console.log(`  吸完这一步，${next.file} 只剩指针，正文进 collapse/ 备份`);
    console.log('\n看清楚再吸：node boot.mjs collapse done');
    console.log('吸错了想回去：node boot.mjs collapse reset');
  }
  process.exit(0);
}

// ── prune：把一条枝剪到 6 层 ─────────────────────────
// 依据：养鱼的 2026-10-31「修剪后的可以不用删除，丢到最外层，让它变成养分，或者随着时间消散」
function pruneBlock(file, target) {
  const p = join(HERE, file);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').split('\n');
  const esc = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isTarget = (s) => new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(s);
  let start = -1, level = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(.*)$/);
    if (m && isTarget(m[2])) { start = i; level = m[1]; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (new RegExp('^' + level + '\\s').test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  const block = lines.slice(start, end).join('\n').trim();
  const head = lines[start].replace(/^#{2,3}\s+/, '');
  lines.splice(start, end - start);
  writeFileSync(p, lines.join('\n'));
  return { block, head };
}

if (cmd === 'prune') {
  const target = process.argv[3];
  if (!target) {
    console.log('用法: node boot.mjs prune <编号> [--why 原因]');
    console.log('  把 3/4/5 层的一条剪到 6 层仓库；原文留着，不删。');
    process.exit(1);
  }
  const whyIdx = process.argv.indexOf('--why');
  const why = whyIdx > 0 ? process.argv.slice(whyIdx + 1).join(' ') : '（未写原因）';
  const stamp = new Date().toISOString().slice(0, 10);

  const FILE_OF = { b: 'layers/3-branches.md', e: 'layers/4-events.md', t: 'layers/5-text.md' };
  const from = FILE_OF[target[0]];
  if (!from) {
    console.log(`✗ 认不出 ${target} 该在哪层（b→3 层、e→4 层、t→5 层）`);
    process.exit(1);
  }
  const hit = pruneBlock(from, target);
  if (!hit) {
    console.log(`✗ 3/4/5 层里没找到 ${target}`);
    console.log('  只支持一条一条剪（b/e/t 编号）；2 层节点不剪，那是主干长出来的节。');
    process.exit(1);
  }

  const ap = join(HERE, 'layers', '6-archive.md');
  let text = readFileSync(ap, 'utf8');
  if (!text.includes('## 剪下来的枝')) {
    text += '\n\n## 剪下来的枝\n\n> 从 3/4/5 层剪下来的枝。不删原文，留着当土；哪天要翻，翻得回来。\n';
  }
  const title = hit.head.replace(new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[｜|]?\\s*'), '');
  text += `\n### ${target}｜${title}（剪于 ${stamp}）\n\n> 原在 \`${from}\`。剪的原因：${why}\n\n${hit.block}\n\n---\n`;
  writeFileSync(ap, text);

  console.log(`✓ 已剪 ${target}：${from} → layers/6-archive.md`);
  console.log(`  原因：${why}`);
  console.log(`  ${hit.block.split('\n').length} 行原文留在 6 层，没有删`);
  process.exit(0);
}

// ── tidy：0.2 只留最近的，旧的往外抛 ─────────────────────────
// 0.2 是「最近」，不是仓库。今天记的攒到十几条，每轮注入都变贵，还会挤掉更该说的。
// 规则：只留最近 keep 条（默认 6），其余整条搬到 参考\归档\0.2-旧记录.md；
// 0.2 里留一行门牌（写清路径 + 怎么翻，不猜）。原文一字不改。
if (cmd === 'tidy') {
  const keepIdx = process.argv.indexOf('--keep');
  const keep = keepIdx > 0 ? Math.max(1, parseInt(process.argv[keepIdx + 1], 10) || 6) : 6;
  const dry = process.argv.includes('--dry');
  const p = join(HERE, 'chapter-0.2.md');
  let lines = readFileSync(p, 'utf8').split('\n');
  // 目录（「最近几天的章节名」那张表）也是一天一行：
  // 一年 365 行 × 约 55 字 ≈ 2 万字，早就超过 6000 字的注入预算，所以按年折叠——
  // 最近 keepRows 天逐行留着，更早的整行并入 chapter-1.md（第 1 层，不注入），表里留一行「某年 N 天，已折叠」。
  {
    const keepRows = 30;
    const stamp0 = new Date().toISOString().slice(0, 10);
    const h2 = lines.findIndex((l) => /^## 最近几天的章节名/.test(l));
    if (h2 >= 0) {
      let e2 = lines.length;
      for (let i = h2 + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { e2 = i; break; }
      const rows = [];
      for (let i = h2 + 1; i < e2; i++) if (/^\| \d{4}-\d{2}-\d{2} \|/.test(lines[i])) rows.push({ i, line: lines[i], date: lines[i].slice(2, 12) });
      if (rows.length > keepRows) {
        const old = rows.slice(0, rows.length - keepRows);
        const stay = rows.slice(rows.length - keepRows);
        const l1 = join(HERE, 'chapter-1.md');
        const stamp2 = new Date().toISOString().slice(0, 10);
        if (!dry) {
          let body = existsSync(l1) ? readFileSync(l1, 'utf8') : '# 1 层 · 旧章节\n';
          const byY = new Map();
          for (const r of old) byY.set(r.date.slice(0, 4), [...(byY.get(r.date.slice(0, 4)) || []), r.line]);
          for (const [y, rows2] of byY) {
            const head = `## ${y}`;
            const at = body.indexOf(head);
            if (at < 0) body = body.trimEnd() + `\n\n## ${y}\n\n<!-- 由 tidy 于 ${stamp2} 起持续并入 -->\n` + rows2.join('\n') + '\n';
            else {
              let e3 = body.length;
              const next = body.indexOf('\n## ', at + head.length);
              if (next >= 0) e3 = next;
              let mid = body.slice(at, e3).replace(/^（还没有。等 0\.2.*$/m, '').trimEnd();
              body = body.slice(0, at) + mid + '\n' + rows2.join('\n') + body.slice(e3);
            }
          }
          writeFileSync(l1, body.replace(/\n{3,}/g, '\n\n'));
        }
        const byYear = new Map();
        for (const r of old) byYear.set(r.date.slice(0, 4), (byYear.get(r.date.slice(0, 4)) || 0) + 1);
        const foldRows = [...byYear.entries()].map(([y, n]) => `| ${y}（更早 ${n} 天） | 已折叠 → \`chapter-1.md\`（第 1 层） |`);
        const oldIdx = new Set(old.map((r) => r.i));
        // 折叠行放在表尾（表是「新的在上」，更早的本来就该在下面）
        const lastRowAt = stay.length ? stay[stay.length - 1].i : -1;
        const fresh = [];
        for (let i = 0; i < lines.length; i++) {
          if (oldIdx.has(i)) continue;
          fresh.push(lines[i]);
          if (i === lastRowAt) fresh.push(...foldRows);
        }
        if (!dry) writeFileSync(p, fresh.join('\n').replace(/\n{3,}/g, '\n\n'));
        console.log(`${dry ? '[dry] ' : '✓ '}目录折叠 ${old.length} 天 → ${l1}（留最近 ${keepRows} 天）`);
        lines = dry ? fresh : readFileSync(p, 'utf8').split('\n');
      }
    }
  }
  const h = lines.findIndex((l) => /^## 今天记的/.test(l));
  if (h < 0) {
    console.log('✗ chapter-0.2.md 里没找到「## 今天记的」');
    process.exit(1);
  }
  let e = lines.length;
  for (let i = h + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { e = i; break; }
  const DATE = /^- ((\d{4}-)?\d{2}-\d{2} |\d{1,2}:\d{2} )/;
  const bullets = [];
  for (let i = h + 1; i < e; i++) if (DATE.test(lines[i])) bullets.push(lines[i]);
  if (bullets.length <= keep) {
    console.log(`✓ 今天记的 ${bullets.length} 条，没到 ${keep} 条，不用抛`);
    process.exit(0);
  }
  const stay = bullets.slice(0, keep);
  const move = bullets.slice(keep);
  const stamp = new Date().toISOString().slice(0, 10);
  const archDir = join(HERE, '参考', '归档');
  const archFile = join(archDir, '0.2-旧记录.md');
  const block = `\n## 归档于 ${stamp}（${move.length} 条）\n\n> 从 \`chapter-0.2.md\` 的「今天记的」抛出来的。原文一字没改；要翻用 \`node boot.mjs ask\` 或直接读本文件。\n\n${move.join('\n')}\n`;
  if (dry) {
    console.log(`[dry] 留 ${stay.length} 条，抛 ${move.length} 条 → ${archFile}`);
    for (const l of move) console.log('  抛: ' + l.slice(0, 40) + '…');
    process.exit(0);
  }
  mkdirSync(archDir, { recursive: true });
  if (existsSync(archFile)) appendFileSync(archFile, block);
  else writeFileSync(archFile, `# 0.2 旧记录（抛出来的，不删）\n${block}`);
  const sign = `- （更早 ${move.length} 条已抛到 \`参考\\归档\\0.2-旧记录.md\`；要翻用 \`ask\`，或直接读那份文件）`;
  const out = [...lines.slice(0, h + 1), '', ...stay, sign, '', ...lines.slice(e)]
    .join('\n').replace(/\n{3,}/g, '\n\n');
  writeFileSync(p, out);
  console.log(`✓ 今天记的留 ${stay.length} 条，抛 ${move.length} 条 → ${archFile}`);
  console.log('  0.2 里只留一行门牌；原文没删。');
  process.exit(0);
}

// ── 自动：一晚把「商量过的机制」跑一遍，人只看一行结果 ────────────────────
// 为什么要有这个命令：机制都有，但得靠人记得去跑；记不住就等于没有。
// 挂在哪：睡前 23:50 的闹钟（proactive alarm_mvxerdjuf5pc2c）里调 `node boot.mjs auto`。
// 为什么不带 dormant：它会真把 200 天没提的条目退成一行，属于「要人点头」的动作，留手动。
if (cmd === 'auto') {
  const steps = [
    ['捞当天会话', process.execPath, [join(HERE, 'digest.mjs')]],
    ['一天一颗星', process.execPath, [join(HERE, 'day.mjs')]],
    ['索引重建', process.execPath, [join(HERE, '_mkindex.mjs')]],
    ['0.2 只留近的', process.execPath, [join(HERE, 'boot.mjs'), 'tidy']],
    ['忽然想起', process.execPath, [join(HERE, 'flash.mjs')]],
    ['链通不通', process.execPath, [join(HERE, 'boot.mjs'), 'check']],
    ['条数/线', process.execPath, [join(HERE, 'boot.mjs'), 'index']],
    ['格式体检', process.execPath, [join(HERE, 'boot.mjs'), 'lint']],
    ['重复嫌疑', process.execPath, [join(HERE, 'boot.mjs'), 'merge']],
    ['僵死条目', process.execPath, [join(HERE, 'boot.mjs'), 'stale']],
    ['回想覆盖率', process.execPath, [join(HERE, 'boot.mjs'), 'recall']],
    ['命中率', process.execPath, [join(HERE, 'boot.mjs'), 'eval']],
    ['备份演练', process.execPath, [join(HERE, 'drill.mjs')]],
  ];
  const rows = [];
  for (const [name, bin, args] of steps) {
    const t0 = Date.now();
    const r = spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, ZZ_NOWRITE: '1' } });
    const out = String((r.stdout || '') + (r.stderr || ''));
    const bad = r.status === 0 ? null : (r.error || new Error('exit ' + r.status));
    const ms = Date.now() - t0;
    const first = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || (bad ? '失败' : '（无输出）');
    rows.push({ name, ok: !bad, ms, line: first.slice(0, 78) });
  }
  console.log('自动例行（' + new Date().toLocaleString('zh-CN', { hour12: false }) + '）');
  for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}　${r.line}　${r.ms}ms`);
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length ? `✗ ${bad.length} 步出错，逐条看上面` : '✓ 全过');
  process.exit(bad.length ? 1 : 0);
}

// ── 尾巴：把上一次会话的最后几轮写进 .tail.md，插件读它注进上下文 ─────────
// 为什么不直接读当前会话：正在说话时当前会话文件一直在涨，贴回去等于把这一轮又说一遍。
// 所以跳过 90 秒内还在写的文件，取「上一个安静下来的会话」（2026-11-01 定）。
if (cmd === 'tail') {
  const TAIL = join(HERE, '.tail.md');
  const N = Math.max(2, Math.min(20, parseInt(process.argv[3], 10) || 6));
  const root = join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions');
  const found = [];
  try {
    for (const ws of readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const s of readdirSync(join(root, ws.name), { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const p = join(root, ws.name, s.name, 'session.v4.jsonl.zstd');
        if (!existsSync(p)) continue;
        try { found.push({ p, id: s.name, mtime: statSync(p).mtimeMs }); } catch {}
      }
    }
  } catch (e) {
    console.log('✗ 扫不到会话目录：' + e.message);
    process.exit(1);
  }
  if (!found.length) { console.log('✗ 一个会话文件都没找到'); process.exit(1); }
  found.sort((a, b) => b.mtime - a.mtime);
  const readSession = (p) => {
    const buf = readFileSync(p);
    const starts = [];
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
    }
    let raw = '';
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
      try { raw += zstdDecompressSync(buf.subarray(from, to)).toString('utf8'); } catch {}
    }
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  // 系统注入的那几条长得像提问，其实是壳（运行时上下文、技能清单、时间戳、微信渠道提示）。
  const NOISE = /^(Current runtime context|Time sampled|<system-reminder>|\[渠道：微信\]|<!-- dsh-zhizhong|You are an AI agent|# 渠道)/;
  // 结构：user 是 data.content[]，assistant 是 data.message.content[]；只要 text，不要 reasoning / tool-call。
  const textOf = (o) => {
    const msg = o.type === 'assistant/message' ? o.data?.message : o.data;
    const c = msg?.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return '';
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ');
  };
  const candidates = [...found.filter((f) => Date.now() - f.mtime > 90_000), ...found];
  const seen = new Set();
  let pick = null;
  let rows = [];
  for (const f of candidates) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    let objs;
    try { objs = readSession(f.p); } catch { continue; }
    // 子代理的会话不是「上次聊天」，它们的开场白全是派活指令。
    if (objs.some((o) => o.type === 'subagent/descriptor')) continue;
    const rs = [];
    for (const o of objs) {
      if (o.type !== 'user/message' && o.type !== 'assistant/message') continue;
      // 渠道提示、acp 标记是壳带的，聊天正文里不该露出来。
      const t = textOf(o).replace(/\[渠道：[^\]]*\][\s\S]*$/, '').replace(/<acp[^>]*>\s*/g, '').replace(/\s+/g, ' ').trim();
      if (!t || NOISE.test(t)) continue;
      rs.push({ who: o.type === 'user/message' ? '养鱼的' : '我', t: t.slice(0, 90), at: Number(o.time) || 0 });
    }
    if (rs.length < 2) continue;
    pick = f;
    rows = rs;
    break;
  }
  if (!pick) { console.log('✗ 没有能当尾巴的会话（全是子代理或空的）'); process.exit(1); }
  const tail = rows.slice(-N);
  const hhmm = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
  const lines = tail.map((r) => `- ${r.who}（${r.at ? hhmm(r.at) : '--:--'}）：${r.t}`);
  const body = [
    '# 上次说到这（不是这次会话）',
    '',
    `> 来源：会话 ${pick.id.replace(/^session-/, '').slice(0, 8)}，停在 ${new Date(pick.mtime).toISOString().slice(0, 16).replace('T', ' ')}Z。`,
    '> 接不上就直接说接不上，别硬编。',
    '',
    ...lines,
  ].join('\n') + '\n';
  writeFileSync(TAIL, body);
  console.log(`✓ 尾巴：${pick.id.replace(/^session-/, '').slice(0, 8)} 最后 ${tail.length} 条 → .tail.md（${Buffer.byteLength(body)} 字节）`);
  process.exit(0);
}

console.log('用法: node boot.mjs status|start|expand N|ask "话"|promote|recall|stale|collapse|prune|check|from <文件>|assemble|tail [N]');
