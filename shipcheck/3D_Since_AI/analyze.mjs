// Summarises model-properties.json and model-tree.json into model-summary.txt
// Usage: node analyze.mjs
import fs from 'node:fs';

const props = JSON.parse(fs.readFileSync('model-properties.json', 'utf8')).data.collection;
const tree = JSON.parse(fs.readFileSync('model-tree.json', 'utf8'));
const out = [];
const log = (s = '') => { out.push(s); console.log(s); };
const top = (map, n = 30) => Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);

// 1. Source files / blocks (top levels of the tree)
log('== Top levels of the model tree (source files / blocks) ==');
const files = [];
(function walk(nodes, depth) {
  for (const n of nodes || []) {
    if (depth <= 2) files.push(`${'  '.repeat(depth)}${n.name}  (${countLeaves(n)} parts)`);
    if (depth < 2) walk(n.objects, depth + 1);
  }
})(tree.data.objects, 0);
function countLeaves(n) { return n.objects ? n.objects.reduce((s, c) => s + countLeaves(c), 0) : 1; }
files.slice(0, 200).forEach((f) => log(f));
if (files.length > 200) log(`... ${files.length - 200} more`);

// 2. Most common object names
log('\n== Most common object names ==');
const names = {};
for (const o of props) names[o.name] = (names[o.name] || 0) + 1;
top(names, 40).forEach(([k, v]) => log(`${v}\t${k}`));

// 3. Property keys per group, with example values
log('\n== Property keys per group (count, examples) ==');
for (const group of ['ShipConstructor', 'Attributes', 'Description', 'Summary', 'Item', 'AutoCad']) {
  const keys = {}, examples = {};
  for (const o of props) {
    const g = o.properties?.[group];
    if (!g) continue;
    for (const [k, v] of Object.entries(g)) {
      keys[k] = (keys[k] || 0) + 1;
      examples[k] ??= new Set();
      if (examples[k].size < 5 && v !== '' && v != null) examples[k].add(String(v).slice(0, 60));
    }
  }
  log(`\n-- ${group} --`);
  top(keys, 40).forEach(([k, v]) => log(`${v}\t${k}\te.g. ${[...examples[k]].join(' | ')}`));
}

// 4. Keywords that matter for rule checks
log('\n== Objects whose name or properties mention rule-relevant words ==');
const words = ['door', 'stair', 'ladder', 'corridor', 'passage', 'escape', 'cabin', 'tank', 'hatch', 'railing', 'thickness', 'room', 'space'];
for (const w of words) {
  const hits = props.filter((o) => JSON.stringify(o).toLowerCase().includes(w));
  log(`${hits.length}\t${w}\te.g. ${hits.slice(0, 3).map((o) => o.name).join(' | ')}`);
}

fs.writeFileSync('model-summary.txt', out.join('\n'));
console.log('\nSaved model-summary.txt');
