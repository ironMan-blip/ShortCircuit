// Checks every node type+version exists and every parameter key is a known property (top level + collection keys).
import fs from 'fs';
const S = new URL('./.cache/', import.meta.url).pathname;
const all = [...JSON.parse(fs.readFileSync(S + 'base-nodes.json')), ...JSON.parse(fs.readFileSync(S + 'lc-nodes.json'))];
const find = (type, v) => {
  let name = type.split('.').pop(); let hitl = false;
  if (name.endsWith('HitlTool')) { name = name.replace(/HitlTool$/, ''); hitl = true; }
  const pkgBase = type.startsWith('n8n-nodes-base.');
  const pool = all.filter((n) => n.name === name);
  return pool.find((n) => (Array.isArray(n.version) ? n.version.includes(v) : n.version === v));
};
const dir = process.argv[2] ?? new URL('../../workflows', import.meta.url).pathname;
let bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('sc.') && f.endsWith('.json'))) {
  const w = JSON.parse(fs.readFileSync(dir + '/' + f));
  for (const node of w.nodes) {
    const d = find(node.type, node.typeVersion);
    if (!d) { console.log(f, node.name, 'UNKNOWN', node.type, node.typeVersion); bad++; continue; }
    const names = new Set(d.properties.map((p) => p.name));
    if (node.type.endsWith('HitlTool')) ['message'].forEach((x) => names.add(x));
    for (const k of Object.keys(node.parameters)) if (!names.has(k)) { console.log(f, node.name, 'param?', k); bad++; }
    for (const p of d.properties) if (p.type === 'collection' && node.parameters[p.name] && typeof node.parameters[p.name] === 'object') {
      const sub = new Set(d.properties.filter((q) => q.name === p.name).flatMap((q) => (q.options || []).map((o) => o.name)));
      for (const k of Object.keys(node.parameters[p.name])) if (!sub.has(k)) { console.log(f, node.name, `option? ${p.name}.${k}`); bad++; }
    }
    for (const p of d.properties) if ((p.type === 'options') && node.parameters[p.name] !== undefined && typeof node.parameters[p.name] === 'string' && !node.parameters[p.name].startsWith('=')) {
      const vals = d.properties.filter((q) => q.name === p.name).flatMap((q) => (q.options || []).map((o) => o.value));
      if (vals.length && !vals.includes(node.parameters[p.name])) { console.log(f, node.name, `value? ${p.name}=${node.parameters[p.name]} not in ${JSON.stringify(vals).slice(0, 120)}`); bad++; }
    }
  }
}
console.log(bad ? `${bad} problems` : 'all nodes valid');
