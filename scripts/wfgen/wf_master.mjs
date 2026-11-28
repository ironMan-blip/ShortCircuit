// sc.ask_master, sc.master (triage), sc.master.daily, sc.tool.* (PLAN §4.8, §5.1, §10.6). M7.
import * as n from './lib.mjs';
import { ESC } from './js.mjs';
const { WF } = n;
const B = 'n8n-nodes-base.';

export const DIAG_WEB_DOMAINS = ['ai.google.dev', 'groq.com', 'console.groq.com', 'ollama.com', 'huggingface.co', 'github.com', 'lmarena.ai', 'artificialanalysis.ai'];
const ANTHROPIC_VERSION = '2026-10-21';
const AGENTS = ['scout', 'writer', 'checker', 'editor', 'director', 'cutter', 'scheduler'];

const REVIEW_SCHEMA = { type: 'object', properties: {
  verdict: { type: 'string', enum: ['ok', 'redo'] }, score: { type: 'integer', minimum: 1, maximum: 10 },
  issues: { type: 'array', items: { type: 'string' } }, feedback: { type: 'string' } }, required: ['verdict', 'score', 'issues', 'feedback'] };
const GRADE_SCHEMA = { type: 'object', properties: {
  agents: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string' }, status: { type: 'string', enum: ['good', 'weak', 'failing'] },
    score: { type: 'integer', minimum: 1, maximum: 10 }, best_provider: { type: 'string' }, notes: { type: 'string' } }, required: ['agent', 'status', 'score', 'best_provider', 'notes'] } },
  candidates: { type: 'array', items: { type: 'object', properties: { model: { type: 'string' }, agent: { type: 'string' }, better: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['model', 'agent', 'better', 'evidence'] } },
  report: { type: 'string' } }, required: ['agents', 'candidates', 'report'] };
const TRIAGE_SCHEMA = { type: 'object', properties: { diagnosis: { type: 'string' }, owner_note: { type: 'string' } }, required: ['diagnosis', 'owner_note'] };
const DAILY_SCHEMA = { type: 'object', properties: {
  healthy: { type: 'boolean' }, findings: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string' }, text: { type: 'string' } }, required: ['agent', 'text'] } },
  suggestions: { type: 'array', items: { type: 'string' } }, brief: { type: 'string' } }, required: ['healthy', 'findings', 'suggestions', 'brief'] };

const ctxWrap = (expr) => `'<context>\\n' + String(${expr} ?? '').replace(/<\\/?context\\b/gi, '[tag]') + '\\n</context>'`;
const logSql = `INSERT INTO master_log (job_id, task, result, usage) VALUES ($1, $2, $3::jsonb, $4::jsonb);`;

// ---------------- sc.ask_master ----------------
export function scAskMaster() {
  const w = new WF('sc.ask_master', { description: 'The Master as judge (PLAN §5.1). Input {task: review_script|review_video|diagnose_grade|diagnose_research, job_id?, context, image_path?}. Output {ok, json, model} or {ok:false, reason: limit|auth|invalid|timeout|down}. Never throws.' });
  w.add(n.input([['task'], ['job_id'], ['context'], ['image_path']]));
  w.add(n.code('Task', `// No node checks the task name and builds the per-task settings.
const i = $input.first().json;
const schemas = { review_script: ${JSON.stringify(JSON.stringify(REVIEW_SCHEMA))}, review_video: ${JSON.stringify(JSON.stringify(REVIEW_SCHEMA))}, diagnose_grade: ${JSON.stringify(JSON.stringify(GRADE_SCHEMA))} };
const ok = ['review_script', 'review_video', 'diagnose_grade', 'diagnose_research'].includes(i.task);
const job_id = Number.isInteger(Number(i.job_id)) && Number(i.job_id) > 0 ? Number(i.job_id) : null;
return [{ json: { ok, task: i.task, job_id, context: typeof i.context === 'string' ? i.context : JSON.stringify(i.context ?? {}), image_path: i.image_path || '',
  schema: schemas[i.task] ?? '', effort: i.task === 'diagnose_grade' ? 'high' : ($env.MASTER_EFFORT || 'medium') } }];`));
  w.add(n.readFile('Read prompt', "={{ '/prompts/master_' + $json.task + '.md' }}", { err: true }));
  w.add(n.extractText('Prompt text', 'prompt'));
  w.add(n.sw('Path', [
    ['image', [["={{ $('Task').first().json.task }}", 'string:equals', 'review_video']]],
    ['judge', [["={{ ['review_script', 'diagnose_grade'].includes($('Task').first().json.task) }}", 'boolean:true']]],
    ['research', [["={{ $('Task').first().json.task }}", 'string:equals', 'diagnose_research']]],
  ]));
  w.add(n.set('Bad task', [['ok', '={{ false }}', 'boolean'], ['reason', 'invalid'], ['detail', "={{ 'unknown task ' + $('Task').first().json.task }}"]]));
  w.add(n.iff('Known task?', [['={{ $json.ok }}', 'boolean:true']]));
  w.chain('Input', 'Task', 'Known task?', 'Read prompt', 'Prompt text', 'Path');
  w.c('Known task?', 'Bad task', 1);

  // Path A: Basic LLM Chain + Anthropic Chat Model + Structured Output Parser
  const T = "$('Task').first().json";
  w.add(n.readFile('Read image', `={{ ${T}.image_path }}`, { err: true }));
  w.c('Path', 'Read image', 0);
  const judge = (name, image) => {
    w.add(n.chain(name, `={{ ${ctxWrap(`${T}.context`)} }}`, "={{ $('Prompt text').first().json.prompt }}", { image: image ? 'data' : undefined, retry: { tries: 2, wait: 30000 } }));
    w.add(n.anthropic(`Claude ${name}`, `={{ ${T}.effort }}`, 16000));
    w.add(n.parser(`Parser ${name}`, `={{ ${T}.schema }}`));
    w.sub(`Claude ${name}`, name, 'ai_languageModel').sub(`Parser ${name}`, name, 'ai_outputParser');
  };
  judge('Judge', false); judge('Judge image', true);
  w.c('Path', 'Judge', 1).c('Read image', 'Judge image').c('Read image', 'Judge', 1);
  w.add(n.code('Map error', `// No node maps an API or parser error to one reason code.
const e = $input.first().json; const m = String(e.error?.message ?? e.error ?? e.message ?? 'error') + ' ' + String(e.error?.description ?? '');
const reason = /401|403|invalid x-api-key|api key|authentication|permission/i.test(m) ? 'auth'
  : /429|rate.?limit|spend|credit balance|usage limit|quota/i.test(m) ? 'limit'
  : /timeout|timed out|ETIMEDOUT|ECONNABORTED/i.test(m) ? 'timeout'
  : /parse|schema|output parser|JSON|format/i.test(m) ? 'invalid' : 'down';
return [{ json: { ok: false, reason, detail: m.slice(0, 500) } }];`));
  w.add(n.code('Check verdict', `// The Master's output is untrusted even when it parses: check enums and names in code.
const o = $input.first().json.output ?? {}; const task = $('Task').first().json.task;
const bad = (why) => [{ json: { ok: false, reason: 'invalid', detail: why } }];
if (task === 'diagnose_grade') {
  const agents = (o.agents ?? []).filter((a) => ${JSON.stringify(AGENTS)}.includes(a.agent) && ['good', 'weak', 'failing'].includes(a.status));
  const candidates = (o.candidates ?? []).filter((c) => /^(gemini|groq|ollama):[A-Za-z0-9._:\\/-]{1,100}$/.test(c.model) && ${JSON.stringify(AGENTS)}.includes(c.agent));
  return [{ json: { ok: true, json: { agents, candidates, report: String(o.report ?? '').slice(0, 4000) }, model: $env.MASTER_MODEL } }];
}
if (!['ok', 'redo'].includes(o.verdict)) return bad('verdict is not ok/redo');
const score = Math.max(1, Math.min(10, Math.round(Number(o.score) || 1)));
return [{ json: { ok: true, json: { verdict: o.verdict, score, issues: (o.issues ?? []).map(String).slice(0, 10), feedback: String(o.feedback ?? '').slice(0, 1500) }, model: $env.MASTER_MODEL } }];`));
  for (const j of ['Judge', 'Judge image']) w.c(j, 'Check verdict', 0).c(j, 'Map error', 1);
  w.c('Read image', 'Map error', 1).c('Read prompt', 'Map error', 1);

  // Path B: diagnose_research, raw HTTP Request to the Messages API with server tools
  w.add(n.code('Build request', `// No node builds a Messages API body with server-side web tools (the contrast lesson, PLAN §5.1).
const DIAG_WEB_DOMAINS = ${JSON.stringify(DIAG_WEB_DOMAINS)};
const ctx = String($('Task').first().json.context).replace(/<\\/?context\\b/gi, '[tag]');
const body = { model: $env.MASTER_MODEL, max_tokens: 32000, output_config: { effort: 'high' },
  // server-side fallback on a refusal (claude-api default for Opus 5.5)
  fallbacks: 'default',
  system: $('Prompt text').first().json.prompt,
  messages: [{ role: 'user', content: [{ type: 'text', text: '<context>\\n' + ctx + '\\n</context>' }] }],
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10, allowed_domains: DIAG_WEB_DOMAINS },
          { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10, allowed_domains: DIAG_WEB_DOMAINS }] };
return [{ json: { body, resumes: 0, retries: 0, searches: 0, input_tokens: 0, output_tokens: 0 } }];`));
  w.c('Path', 'Build request', 2);
  w.add(n.http('Messages API', {
    method: 'POST', url: 'https://api.anthropic.com/v1/messages', auth: 'anthropicHeader',
    headers: { 'anthropic-version': ANTHROPIC_VERSION, 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' },
    json: '={{ JSON.stringify($json.body) }}', timeout: 600000, full: true, never: true,
  }));
  w.add(n.code('Check response', `// No node handles pause_turn, retry-after and "parse the last JSON object" for a raw API reply.
const prev = $('Messages API').isExecuted && $input.first().json ? $input.first().json : {};
const st = $('Next call').isExecuted ? $('Next call').last().json : $('Build request').first().json;
const r = prev; const code = Number(r.statusCode ?? 0); const b = r.body ?? {};
const usage = { input_tokens: st.input_tokens + (b.usage?.input_tokens ?? 0), output_tokens: st.output_tokens + (b.usage?.output_tokens ?? 0),
  web_search_requests: st.searches + (b.usage?.server_tool_use?.web_search_requests ?? 0) };
const fail = (reason, detail) => [{ json: { done: true, ok: false, reason, detail: String(detail).slice(0, 2000), usage } }];
if ([429, 529].includes(code) || code >= 500) {
  if (st.retries < 1) return [{ json: { done: false, wait: Math.min(60, Number(r.headers?.['retry-after']) || 20), next: { ...st, retries: st.retries + 1 } } }];
  return fail(code === 429 ? 'limit' : 'down', 'HTTP ' + code);
}
if (code === 401 || code === 403) return fail('auth', 'HTTP ' + code);
if (code !== 200) return fail(code === 400 ? 'invalid' : 'down', 'HTTP ' + code + ' ' + JSON.stringify(b).slice(0, 1500));
if (b.stop_reason === 'pause_turn') {
  if (st.resumes >= 3) return fail('invalid', 'pause_turn 3 times');
  // resend with the paused reply appended; no new user message
  const body = { ...st.body, messages: [...st.body.messages, { role: 'assistant', content: b.content }] };
  return [{ json: { done: false, wait: 0, next: { ...st, body, resumes: st.resumes + 1, retries: 0, searches: usage.web_search_requests, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } } }];
}
if (b.stop_reason !== 'end_turn') return fail('invalid', 'stop_reason ' + b.stop_reason);
const blocks = b.content ?? []; let last = -1;
blocks.forEach((x, i) => { if (/_tool_result$/.test(x.type)) last = i; });
const text = blocks.slice(last + 1).filter((x) => x.type === 'text').map((x) => x.text).join('');
const end = text.lastIndexOf('}'); let obj = null;
for (let s = text.lastIndexOf('{', end); s >= 0 && !obj; s = text.lastIndexOf('{', s - 1)) { try { obj = JSON.parse(text.slice(s, end + 1)); if (!obj.in_use) obj = null; } catch {} }
if (!obj) return fail('invalid', 'no JSON object with in_use at the end of the reply');
const arr = (a) => (Array.isArray(a) ? a : []);
const json = {
  in_use: arr(obj.in_use).map((x) => ({ model: String(x.model ?? ''), free: ['yes', 'no', 'unknown'].includes(x.free) ? x.free : 'unknown', limits: String(x.limits ?? '').slice(0, 300), source_url: String(x.source_url ?? '') })),
  candidates: arr(obj.candidates).slice(0, 3).filter((c) => /^(gemini|groq|ollama):[A-Za-z0-9._:\\/-]{1,100}$/.test(c.model)).map((c) => ({ model: c.model, agents: arr(c.agents).filter((a) => ${JSON.stringify(AGENTS)}.includes(a)), why: String(c.why ?? '').slice(0, 500), free: String(c.free ?? ''), size_gb: Number(c.size_gb) || null, source_url: String(c.source_url ?? '') })),
  other_options: arr(obj.other_options).slice(0, 10).map((o) => ({ text: String(o.text ?? '').slice(0, 500), source_url: String(o.source_url ?? '') })),
};
return [{ json: { done: true, ok: true, json, model: b.model ?? $env.MASTER_MODEL, usage } }];`));
  w.add(n.iff('Done?', [['={{ $json.done }}', 'boolean:true']]));
  w.add({ name: 'Wait retry', type: B + 'wait', typeVersion: 1.1, parameters: { amount: '={{ $json.wait || 1 }}', unit: 'seconds' }, webhookId: 'sc-ask-master-wait' });
  w.add(n.set('Next call', [['body', '={{ $json.next.body }}', 'object'], ['resumes', '={{ $json.next.resumes }}', 'number'], ['retries', '={{ $json.next.retries }}', 'number'],
    ['searches', '={{ $json.next.searches }}', 'number'], ['input_tokens', '={{ $json.next.input_tokens }}', 'number'], ['output_tokens', '={{ $json.next.output_tokens }}', 'number']]));
  w.chain('Build request', 'Messages API', 'Check response', 'Done?');
  w.c('Done?', 'Wait retry', 1).chain('Wait retry', 'Next call', 'Messages API');

  // log every call (skips included), then answer
  w.add(n.set('Answer', [
    ['ok', '={{ $json.ok === true }}', 'boolean'], ['task', `={{ ${T}.task }}`],
    ['json', '={{ $json.json ?? null }}', 'object'], ['model', '={{ $json.model ?? null }}'],
    ['reason', '={{ $json.ok ? null : ($json.reason ?? "down") }}'], ['detail', '={{ $json.detail ?? null }}'],
    ['usage', '={{ $json.usage ?? null }}', 'object'],
  ]));
  for (const x of ['Check verdict', 'Map error', 'Bad task']) w.c(x, 'Answer');
  w.c('Done?', 'Answer', 0);
  w.add(n.pg('Log', logSql, [`${T}.job_id`, `${T}.task`, n.J('$json.ok ? $json.json : { skipped: $json.reason, detail: $json.detail }'), "$json.usage ? JSON.stringify($json.usage) : null"], { err: true }));
  w.add(n.set('Result', [['ok', "={{ $('Answer').first().json.ok }}", 'boolean'], ['json', "={{ $('Answer').first().json.json }}", 'object'],
    ['model', "={{ $('Answer').first().json.model }}"], ['reason', "={{ $('Answer').first().json.reason }}"], ['usage', "={{ $('Answer').first().json.usage }}", 'object']]));
  w.chain('Answer', 'Log', 'Result');
  w.c('Log', 'Result', 1);
  return w;
}

// ---------------- sc.tool.* ----------------
// Every action tool: guarded SQL in one statement; refusals come back as text, never as errors.
const GUARD = (extra = '') => `WITH w AS (SELECT NULLIF(regexp_replace(coalesce($1, ''), '[^0-9]', '', 'g'), '')::int AS want),
g AS (SELECT w.want, j.*, CASE
    WHEN j.id IS NULL THEN 'no such job'
    WHEN j.status IN ('failed', 'done', 'cancelled', 'rejected') THEN 'job is ' || j.status
    WHEN j.master_rounds >= 2 THEN 'master_rounds is ' || j.master_rounds
    WHEN $2 = 'triage' AND (j.id <> $3::int OR j.status <> 'triage') THEN 'not the job in triage'
    WHEN $2 = 'daily' AND NOT (j.status IN (${n.ACTIVE.map((s) => `'${s}'`).join(', ')}) AND j.updated_at < now() - interval '24 hours') THEN 'not stuck for 24 h (see list_stuck)'
    WHEN $2 NOT IN ('triage', 'daily') THEN 'unknown mode'${extra}
  END AS refused
  FROM w LEFT JOIN LATERAL (SELECT * FROM jobs WHERE id = w.want FOR UPDATE) j ON true)`;

const TOOL_IN = [['job'], ['mode'], ['claimed_id'], ['text']];
function actionTool(name, description, updateSql, doneText) {
  const w = new WF(`sc.tool.${name}`, { saveSuccess: true, description });
  w.add(n.input(TOOL_IN));
  w.add(n.pg('Act', `${GUARD()},
u AS (${updateSql} RETURNING jobs.id, jobs.status),
l AS (INSERT INTO master_log (job_id, task, result)
  SELECT g.id, 'tool:${name}', jsonb_build_object('mode', $2, 'text', left($4, 2000), 'result',
    CASE WHEN g.refused IS NULL THEN 'done' ELSE 'refused: ' || g.refused END) FROM g)
SELECT CASE WHEN g.refused IS NOT NULL THEN 'refused: ' || g.refused
  ELSE 'done: SC-' || lpad(g.id::text, 4, '0') || ' ${doneText} ' || coalesce((SELECT status FROM u), '?') END AS result,
  g.refused IS NULL AS acted, g.id, 'SC-' || lpad(g.id::text, 4, '0') AS job
FROM g;`, ['String($json.job ?? "")', '$json.mode', 'Number($json.claimed_id) || 0', 'String($json.text ?? "")'], { tx: true }));
  w.chain('Input', 'Act');
  return w;
}
const ACT = `UPDATE jobs SET`;
const DONE = `master_rounds = jobs.master_rounds + 1, attempts = 0, locked_at = NULL, updated_at = now() FROM g WHERE jobs.id = g.id AND g.refused IS NULL`;
export function scToolRetry() {
  return actionTool('retry_job', 'Retry the failed step: attempts 0, lock cleared; from triage back to triage_from.',
    `${ACT} status = CASE WHEN jobs.status = 'triage' THEN coalesce(jobs.triage_from, 'new') ELSE jobs.status END, ${DONE}`, 'retried, now');
}
export function scToolRedo() {
  return actionTool('redo_job', 'Feedback → notes ("From the Master: …"); script states → revising, video states → video_editing, others = retry.',
    `${ACT} notes = concat_ws(E'\\n\\n', jobs.notes, 'From the Master: ' || left($4, 1500)),
  status = CASE
    WHEN coalesce(CASE WHEN jobs.status = 'triage' THEN jobs.triage_from END, jobs.status) IN ('script_review', 'needs_human', 'revising', 'script_approved') AND jobs.script IS NOT NULL THEN 'revising'
    WHEN coalesce(CASE WHEN jobs.status = 'triage' THEN jobs.triage_from END, jobs.status) IN ('video_review', 'video_editing', 'approved') AND jobs.plan IS NOT NULL THEN 'video_editing'
    WHEN jobs.status = 'triage' THEN coalesce(jobs.triage_from, 'new') ELSE jobs.status END,
  edit_then = CASE WHEN coalesce(CASE WHEN jobs.status = 'triage' THEN jobs.triage_from END, jobs.status) IN ('video_review', 'video_editing', 'approved') THEN 'review' ELSE jobs.edit_then END,
  review_url = NULL, ${DONE}`, 'sent back, now');
}
export function scToolFail() {
  const w = actionTool('fail_job', 'End the job: failed, slot cleared, ALERT to the owner with the diagnosis.',
    `${ACT} status = 'failed', slot_at = NULL, slot_date = NULL, last_error = left('Master: ' || $4, 2000), ${DONE}`, 'is');
  w.add(n.iff('Acted?', [['={{ $json.acted }}', 'boolean:true']]));
  w.add(n.alert('Alert', "'job_failed:' + $json.job", "$json.job + ' failed (Master)'", "$json.job + ' was ended by the Master. Diagnosis: ' + $('Input').first().json.text"));
  w.add(n.set('Result', [['result', "={{ $('Act').first().json.result }}"]]));
  w.chain('Act', 'Acted?', 'Alert', 'Result');
  w.c('Alert', 'Result', 1).c('Acted?', 'Result', 1);
  return w;
}
export function scToolReject() {
  return actionTool('reject_job', 'Drop the job (rejected, slot cleared). Only reached after the owner approved it in the human review step.',
    `${ACT} status = 'rejected', slot_at = NULL, slot_date = NULL, review_url = NULL, ${DONE}`, 'is');
}
// read tools (at most 20 rows, no outbox, review_url or Drive links)
const readTool = (name, description, sql, params, inputs) => {
  const w = new WF(`sc.tool.${name}`, { saveSuccess: true, description });
  w.add(n.input(inputs));
  w.add(n.pg('Read', sql, params));
  w.chain('Input', 'Read');
  return w;
};
export function scToolGetJob() {
  return readTool('get_job', 'One job row (no secrets, no links), its last_error, providers and Master log.',
    `WITH w AS (SELECT NULLIF(regexp_replace(coalesce($1, ''), '[^0-9]', '', 'g'), '')::int AS want)
SELECT coalesce((SELECT jsonb_build_object('job', 'SC-' || lpad(j.id::text, 4, '0'), 'status', j.status, 'round', j.round, 'attempts', j.attempts,
  'last_error', j.last_error, 'topic', j.topic, 'title', j.script->>'title', 'check_result', j.check_result, 'providers', j.providers,
  'triage_from', j.triage_from, 'triage_at', j.triage_at, 'master_rounds', j.master_rounds, 'slot_at', j.slot_at, 'has_notes', j.notes IS NOT NULL,
  'created_at', j.created_at, 'updated_at', j.updated_at,
  'master_log', (SELECT coalesce(jsonb_agg(jsonb_build_object('task', m.task, 'result', m.result, 'at', m.created_at) ORDER BY m.id DESC), '[]') FROM (SELECT * FROM master_log WHERE job_id = j.id ORDER BY id DESC LIMIT 20) m))
  FROM jobs j, w WHERE j.id = w.want), '{"error": "no such job"}'::jsonb) AS result;`, ['String($json.job ?? "")'], [['job']]);
}
const STATS_SQL = `WITH d AS (SELECT LEAST(30, GREATEST(1, coalesce($1, 7))) AS days),
j AS (SELECT * FROM jobs, d WHERE created_at > now() - make_interval(days => d.days) OR updated_at > now() - make_interval(days => d.days))
SELECT jsonb_build_object(
  'days', (SELECT days FROM d),
  'jobs_per_status', (SELECT coalesce(jsonb_object_agg(status, c), '{}') FROM (SELECT status, count(*) c FROM j GROUP BY status) s),
  'provider_use', (SELECT coalesce(jsonb_object_agg(agent, p), '{}') FROM (SELECT agent, jsonb_object_agg(provider, c) p FROM (SELECT k AS agent, v AS provider, count(*) c FROM j, jsonb_each_text(j.providers) e(k, v) GROUP BY 1, 2) x GROUP BY agent) y),
  'checker_flag_rate', (SELECT round(avg(CASE WHEN (check_result->>'pass')::boolean THEN 0 ELSE 1 END)::numeric, 2) FROM j WHERE check_result IS NOT NULL),
  'needs_human', (SELECT count(*) FROM j WHERE status = 'needs_human'),
  'master', (SELECT coalesce(jsonb_object_agg(task, c), '{}') FROM (SELECT task || CASE WHEN result ? 'skipped' THEN ':skipped' WHEN result->>'verdict' = 'redo' THEN ':redo' ELSE '' END AS task, count(*) c FROM master_log, d WHERE created_at > now() - make_interval(days => d.days) GROUP BY 1) m),
  'owner_decisions', (SELECT coalesce(jsonb_object_agg(decision, c), '{}') FROM (SELECT kind || ':' || decision AS decision, count(*) c FROM reviews, d WHERE answered_at > now() - make_interval(days => d.days) GROUP BY 1) r),
  'errors', (SELECT coalesce(jsonb_agg(e), '[]') FROM (SELECT 'SC-' || lpad(id::text, 4, '0') AS job, status, left(last_error, 300) AS error FROM j WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 20) e),
  'views_48h', (SELECT coalesce(jsonb_agg(jsonb_build_object('job', 'SC-' || lpad(m.job_id::text, 4, '0'), 'views', m.views)), '[]') FROM metrics m, d WHERE m.age_h = 48 AND m.taken_at > now() - make_interval(days => d.days))
) AS result;`;
export function scToolCrewStats() {
  return readTool('crew_stats', 'Per-agent stats for the last N days (1-30).', STATS_SQL, ['Number($json.days) || 7'], [['days', 'number']]);
}
export function scToolListStuck() {
  return readTool('list_stuck', 'Jobs in an active state for more than 24 h (not triage, not failed); at most 20.',
    `SELECT coalesce(jsonb_agg(jsonb_build_object('job', 'SC-' || lpad(id::text, 4, '0'), 'status', status, 'attempts', attempts, 'updated_at', updated_at,
  'last_error', left(last_error, 300), 'master_rounds', master_rounds, 'title', script->>'title')), '[]') AS result
FROM (SELECT * FROM jobs WHERE status IN (${n.ACTIVE.map((s) => `'${s}'`).join(', ')}) AND updated_at < now() - interval '24 hours' ORDER BY updated_at LIMIT 20) s;`, [], [['note']]);
}

// tool nodes in an agent workflow. job: expression for the job id (fixed in triage, $fromAI in daily).
const TOOL_DESC = {
  get_job: 'Read one job: status, last_error, providers, check result, Master log. Input: job id like SC-0042. Read only.',
  crew_stats: 'Read per-agent stats for the last N days (provider use, Checker flag rate, Master reviews, owner decisions, recent errors, 48 h views). Read only.',
  list_stuck: 'List jobs that have been in an active state for more than 24 h (not triage, not failed). Read only.',
  retry_job: 'Try the failed step of the job again (attempts reset; a triage job goes back to the state it failed in). Returns "done: …" or "refused: <reason>".',
  redo_job: 'Send the job back with your feedback: a script is rewritten by the Editor, a video re-cut by the Cutter. Feedback must be concrete and ask for no new facts. Returns "done: …" or "refused: <reason>".',
  fail_job: 'End the job as failed and alert the owner with your diagnosis. For problems a retry cannot fix. Returns "done: …" or "refused: <reason>".',
  reject_job: 'Drop the job so it is never published. The owner is asked first by mail and may decline (then leave the job). Returns "done: …", "refused: <reason>", or a declined answer.',
};
const toolNode = (name, inputs) => n.tool(name, `sc.tool.${name}`, TOOL_DESC[name], inputs);
const fromAI = (key, desc, type = 'string') => `={{ $fromAI('${key}', '${desc}', '${type}') }}`;

function agentTools(w, agentName, mode, jobExpr, names) {
  for (const t of names) {
    const inputs = t === 'crew_stats' ? { days: fromAI('days', 'How many days back, 1-30', 'number') }
      : t === 'list_stuck' ? { note: '' }
      : t === 'get_job' ? { job: fromAI('job', 'The job id, e.g. SC-0042') }
      : { job: jobExpr, mode, claimed_id: mode === 'triage' ? "={{ $('Pick').first().json.id }}" : '0',
          text: fromAI(t === 'redo_job' ? 'feedback' : t === 'fail_job' ? 'diagnosis' : 'reason', t === 'redo_job' ? 'Concrete feedback for the Editor or Cutter' : t === 'fail_job' ? 'Your diagnosis for the owner' : 'Why') };
    w.add(toolNode(t, inputs));
    if (t === 'reject_job') {
      w.add(n.gmailApprovalTool('Owner approves reject', `={{ 'ShortCircuit Master asks: reject ' + ${mode === 'triage' ? "$('Pick').first().json.job" : "String($tool.parameters.job ?? '')"} + '?' }}`,
        "={{ ('The Master wants to drop this job so it is never published. Its reason: ' + String($tool.parameters.text ?? '')).replace(/[<>&]/g, ' ').slice(0, 1500) + ' — No answer within 1 hour counts as Decline.' }}"));
      w.c(t, 'Owner approves reject', 0, 0, 'ai_tool');
      w.c('Owner approves reject', agentName, 0, 0, 'ai_tool');
    } else w.c(t, agentName, 0, 0, 'ai_tool');
  }
}

// ---------------- sc.master (triage) ----------------
export function scMaster() {
  const w = new WF('sc.master', { saveSuccess: true, description: 'Every 5 min: picks one triage job (no attempts counted) and runs the Master AI Agent with get_job, crew_stats and four guarded action tools; the job id is fixed in every action tool. reject_job needs the owner (PLAN §4.8, §10.6).' });
  w.add(n.every('Every 5 min', 5));
  w.add(n.pg('Pick', `UPDATE jobs SET locked_at = now() WHERE id = (SELECT id FROM jobs WHERE status = 'triage'
  AND (locked_at IS NULL OR locked_at < now() - interval '90 minutes') ORDER BY triage_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING id, status, triage_from, triage_at, attempts, left(last_error, 2000) AS last_error, master_rounds, providers, topic, script->>'title' AS title, 'SC-' || lpad(id::text, 4, '0') AS job;`));
  w.add(n.readFile('Read prompt', '/prompts/master_triage.md'));
  w.add(n.extractText('Prompt text', 'prompt'));
  w.add(n.agent('Master', `={{ 'Job ' + $('Pick').first().json.job + ' is in triage. Find out why it failed and pick one action.\\n' + ${ctxWrap("JSON.stringify($('Pick').first().json)")} }}`,
    '={{ $json.prompt }}', { maxIterations: 10 }));
  w.add(n.anthropic('Claude', 'high', 16000));
  w.add(n.parser('Answer format', TRIAGE_SCHEMA));
  w.sub('Claude', 'Master', 'ai_languageModel').sub('Answer format', 'Master', 'ai_outputParser');
  agentTools(w, 'Master', 'triage', "={{ $('Pick').first().json.job }}", ['get_job', 'crew_stats', 'retry_job', 'redo_job', 'fail_job', 'reject_job']);
  w.chain('Every 5 min', 'Pick', 'Read prompt', 'Prompt text', 'Master');
  w.add(n.code('Outcome', `// No node reads the agent's tool steps to see whether an action tool succeeded.
const r = $input.first().json;
// the agent may put a sub-node error (Anthropic down, bad key) on its main output
if (r.error || !r.output) return [{ json: { acted: false, output: { skipped: 'down', detail: String(r.error?.message ?? r.error ?? 'no answer').slice(0, 500) }, tools: [] } }];
const steps = r.intermediateSteps ?? [];
const acts = steps.filter((s) => ['retry_job', 'redo_job', 'fail_job', 'reject_job'].includes(s.action?.tool));
const done = acts.some((s) => /^\\s*(\\[\\s*\\{.*)?"?done:/s.test(typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation)) || /done: SC-/.test(JSON.stringify(s.observation)));
return [{ json: { acted: done, output: r.output ?? null, tools: steps.map((s) => ({ tool: s.action?.tool, input: s.action?.toolInput, result: String(typeof s.observation === 'string' ? s.observation : JSON.stringify(s.observation)).slice(0, 500) })) } }];`));
  w.add(n.set('Agent error', [['acted', '={{ false }}', 'boolean'], ['output', '={{ { skipped: "down", detail: String($json.error?.message ?? $json.error ?? "error").slice(0, 500) } }}', 'object'], ['tools', '={{ [] }}', 'array']]));
  w.c('Master', 'Outcome', 0).c('Master', 'Agent error', 1);
  w.add(n.pg('Log', logSql, ["$('Pick').first().json.id", "'triage'", n.J('$json.output?.skipped ? $json.output : { acted: $json.acted, diagnosis: $json.output, tools: $json.tools }'), 'null']));
  // no action done (only reads, a refusal, a declined reject, or the Master down) → leave the job for the next tick
  w.add(n.pg('Release', `UPDATE jobs SET locked_at = NULL WHERE id = $1 AND status = 'triage';`, ["$('Pick').first().json.id"]));
  w.c('Outcome', 'Log').c('Agent error', 'Log').c('Log', 'Release');
  w.guard('Pick');
  return w;
}

// ---------------- sc.master.daily ----------------
const SNAPSHOT_SQL = `SELECT jsonb_build_object(
  'now', now(),
  'jobs_per_status', (SELECT coalesce(jsonb_object_agg(status, c), '{}') FROM (SELECT status, count(*) c FROM jobs WHERE status NOT IN ('done', 'failed', 'cancelled', 'rejected') OR updated_at > now() - interval '24 hours' GROUP BY status) s),
  'errors_24h', (SELECT coalesce(jsonb_agg(e), '[]') FROM (SELECT 'SC-' || lpad(id::text, 4, '0') AS job, status, attempts, left(last_error, 300) AS error FROM jobs WHERE last_error IS NOT NULL AND updated_at > now() - interval '24 hours' ORDER BY updated_at DESC LIMIT 20) e),
  'buffer', (SELECT count(*) FROM jobs WHERE slot_at > now() AND status IN ('video_review', 'video_editing', 'approved', 'awaiting_upload', 'scheduled')),
  'empty_slot_days', (SELECT coalesce(jsonb_agg(to_char(d, 'YYYY-MM-DD')), '[]') FROM generate_series((now() AT TIME ZONE $1)::date + 1, (now() AT TIME ZONE $1)::date + 3, interval '1 day') d WHERE d::date NOT IN (SELECT slot_date FROM jobs WHERE slot_date IS NOT NULL)),
  'schedule', (SELECT coalesce(jsonb_object_agg(dow, to_char(publish_time, 'HH24:MI')), '{}') FROM schedule),
  'schedule_changed_today', EXISTS (SELECT 1 FROM master_log WHERE task = 'schedule' AND created_at > now() - interval '24 hours' AND result->>'changed' = 'true'),
  'config_changed_today', EXISTS (SELECT 1 FROM master_log WHERE task = 'config' AND created_at > now() - interval '24 hours'),
  'master_log_today', (SELECT coalesce(jsonb_agg(jsonb_build_object('job', CASE WHEN job_id IS NULL THEN NULL ELSE 'SC-' || lpad(job_id::text, 4, '0') END, 'task', task, 'result', result) ORDER BY id), '[]') FROM (SELECT * FROM master_log WHERE created_at > now() - interval '24 hours' AND task <> 'daily' ORDER BY id DESC LIMIT 40) m)
) AS snapshot;`;

export function scMasterDaily() {
  const w = new WF('sc.master.daily', { saveSuccess: true, description: 'Daily 21:00: crew snapshot → Master AI Agent (get_job, crew_stats, list_stuck, retry_job, reject_job; action tools only on jobs stuck > 24 h) → master_log → the Master brief, only on days with something to say. Alerts master_down after 24 h without a working Master run (PLAN §4.8, §10.6).' });
  w.add(n.cron('Daily 21:00', '0 21 * * *'));
  w.add(n.pg('Snapshot', SNAPSHOT_SQL, ['$env.TZ']));
  w.add(n.pg('Crew stats', STATS_SQL, ['1']));
  w.add(n.readFile('Read prompt', '/prompts/master_daily.md'));
  w.add(n.extractText('Prompt text', 'prompt'));
  w.add(n.agent('Master', `={{ 'Check the crew and write today\\'s brief.\\n' + ${ctxWrap("JSON.stringify({ ...$('Snapshot').first().json.snapshot, agent_stats_24h: $('Crew stats').first().json.result })")} }}`,
    '={{ $json.prompt }}', { maxIterations: 10 }));
  w.add(n.anthropic('Claude', '={{ $env.MASTER_EFFORT || "medium" }}', 16000));
  w.add(n.parser('Answer format', DAILY_SCHEMA));
  w.sub('Claude', 'Master', 'ai_languageModel').sub('Answer format', 'Master', 'ai_outputParser');
  agentTools(w, 'Master', 'daily', fromAI('job', 'The job id from list_stuck, e.g. SC-0042'), ['get_job', 'crew_stats', 'list_stuck', 'retry_job', 'reject_job']);
  w.chain('Daily 21:00', 'Snapshot', 'Crew stats', 'Read prompt', 'Prompt text', 'Master');
  w.add(n.code('Brief', `// No node decides whether today needs a brief and HTML-escapes the Master's text.
${ESC}
const r = $input.first().json; const o = r.output ?? {}; const s = $('Snapshot').first().json.snapshot;
const steps = (r.intermediateSteps ?? []).map((x) => ({ tool: x.action?.tool, input: x.action?.toolInput, result: String(typeof x.observation === 'string' ? x.observation : JSON.stringify(x.observation)).slice(0, 300) }));
const acted = steps.some((x) => ['retry_job', 'reject_job'].includes(x.tool) && /done:/.test(x.result));
const actionsToday = (s.master_log_today ?? []).filter((m) => String(m.task).startsWith('tool:') || m.task === 'triage' || m.task === 'late_publish');
const send = acted || actionsToday.length > 0 || (o.suggestions ?? []).length > 0 || (o.findings ?? []).length > 0 || (s.empty_slot_days ?? []).length > 0 || s.schedule_changed_today || s.config_changed_today;
const li = (a) => a.length ? '<ul>' + a.map((x) => '<li>' + x + '</li>').join('') + '</ul>' : '<p>None.</p>';
const html = page('Master brief', '<p style="white-space:pre-wrap">' + esc(o.brief) + '</p>'
  + '<h3>Findings</h3>' + li((o.findings ?? []).map((f) => '<b>' + esc(f.agent) + '</b>: ' + esc(f.text)))
  + '<h3>Suggestions (you decide)</h3>' + li((o.suggestions ?? []).map(esc))
  + ((s.empty_slot_days ?? []).length ? '<h3>Days with no Short</h3>' + li(s.empty_slot_days.map(esc)) : '')
  + '<h3>Master actions in the last 24 h</h3>' + li([...actionsToday.map((m) => esc((m.job ?? '') + ' ' + m.task + ': ' + JSON.stringify(m.result).slice(0, 300))), ...steps.filter((x) => !['get_job', 'crew_stats', 'list_stuck'].includes(x.tool)).map((x) => esc(x.tool + ' ' + JSON.stringify(x.input) + ' → ' + x.result))]));
const date = new Date().toLocaleDateString('en-CA', { timeZone: $env.TZ });
return [{ json: { send, result: { ...o, tools: steps }, subject: 'ShortCircuit Master brief — ' + date, html } }];`));
  w.add(n.pg('Log', logSql, ['null', "'daily'", n.J('$json.result'), 'null']));
  w.add(n.iff('Send brief?', [["={{ $('Brief').first().json.send }}", 'boolean:true']]));
  w.add(n.exec('Mail brief', 'sc.mail', { subject: "={{ $('Brief').first().json.subject }}", html: "={{ $('Brief').first().json.html }}" }, { err: true }));
  w.add(n.iff('Agent answered?', [['={{ $json.output }}', 'object:exists']]));
  w.c('Master', 'Agent answered?', 0).c('Agent answered?', 'Brief', 0).c('Agent answered?', 'Log down', 1).chain('Brief', 'Log', 'Send brief?', 'Mail brief');
  // Master down: alert only when no Master run worked for 24 h
  w.add(n.pg('Log down', logSql, ['null', "'daily'", n.J('{ skipped: "down", detail: String($json.error?.message ?? $json.error ?? "error").slice(0, 500) }'), 'null']));
  w.add(n.pg('Master worked lately?', `SELECT EXISTS (SELECT 1 FROM master_log WHERE created_at > now() - interval '24 hours' AND task IN ('review_script', 'review_video', 'triage', 'daily', 'diagnose_grade', 'diagnose_research') AND NOT (result ? 'skipped')) AS ok;`));
  w.add(n.iff('Down 24 h?', [['={{ $json.ok }}', 'boolean:false']]));
  w.add(n.alert('Alert down', "'master_down'", "'The Master has not worked for 24 h'", "'No Master call succeeded in the last 24 hours (API outage, spend limit or a revoked key). Reviews are skipped and triage jobs end as failed after 6 h until it is back. Check the Anthropic credential and the Console usage page.'"));
  w.c('Master', 'Log down', 1).chain('Log down', 'Master worked lately?', 'Down 24 h?', 'Alert down');
  return w;
}
