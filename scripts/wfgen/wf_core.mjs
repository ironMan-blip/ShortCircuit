import * as n from './lib.mjs';
import { ESC } from './js.mjs';
const { WF } = n;

// ---------------- sc.error ----------------
export function scError() {
  const w = new WF('sc.error', { description: 'Error Trigger for every sc.* workflow. Alerts when one workflow fails 3 times in an hour. Never touches jobs (PLAN §10.3).' });
  w.add(n.errorTrigger());
  w.add(n.code('Count failures', `// No node keeps a rolling count across executions: workflow static data does.
const e = $input.first().json;
const wf = e.workflow?.name ?? 'unknown';
// sc.llm throws on purpose when a whole chain fails; its caller's fail branch handles that (attempts → triage).
if (wf === 'sc.llm') return [];
const s = $getWorkflowStaticData('global');
const now = Date.now();
s.fails = (s.fails ?? {});
s.fails[wf] = (s.fails[wf] ?? []).filter((t) => now - t < 3600e3).concat(now);
const msg = String(e.execution?.error?.message ?? e.trigger?.error?.message ?? 'unknown error').slice(0, 500);
const node = e.execution?.lastNodeExecuted ?? '';
if (s.fails[wf].length < 3) return [];
s.fails[wf] = [];
return [{ json: { key: 'workflow_failing:' + wf, subject: wf + ' failed 3 times in an hour',
  text: 'Workflow ' + wf + ' failed 3 times in the last hour. Last failure at node "' + node + '": ' + msg + (e.execution?.url ? '\\nExecution: ' + e.execution.url : '') } }];`));
  w.add(n.exec('Alert', 'sc.alert', { key: '={{ $json.key }}', subject: '={{ $json.subject }}', text: '={{ $json.text }}' }));
  w.chain('Error Trigger', 'Count failures', 'Alert');
  return w;
}

// ---------------- sc.alert ----------------
export function scAlert() {
  const w = new WF('sc.alert', { description: 'Input {key, subject, text}. One alert per key per 24 h, mailed through sc.mail.' });
  w.add(n.input([['key'], ['subject'], ['text']]));
  w.add(n.pg('Claim alert', `INSERT INTO alerts (key, last_sent_at) VALUES ($1, now())
ON CONFLICT (key) DO UPDATE SET last_sent_at = now()
  WHERE alerts.last_sent_at IS NULL OR alerts.last_sent_at < now() - interval '24 hours'
RETURNING key;`, ['$json.key']));
  w.add(n.iff('New today?', [['={{ $json.key }}', 'string:exists']]));
  w.add(n.code('Build mail', `// No node HTML-escapes text.
${ESC}
const i = $('Input').first().json;
return [{ json: { subject: 'ShortCircuit ALERT: ' + i.subject,
  html: page('ALERT: ' + i.subject, '<pre style="white-space:pre-wrap;font-family:inherit">' + esc(i.text) + '</pre><p style="color:#666">key: ' + esc(i.key) + '</p>') } }];`));
  w.add(n.exec('Mail', 'sc.mail', { subject: '={{ $json.subject }}', html: '={{ $json.html }}' }, { err: true }));
  w.add(n.pg('Unclaim on mail error', `UPDATE alerts SET last_sent_at = NULL WHERE key = $1;`, ["$('Input').first().json.key"]));
  w.add(n.stop('Mail failed', "={{ 'sc.alert could not mail ' + $('Input').first().json.key }}"));
  w.chain('Input', 'Claim alert', 'New today?', 'Build mail', 'Mail');
  w.c('Mail', 'Unclaim on mail error', 1).c('Unclaim on mail error', 'Mail failed');
  return w;
}

// ---------------- sc.mail ----------------
export function scMail() {
  const w = new WF('sc.mail', { description: 'The only plain Gmail Send node. Input {job_id} (sends that job\'s outbox) or {subject, html}. Recipient is always $env.OWNER_EMAIL (PLAN §1, §10.6).' });
  w.add(n.input([['job_id', 'number'], ['subject'], ['html']]));
  w.add(n.iff('Job mail?', [['={{ $json.job_id }}', 'number:exists']]));
  w.add(n.pg('Load outbox', `SELECT id AS job_id, outbox->>'subject' AS subject, outbox->>'html' AS html FROM jobs WHERE id = $1 AND outbox IS NOT NULL;`, ['$json.job_id']));
  w.add(n.iff('Outbox set?', [['={{ $json.subject }}', 'string:exists']]));
  w.add(n.code('Check and clean', `// No node validates a single address or strips control characters from a header.
const to = $env.OWNER_EMAIL ?? '';
if (!/^[^@,;\\s]+@[^@,;\\s.]+(\\.[^@,;\\s.]+)+$/.test(to)) throw new Error('OWNER_EMAIL is empty or not exactly one address; nothing sent');
const i = $input.first().json;
const subject = String(i.subject ?? '').replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/g, ' ').slice(0, 200).trim();
if (!subject || !i.html) throw new Error('sc.mail needs a subject and html');
return [{ json: { job_id: i.job_id ?? null, subject, html: String(i.html) } }];`));
  w.add(n.gmailSend('Send', '={{ $json.subject }}', '={{ $json.html }}'));
  w.add(n.stop('Send failed', "={{ 'Gmail send failed: ' + ($json.error?.message ?? $json.error ?? 'unknown') }}"));
  w.add(n.iff('Clear outbox?', [["={{ $('Check and clean').first().json.job_id }}", 'number:exists']]));
  w.add(n.pg('Clear outbox', `UPDATE jobs SET outbox = NULL, gmail_thread_id = $2, gmail_message_id = $3, updated_at = now() WHERE id = $1;`,
    ["$('Check and clean').first().json.job_id", '$json.threadId', '$json.id']));
  w.chain('Input', 'Job mail?');
  w.c('Job mail?', 'Load outbox', 0).c('Job mail?', 'Check and clean', 1);
  w.chain('Load outbox', 'Outbox set?', 'Check and clean', 'Send', 'Clear outbox?', 'Clear outbox');
  w.c('Send', 'Send failed', 1);
  return w;
}

// ---------------- sc.llm ----------------
const PROVIDERS = [['gemini', n.gemini, "={{ 'models/' + $json.model }}"], ['groq', n.groq, '={{ $json.model }}'], ['ollama', n.ollama, '={{ $json.model }}']];
export function scLlm() {
  const w = new WF('sc.llm', { description: 'The shared worker model call (PLAN §10.4). Input {agent, prompt, user_content, chain, exclude_provider?, temperature?}. Reads /prompts/<prompt>.md and .schema.json. Output {ok, provider, model, json}. Every provider failing → error.' });
  w.add(n.input([['agent'], ['prompt'], ['user_content'], ['chain'], ['exclude_provider'], ['temperature', 'number']]));
  w.add(n.pg('Render running?', `SELECT EXISTS (SELECT 1 FROM jobs WHERE render_started_at > now() - interval '20 minutes') AS rendering;`));
  w.add(n.readFile('Read prompt', "={{ '/prompts/' + $('Input').first().json.prompt + '.md' }}"));
  w.add(n.extractText('Prompt text'));
  w.add(n.readFile('Read schema', "={{ '/prompts/' + $('Input').first().json.prompt + '.schema.json' }}"));
  w.add(n.extractText('Schema text'));
  w.add(n.readFile('Read style', '/prompts/style.md'));
  w.add(n.extractText('Style text'));
  w.add(n.set('Entries', [
    ['entries', "={{ String($('Input').first().json.chain ?? '').split(',').map(s => s.trim()).filter(s => s) }}", 'array'],
    ['system_prompt', "={{ $('Prompt text').first().json.text.replace('<!-- include style.md -->', $json.text) }}"],
    ['schema', "={{ $('Schema text').first().json.text }}"],
    ['user_content', "={{ $('Input').first().json.user_content }}"],
    ['exclude', "={{ $('Input').first().json.exclude_provider ?? '' }}"],
    ['rendering', "={{ $('Render running?').first().json.rendering === true }}", 'boolean'],
    ['temperature', "={{ $('Input').first().json.temperature ?? 0.4 }}", 'number'],
  ]));
  w.add(n.splitOut('One per provider', 'entries'));
  w.nodes.at(-1).parameters.include = 'allOtherFields';
  w.nodes.at(-1).parameters.options = { destinationFieldName: 'entry' };
  w.add(n.set('Provider and model', [
    ['provider', "={{ $json.entry.split(':')[0] }}"],
    ['model', "={{ $json.entry.includes(':') ? $json.entry.slice($json.entry.indexOf(':') + 1) : $env[$json.entry.toUpperCase() + '_MODEL'] }}"],
  ], { keep: true }));
  w.add(n.filter('Drop excluded', [
    ['={{ $json.provider }}', 'string:notEquals', '={{ $json.exclude }}'],
    ["={{ $json.provider === 'ollama' && $json.rendering }}", 'boolean:false'],
    ["={{ ['gemini', 'groq', 'ollama'].includes($json.provider) }}", 'boolean:true'],
  ], { always: true }));
  w.add(n.loop('Next provider'));
  w.add(n.sw('Which provider', PROVIDERS.map(([p]) => [p, [['={{ $json.provider }}', 'string:equals', p]]]), { fallback: 'none' }));
  w.add(n.stop('No provider left', "={{ 'sc.llm: no provider left in chain \"' + $('Input').first().json.chain + '\" for ' + $('Input').first().json.agent + ' (excluded: ' + ($('Input').first().json.exclude_provider || 'none') + ', ollama skipped while rendering: ' + $('Render running?').first().json.rendering + ')' }}"));
  w.add(n.stop('All providers failed', "={{ 'sc.llm: every provider failed for ' + $('Input').first().json.agent + ': ' + $input.all().map(i => (i.json.provider ?? '?') + ' → ' + String(i.json.error?.message ?? i.json.error ?? 'error').slice(0, 300)).join(' | ') }}"));
  w.add(n.set('Result', [
    ['ok', '={{ true }}', 'boolean'],
    ['provider', "={{ $('Which provider').item.json.provider }}"],
    ['model', "={{ $('Which provider').item.json.model }}"],
    ['json', '={{ $json.output }}', 'object'],
  ]));
  w.add(n.set('Tag error', [
    ['provider', "={{ $('Which provider').item.json.provider }}"],
    ['error', '={{ $json.error?.message ?? $json.error ?? "error" }}'],
  ]));
  w.chain('Input', 'Render running?', 'Read prompt', 'Prompt text', 'Read schema', 'Schema text', 'Read style', 'Style text', 'Entries', 'One per provider', 'Provider and model', 'Drop excluded', 'Next provider');
  w.c('Next provider', 'All providers failed', 0).c('Next provider', 'Which provider', 1);
  PROVIDERS.forEach(([p, model, modelExpr], i) => {
    const C = `Chain ${p}`, M = `Model ${p}`, P = `Parser ${p}`;
    w.add(n.chain(C, '={{ $json.user_content }}', '={{ $json.system_prompt }}', { retry: { tries: 2, wait: 10000 } }));
    w.nodes.at(-1).parameters.text = '={{ $json.user_content }}';
    w.add(model(M, modelExpr, '={{ $json.temperature }}'));
    w.add(n.parser(P, '={{ $json.schema }}', { autoFix: true }));
    // A chain that catches its own error puts {error} on the success output: check for output.
    w.add(n.iff(`Output ${p}?`, [['={{ $json.output }}', 'object:exists']]));
    w.c('Which provider', C, i);
    w.sub(M, C, 'ai_languageModel'); w.sub(P, C, 'ai_outputParser'); w.sub(M, P, 'ai_languageModel');
    w.c(C, `Output ${p}?`, 0); w.c(C, 'Tag error', 1);
    w.c(`Output ${p}?`, 'Result', 0); w.c(`Output ${p}?`, 'Tag error', 1);
  });
  w.c('Which provider', 'No provider left', 3);
  w.c('Tag error', 'Next provider');
  return w;
}

// ---------------- sc.channel ----------------
export function scChannel() {
  const w = new WF('sc.channel', { description: 'Channel guard (PLAN §1, §10.6). Output {ok, channel_id} or {ok:false, reason}. Checks the YouTube credential is the channel of CHANNEL_HANDLE.' });
  w.add(n.input([['caller']]));
  w.add(n.code('Check handle', `// No node checks a value against a regex without changing it.
const h = $env.CHANNEL_HANDLE ?? '';
return [{ json: { handle: h, ok: /^@[A-Za-z0-9._-]{3,30}$/.test(h) } }];`));
  w.add(n.iff('Handle valid?', [['={{ $json.ok }}', 'boolean:true']]));
  w.add(n.exec('Alert bad handle', 'sc.alert', { key: 'bad_handle', subject: 'CHANNEL_HANDLE is not a valid handle', text: "={{ 'CHANNEL_HANDLE in .env is \"' + $json.handle + '\". It must be the handle exactly as the channel page shows it, @ included (3-30 of A-Z a-z 0-9 . _ -). Nothing is uploaded until it is fixed.' }}" }, { err: true }));
  w.add(n.set('Bad handle', [['ok', '={{ false }}', 'boolean'], ['reason', 'bad_handle']]));
  w.add(n.http('Handle channel', { url: 'https://www.googleapis.com/youtube/v3/channels', auth: 'yt', query: { part: 'id', forHandle: '={{ $json.handle }}' }, err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(n.http('Credential channel', { url: 'https://www.googleapis.com/youtube/v3/channels', auth: 'yt', query: { part: 'id', mine: 'true' }, err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(n.code('Compare', `// No node compares two API results and picks one of three outcomes.
const want = $('Handle channel').first().json.items?.[0]?.id ?? null;
const have = $('Credential channel').first().json.items?.[0]?.id ?? null;
const handle = $('Check handle').first().json.handle;
if (!want) return [{ json: { ok: false, reason: 'handle_not_found', alert: { key: 'handle_not_found', subject: 'No channel has the handle ' + handle,
  text: 'YouTube finds no channel for CHANNEL_HANDLE "' + handle + '" (exactly as written in .env). Fix the value in .env; nothing is uploaded until then.' } } }];
if (want !== have) return [{ json: { ok: false, reason: 'channel_mismatch', alert: { key: 'channel_mismatch', subject: 'YouTube credential is for another channel',
  text: 'The YouTube Channel credential is connected to channel ' + have + ', but ' + handle + ' is channel ' + want + '. Nothing was uploaded. Re-connect the credential to ' + handle + ' or fix CHANNEL_HANDLE.' } } }];
return [{ json: { ok: true, channel_id: want } }];`));
  w.add(n.iff('Match?', [['={{ $json.ok }}', 'boolean:true']]));
  w.add(n.exec('Alert mismatch', 'sc.alert', { key: '={{ $json.alert.key }}', subject: '={{ $json.alert.subject }}', text: '={{ $json.alert.text }}' }, { err: true }));
  w.add(n.set('Refused', [['ok', '={{ false }}', 'boolean'], ['reason', "={{ $('Compare').first().json.reason }}"]]));
  w.add(n.set('OK', [['ok', '={{ true }}', 'boolean'], ['channel_id', '={{ $json.channel_id }}']]));
  w.add(n.set('YouTube error', [['ok', '={{ false }}', 'boolean'], ['reason', 'youtube_error']]));
  w.chain('Input', 'Check handle', 'Handle valid?', 'Handle channel', 'Credential channel', 'Compare', 'Match?', 'OK');
  w.c('Handle valid?', 'Alert bad handle', 1).c('Alert bad handle', 'Bad handle').c('Alert bad handle', 'Bad handle', 1);
  w.c('Match?', 'Alert mismatch', 1).c('Alert mismatch', 'Refused').c('Alert mismatch', 'Refused', 1);
  w.c('Handle channel', 'YouTube error', 1).c('Credential channel', 'YouTube error', 1);
  return w;
}
