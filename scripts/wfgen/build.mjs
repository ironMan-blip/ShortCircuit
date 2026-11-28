import fs from 'fs';
import path from 'path';
import { STUB_CREDS } from './lib.mjs';
const OUT = process.argv[2] ?? new URL('../../workflows', import.meta.url).pathname;
const mods = ['wf_core', 'wf_create', 'wf_review', 'wf_render', 'wf_publish', 'wf_master', 'wf_weekly'];
const wfs = [];
for (const m of mods) {
  if (!fs.existsSync(new URL(`./${m}.mjs`, import.meta.url))) continue;
  const mod = await import(`./${m}.mjs`);
  for (const [k, f] of Object.entries(mod)) if (typeof f === 'function' && /^sc[A-Z]/.test(k)) { const r = f(); for (const w of [r].flat()) wfs.push(w); }
}
fs.mkdirSync(OUT, { recursive: true });
for (const w of wfs) fs.writeFileSync(path.join(OUT, `${w.name}.json`), JSON.stringify(w.toJSON(), null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'credentials.stub.json'), JSON.stringify(STUB_CREDS.map(([id, name, type, data]) => ({ id, name, type, data })), null, 2) + '\n');
console.log(wfs.length, 'workflows →', OUT);
