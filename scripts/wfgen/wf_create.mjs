// sc.produce, sc.create, sc.revise (PLAN §6, §10.6). M2.
import * as n from './lib.mjs';
import { ESC, RULES, TAGS, tagsafeExpr } from './js.mjs';
const { WF } = n;

const BUFFER = ['video_review', 'video_editing', 'approved', 'awaiting_upload', 'scheduled'];
const PIPELINE = ['new', 'script_review', 'needs_human', 'revising', 'script_approved'];
const list = (a) => a.map((s) => `'${s}'`).join(', ');

// ---------------- sc.produce ----------------
export function scProduce() {
  const w = new WF('sc.produce', { timer: true, description: 'Daily 08:00: while buffer + pipeline < BUFFER_TARGET, insert new jobs (at most 2 a day). Alerts buffer_low (PLAN §6).' });
  w.add(n.cron('Daily 08:00', '0 8 * * *'));
  // One statement counts and inserts, so two runs can never both top up past the target.
  w.add(n.pg('Top up', `WITH c AS (
  SELECT count(*) FILTER (WHERE status IN (${list(BUFFER)}))::int AS buffer,
         count(*) FILTER (WHERE status IN (${list(PIPELINE)}))::int AS pipeline
  FROM jobs),
ins AS (
  INSERT INTO jobs (status)
  SELECT 'new' FROM c, generate_series(1, GREATEST(0, LEAST(2, $1::int - c.buffer - c.pipeline)))
  RETURNING id)
SELECT c.buffer, c.pipeline, (SELECT count(*) FROM ins)::int AS inserted FROM c;`, ['Number($env.BUFFER_TARGET ?? 4)']));
  w.add(n.iff('Buffer low?', [['={{ $json.buffer }}', 'number:lt', 2]]));
  w.add(n.alert('Alert buffer low', "'buffer_low'", "'Only ' + $json.buffer + ' videos are booked ahead'",
    "'The buffer holds ' + $json.buffer + ' finished videos with a slot (target ' + ($env.BUFFER_TARGET ?? 4) + ', ' + $json.pipeline + ' more in the pipeline). Daily slots may stay empty until it refills.'"));
  w.chain('Daily 08:00', 'Top up', 'Buffer low?', 'Alert buffer low');
  return w;
}

// ---------------- shared: write → rules → check → verdict ----------------
// Adds Writer/Editor{s}, Rules{s}, Checker{s}, Verdict{s}. writerUser: user-message expression.
// briefExpr: expression for the brief (with source_texts). Returns [first, last] node names.
export function writeAndCheck(w, s, { agent = 'writer', writerUser, briefExpr, fail = 'Fail' }) {
  const Wn = `${agent === 'writer' ? 'Writer' : 'Editor'}${s}`, R = `Rules${s}`, C = `Checker${s}`, V = `Verdict${s}`;
  w.add(n.llm(Wn, agent, writerUser));
  w.add(n.code(R, RULES(`$('${Wn}').first().json.json`, briefExpr)));
  w.add(n.llm(C, 'checker',
    `'<script>' + JSON.stringify($('${Wn}').first().json.json) + '</script>\\n<brief>' + JSON.stringify({ ...${briefExpr}, source_texts: undefined }) + '</brief>\\n' + (${briefExpr}.source_texts ?? []).map(x => '<source url="' + x.url + '">' + x.text + '</source>').join('\\n')`,
    { exclude: `$('${Wn}').first().json.provider` }));
  w.add(n.code(V, `// No node merges the Checker's JSON with the code rule checks.
const c = $input.first().json;
const rules = $('${R}').first().json.rules;
const script = $('${Wn}').first().json.json;
const pass = c.json?.pass === true && rules.length === 0;
const flags = [...(c.json?.unsupported_claims ?? []), ...(c.json?.policy_issues ?? []), ...rules].map(String);
return [{ json: { script, check: { ...c.json, rules, pass }, pass, flags,
  writer_agent: '${agent}', writer_provider: $('${Wn}').first().json.provider, checker_provider: c.provider } }];`));
  w.chain(Wn, R, C, V);
  w.c(Wn, fail, 1).c(C, fail, 1);
  return [Wn, V];
}

const CLAIM_NEW = n.CLAIM_SQL(['new']);

// ---------------- sc.create ----------------
const RSS = [['The Verge', 'https://www.theverge.com/rss/index.xml'], ['Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index'],
  ['TechCrunch', 'https://techcrunch.com/feed/'], ['9to5Mac', 'https://9to5mac.com/feed/'], ['9to5Google', 'https://9to5google.com/feed/']];
const REDDIT = [['r/technology', 'technology'], ['r/gadgets', 'gadgets']];

export function scCreate() {
  const w = new WF('sc.create', { timer: true, description: 'Claims a new job: sources → Scout rank → url check → fetch (via the renderer proxy) → Guardrails → Scout brief → Writer → Checker (→ fix) → Master review (→ redo) → script_review / needs_human → sc.review (PLAN §10.6).' });
  w.add(n.every('Every 2 min', 2));
  w.add(n.pg('Claim', CLAIM_NEW));
  w.add(n.failNode());
  w.chain('Every 2 min', 'Claim');

  // 2. sources, in parallel; each one may fail on its own
  const sources = [];
  w.add(n.http('HN', { url: 'https://hn.algolia.com/api/v1/search', query: { tags: 'front_page', hitsPerPage: '40' }, soft: true, once: true, timeout: 20000 }));
  sources.push('HN');
  w.add(n.http('GitHub Trending', { url: 'https://github.com/trending', format: 'text', soft: true, once: true, timeout: 20000 }));
  w.add(n.htmlExtract('Trending repos', 'data', [['repos', 'article.Box-row h2 a', true, 'href']]));
  w.c('Claim', 'GitHub Trending').c('GitHub Trending', 'Trending repos');
  sources.push('Trending repos');
  for (const [name, url] of RSS) { w.add(n.rss(name, url)); w.nodes.at(-1).executeOnce = true; sources.push(name); }
  for (const [name, sub] of REDDIT) {
    w.add(n.http(name, { url: `https://www.reddit.com/r/${sub}/top.json`, query: { t: 'day', limit: '25' }, headers: { 'User-Agent': 'ShortCircuit/1.0 (tech news reader)' }, soft: true, once: true, timeout: 20000 }));
    sources.push(name);
  }
  w.add(n.merge('All sources', sources.length));
  sources.forEach((s, i) => { if (s !== 'Trending repos') w.c('Claim', s); w.c(s, 'All sources', 0, i); });

  // 3. normalise
  w.add(n.code('Candidates', `// No node merges nine differently shaped feeds into one candidate list.
${ESC}
const all = (name) => { try { return $(name).all().map((i) => i.json).filter((j) => j && !j.error); } catch { return []; } };
const now = Date.now(); const out = new Map();
const add = (title, url, source, kind, score, date) => {
  const u = okUrl(url); if (!title || !u) return;
  const t = date ? new Date(date).getTime() : now;
  if (!(t > now - 72 * 3600e3)) return;
  const c = out.get(u) ?? { title: String(title).slice(0, 200), url: u, source, score: 0, date: new Date(t).toISOString(), kinds: [] };
  c.score = Math.max(c.score, Number(score) || 0); if (!c.kinds.includes(kind)) c.kinds.push(kind);
  out.set(u, c);
};
for (const h of (all('HN')[0]?.hits ?? []).slice(0, 25)) add(h.title, h.url, 'Hacker News', 'hn', h.points, h.created_at);
(all('Trending repos')[0]?.repos ?? []).slice(0, 10).forEach((href, i) => add(String(href).replace(/^\\//, '').replace(/\\s+/g, ''), 'https://github.com' + String(href).replace(/\\s+/g, ''), 'GitHub Trending', 'github', 100 - i, null));
for (const name of ${JSON.stringify(RSS.map((r) => r[0]))}) for (const it of all(name).slice(0, 8)) add(it.title, it.link, name, 'rss', 50, it.isoDate ?? it.pubDate);
for (const name of ${JSON.stringify(REDDIT.map((r) => r[0]))}) for (const c of (all(name)[0]?.data?.children ?? []).slice(0, 10)) add(c.data?.title, c.data?.url, 'Reddit ' + name, 'reddit', c.data?.score, c.data?.created_utc ? c.data.created_utc * 1000 : null);
const candidates = [...out.values()];
if (candidates.length < 5) throw new Error('only ' + candidates.length + ' source items fetched; sources down?');
return [{ json: { candidates } }];`, { err: true }));
  w.c('All sources', 'Candidates').c('Candidates', 'Fail', 1);

  // 4. recent topics
  w.add(n.pg('Recent topics', `SELECT coalesce(json_agg(topic ORDER BY created_at DESC), '[]'::json) AS topics FROM jobs
WHERE topic IS NOT NULL AND status <> 'failed' AND created_at > now() - interval '60 days';`, [], { err: true }));
  w.c('Candidates', 'Recent topics').c('Recent topics', 'Fail', 1);

  // 5. Scout rank
  w.add(n.llm('Scout rank', 'scout', `'<candidates>' + JSON.stringify($('Candidates').first().json.candidates.map(({ kinds, ...c }) => c)) + '</candidates>\\n<recent_topics>' + JSON.stringify($json.topics) + '</recent_topics>'`, { prompt: 'scout_rank', temp: 0.3 }));
  w.c('Recent topics', 'Scout rank').c('Scout rank', 'Fail', 1);

  // 5a. url check (trust boundary: urls come from model output)
  w.add(n.code('URL check', `// No node checks model-chosen urls against the fetched candidate list.
${ESC}
const r = $input.first().json; const p = r.json ?? {};
const byUrl = new Map($('Candidates').first().json.candidates.map((c) => [c.url, c]));
const urls = [...new Set((p.source_urls ?? []).map(okUrl).filter((u) => u && byUrl.has(u)))].slice(0, 4);
if (urls.length < 2) throw new Error('Scout picked fewer than 2 source urls from the candidates');
if (!urls.some((u) => byUrl.get(u).kinds.some((k) => k === 'rss' || k === 'github'))) throw new Error('no source url comes from an RSS feed or GitHub Trending (HN/Reddit links alone are not independent)');
if (!(Number(p.shelf_life_days) >= 7)) throw new Error('Scout pick has a shelf life under 7 days');
let primary = okUrl(p.primary_url);
if (!(primary && hostOf(primary) === 'github.com' && byUrl.get(primary)?.kinds.includes('github'))) primary = null;
return [{ json: { topic: String(p.topic ?? '').slice(0, 200), angle: p.angle ?? '', shelf_life_days: Number(p.shelf_life_days), source_urls: urls, primary_url: primary, provider: r.provider } }];`, { err: true }));
  w.c('Scout rank', 'URL check').c('URL check', 'Fail', 1);

  // 6. fetch through the renderer's checking proxy, extract, trim
  w.add(n.splitOut('One per source', 'source_urls'));
  w.nodes.at(-1).parameters.options = { destinationFieldName: 'url' };
  w.add(n.http('Fetch source', { url: '={{ $json.url }}', format: 'text', proxy: 'http://renderer:8899', timeout: 30000, soft: true, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShortCircuit/1.0)' }, retry: { tries: 2, wait: 5000 } }));
  w.add(n.htmlExtract('Page text', 'data', [['article', 'article'], ['main', 'main'], ['body', 'body']]));
  w.add(n.code('Trim', `// No node trims text to a word budget. 2000 words each, so 3 sources still fit Ollama's 16k context.
const urls = $('One per source').all().map((i) => i.json.url);
return $input.all().map((it, i) => {
  const t = [it.json.article, it.json.main, it.json.body].find((x) => typeof x === 'string' && x.split(/\\s+/).length > 80) ?? '';
  return { json: { url: urls[i], text: t.split(/\\s+/).slice(0, 2000).join(' ') } };
}).filter((x) => x.json.text);`, { always: true }));
  w.chain('URL check', 'One per source', 'Fetch source', 'Page text', 'Trim');

  // 6a. Guardrails: prompt-injection check on each source text
  w.add(n.guardrailJailbreak('Injection check', '={{ $json.text }}'));
  w.add(n.groq('Guardrails model', '={{ $env.GROQ_MODEL }}', 0));
  w.sub('Guardrails model', 'Injection check', 'ai_languageModel');
  w.add(n.set('Clean', [['url', "={{ $('Trim').item.json.url }}"], ['text', "={{ $('Trim').item.json.text }}"], ['flagged', '={{ false }}', 'boolean']]));
  w.add(n.set('Flagged', [['url', "={{ $('Trim').item.json.url }}"], ['flagged', '={{ true }}', 'boolean'], ['error', '={{ $json.error ?? "" }}']]));
  w.add(n.merge('Checked sources', 2));
  w.nodes.at(-1).alwaysOutputData = true;
  w.c('Trim', 'Injection check');
  w.c('Injection check', 'Clean', 0).c('Injection check', 'Flagged', 1);
  w.c('Clean', 'Checked sources', 0, 0).c('Flagged', 'Checked sources', 0, 1);
  w.add(n.code('Enough sources', `// No node counts the sources left after the injection check.
${TAGS}
const all = $input.all().map((i) => i.json).filter((j) => j.url);
const err = all.find((j) => j.error);
if (err) throw new Error('Guardrails could not check ' + err.url + ': ' + err.error);
const clean = all.filter((j) => !j.flagged && j.text);
const pick = $('URL check').first().json;
const dropped = pick.source_urls.filter((u) => !clean.some((c) => c.url === u));
if (clean.length < 2) throw new Error('fewer than 2 usable sources (' + clean.length + ' clean; dropped or unreadable: ' + dropped.join(', ') + ')');
return [{ json: { source_texts: clean.map((c) => ({ url: c.url, text: tagsafe(c.text) })), dropped } }];`, { err: true }));
  w.c('Checked sources', 'Enough sources').c('Enough sources', 'Fail', 1);

  // 7. Scout brief
  w.add(n.llm('Scout brief', 'scout', `'<pick>' + JSON.stringify((({ provider, ...p }) => p)($('URL check').first().json)) + '</pick>\\n' + $json.source_texts.map(x => '<source url="' + x.url + '">' + x.text + '</source>').join('\\n')`, { prompt: 'scout_brief', temp: 0.3 }));
  w.c('Enough sources', 'Scout brief').c('Scout brief', 'Fail', 1);
  w.add(n.code('Brief check', `// No node filters model facts against the checked url list.
${ESC}
const r = $input.first().json; const b = r.json ?? {};
const pick = $('URL check').first().json; const src = $('Enough sources').first().json;
const ok = src.source_texts.map((x) => x.url);
b.facts = (b.facts ?? []).filter((f) => ok.includes(okUrl(f.source_url)));
if (b.facts.length < 2) throw new Error('the brief has fewer than 2 facts on checked sources');
const meta = (u) => (b.sources ?? []).find((s) => okUrl(s.url) === u) ?? {};
b.sources = ok.map((u) => ({ url: u, title: String(meta(u).title ?? ''), publisher: String(meta(u).publisher ?? hostOf(u)) }));
b.topic = String(b.topic || pick.topic).slice(0, 200);
b.primary_url = pick.primary_url; b.checked_urls = ok; b.dropped_sources = src.dropped; b.source_texts = src.source_texts;
return [{ json: { brief: b, scout_provider: r.provider } }];`, { err: true }));
  w.c('Scout brief', 'Brief check').c('Brief check', 'Fail', 1);

  const BRIEF = "$('Brief check').first().json.brief";
  const BRIEF_NO_TEXT = `JSON.stringify({ ...${BRIEF}, source_texts: undefined })`;
  // 8–9. Writer → Checker
  const [w1, v1] = writeAndCheck(w, ' 1', { writerUser: `'<brief>' + ${BRIEF_NO_TEXT} + '</brief>'`, briefExpr: BRIEF });
  w.c('Brief check', w1);
  w.add(n.iff('Clean check?', [['={{ $json.pass }}', 'boolean:true']]));
  w.c(v1, 'Clean check?');
  // fix once with the flags
  const [w2, v2] = writeAndCheck(w, ' fix', { writerUser: `'<brief>' + ${BRIEF_NO_TEXT} + '</brief>\\n<flags>' + JSON.stringify($('${v1}').first().json.flags) + '</flags>\\n<previous_script>' + JSON.stringify($('${v1}').first().json.script) + '</previous_script>'`, briefExpr: BRIEF });
  w.c('Clean check?', w2, 1);
  // 9a. Master review, only on a clean check
  w.add(n.askMaster('Master review', 'review_script', "$('Claim').first().json.id", `JSON.stringify({ brief: { ...${BRIEF}, source_texts: undefined }, script: $('${v1}').first().json.script, check: $('${v1}').first().json.check })`));
  w.add(n.iff('Redo?', [['={{ $json.ok === true && $json.json?.verdict === "redo" }}', 'boolean:true']]));
  w.c('Clean check?', 'Master review', 0).chain('Master review', 'Redo?');
  w.c('Master review', 'Redo?', 1); // ask_master never throws; an error item is "no verdict"
  const [w3, v3] = writeAndCheck(w, ' redo', { writerUser: `'<brief>' + ${BRIEF_NO_TEXT} + '</brief>\\n<feedback>' + ${tagsafeExpr("$('Master review').first().json.json.feedback")} + '</feedback>\\n<previous_script>' + JSON.stringify($('${v1}').first().json.script) + '</previous_script>'`, briefExpr: BRIEF });
  w.c('Redo?', w3, 0);

  // 10. finish: one Set per path, one guarded update
  const result = (name, v, masterInc) => {
    w.add(n.set(name, [
      ['status', `={{ $('${v}').first().json.pass ? 'script_review' : 'needs_human' }}`],
      ['script', `={{ $('${v}').first().json.script }}`, 'object'],
      ['check', `={{ $('${v}').first().json.check }}`, 'object'],
      ['providers', `={{ { scout: $('Brief check').first().json.scout_provider, writer: $('${v}').first().json.writer_provider, checker: $('${v}').first().json.checker_provider } }}`, 'object'],
      ['master_inc', `={{ ${masterInc} }}`, 'number'],
      ['reason', `={{ $('${v}').first().json.pass ? '' : 'the Checker flagged: ' + $('${v}').first().json.flags.join('; ').slice(0, 300) }}`],
    ]));
    w.c(name, 'Finish');
  };
  w.add(n.pg('Finish', `UPDATE jobs SET status = $2, topic = $3, brief = $4::jsonb, script = $5::jsonb, check_result = $6::jsonb,
  providers = providers || $7::jsonb, master_rounds = master_rounds + $8, review_sent_at = NULL, review_url = NULL,
  attempts = 0, locked_at = NULL, last_error = NULL, updated_at = now()
WHERE id = $1 AND status = 'new' RETURNING id, status, $9::text AS reason;`,
  ["$('Claim').first().json.id", '$json.status', `${BRIEF}.topic`, n.J(BRIEF), n.J('$json.script'), n.J('$json.check'), n.J('$json.providers'), '$json.master_inc', '$json.reason'], { err: true }));
  result('Result clean', v1, 0);
  result('Result fixed', v2, 0);
  result('Result redone', v3, 1);
  w.c('Redo?', 'Result clean', 1);
  w.c(v2, 'Result fixed').c(v3, 'Result redone');
  w.c('Finish', 'Fail', 1);
  // 11. review, no wait
  w.add(n.startReview('Start review', '$json.id', "$json.status === 'needs_human' ? 'needs_human' : 'script'", '$json.reason'));
  w.c('Finish', 'Start review');
  w.guard('Claim');
  w.guard('Finish');
  return w;
}

// ---------------- sc.revise ----------------
export function scRevise() {
  const w = new WF('sc.revise', { timer: true, description: 'Claims revising: Editor applies the notes (owner or Master), Checker checks → script_review / needs_human → sc.review. Round 3 used → needs_human (PLAN §10.6).' });
  w.add(n.every('Every 2 min', 2));
  w.add(n.pg('Claim', n.CLAIM_SQL(['revising'])));
  w.add(n.failNode());
  w.add(n.iff('Rounds used?', [['={{ $json.round }}', 'number:gte', 3]]));
  w.chain('Every 2 min', 'Claim', 'Rounds used?');
  w.add(n.pg('Finish rounds used', `UPDATE jobs SET status = 'needs_human', review_sent_at = NULL, review_url = NULL, attempts = 0, locked_at = NULL, last_error = NULL, updated_at = now()
WHERE id = $1 AND status = 'revising' RETURNING id;`, ["$('Claim').first().json.id"], { err: true }));
  w.add(n.startReview('Review rounds used', '$json.id', "'needs_human'", "'3 rounds used'"));
  w.c('Rounds used?', 'Finish rounds used', 0).c('Finish rounds used', 'Review rounds used').c('Finish rounds used', 'Fail', 1);
  const BRIEF = "$('Claim').first().json.brief";
  const [e1, v1] = writeAndCheck(w, '', { agent: 'editor', briefExpr: BRIEF,
    writerUser: `'<script>' + JSON.stringify($('Claim').first().json.script) + '</script>\\n<owner_notes>' + ${tagsafeExpr("$('Claim').first().json.notes")} + '</owner_notes>\\n<brief>' + JSON.stringify({ ...${BRIEF}, source_texts: undefined }) + '</brief>'` });
  w.c('Rounds used?', e1, 1);
  w.add(n.pg('Finish', `UPDATE jobs SET status = $2, script = $3::jsonb, check_result = $4::jsonb, providers = providers || $5::jsonb,
  round = round + 1, notes = NULL, review_sent_at = NULL, review_url = NULL, attempts = 0, locked_at = NULL, last_error = NULL, updated_at = now()
WHERE id = $1 AND status = 'revising' RETURNING id, status;`,
  ["$('Claim').first().json.id", "$json.pass ? 'script_review' : 'needs_human'", n.J('$json.script'), n.J('$json.check'),
    n.J('{ editor: $json.writer_provider, checker: $json.checker_provider }')], { err: true }));
  w.c(v1, 'Finish').c('Finish', 'Fail', 1);
  w.add(n.startReview('Start review', '$json.id', "$json.status === 'needs_human' ? 'needs_human' : 'script'",
    `$json.status === 'needs_human' ? 'the Checker flagged: ' + $('${v1}').first().json.flags.join('; ').slice(0, 300) : ''`));
  w.c('Finish', 'Start review');
  w.guard('Claim');
  w.guard('Finish rounds used');
  w.guard('Finish');
  return w;
}
