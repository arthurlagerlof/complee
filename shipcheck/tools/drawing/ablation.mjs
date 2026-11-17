// Ablation: what each recognition rule (src/drawing/rules.mjs) contributes, measured on the development set (the 65
// plans the rules were developed on) and on the held-out set (200 plans never looked at, tools/fetch-heldout.mjs).
// Runs the baseline and one run per rule with that rule off; reports the change of every number.
//   node tools/drawing/ablation.mjs [--sets dev,heldout] [--rules a,b] [--jobs 3]
// Decision rule, fixed before looking: a rule stays if it does not make the held-out set worse on any number; a rule
// that helps on the development set only is tuning and goes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES } from '../../src/drawing/rules.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const SETS = {
  dev: { dir: 'tools/drawing-samples/stoa-preview/junction-dataset-preview/data/swiss_dwellings', questions: 'tools/drawing-samples/stoa-preview/junction-dataset-preview/questions.jsonl' },
  heldout: { dir: 'tools/drawing-samples/stoa-heldout/data/swiss_dwellings', questions: 'tools/drawing-samples/stoa-heldout/questions.jsonl' },
};
const sets = arg('sets', 'dev,heldout').split(',').filter((s) => SETS[s] && fs.existsSync(path.join(root, SETS[s].dir)));
const rules = arg('rules', Object.keys(RULES).join(',')).split(',');
const JOBS = Number(arg('jobs', 3));
const OUT = path.join(here, 'out', 'ablation');
fs.mkdirSync(OUT, { recursive: true });

const runs = [];
for (const set of sets) for (const off of ['', ...rules]) runs.push({ set, off });
const run = ({ set, off }) => new Promise((resolve) => {
  const json = path.join(OUT, `${set}-${off || 'baseline'}.json`);
  const args = ['tools/drawing/eval-swiss.mjs', '--quiet', '--dir', SETS[set].dir, '--questions', SETS[set].questions, '--json', json, ...(off ? ['--off', off] : [])];
  const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => { log += d; });
  p.stderr.on('data', () => {});
  p.on('close', () => {
    const line = (re) => (log.match(re) || [])[1];
    const r = {
      set, off: off || 'baseline',
      strict: Number(line(/STRICT .*?= ([\d.]+) %/)), found: Number(line(/AS SPACELENS COUNTS .*?: \d+\/(\d+)/)),
      ofFound: Number(line(/AS SPACELENS COUNTS .*?= ([\d.]+) %/)), doors: Number(line(/CAD twins .*?leaves = ([\d.]+) %/)),
      doorPlans: Number(line(/CAD twins .*?plans exact (\d+)\//)), ms: Number(line(/median (\d+) ms per plan/)),
    };
    resolve(r);
  });
});
// --report-only: rebuild the report from the last results.json without running again
const results = process.argv.includes('--report-only') ? JSON.parse(fs.readFileSync(path.join(OUT, 'results.json'), 'utf8')) : [];
let next = 0;
if (!results.length) await Promise.all(Array.from({ length: JOBS }, async () => { while (next < runs.length) { const r = runs[next++]; results.push(await run(r)); process.stdout.write('.'); } }));
console.log('');

const KEYS = [['strict', '% all areas ±2 %'], ['ofFound', '% found ±2 %'], ['found', 'rooms found'], ['doors', '% doors'], ['doorPlans', 'plans doors exact']];
const lines = [];
for (const set of sets) {
  const base = results.find((r) => r.set === set && r.off === 'baseline');
  lines.push(`\n${set.toUpperCase()}: baseline ${KEYS.map(([k, n]) => `${n} ${base[k]}`).join(' · ')}`);
  lines.push('rule off             ' + KEYS.map(([, n]) => n.padStart(18)).join(''));
  for (const r of results.filter((x) => x.set === set && x.off !== 'baseline').sort((a, b) => (a.strict - base.strict) - (b.strict - base.strict))) {
    const d = (k) => { const v = +(r[k] - base[k]).toFixed(1); return (v > 0 ? `+${v}` : `${v}`).padStart(18); };
    lines.push(r.off.padEnd(21) + KEYS.map(([k]) => d(k)).join(''));
  }
}
// Verdict on three primary numbers, each "higher is better": all printed areas within 2 % (strict), door accuracy as
// closeness to the distinct CAD doors (100 − |doors % − 100|: counting too many is as wrong as too few), plans with the
// exact door count. Rooms found and accuracy of found rooms are shown above but decide nothing alone (finding one more
// room and getting ten others wrong is no gain).
const primary = (r) => ({ areas: r.strict, doors: 100 - Math.abs(r.doors - 100), doorPlans: r.doorPlans });
lines.push('\nVERDICT on the held-out set (the development set only shows whether a rule was tuned):');
const hb = results.find((r) => r.set === 'heldout' && r.off === 'baseline');
const db = results.find((r) => r.set === 'dev' && r.off === 'baseline');
for (const rule of rules) {
  const h = results.find((r) => r.set === 'heldout' && r.off === rule), dv = results.find((r) => r.set === 'dev' && r.off === rule);
  if (!h || !hb) continue;
  const on = primary(hb), off = primary(h);
  // what the rule does = on − off, per number
  const gains = Object.keys(on).filter((k) => on[k] > off[k] + 0.05), costs = Object.keys(on).filter((k) => on[k] < off[k] - 0.05);
  const devGains = dv && db ? Object.keys(on).filter((k) => primary(db)[k] > primary(dv)[k] + 0.05) : [];
  const fmt = (ks) => ks.map((k) => `${k} ${(on[k] - off[k] > 0 ? '+' : '')}${(on[k] - off[k]).toFixed(1)}`).join(', ');
  const verdict = gains.length && !costs.length ? `helps (${fmt(gains)}): keep`
    : gains.length && costs.length ? `trade-off: gains ${fmt(gains)}, costs ${fmt(costs)}`
    : costs.length ? `hurts (${fmt(costs)}): remove or rework`
    : devGains.length ? 'helps on the development set only: tuning, no effect on unseen plans'
    : 'no effect on these plans (written for ship drawings: measured by the tests and the blind drawings)';
  lines.push(`  ${rule.padEnd(20)} ${verdict}`);
}
const text = lines.join('\n');
console.log(text);
fs.writeFileSync(path.join(OUT, 'report.txt'), text + '\n');
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
