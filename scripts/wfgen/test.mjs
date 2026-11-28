// Self-check of the code that runs inside n8n Code nodes (no n8n needed): node scripts/wfgen/test.mjs
import assert from 'assert/strict';
import fs from 'fs';
import { ESC, RULES, CHECKS, META } from './js.mjs';

// Code node snippets run as function bodies with $env in scope, without the URL class (as in n8n's sandbox).
const run = (body, env = { TZ: 'UTC' }) => new Function('$env', 'URL', body)(env, undefined);
const { okUrl, hostOf, esc } = run(ESC + 'return { okUrl, hostOf, esc };');

// url check: the trust boundary for model-chosen urls
assert.equal(okUrl('https://GitHub.com/a/b'), 'https://github.com/a/b');
assert.equal(okUrl('https://github.com'), 'https://github.com/');
for (const bad of ['http://a.b/', 'https://10.0.0.1/', 'https://n8n:5678/', 'https://a@b.c/', 'https://localhost/', 'https://a.b/c d', 'javascript:alert(1)', ''])
  assert.equal(okUrl(bad), null, bad);
assert.equal(hostOf('https://Host.docker.internal/x'), 'host.docker.internal');
assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');

// script rules (word count, title, fact ids)
const fx = (a) => JSON.parse(fs.readFileSync(new URL(`../../tests/agents/${a}.json`, import.meta.url)));
const writerIn = fx('writer')[1].input;
const brief = JSON.parse(writerIn.match(/<brief>(.*)<\/brief>/s)[1]);
const script = JSON.parse(writerIn.match(/<previous_script>(.*)<\/previous_script>/s)[1]);
const r1 = new Function('$env', RULES(JSON.stringify(script), JSON.stringify(brief)).replace('return [{ json: { rules, words } }];', 'return { rules, words };'))({});
assert.deepEqual(r1.rules, [], 'the fixture script passes the rules');
const short = { ...script, scenes: script.scenes.slice(0, 1).map((s) => ({ ...s, fact_ids: [9] })) };
const r2 = new Function('$env', RULES(JSON.stringify(short), JSON.stringify(brief)).replace('return [{ json: { rules, words } }];', 'return { rules, words };'))({});
assert.equal(r2.rules.length, 2, 'too short and a missing fact');

// fixture checks
const { runChecks } = run(CHECKS + 'return { runChecks };');
const exp = (a, i) => JSON.parse(fx(a)[i].expect);
assert.deepEqual(runChecks({ pass: false, unsupported_claims: ['scene 1 says $60; source says $80'], policy_issues: [] }, exp('checker', 0)), []);
assert.notDeepEqual(runChecks({ pass: true, unsupported_claims: [], policy_issues: [] }, exp('checker', 0)), []);
assert.deepEqual(runChecks(script, exp('writer', 0)).filter((f) => !f.includes('sixty')), []);
const plan = JSON.parse(fx('cutter')[0].input.match(/<plan>(.*)<\/plan>/s)[1]);
assert.deepEqual(runChecks({ ...plan, narration_change: '' }, exp('cutter', 0)), []);
assert.notDeepEqual(runChecks({ ...plan, scenes: [{ ...plan.scenes[0], narration: 'changed' }], narration_change: '' }, exp('cutter', 0)), []);
assert.notDeepEqual(runChecks({ ...plan, scenes: [{ ...plan.scenes[0], visual: { type: 'screenshot', url: 'https://evil.example/' } }] }, exp('director', 0)), []);
const sched = exp('scheduler', 0);
assert.deepEqual(runChecks({ week: { ...sched.current, fri: '21:00' }, explore_day: 'wed' }, sched), []);
assert.notDeepEqual(runChecks({ week: { ...sched.current, fri: '23:00' } }, sched), []);

// upload metadata: the Writer's urls are removed, checked sources and #Shorts added, job tag kept
const { desc, tags } = run(ESC + META + 'return { desc, tags };');
const d = desc({ description: 'Read more at https://evil.example/x or www.evil.example now.' }, { checked_urls: ['https://www.theverge.com/a', 'http://bad/'] });
assert.ok(!d.includes('evil') && d.includes('https://www.theverge.com/a') && d.endsWith('#Shorts') && !d.includes('http://bad'), d);
assert.ok(tags({ tags: ['pi', 'a<b'] }, 42).includes('sc-0042'));

console.log('wfgen self-check passed');
