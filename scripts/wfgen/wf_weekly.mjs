// sc.schedule, sc.diagnose, sc.fixtures, sc.eval.<agent>, sc.ask_master.test (PLAN §4.7, §4.9, §5.1). M8–M9.
import fs from 'fs';
import * as n from './lib.mjs';
import { ESC, CHECKS } from './js.mjs';
import { DIAG_WEB_DOMAINS } from './wf_master.mjs';
const { WF } = n;
const AGENTS = ['scout', 'writer', 'checker', 'editor', 'director', 'cutter', 'scheduler'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // index = Postgres dow
const TESTS = new URL('../../tests/', import.meta.url);
const STATS_INLINE = `SELECT jsonb_build_object(
  'provider_use', (SELECT coalesce(jsonb_object_agg(agent, p), '{}') FROM (SELECT agent, jsonb_object_agg(provider, c) p FROM (SELECT k AS agent, v AS provider, count(*) c FROM jobs, jsonb_each_text(providers) e(k, v) WHERE updated_at > now() - interval '7 days' GROUP BY 1, 2) x GROUP BY agent) y),
  'checker_flag_rate', (SELECT round(avg(CASE WHEN (check_result->>'pass')::boolean THEN 0 ELSE 1 END)::numeric, 2) FROM jobs WHERE check_result IS NOT NULL AND updated_at > now() - interval '7 days'),
  'master_redo', (SELECT count(*) FROM master_log WHERE result->>'verdict' = 'redo' AND created_at > now() - interval '7 days'),
  'owner_changes', (SELECT count(*) FROM reviews WHERE decision IN ('approve_changes', 'revise') AND answered_at > now() - interval '7 days'),
  'errors', (SELECT count(*) FROM jobs WHERE last_error IS NOT NULL AND updated_at > now() - interval '7 days'),
  'views_48h', (SELECT coalesce(jsonb_agg(views), '[]') FROM metrics WHERE age_h = 48 AND taken_at > now() - interval '7 days')
) AS result`;
const fixtures = (agent) => JSON.parse(fs.readFileSync(new URL(`agents/${agent}.json`, TESTS)));

// ---------------- sc.schedule ----------------
export function scSchedule() {
  const w = new WF('sc.schedule', { timer: true, description: 'Sunday 04:00: code builds per time × weekday stats from metrics; < 12 published → rotate candidates; else the Scheduler picks inside fixed rules, checked in code. An assigned slot never moves (PLAN §4.7, §10.6).' });
  w.add(n.cron('Sunday 04:00', '0 4 * * 0'));
  w.add(n.pg('Published', `SELECT j.id, extract(dow FROM j.slot_at AT TIME ZONE $1)::int AS dow, to_char(j.slot_at AT TIME ZONE $1, 'HH24:MI') AS time,
  m.views, m.likes, m.comments
FROM jobs j LEFT JOIN metrics m ON m.job_id = j.id AND m.age_h = 48
WHERE j.status IN ('live', 'done') AND j.slot_at > now() - interval '90 days';`, ['$env.TZ'], { always: true }));
  w.add(n.pg('Current', `SELECT coalesce(jsonb_object_agg(dow, to_char(publish_time, 'HH24:MI')), '{}') AS current FROM schedule;`));
  w.chain('Sunday 04:00', 'Published', 'Current');
  w.add(n.code('Stats', `// No node computes medians per time × weekday; code computes, the model only picks (PLAN §4.7).
const DAYS = ${JSON.stringify(DAYS)};
const cands = String($env.SCHEDULE_CANDIDATES ?? '12:00,15:00,18:00,21:00').split(',').map((s) => s.trim()).filter((s) => /^[0-2][0-9]:[0-5][0-9]$/.test(s));
const cur = $input.first().json.current ?? {};
const current = Object.fromEntries(DAYS.map((d, i) => [d, cur[i] ?? $env.PUBLISH_TIME ?? '18:00']));
const rows = $('Published').all().map((i) => i.json).filter((r) => r.id);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const stats = [];
for (const [i, d] of DAYS.entries()) for (const t of cands) {
  const r = rows.filter((x) => x.dow === i && x.time === t && x.views != null);
  stats.push({ weekday: d, time: t, videos: r.length, median_views_48h: med(r.map((x) => x.views)), engagement: med(r.map((x) => x.views ? (x.likes + x.comments) / x.views : 0)) });
}
const week = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 6048e5);
const rotate = Object.fromEntries(DAYS.map((d, i) => [d, cands[(i + week) % cands.length]]));
return [{ json: { cold: rows.length < 12, published: rows.length, cands, current, stats, rotate } }];`));
  w.add(n.iff('Cold start?', [['={{ $json.cold }}', 'boolean:true']]));
  w.c('Current', 'Stats').c('Stats', 'Cold start?');
  w.add(n.llm('Scheduler', 'scheduler', `'<stats>' + JSON.stringify($json.stats) + '</stats>\\n<current_schedule>' + JSON.stringify($json.current) + '</current_schedule>\\n<candidates>' + JSON.stringify($json.cands) + '</candidates>'`, { temp: 0.2 }));
  w.c('Cold start?', 'Scheduler', 1);
  w.add(n.code('Rule check', `// No node checks the Scheduler's pick against the rules; invalid → keep the current schedule.
const s = $('Stats').first().json; const cold = s.cold;
const r = cold ? { json: { week: s.rotate, explore_day: null, confidence: 'low', reason: 'cold start: ' + s.published + ' videos published, rotating the candidates' } } : $input.first().json;
const o = r.json ?? {}; const DAYS = ${JSON.stringify(DAYS)};
const problems = [];
if (!r.json) problems.push('Scheduler failed: ' + String(r.error?.message ?? r.error ?? 'no output').slice(0, 200));
const next = { ...s.current };
if (!problems.length) {
  if (!DAYS.every((d) => s.cands.includes(o.week?.[d]))) problems.push('a time is not one of SCHEDULE_CANDIDATES');
  const changed = DAYS.filter((d) => o.week?.[d] !== s.current[d]);
  if (!cold) {
    const stat = (d, t) => s.stats.find((x) => x.weekday === d && x.time === t) ?? {};
    // a gap under 20 % or < 5 videos is noise: that day keeps its time (explore day excepted)
    for (const d of changed) if (d !== o.explore_day) { const a = stat(d, o.week[d]), b = stat(d, s.current[d]); if (!(a.videos >= 5 && (a.median_views_48h ?? 0) >= 1.2 * (b.median_views_48h ?? 0))) o.week[d] = s.current[d]; }
    const kept = DAYS.filter((d) => o.week?.[d] !== s.current[d]);
    if (kept.filter((d) => d !== o.explore_day).length > 2) problems.push('more than 2 weekdays changed');
  }
  if (!problems.length) Object.assign(next, o.week);
}
const changed = DAYS.filter((d) => next[d] !== s.current[d]);
return [{ json: { week: next, rows: DAYS.map((d, i) => ({ dow: i, time: next[d] })), changed: changed.length > 0, changed_days: changed, problems, confidence: o.confidence ?? 'low', explore_day: o.explore_day ?? null, reason: String(o.reason ?? '').slice(0, 500) } }];`));
  w.c('Cold start?', 'Rule check', 0).c('Scheduler', 'Rule check', 0).c('Scheduler', 'Rule check', 1);
  w.add(n.pg('Save', `INSERT INTO schedule (dow, publish_time, reason, updated_at)
SELECT (r->>'dow')::int, (r->>'time')::time, $2, now() FROM jsonb_array_elements($1::jsonb) r
ON CONFLICT (dow) DO UPDATE SET publish_time = EXCLUDED.publish_time, reason = EXCLUDED.reason, updated_at = now();
INSERT INTO master_log (task, result) VALUES ('schedule', $3::jsonb);`,
  [n.J('$json.rows'), '$json.reason', n.J('{ changed: $json.changed, changed_days: $json.changed_days, week: $json.week, confidence: $json.confidence, explore_day: $json.explore_day, reason: $json.reason, problems: $json.problems }')]));
  w.c('Rule check', 'Save');
  return w;
}

// ---------------- fixture loop block (sc.diagnose) ----------------
function testLoop(w, s, from) {
  const L = `Next test${s}`;
  w.add(n.loop(L));
  w.add(n.set(`Start${s}`, [['t0', '={{ Date.now() }}', 'number']], { keep: true }));
  w.add(n.exec(`Run${s}`, 'sc.llm', { agent: '={{ $json.agent }}', prompt: '={{ $json.prompt }}', user_content: '={{ $json.input }}', chain: '={{ $json.entry }}', exclude_provider: '', temperature: '={{ 0.3 }}' }, { err: true }));
  w.add(n.code(`Check${s}`, `// No node runs fixture expectations on a model's JSON.
${CHECKS}
const t = $('Start${s}').item.json; const r = $input.item.json;
const fails = r.ok ? runChecks(r.json, JSON.parse(t.expect || '{}')) : ['call failed: ' + String(r.error?.message ?? r.error ?? 'error').slice(0, 200)];
return { json: { agent: t.agent, name: t.name, entry: t.entry, provider: t.entry.split(':')[0], model: r.model ?? t.entry, candidate: !!t.candidate, ok: !!r.ok, pass: fails.length === 0, fails, ms: Date.now() - t.t0, output: r.ok ? JSON.stringify(r.json).slice(0, 1500) : null } };`, { each: true }));
  w.c(from, L).c(L, `Start${s}`, 1).chain(`Start${s}`, `Run${s}`, `Check${s}`).c(`Run${s}`, `Check${s}`, 1).c(`Check${s}`, L);
  return L; // output 0 = done (all results)
}

// ---------------- sc.diagnose ----------------
export function scDiagnose() {
  const w = new WF('sc.diagnose', { timer: true, description: 'Sunday 05:00 and by hand: runs every fixture on every provider of each chain, 7-day stats, Master research (web) → verified candidates tried → Master grade → local-or-free check in code → weekly report mail. Only reports; never changes settings (PLAN §4.9).' });
  w.add(n.cron('Sunday 05:00', '0 5 * * 0'));
  w.add(n.manual());
  w.add(n.noop('Begin'));
  w.c('Sunday 05:00', 'Begin').c('Manual', 'Begin');
  const tables = AGENTS.map((a) => { const t = `Fixtures ${a}`; w.add(n.dtGet(t, `eval_${a}`)); w.nodes.at(-1).executeOnce = true; w.nodes.at(-1).onError = 'continueRegularOutput'; return t; });
  w.chain('Begin', ...tables);
  w.add(n.code('Test items', `// No node expands fixtures × each provider of the agent's chain.
const AGENTS = ${JSON.stringify(AGENTS)}; const items = [];
for (const a of AGENTS) {
  let rows = []; try { rows = $('Fixtures ' + a).all().map((i) => i.json).filter((r) => r.input); } catch {}
  const chain = String($env['LLM_CHAIN_' + a.toUpperCase()] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const r of rows) for (const entry of (r.provider ? [r.provider] : chain)) items.push({ json: { agent: a, name: r.name, prompt: r.prompt || a, input: r.input, expect: r.expect, entry } });
}
return items.length ? items : [{ json: { agent: 'none', name: 'no fixtures', prompt: 'writer', input: '', expect: '{}', entry: 'none' } }];`));
  w.c(tables.at(-1), 'Test items');
  const L1 = testLoop(w, '', 'Test items');
  w.add(n.aggregateAll('Results', 'results'));
  w.c(L1, 'Results', 0);
  w.add(n.pg('Week stats', `SELECT (SELECT result FROM (${STATS_INLINE}) s) AS stats,
  (SELECT coalesce(jsonb_object_agg(task, result), '{}') FROM (SELECT DISTINCT ON (task) task, result FROM master_log WHERE task LIKE 'diagnose_%' AND created_at < now() - interval '1 day' ORDER BY task, id DESC) l) AS last_week,
  (SELECT coalesce(sum((usage->>'input_tokens')::numeric), 0) FROM master_log WHERE created_at > now() - interval '7 days') AS in_tokens,
  (SELECT coalesce(sum((usage->>'output_tokens')::numeric), 0) FROM master_log WHERE created_at > now() - interval '7 days') AS out_tokens,
  (SELECT coalesce(sum((usage->>'web_search_requests')::numeric), 0) FROM master_log WHERE created_at > now() - interval '7 days') AS searches,
  (SELECT count(*) FROM master_log WHERE created_at > now() - interval '7 days' AND usage IS NOT NULL) AS usage_rows,
  (SELECT count(*) FROM master_log WHERE created_at > now() - interval '7 days' AND task IN ('review_script', 'review_video', 'triage', 'daily')) AS master_calls;`));
  w.c('Results', 'Week stats');
  w.add(n.askMaster('Research', 'diagnose_research', null, `JSON.stringify({
    agents: { scout: 'pick a topic from ~60 items and write a sourced brief; JSON; long context (source texts)', writer: 'write a 90-140 word script from a brief; JSON; best writing', checker: 'fact-check a script against sources; JSON; must be a different family from the writer', editor: 'apply owner notes to a script; JSON; never Gemini (owner notes are private)', director: 'turn a script into an edit plan; short JSON; local preferred', cutter: 'apply video notes to an edit plan; short JSON; never Gemini', scheduler: 'pick weekly publish times inside fixed rules; short JSON' },
    chains: Object.fromEntries(${JSON.stringify(AGENTS)}.map((a) => [a, $env['LLM_CHAIN_' + a.toUpperCase()]])),
    models: { gemini: $env.GEMINI_MODEL, groq: $env.GROQ_MODEL, ollama: $env.OLLAMA_MODEL },
    hardware: '16 GB M4 Mac; an Ollama model must be at most about 10 GB',
    allowed: ['ollama (local)', 'Google Gemini free tier', 'Groq free tier'],
    last_week: $('Week stats').first().json.last_week.diagnose_research ?? null })`));
  w.c('Week stats', 'Research');
  w.add(n.http('Gemini models', { url: 'https://generativelanguage.googleapis.com/v1beta/models', query: { pageSize: '1000' }, soft: true, timeout: 30000 }));
  Object.assign(w.nodes.at(-1).parameters, { authentication: 'predefinedCredentialType', nodeCredentialType: 'googlePalmApi' });
  w.nodes.at(-1).credentials = n.CRED.gemini;
  w.add(n.http('Groq models', { url: 'https://api.groq.com/openai/v1/models', soft: true, timeout: 30000 }));
  Object.assign(w.nodes.at(-1).parameters, { authentication: 'predefinedCredentialType', nodeCredentialType: 'groqApi' });
  w.nodes.at(-1).credentials = n.CRED.groq;
  w.add(n.http('Ollama models', { url: 'http://host.docker.internal:11434/api/tags', soft: true, timeout: 15000 }));
  w.chain('Research', 'Gemini models', 'Groq models', 'Ollama models');
  w.add(n.code('Candidates', `// No node checks model ids from web text against the providers' own model lists.
const r = $('Research').first().json; const res = r.ok ? r.json : { in_use: [], candidates: [], other_options: [] };
const gem = new Set(($('Gemini models').first().json.models ?? []).map((m) => String(m.name).replace(/^models\\//, '')));
const grq = new Set(($('Groq models').first().json.data ?? []).map((m) => m.id));
const oll = new Set(($('Ollama models').first().json.models ?? []).map((m) => m.name));
const listed = { gemini: gem, groq: grq, ollama: oll };
const fx = Object.fromEntries(${JSON.stringify(AGENTS)}.map((a) => { let rows = []; try { rows = $('Fixtures ' + a).all().map((i) => i.json).filter((x) => x.input); } catch {} return [a, rows]; }));
const tried = [];
for (const c of res.candidates ?? []) {
  const [p, ...rest] = c.model.split(':'); const id = rest.join(':');
  if (p === 'gemini' && c.agents.some((a) => a === 'editor' || a === 'cutter')) c.agents = c.agents.filter((a) => a !== 'editor' && a !== 'cutter');
  if (listed[p]?.has(id)) tried.push({ ...c, provider: p, id }); // an id the provider does not list is never called
}
const items = tried.flatMap((c) => c.agents.flatMap((a) => (fx[a] ?? []).map((row) => ({ json: { agent: a, name: row.name, prompt: row.prompt || a, input: row.input, expect: row.expect, entry: c.provider + ':' + c.id, candidate: true } }))));
return items.length ? items : [{ json: { none: true } }];`));
  w.c('Ollama models', 'Candidates');
  w.add(n.iff('Any candidate?', [['={{ $json.none }}', 'boolean:true']]));
  w.c('Candidates', 'Any candidate?');
  const L2 = testLoop(w, ' cand', 'Any candidate?');
  // If output 0 = none → skip; output 1 = items → loop
  w.conns['Any candidate?'].main = [[], [{ node: L2, type: 'main', index: 0 }]];
  w.add(n.aggregateAll('Candidate results', 'results'));
  w.c(L2, 'Candidate results', 0);
  w.add(n.noop('Tests done'));
  w.c('Candidate results', 'Tests done').c('Any candidate?', 'Tests done', 0);
  w.add(n.askMaster('Grade', 'diagnose_grade', null, `JSON.stringify({ tests: $('Results').first().json.results.map(({ output, ...r }) => ({ ...r, output: (output ?? '').slice(0, 600) })),
    candidate_tests: $('Candidate results').isExecuted ? $('Candidate results').first().json.results : [],
    week_stats: $('Week stats').first().json.stats, last_week: $('Week stats').first().json.last_week.diagnose_grade ?? null })`));
  w.c('Tests done', 'Grade');
  w.add(n.code('Report', `// No node runs the local-or-free check, prices the Master or builds the HTML report (PLAN §4.9 steps 6-7).
${ESC}
const DIAG = ${JSON.stringify(DIAG_WEB_DOMAINS)};
const AGENTS = ${JSON.stringify(AGENTS)};
const okLink = (u) => { const x = okUrl(u); if (!x) return null; const h = hostOf(x); return DIAG.some((d) => h === d || h.endsWith('.' + d)) ? x : null; };
const link = (u, t) => okLink(u) ? '<a href="' + esc(okLink(u)) + '">' + esc(t) + '</a>' : '';
const info = $('Research').first().json.ok ? $('Research').first().json.json : null;
const results = $('Results').first().json.results.filter((r) => r.agent !== 'none');
const candResults = $('Candidate results').isExecuted ? $('Candidate results').first().json.results.filter((r) => r.agent) : [];
const grade = $('Grade').first().json; const g = grade.ok ? grade.json : null;
const env = (a) => String($env['LLM_CHAIN_' + a.toUpperCase()] ?? '');
// step 6: local or free, in code (the Master's word is input, not proof)
const freeOf = (m) => (info?.in_use ?? []).find((x) => x.model === m);
const used = [...new Set(AGENTS.flatMap((a) => env(a).split(',').map((e) => e.trim()).filter(Boolean).map((e) => e.includes(':') ? e : e + ':' + ($env[e.toUpperCase() + '_MODEL'] ?? ''))))];
const notFree = used.filter((m) => !m.startsWith('ollama:') && freeOf(m)?.free !== 'yes');
// Master cost (Opus 5.5 list prices: $4 / $20 per million tokens, $10 per 1 000 searches; update if MASTER_MODEL changes)
const ws = $('Week stats').first().json;
const cost = (Number(ws.in_tokens) * 4 + Number(ws.out_tokens) * 20) / 1e6 + Number(ws.searches) * 0.01;
const costLine = Number(ws.usage_rows) ? '$' + cost.toFixed(2) + ' (' + ws.usage_rows + ' metered calls; chain reviews and agent runs: see the Console usage page)' : 'see the Console usage page (this n8n version returns no token counts)';
const per = AGENTS.map((a) => { const r = results.filter((x) => x.agent === a); const byP = {};
  for (const x of r) { byP[x.provider] ??= [0, 0]; byP[x.provider][1]++; if (x.pass) byP[x.provider][0]++; }
  const ga = g?.agents?.find((x) => x.agent === a);
  return { a, r, byP, ga, ok: r.length && r.every((x) => x.pass) }; });
const healthy = per.filter((p) => p.ok && (!p.ga || p.ga.status === 'good')).length;
const first = (notFree.length ? '⚠ Not verified local or free: ' + notFree.join(', ') + '. ' : '')
  + (healthy === AGENTS.length ? 'All ' + AGENTS.length + ' agents healthy' : (AGENTS.length - healthy) + ' of ' + AGENTS.length + ' agents need a look') + (notFree.length ? '' : ' · all workers local or free');
// .env lines built by code from verified ids only
const better = (g?.candidates ?? []).filter((x) => x.better);
const tried = candResults.length ? [...new Set(candResults.map((r) => r.entry))] : [];
const lines = better.filter((b) => tried.includes(b.model) && candResults.filter((r) => r.entry === b.model && r.agent === b.agent).every((r) => r.pass))
  .filter((b) => !((b.agent === 'editor' || b.agent === 'cutter') && b.model.startsWith('gemini:')))
  .map((b) => 'LLM_CHAIN_' + b.agent.toUpperCase() + '=' + [b.model, ...env(b.agent).split(',').map((e) => e.trim()).filter((e) => e && e !== b.model)].join(','));
const td = (x) => '<td style="border:1px solid #ddd;padding:4px 8px;vertical-align:top">' + x + '</td>';
const rows = per.map((p) => '<tr>' + td('<b>' + esc(p.a) + '</b>') + td(esc(p.ga?.status ?? (p.ok ? 'tests pass' : 'tests fail'))) + td(esc(p.ga?.score ?? '–'))
  + td(Object.entries(p.byP).map(([k, v]) => esc(k + ' ' + v[0] + '/' + v[1])).join('<br>')) + td(esc(p.ga?.best_provider ?? '–'))
  + td(env(p.a).split(',').map((e) => { const m = e.includes(':') ? e : e + ':' + ($env[e.toUpperCase() + '_MODEL'] ?? ''); const f = m.startsWith('ollama:') ? 'local' : (freeOf(m)?.free ?? 'unknown'); return esc(m + ': ' + f) + ' ' + link(freeOf(m)?.source_url, 'source'); }).join('<br>'))
  + td(esc(p.r.filter((x) => !x.pass).map((x) => x.name + ' @' + x.provider + ': ' + x.fails.join('; ')).join(' | ').slice(0, 600))) + '</tr>').join('');
let body = '<p><b>' + esc(first) + '</b></p>';
body += '<table style="border-collapse:collapse;font-size:13px"><tr>' + ['Agent', 'Status', 'Score', 'Fixtures passed', 'Best provider', 'Models (local/free)', 'Failures'].map((h) => td('<b>' + h + '</b>')).join('') + '</tr>' + rows + '</table>';
if (!grade.ok) body += '<p><i>Master unavailable (' + esc(grade.reason) + ') — no grading this week.</i></p>';
else body += '<p style="white-space:pre-wrap">' + esc(g.report) + '</p>';
if (!$('Research').first().json.ok) body += '<p><i>Master unavailable (' + esc($('Research').first().json.reason) + ') — no research this week.</i></p>';
else {
  body += '<h3>Candidates tried</h3>' + (candResults.length ? '<ul>' + tried.map((m) => '<li>' + esc(m) + ': ' + candResults.filter((r) => r.entry === m).map((r) => esc(r.agent + '/' + r.name + ' ' + (r.pass ? 'pass' : 'fail'))).join(', ') + '</li>').join('') + '</ul>' : '<p>None verified this week.</p>');
  body += '<h3>Switch (paste into .env only if you agree)</h3>' + (lines.length ? '<pre>' + lines.map(esc).join('\\n') + '</pre>' : '<p>No change suggested.</p>');
  const pend = (info.candidates ?? []).filter((x) => x.model.startsWith('ollama:') && !tried.includes(x.model));
  if (pend.length) body += '<h3>Not pulled (tested next week once pulled)</h3><ul>' + pend.map((x) => '<li>run <code>ollama pull ' + esc(x.model.slice(7)) + '</code> (' + esc(x.size_gb ?? '?') + ' GB): ' + esc(x.why) + ' ' + link(x.source_url, 'source') + '</li>').join('') + '</ul>';
  body += '<h3>Other options (untested)</h3><ul>' + (info.other_options ?? []).map((o) => '<li>' + esc(o.text) + ' ' + link(o.source_url, 'source') + '</li>').join('') + '</ul>';
}
body += '<p><b>Master cost, last 7 days:</b> ' + esc(costLine) + ' — the one paid part, by design.</p>';
const date = new Date().toLocaleDateString('en-CA', { timeZone: $env.TZ });
return [{ json: { subject: 'ShortCircuit weekly diagnosis — ' + date, html: page('Weekly diagnosis — ' + date, body),
  tests: { results: results.map(({ output, ...r }) => r), candidates: candResults.map(({ output, ...r }) => r), first_line: first, env_lines: lines } } }];`));
  w.c('Grade', 'Report');
  w.add(n.pg('Log tests', `INSERT INTO master_log (task, result) VALUES ('diagnose_tests', $1::jsonb);`, [n.J('$json.tests')]));
  w.add(n.exec('Mail report', 'sc.mail', { subject: "={{ $('Report').first().json.subject }}", html: "={{ $('Report').first().json.html }}" }));
  w.chain('Report', 'Log tests', 'Mail report');
  return w;
}

// ---------------- sc.fixtures ----------------
// tests/agents/<agent>.json is the source of truth (git keeps the history); this loads it into the Data Tables.
export function scFixtures() {
  const w = new WF('sc.fixtures', { description: 'By hand: creates the Data Tables eval_<agent> and loads them from tests/agents/<agent>.json (embedded at build time). Run after every fixture change (PLAN §4.9).' });
  w.add(n.manual());
  let prev = 'Manual';
  for (const a of AGENTS) {
    const C = `Create eval_${a}`, X = `Clear eval_${a}`, R = `Rows ${a}`, I = `Insert eval_${a}`;
    w.add({ name: C, type: 'n8n-nodes-base.dataTable', typeVersion: 1, parameters: { resource: 'table', operation: 'create', tableName: `eval_${a}`,
      columns: { column: ['name', 'prompt', 'input', 'expect', 'provider'].map((name) => ({ name, type: 'string' })) }, options: { createIfNotExists: true } }, executeOnce: true });
    w.add({ name: X, type: 'n8n-nodes-base.dataTable', typeVersion: 1, parameters: { resource: 'table', operation: 'clear', dataTableId: { __rl: true, value: `eval_${a}`, mode: 'name' } }, executeOnce: true });
    w.add(n.code(R, `// Fixture rows from tests/agents/${a}.json, embedded by scripts/wfgen at build time.
return ${JSON.stringify(fixtures(a))}.map((r) => ({ json: r }));`));
    w.add({ name: I, type: 'n8n-nodes-base.dataTable', typeVersion: 1, parameters: { resource: 'row', operation: 'insert', dataTableId: { __rl: true, value: `eval_${a}`, mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true }, options: {} } });
    w.chain(prev, C, X, R, I);
    prev = I;
  }
  return w;
}

// ---------------- sc.eval.<agent> ----------------
export function scEval() {
  return AGENTS.map((a) => {
    const w = new WF(`sc.eval.${a}`, { saveSuccess: true, description: `Evaluations tab → Run Test: each eval_${a} row → sc.llm (row provider, else the first in LLM_CHAIN_${a.toUpperCase()}) → metrics pass (code checks) and correctness (LLM judge). After the first sc.fixtures run, pick the table eval_${a} in the trigger once (PLAN §4.9).` });
    w.add(n.evalTrigger('Fixtures', `eval_${a}`));
    w.nodes.at(-1).parameters.dataTableId = { __rl: true, value: '', mode: 'list', cachedResultName: `eval_${a}` };
    w.add(n.exec('Run', 'sc.llm', { agent: a, prompt: `={{ $json.prompt || '${a}' }}`, user_content: '={{ $json.input }}',
      chain: `={{ $json.provider || String($env.LLM_CHAIN_${a.toUpperCase()} ?? '').split(',')[0] }}`, exclude_provider: '', temperature: '={{ 0.3 }}' }, { err: true }));
    w.add(n.code('Checks', `// No node runs the fixture's code checks.
${CHECKS}
const row = $('Fixtures').item.json; const r = $input.item.json;
const fails = r.ok ? runChecks(r.json, JSON.parse(row.expect || '{}')) : ['call failed: ' + String(r.error?.message ?? r.error ?? 'error').slice(0, 200)];
return { json: { pass: fails.length ? 0 : 1, fails: fails.join('; '), output: r.ok ? JSON.stringify(r.json) : '', expect: row.expect } };`, { each: true }));
    w.add(n.evalMetrics('Pass metric', [['pass', '={{ $json.pass }}']]));
    w.add(n.evalCorrectness('Correctness', "={{ 'The output must satisfy these checks: ' + $('Checks').item.json.expect }}", "={{ $('Checks').item.json.output || ('FAILED: ' + $('Checks').item.json.fails) }}"));
    w.add(n.anthropic('Judge model', 'low', 4000));
    w.sub('Judge model', 'Correctness', 'ai_languageModel');
    w.chain('Fixtures', 'Run', 'Checks', 'Pass metric', 'Correctness');
    w.c('Run', 'Checks', 1);
    return w;
  });
}

// ---------------- sc.ask_master.test ----------------
export function scAskMasterTest() {
  const w = new WF('sc.ask_master.test', { saveSuccess: true, description: 'Manual: calls sc.ask_master with the fixture contexts from tests/master/ and checks each answer (valid JSON per task, a weak script gets redo, research links on allowed domains) (PLAN §5.1).' });
  w.add(n.manual());
  const cases = ['review_script', 'review_script_weak', 'diagnose_research'].map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(new URL(`master/${f}.json`, TESTS))) }));
  w.add(n.code('Cases', `// Fixture contexts from tests/master/, embedded at build time.
return ${JSON.stringify(cases)}.map((c) => ({ json: c }));`));
  w.add(n.exec('Ask', 'sc.ask_master', { task: '={{ $json.task }}', job_id: '', context: '={{ $json.context }}', image_path: '' }, { each: true }));
  w.add(n.code('Verify', `// No node asserts on another workflow's answers.
const DIAG = ${JSON.stringify(DIAG_WEB_DOMAINS)};
const cases = $('Cases').all().map((i) => i.json);
const out = $input.all().map((it, i) => { const c = cases[i]; const r = it.json; const f = [];
  if (!r.ok) f.push('not ok: ' + r.reason);
  else if (c.task.startsWith('review')) { if (!['ok', 'redo'].includes(r.json?.verdict)) f.push('bad verdict'); if (c.expect?.verdict && r.json.verdict !== c.expect.verdict) f.push('verdict ' + r.json.verdict + ', want ' + c.expect.verdict); }
  else if (c.task === 'diagnose_research') { const urls = [...(r.json.in_use ?? []), ...(r.json.candidates ?? [])].map((x) => x.source_url).filter(Boolean);
    if (!urls.some((u) => { const h = (/^https:\/\/([^/:?#]+)/i.exec(String(u)) ?? [])[1]?.toLowerCase(); return !!h && DIAG.some((d) => h === d || h.endsWith('.' + d)); })) f.push('no source_url on an allowed domain'); }
  return { case: c.file, pass: f.length === 0, fails: f }; });
return [{ json: { all_pass: out.every((x) => x.pass), cases: out } }];`));
  w.chain('Manual', 'Cases', 'Ask', 'Verify');
  return w;
}
