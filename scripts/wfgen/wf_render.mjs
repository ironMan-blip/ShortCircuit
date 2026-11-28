// sc.render (PLAN §5, §6, §10.6). M5.
import * as n from './lib.mjs';
import { ESC } from './js.mjs';
import { writeAndCheck } from './wf_create.mjs';
const { WF } = n;

// Code-enforced plan rules (PLAN §4.5): narration is the checked script's, screenshots only of
// the checked primary_url, music_mood from the renderer's own list.
const PLAN_CHECK = (planExpr, scriptExpr) => `// No node rewrites a model's plan against the checked script.
const plan = ${planExpr} ?? {};
const script = ${scriptExpr};
const primary = $('Claim').first().json.brief?.primary_url ?? null;
const moods = $('Renderer').first().json.moods ?? [];
const warnings = [];
const byId = new Map((plan.scenes ?? []).map((s) => [s.id, s]));
const scenes = (script.scenes ?? []).map((s, i) => {
  const p = byId.get(s.id) ?? plan.scenes?.[i] ?? {};
  let v = p.visual ?? { type: 'card', text: '' };
  if (v.type === 'screenshot' && (!primary || v.url !== primary)) { warnings.push('scene ' + s.id + ': screenshot of ' + v.url + ' replaced by a card'); v = { type: 'card', text: p.on_screen_text || s.narration.split(/\\s+/).slice(0, 6).join(' ') }; }
  if (!['stock', 'card', 'screenshot'].includes(v.type)) v = { type: 'card', text: p.on_screen_text ?? '' };
  return { id: s.id, narration: s.narration, visual: { type: v.type, query: String(v.query ?? '').slice(0, 200), text: String(v.text ?? '').slice(0, 300), url: v.type === 'screenshot' ? primary : '' }, on_screen_text: String(p.on_screen_text ?? '').slice(0, 120) };
});
let mood = plan.music_mood;
if (!moods.includes(mood)) { if (!moods.length) throw new Error('the renderer lists no music moods: add folders to assets/music/'); warnings.push('music_mood ' + mood + ' is not a folder; using ' + moods[0]); mood = moods[0]; }
const speed = Math.min(1.3, Math.max(0.8, Number(plan.speed) || 1.05));
return [{ json: { plan: { voice: String(plan.voice ?? 'af_heart'), speed, music_mood: mood, scenes }, script, plan_warnings: warnings } }];`;

export function scRender() {
  const w = new WF('sc.render', { timer: true, description: 'Claims script_approved / video_editing (one render at a time): Editor+Checker on notes, Director or Cutter, render, Master video review (→ one redo), Drive upload/update, slot, → video_review / approved (PLAN §10.6).' });
  w.add(n.every('Every 2 min', 2));
  w.add(n.pg('Claim', n.CLAIM_SQL(['script_approved', 'video_editing'], `
              AND NOT EXISTS (SELECT 1 FROM jobs r WHERE r.status IN ('script_approved', 'video_editing')
                              AND r.locked_at > now() - interval '90 minutes')`)));
  w.add(n.failNode());
  w.add(n.http('Renderer', { url: 'http://renderer:8000/health', err: true, retry: { tries: 3, wait: 10000 }, timeout: 10000 }));
  w.chain('Every 2 min', 'Claim', 'Renderer');
  w.c('Renderer', 'Fail', 1);
  const C = "$('Claim').first().json";
  w.add(n.sw('Route', [
    ['owner notes', [[`={{ ${C}.status === 'script_approved' && !!${C}.notes }}`, 'boolean:true']]],
    ['first render', [[`={{ ${C}.status === 'script_approved' && !${C}.notes }}`, 'boolean:true']]],
    ['video edit', [[`={{ ${C}.status === 'video_editing' }}`, 'boolean:true']]],
  ]));
  w.c('Renderer', 'Route');

  const BRIEF = `${C}.brief`;
  const editorUser = (notesExpr) => `'<script>' + JSON.stringify(${C}.script) + '</script>\\n<owner_notes>' + String(${notesExpr} ?? '') + '</owner_notes>\\n<brief>' + JSON.stringify({ ...${BRIEF}, source_texts: undefined }) + '</brief>'`;
  // 2. script notes → Editor → Checker
  const [e1, v1] = writeAndCheck(w, ' notes', { agent: 'editor', briefExpr: BRIEF, writerUser: editorUser(`${C}.notes`) });
  w.c('Route', e1, 0);
  w.add(n.iff('Notes clean?', [['={{ $json.pass }}', 'boolean:true']]));
  w.c(v1, 'Notes clean?');
  // 3. video notes → Cutter (narration changes go to Editor + Checker first)
  w.add(n.llm('Cutter', 'cutter', `'<plan>' + JSON.stringify(${C}.plan) + '</plan>\\n<owner_notes>' + String(${C}.notes ?? '') + '</owner_notes>\\n<primary_url>' + (${BRIEF}?.primary_url ?? 'none') + '</primary_url>'`));
  w.c('Route', 'Cutter', 2).c('Cutter', 'Fail', 1);
  w.add(n.iff('Narration change?', [['={{ $json.json.narration_change }}', 'string:notEmpty']]));
  w.c('Cutter', 'Narration change?');
  const [e2, v2] = writeAndCheck(w, ' video', { agent: 'editor', briefExpr: BRIEF, writerUser: editorUser("$('Cutter').first().json.json.narration_change") });
  w.c('Narration change?', e2, 0);
  w.add(n.iff('Narration clean?', [['={{ $json.pass }}', 'boolean:true']]));
  w.c(v2, 'Narration clean?');

  // flagged edit → needs_human (keeps its slot and Drive file)
  w.add(n.pg('Finish flagged', `UPDATE jobs SET status = 'needs_human', script = $2::jsonb, check_result = $3::jsonb, providers = providers || $4::jsonb,
  notes = NULL, edit_then = NULL, review_sent_at = NULL, review_url = NULL, attempts = 0, locked_at = NULL, last_error = NULL, updated_at = now()
WHERE id = $1 AND status = $5 RETURNING id, $6::text AS reason;`,
  [`${C}.id`, n.J('$json.script'), n.J('$json.check'), n.J('{ editor: $json.writer_provider, checker: $json.checker_provider }'), `${C}.status`,
    "'the Checker flagged the edit: ' + $json.flags.join('; ').slice(0, 280)"], { err: true }));
  w.c('Notes clean?', 'Finish flagged', 1).c('Narration clean?', 'Finish flagged', 1).c('Finish flagged', 'Fail', 1);
  w.add(n.startReview('Review flagged', '$json.id', "'needs_human'", '$json.reason'));
  w.c('Finish flagged', 'Review flagged');

  // the script the Director works from (one node, so later nodes can name it)
  const scriptSet = (name, scriptExpr, providersExpr) => { w.add(n.set(name, [['script', `={{ ${scriptExpr} }}`, 'object'], ['providers', `={{ ${providersExpr} }}`, 'object']])); w.c(name, 'Director input'); };
  w.add(n.noop('Director input'));
  scriptSet('Script edited', '$json.script', '{ editor: $json.writer_provider, checker: $json.checker_provider }');
  scriptSet('Script as approved', `${C}.script`, '{}');
  scriptSet('Script narration edited', '$json.script', '{ editor: $json.writer_provider, checker: $json.checker_provider }');
  w.c('Notes clean?', 'Script edited', 0).c('Route', 'Script as approved', 1).c('Narration clean?', 'Script narration edited', 0);
  w.add(n.llm('Director', 'director', `'<script>' + JSON.stringify($json.script) + '</script>\\n<primary_url>' + (${BRIEF}?.primary_url ?? 'none') + '</primary_url>\\n<music_moods>' + JSON.stringify($('Renderer').first().json.moods) + '</music_moods>'`, { temp: 0.5 }));
  w.c('Director input', 'Director').c('Director', 'Fail', 1);
  w.add(n.code('Plan check', PLAN_CHECK("$input.first().json.json", "$('Director input').first().json.script")));
  w.add(n.code('Plan check cut', PLAN_CHECK("$('Cutter').first().json.json", `${C}.script`)));
  w.c('Director', 'Plan check').c('Narration change?', 'Plan check cut', 1);
  w.add(n.set('Plan ready', [
    ['plan', '={{ $json.plan }}', 'object'], ['script', '={{ $json.script }}', 'object'], ['plan_warnings', '={{ $json.plan_warnings }}', 'array'],
    ['providers', `={{ { ...($('Director input').isExecuted ? $('Director input').first().json.providers : {}), ...($('Director').isExecuted ? { director: $('Director').first().json.provider } : {}), ...($('Cutter').isExecuted ? { cutter: $('Cutter').first().json.provider } : {}) } }}`, 'object'],
  ]));
  w.c('Plan check', 'Plan ready').c('Plan check cut', 'Plan ready');

  // 3a–4. render block: flag the render (sc.llm skips Ollama), unload Ollama, render, clear the flag
  const renderBlock = (s, from) => {
    w.add(n.pg(`Render flag${s}`, `UPDATE jobs SET render_started_at = now() WHERE id = $1;`, [`${C}.id`], { err: true }));
    w.add(n.http(`Unload Ollama${s}`, { method: 'POST', url: 'http://host.docker.internal:11434/api/generate', json: '={{ JSON.stringify({ model: $env.OLLAMA_MODEL, keep_alive: 0 }) }}', soft: true, timeout: 30000 }));
    w.add(n.http(`Render${s}`, { method: 'POST', url: 'http://renderer:8000/render', json: `={{ JSON.stringify({ job_id: ${C}.job, plan: $('${from}').first().json.plan }) }}`, timeout: 900000, err: true }));
    w.add(n.pg(`Render done${s}`, `UPDATE jobs SET render_started_at = NULL WHERE id = $1;`, [`${C}.id`]));
    w.chain(from, `Render flag${s}`, `Unload Ollama${s}`, `Render${s}`, `Render done${s}`);
    w.c(`Render flag${s}`, 'Fail', 1).c(`Render${s}`, 'Fail', 1);
    return `Render${s}`;
  };
  renderBlock('', 'Plan ready');
  // 4a. Master video review, with the contact sheet as an image
  w.add(n.iff('Master rounds left?', [[`={{ ${C}.master_rounds }}`, 'number:lt', 2]]));
  w.c('Render done', 'Master rounds left?');
  w.add(n.askMaster('Master review', 'review_video', `${C}.id`,
    `JSON.stringify({ script: $('Plan ready').first().json.script, plan: $('Plan ready').first().json.plan, plan_warnings: $('Plan ready').first().json.plan_warnings, render: (({ transcript, contact_sheet, path, ...r }) => r)($('Render').first().json), transcript: $('Render').first().json.transcript })`,
    { image: "$('Render').first().json.contact_sheet" }));
  w.c('Master rounds left?', 'Master review', 0);
  w.add(n.iff('Redo?', [['={{ $json.ok === true && $json.json?.verdict === "redo" }}', 'boolean:true']]));
  w.c('Master review', 'Redo?').c('Master review', 'Redo?', 1);
  w.add(n.llm('Cutter redo', 'cutter', `'<plan>' + JSON.stringify($('Plan ready').first().json.plan) + '</plan>\\n<feedback>' + String($('Master review').first().json.json.feedback ?? '') + '</feedback>\\n<primary_url>' + (${BRIEF}?.primary_url ?? 'none') + '</primary_url>'`));
  w.c('Redo?', 'Cutter redo', 0).c('Cutter redo', 'Fail', 1);
  w.add(n.code('Plan check redo', PLAN_CHECK("$input.first().json.json", "$('Plan ready').first().json.script")));
  w.c('Cutter redo', 'Plan check redo');
  renderBlock(' 2', 'Plan check redo');

  // one node for the final render, whichever path made it
  w.add(n.set('Final render', [
    ['render', `={{ $('Render 2').isExecuted ? $('Render 2').first().json : $('Render').first().json }}`, 'object'],
    ['plan', `={{ $('Render 2').isExecuted ? $('Plan check redo').first().json.plan : $('Plan ready').first().json.plan }}`, 'object'],
    ['master_inc', `={{ $('Render 2').isExecuted ? 1 : 0 }}`, 'number'],
  ]));
  w.c('Master rounds left?', 'Final render', 1).c('Redo?', 'Final render', 1).c('Render done 2', 'Final render');

  // 5–7. Drive: upload once, then update the same file; delete the local copy
  w.add(n.pg('Drive folder', `SELECT value AS folder_id FROM config_seen WHERE key = 'drive_ready';`, [], { err: true }));
  w.add(n.iff('Folder known?', [['={{ $json.folder_id }}', 'string:notEmpty']]));
  w.add(n.stop('No folder', '={{ "Drive folder ShortCircuit/ready is not known yet: run sc.config once" }}'));
  w.add(n.readFile('Video file', "={{ $('Final render').first().json.render.path }}", { err: true }));
  w.add(n.iff('First upload?', [[`={{ ${C}.drive_file_id }}`, 'string:empty']]));
  w.add(n.driveUpload('Upload', `={{ ${C}.job + '.mp4' }}`, "={{ $('Drive folder').first().json.folder_id }}"));
  w.add(n.driveUpdate('Update file', `={{ ${C}.drive_file_id }}`));
  w.add(n.set('Drive done', [['drive_file_id', '={{ $json.id }}'], ['drive_link', "={{ 'https://drive.google.com/file/d/' + $json.id + '/view' }}"]]));
  w.add(n.http('Delete local', { method: 'DELETE', url: `={{ 'http://renderer:8000/jobs/' + ${C}.job }}`, soft: true, timeout: 30000 }));
  w.chain('Final render', 'Drive folder', 'Folder known?', 'Video file', 'First upload?', 'Upload', 'Drive done', 'Delete local');
  w.c('Folder known?', 'No folder', 1).c('Drive folder', 'Fail', 1).c('Video file', 'Fail', 1);
  w.c('First upload?', 'Update file', 1).c('Update file', 'Drive done').c('Upload', 'Fail', 1).c('Update file', 'Fail', 1);
  // 8. slot: earliest free day whose publish time is ≥ 48 h away; never for a cancelled job
  w.add(n.pg('Assign slot', `WITH cand AS (
  SELECT d::date AS day, ((d::date + coalesce(s.publish_time, $2::time)) AT TIME ZONE $3) AS at
  FROM generate_series((now() AT TIME ZONE $3)::date, (now() AT TIME ZONE $3)::date + 90, interval '1 day') d
  LEFT JOIN schedule s ON s.dow = extract(dow FROM d)::int),
pick AS (
  SELECT * FROM cand WHERE at >= now() + interval '48 hours'
    AND day NOT IN (SELECT slot_date FROM jobs WHERE slot_date IS NOT NULL) ORDER BY day LIMIT 1)
UPDATE jobs SET slot_date = pick.day, slot_at = pick.at FROM pick
WHERE jobs.id = $1 AND jobs.slot_date IS NULL AND jobs.status IN ('script_approved', 'video_editing')
RETURNING jobs.slot_at;`, [`${C}.id`, "$env.PUBLISH_TIME ?? '18:00'", '$env.TZ'], { always: true, err: true }));
  w.nodes.at(-1).retryOnFail = true; w.nodes.at(-1).maxTries = 3; w.nodes.at(-1).waitBetweenTries = 2000; // UNIQUE race → try again
  w.c('Delete local', 'Assign slot').c('Assign slot', 'Fail', 1);
  // 9. finish; an "Approve with these changes" re-render goes straight to approved with the Updated video mail
  w.add(n.code('Outbox', `// No node HTML-escapes text or builds the Updated video mail.
${ESC}
const j = $('Claim').first().json; const d = $('Drive done').first().json;
const slot = $input.first().json.slot_at ?? j.slot_at;
const approve = j.status === 'video_editing' && j.edit_then === 'approve';
const s = $('Plan ready').first().json.script;
const outbox = approve ? { subject: '[' + j.job + '] Updated video — publishes ' + fmt(slot), html: page(j.job + ' · updated video',
  '<p>Your changes are in. ' + esc(s.title) + ' publishes ' + esc(fmt(slot)) + '; nothing else is needed.</p>' + button(d.drive_link, 'Watch on Drive') + cancelLink(j.id)) } : null;
return [{ json: { status: approve ? 'approved' : 'video_review', outbox } }];`));
  w.add(n.pg('Finish', `UPDATE jobs SET status = $2, plan = $3::jsonb, script = $4::jsonb, drive_file_id = $5, drive_link = $6,
  providers = providers || $7::jsonb, master_rounds = master_rounds + $8, outbox = $9::jsonb,
  notes = NULL, edit_then = NULL, review_sent_at = NULL, review_url = NULL, attempts = 0, locked_at = NULL, last_error = NULL, render_started_at = NULL, updated_at = now()
WHERE id = $1 AND status = $10 RETURNING id, status;`,
  [`${C}.id`, '$json.status', n.J("$('Final render').first().json.plan"), n.J("$('Plan ready').first().json.script"), "$('Drive done').first().json.drive_file_id",
    "$('Drive done').first().json.drive_link", n.J("$('Plan ready').first().json.providers"), "$('Final render').first().json.master_inc",
    '$json.outbox ? JSON.stringify($json.outbox) : null', `${C}.status`], { err: true }));
  w.chain('Assign slot', 'Outbox', 'Finish');
  w.c('Finish', 'Fail', 1);
  // 10.
  w.add(n.iff('Video review?', [['={{ $json.status }}', 'string:equals', 'video_review']]));
  w.add(n.startReview('Start review', '$json.id', "'video'"));
  w.add(n.sendJobMail('Send updated mail', '$json.id'));
  w.chain('Finish', 'Video review?', 'Start review');
  w.c('Video review?', 'Send updated mail', 1);
  w.guard('Claim');
  w.guard('Finish flagged');
  w.guard('Finish');
  return w;
}
