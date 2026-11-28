// sc.review, sc.cancel, sc.timeouts (PLAN §2, §10.6). M3.
import * as n from './lib.mjs';
import { ESC } from './js.mjs';
const { WF } = n;

const REVIEW_STATES = ['script_review', 'video_review', 'needs_human'];
export const ACTIVE = [...n.ACTIVE, 'triage'];
const list = (a) => a.map((s) => `'${s}'`).join(', ');
const DECISIONS = ['Approve', 'Approve with these changes', 'Revise and show me again', 'Reject'];

// ---------------- sc.review ----------------
export function scReview() {
  const w = new WF('sc.review', { saveSuccess: true, description: 'Input {job_id, kind: script|video|needs_human, reason?}. Sends the review form to OWNER_EMAIL and waits (12 h, 48 h for needs_human); then one guarded status change. Called with wait off (PLAN §10.6).' });
  w.add(n.input([['job_id'], ['kind'], ['reason']]));
  w.add(n.code('Kind', `// No node maps a review kind to its state and time limit.
const i = $input.first().json;
const state = { script: 'script_review', video: 'video_review', needs_human: 'needs_human' }[i.kind];
if (!state || !Number.isInteger(Number(i.job_id))) throw new Error('sc.review: bad input ' + JSON.stringify(i));
return [{ json: { job_id: Number(i.job_id), kind: i.kind, state, hours: i.kind === 'needs_human' ? 48 : 12, reason: String(i.reason ?? '') } }];`));
  // 2. take the review: only one open form per job, and only while it is in that state
  w.add(n.pg('Take review', `UPDATE jobs SET review_sent_at = now(), review_url = $2, review_deadline = now() + make_interval(hours => $3), updated_at = now()
WHERE id = $1 AND status = $4 AND review_sent_at IS NULL
RETURNING *, 'SC-' || lpad(id::text, 4, '0') AS job;`, ['$json.job_id', '$execution.resumeFormUrl', '$json.hours', '$json.state']));
  // 3. the mail body: every value escaped, links only from checked urls
  w.add(n.code('Build mail', `// No node HTML-escapes text or builds the review mail.
${ESC}
const j = $input.first().json; const k = $('Kind').first().json;
const s = j.script ?? {}; const b = j.brief ?? {}; const c = j.check_result ?? {};
const when = (t) => fmt(t);
let reason = k.reason;
if (k.kind === 'needs_human' && !reason) reason = j.round >= 3 ? '3 rounds used' : 'the Checker flagged: ' + [...(c.unsupported_claims ?? []), ...(c.policy_issues ?? []), ...(c.rules ?? [])].join('; ').slice(0, 300);
const subject = k.kind === 'script' ? '[' + j.job + '] Script — auto-approves ' + when(j.review_deadline)
  : k.kind === 'video' ? '[' + j.job + '] Video — publishes ' + when(j.slot_at) + ' — auto-approves ' + when(j.review_deadline)
  : '[' + j.job + '] NEEDS YOU: ' + reason;
const li = (arr) => '<ul>' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
let body = '<p><b>' + esc(s.title) + '</b></p><p><i>' + esc(s.hook) + '</i></p>';
body += '<ol>' + (s.scenes ?? []).map((x) => '<li>' + esc(x.narration) + '</li>').join('') + '</ol>';
body += '<p>' + esc(s.description) + '</p><p style="color:#666">Tags: ' + esc((s.tags ?? []).join(', ')) + '</p>';
if (s.editor_notes) body += '<p><b>Editor:</b> ' + esc(s.editor_notes) + '</p>';
const flags = [...(c.unsupported_claims ?? []), ...(c.policy_issues ?? []), ...(c.rules ?? [])];
body += '<p><b>Fact check:</b> ' + (c.pass ? 'clean' : 'flagged') + '</p>' + (flags.length ? li(flags) : '');
body += '<p><b>Sources</b></p><ul>' + (b.sources ?? []).map((x) => okUrl(x.url) ? '<li><a href="' + esc(okUrl(x.url)) + '">' + esc(x.title || x.url) + '</a> (' + esc(x.publisher) + ')</li>' : '').join('') + '</ul>';
if (k.kind === 'video') body = button(j.drive_link, 'Watch on Drive') + '<p>Publishes ' + esc(when(j.slot_at)) + '.</p>' + body + cancelLink(j.id);
if (k.kind === 'needs_human') body = '<p><b>Why:</b> ' + esc(reason) + '</p><p>No answer by ' + esc(when(j.review_deadline)) + ' drops this job. Only Approve renders it.</p>' + body;
else body = '<p>Silence approves at ' + esc(when(j.review_deadline)) + '. Open the form only to change or stop it.</p>' + body;
return [{ json: { subject: subject.replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]/g, ' ').slice(0, 200), html: page(j.job + ' · ' + (s.title ?? ''), body), deadline: j.review_deadline, job_id: j.id, job: j.job } }];`));
  // 4. send and wait
  w.add(n.gmailSendAndWait('Ask owner', '={{ $json.subject }}', '={{ $json.html }}', [
    { fieldLabel: 'Decision', fieldType: 'dropdown', requiredField: true, fieldOptions: { values: DECISIONS.map((option) => ({ option })) } },
    { fieldLabel: 'Notes', fieldType: 'textarea', placeholder: 'What to change (needed for the two change choices)' },
  ], '={{ $json.deadline }}', { button: 'Review', title: '={{ $json.job }} review' }));
  w.add(n.pg('Release review', `UPDATE jobs SET review_sent_at = NULL, review_url = NULL, updated_at = now() WHERE id = $1 AND review_url = $2;`,
    ["$('Kind').first().json.job_id", '$execution.resumeFormUrl']));
  w.add(n.stop('Mail failed', "={{ 'sc.review could not send the form: ' + ($json.error?.message ?? $json.error ?? 'unknown') }}"));
  // 5. on resume: no form data = time limit reached
  w.add(n.code('Decision', `// No node maps a form answer (or a time-out) to a decision code.
// On a time-out Send and Wait passes its input through (no data); a send error must never read as silence.
if ($input.first().json.error) throw new Error('sc.review: the form mail failed, nothing applied: ' + $input.first().json.error);
const d = $input.first().json.data;
const map = ${JSON.stringify(Object.fromEntries(DECISIONS.map((x, i) => [x, ['approve', 'approve_changes', 'revise', 'reject'][i]])))};
const decision = d && map[d.Decision] ? map[d.Decision] : 'timeout';
return [{ json: { decision, notes: String(d?.Notes ?? '').trim().slice(0, 4000) } }];`));
  w.add(n.iff('Has notes?', [['={{ $json.notes }}', 'string:notEmpty']]));
  // 6. Guardrails: strip personal data before any model sees the notes
  w.add(n.guardrailPii('Remove personal data', '={{ $json.notes }}'));
  w.add(n.code('Clean notes', `// Sanitize drops failed items: refuse to go on without the cleaned text.
const t = $input.first().json.guardrailsInput;
if (typeof t !== 'string') throw new Error('Guardrails could not sanitize the owner notes');
return [{ json: { decision: $('Decision').first().json.decision, notes: t } }];`));
  w.add(n.iff('Empty change request?', [["={{ ['approve_changes', 'revise'].includes($json.decision) && !$json.notes }}", 'boolean:true']]));
  // 7. nothing to apply: a fresh form with a full window (a new execution, so a new form url)
  w.add(n.pg('Reopen', `UPDATE jobs SET review_sent_at = NULL, review_url = NULL, updated_at = now() WHERE id = $1 AND review_url = $2 RETURNING id;`,
    ["$('Kind').first().json.job_id", '$execution.resumeFormUrl']));
  w.add(n.startReview('New form', "$('Kind').first().json.job_id", "$('Kind').first().json.kind", "$('Kind').first().json.reason"));
  // 8. one statement: audit row + guarded transition; only the newest form counts
  w.add(n.pg('Apply', `WITH j AS (
  SELECT id, status FROM jobs WHERE id = $1 AND review_url = $2 FOR UPDATE),
d AS (
  SELECT j.id, CASE
    WHEN j.status = 'script_review' AND $4 IN ('approve', 'approve_changes', 'timeout') THEN 'script_approved'
    WHEN j.status = 'needs_human' AND $4 IN ('approve', 'approve_changes') THEN 'script_approved'
    WHEN j.status IN ('script_review', 'needs_human') AND $4 = 'revise' THEN 'revising'
    WHEN j.status = 'video_review' AND $4 IN ('approve', 'timeout') THEN 'approved'
    WHEN j.status = 'video_review' AND $4 IN ('approve_changes', 'revise') THEN 'video_editing'
    WHEN j.status IN ('script_review', 'needs_human', 'video_review') AND $4 = 'reject' THEN 'rejected'
    WHEN j.status = 'needs_human' AND $4 = 'timeout' THEN 'rejected'
  END AS next FROM j),
ins AS (
  INSERT INTO reviews (execution_id, job_id, kind, decision, notes)
  VALUES ($3, $1, $5, $4, NULLIF($6, '')) ON CONFLICT DO NOTHING RETURNING 1),
upd AS (
  UPDATE jobs SET status = d.next,
    notes = CASE WHEN $4 IN ('approve_changes', 'revise') THEN NULLIF($6, '') ELSE jobs.notes END,
    edit_then = CASE WHEN d.next = 'video_editing' THEN CASE WHEN $4 = 'approve_changes' THEN 'approve' ELSE 'review' END ELSE jobs.edit_then END,
    slot_at = CASE WHEN d.next = 'rejected' THEN NULL ELSE jobs.slot_at END,
    slot_date = CASE WHEN d.next = 'rejected' THEN NULL ELSE jobs.slot_date END,
    review_url = NULL, review_deadline = NULL, updated_at = now()
  FROM d WHERE jobs.id = d.id AND d.next IS NOT NULL AND EXISTS (SELECT 1 FROM ins)
  RETURNING jobs.id, jobs.status)
SELECT (SELECT count(*) FROM upd)::int AS applied,
  coalesce((SELECT status FROM upd), (SELECT status FROM jobs WHERE id = $1)) AS status_now,
  (SELECT review_url IS NOT NULL FROM jobs WHERE id = $1) AS newer_form,
  'SC-' || lpad($1::text, 4, '0') AS job;`,
  ["$('Kind').first().json.job_id", '$execution.resumeFormUrl', '$execution.id', '$json.decision', "$('Kind').first().json.kind", '$json.notes'], { tx: true }));
  // 9. an owner answer that changed nothing gets a short note
  w.add(n.iff('Not applied?', [['={{ $json.applied === 0 && $("Empty change request?").first().json.decision !== "timeout" }}', 'boolean:true']]));
  w.add(n.code('Not applied mail', `// No node HTML-escapes text.
${ESC}
const r = $input.first().json;
const why = r.newer_form ? 'This form was replaced by a newer one; use the newest mail.' : r.job + ' is now ' + r.status_now + '; your answer was not applied.';
return [{ json: { subject: '[' + r.job + '] Not applied', html: page(r.job + ' · not applied', '<p>' + esc(why) + '</p>') } }];`));
  w.add(n.exec('Send note', 'sc.mail', { subject: '={{ $json.subject }}', html: '={{ $json.html }}' }, { err: true }));

  w.chain('Input', 'Kind', 'Take review', 'Build mail', 'Ask owner', 'Decision', 'Has notes?');
  w.c('Ask owner', 'Release review', 1).c('Release review', 'Mail failed');
  w.c('Has notes?', 'Remove personal data', 0).c('Remove personal data', 'Clean notes').c('Clean notes', 'Empty change request?');
  w.c('Has notes?', 'Empty change request?', 1);
  w.c('Empty change request?', 'Reopen', 0).c('Reopen', 'New form');
  w.c('Empty change request?', 'Apply', 1).chain('Apply', 'Not applied?', 'Not applied mail', 'Send note');
  w.guard('Take review');
  w.guard('Reopen');
  return w;
}

// ---------------- sc.cancel ----------------
export function scCancel() {
  const w = new WF('sc.cancel', { saveSuccess: true, description: 'Form (Basic Auth, /form/sc-cancel?Job=SC-0042): pulls a job at any point. Frees its slot; sc.publish deletes an uploaded video (PLAN §8, §10.6).' });
  w.add(n.formTrigger('Cancel form', {
    title: 'Cancel a ShortCircuit video', description: 'This drops the job and frees its slot. In manual mode, also delete it in YouTube Studio if you already scheduled it.', path: 'sc-cancel', button: 'Cancel it',
    fields: [
      { fieldLabel: 'Job', fieldType: 'text', requiredField: true, placeholder: 'SC-0042' },
      { fieldLabel: 'Confirm', fieldType: 'checkbox', requiredField: true, fieldOptions: { values: [{ option: 'Yes, cancel this job' }] } },
    ],
  }));
  w.add(n.code('Job id', `// No node checks a form value against a pattern.
const raw = String($input.first().json.Job ?? '').trim();
const m = /^SC-([0-9]{4,})$/.exec(raw);
return [{ json: { ok: !!m, id: m ? Number(m[1]) : null, job: raw.slice(0, 20) } }];`));
  w.add(n.iff('Valid?', [['={{ $json.ok }}', 'boolean:true']]));
  w.add(n.pg('Cancel', `WITH u AS (
  UPDATE jobs SET status = 'cancelled', slot_at = NULL, slot_date = NULL, review_url = NULL, updated_at = now()
  WHERE id = $1 AND status IN (${list(ACTIVE)}) RETURNING id),
ins AS (
  INSERT INTO reviews (execution_id, job_id, kind, decision)
  SELECT $2, $1, 'cancel', 'cancel' WHERE EXISTS (SELECT 1 FROM u) ON CONFLICT DO NOTHING)
SELECT (SELECT count(*) FROM u)::int AS cancelled, (SELECT status FROM jobs WHERE id = $1) AS status;`, ['$json.id', '$execution.id'], { tx: true }));
  w.add(n.formEnd('Done', "={{ $json.cancelled ? $('Job id').first().json.job + ' cancelled' : 'Nothing changed' }}",
    "={{ $json.cancelled ? 'The job is dropped and its day is free again.' : $('Job id').first().json.job + ' is ' + ($json.status ?? 'not a known job') + '; nothing changed.' }}"));
  w.add(n.formEnd('Bad id', 'Not a job id', '={{ "Write the job id as shown in the mail subject, e.g. SC-0042." }}'));
  w.chain('Cancel form', 'Job id', 'Valid?', 'Cancel', 'Done');
  w.c('Valid?', 'Bad id', 1);
  return w;
}

// ---------------- sc.timeouts ----------------
export function scTimeouts() {
  const w = new WF('sc.timeouts', { timer: true, description: 'Every 15 min: re-sends lost outbox mails, restarts reviews that never started, moves 3-times-failed jobs to triage (or failed), fails triage after 6 h, clears stale locks. Never approves or drops a reviewed job (PLAN §10.6).' });
  w.add(n.every('Every 15 min', 15));
  const branch = (name, sql, next) => { w.add(n.pg(name, sql)); w.c('Every 15 min', name); if (next) { w.add(next); w.c(name, next.name); } };
  branch('Lost outbox', `SELECT id FROM jobs WHERE outbox IS NOT NULL AND locked_at IS NULL AND updated_at < now() - interval '10 minutes';`,
    n.sendJobMail('Resend', '$json.id', { each: true }));
  branch('Expired forms', `UPDATE jobs SET review_sent_at = NULL, review_url = NULL
WHERE status IN (${list(REVIEW_STATES)}) AND review_deadline < now() - interval '1 hour' AND review_url IS NOT NULL RETURNING id;`);
  branch('Reviews not started', `SELECT id, CASE status WHEN 'script_review' THEN 'script' WHEN 'video_review' THEN 'video' ELSE 'needs_human' END AS kind FROM jobs
WHERE status IN (${list(REVIEW_STATES)}) AND review_sent_at IS NULL AND locked_at IS NULL AND updated_at < now() - interval '10 minutes';`,
    n.startReview('Restart review', '$json.id', '$json.kind', "''", { each: true }));
  // A worker increments attempts at claim, so only unlocked rows have really failed 3 times.
  branch('To triage', `UPDATE jobs SET status = CASE WHEN master_rounds >= 2 THEN 'failed' ELSE 'triage' END,
  triage_from = status, triage_at = now(), attempts = 0, locked_at = NULL,
  slot_at = CASE WHEN master_rounds >= 2 THEN NULL ELSE slot_at END,
  slot_date = CASE WHEN master_rounds >= 2 THEN NULL ELSE slot_date END, updated_at = now()
WHERE attempts >= 3 AND status IN (${list(n.ACTIVE)}) AND (locked_at IS NULL OR locked_at < now() - interval '90 minutes')
RETURNING id, status, triage_from, last_error, 'SC-' || lpad(id::text, 4, '0') AS job;`);
  w.add(n.filter('Failed now', [['={{ $json.status }}', 'string:equals', 'failed']]));
  w.c('To triage', 'Failed now');
  branch('Triage expired', `UPDATE jobs SET status = 'failed', slot_at = NULL, slot_date = NULL, locked_at = NULL, updated_at = now()
WHERE status = 'triage' AND triage_at < now() - interval '6 hours' AND (locked_at IS NULL OR locked_at < now() - interval '90 minutes')
RETURNING id, status, triage_from, last_error, 'SC-' || lpad(id::text, 4, '0') AS job;`);
  w.add(n.alert('Alert failed', "'job_failed:' + $json.job", "$json.job + ' failed in ' + $json.triage_from",
    "$json.job + ' failed 3 times in ' + $json.triage_from + ' and the Master could not fix it (or is down). Last error: ' + ($json.last_error ?? 'none') + '. Its slot is free again.'", { each: true }));
  w.c('Failed now', 'Alert failed').c('Triage expired', 'Alert failed');
  branch('Stale render flag', `UPDATE jobs SET render_started_at = NULL WHERE render_started_at < now() - interval '20 minutes' RETURNING id;`);
  branch('Stale locks', `UPDATE jobs SET locked_at = NULL WHERE locked_at < now() - interval '90 minutes' RETURNING id;`);
  w.guard('Lost outbox');
  w.guard('Reviews not started');
  w.guard('Triage expired');
  return w;
}
