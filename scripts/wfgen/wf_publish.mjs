// sc.publish, sc.livecheck, sc.housekeeping, sc.config (PLAN §1, §7, §8, §10.6). M6.
import * as n from './lib.mjs';
import { ESC, META } from './js.mjs';
const { WF } = n;
const YT = 'https://www.googleapis.com/youtube/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const ENDED = ['done', 'failed', 'cancelled', 'rejected'];
const list = (a) => a.map((s) => `'${s}'`).join(', ');

// ---------------- sc.publish ----------------
export function scPublish() {
  const w = new WF('sc.publish', { timer: true, description: 'Every 15 min. auto: claims approved → sc.channel → Drive download → YouTube upload (private + publishAt, or public when late) → scheduled; deletes the upload of a cancelled/rejected job. manual: mails the upload pack → awaiting_upload (PLAN §8, §10.6). The only workflow with YouTube writes.' });
  w.add(n.every('Every 15 min', 15));
  w.add(n.iff('Auto mode?', [['={{ $env.PUBLISH_MODE }}', 'string:equals', 'auto']]));
  w.c('Every 15 min', 'Auto mode?');

  // ---- auto: upload one approved job
  w.add(n.pg('Claim', n.CLAIM_SQL(['approved'])));
  w.add(n.failNode());
  w.c('Auto mode?', 'Claim', 0);
  const C = "$('Claim').first().json";
  w.add(n.iff('Already uploaded?', [[`={{ ${C}.youtube_id }}`, 'string:notEmpty']]));
  w.c('Claim', 'Already uploaded?');
  w.add(n.exec('Channel', 'sc.channel', { caller: 'sc.publish' }, { err: true }));
  w.add(n.iff('Channel ok?', [['={{ $json.ok }}', 'boolean:true']]));
  w.add(n.code('Channel refused', `// sc.channel has alerted; the job stays approved for the next run.
throw new Error('sc.channel refused: ' + $input.first().json.reason);`, { err: true }));
  w.c('Already uploaded?', 'Channel', 1).chain('Channel', 'Channel ok?').c('Channel', 'Fail', 1);
  w.c('Channel ok?', 'Channel refused', 1).c('Channel refused', 'Fail', 1);
  w.add(n.driveDownload('Download', `={{ ${C}.drive_file_id }}`));
  w.add(n.code('Metadata', `// No node builds the upload metadata from a checked script.
${ESC}
${META}
const j = $('Claim').first().json;
const late = new Date(j.slot_at).getTime() < Date.now() + 15 * 60e3;
return [{ json: { title: String(j.script?.title ?? j.job).slice(0, 100), description: desc(j.script ?? {}, j.brief ?? {}).slice(0, 4900), tags: tags(j.script ?? {}, j.id).join(','),
  late, publish_at: new Date(j.slot_at).toISOString() }, binary: $input.first().binary }];`));
  w.c('Channel ok?', 'Download', 0).chain('Download', 'Metadata').c('Download', 'Fail', 1);
  w.add(n.iff('Late?', [['={{ $json.late }}', 'boolean:true']]));
  w.c('Metadata', 'Late?');
  w.add(n.ytUpload('Upload scheduled', { title: '={{ $json.title }}', description: '={{ $json.description }}', tags: '={{ $json.tags }}', privacy: 'private', publishAt: '={{ $json.publish_at }}' }));
  w.add(n.ytUpload('Upload now', { title: '={{ $json.title }}', description: '={{ $json.description }}', tags: '={{ $json.tags }}', privacy: 'public' }));
  delete w.nodes.at(-1).parameters.options.publishAt;
  w.c('Late?', 'Upload now', 0).c('Late?', 'Upload scheduled', 1);
  w.c('Upload now', 'Fail', 1).c('Upload scheduled', 'Fail', 1);
  w.add(n.code('Check upload', `// No node compares the upload's channel with sc.channel's answer.
const v = $input.first().json; const want = $('Channel').first().json.channel_id;
const got = v.snippet?.channelId ?? null;
return [{ json: { youtube_id: v.id, channel_id: got ?? want, mismatch: !!got && got !== want, want, got } }];`));
  w.c('Upload now', 'Check upload').c('Upload scheduled', 'Check upload');
  // saved with no status guard: a cancel during the upload must still find the video to delete it
  w.add(n.pg('Save upload', `UPDATE jobs SET youtube_id = $2, channel_id = $3, updated_at = now() WHERE id = $1;`, [`${C}.id`, '$json.youtube_id', '$json.channel_id']));
  w.add(n.iff('Wrong channel?', [['={{ $("Check upload").first().json.mismatch }}', 'boolean:true']]));
  w.add(n.alert('Alert channel', "'channel_mismatch'", "'A video went to the wrong channel'",
    `${C}.job + ' was uploaded to channel ' + $('Check upload').first().json.got + ', not ' + $('Check upload').first().json.want + ' (CHANNEL_HANDLE). Delete it in Studio and re-connect the YouTube credential.'`));
  w.add(n.code('Stop wrong channel', `throw new Error('upload landed on another channel');`, { err: true }));
  w.chain('Check upload', 'Save upload', 'Wrong channel?', 'Alert channel', 'Stop wrong channel');
  w.c('Stop wrong channel', 'Fail', 1);
  w.add(n.http('Synthetic media flag', {
    method: 'PUT', url: `${YT}/videos`, auth: 'yt', query: { part: 'status' }, soft: true,
    json: `={{ JSON.stringify({ id: $('Check upload').first().json.youtube_id, status: { privacyStatus: $('Metadata').first().json.late ? 'public' : 'private', ...($('Metadata').first().json.late ? {} : { publishAt: $('Metadata').first().json.publish_at }), selfDeclaredMadeForKids: false, containsSyntheticMedia: false } }) }}`,
  }));
  w.c('Wrong channel?', 'Synthetic media flag', 1);
  w.add(n.pg('Note late', `INSERT INTO master_log (job_id, task, result) SELECT $1, 'late_publish', $2::jsonb WHERE $3;`,
    [`${C}.id`, n.J(`{ slot_at: ${C}.slot_at, published: 'now' }`), "$('Metadata').first().json.late"]));
  w.add(n.pg('Finish', `UPDATE jobs SET status = 'scheduled', attempts = 0, locked_at = NULL, last_error = NULL, updated_at = now()
WHERE id = $1 AND status = 'approved' RETURNING id;`, [`${C}.id`], { err: true }));
  w.chain('Synthetic media flag', 'Note late', 'Finish');
  w.c('Already uploaded?', 'Finish', 0).c('Finish', 'Fail', 1);

  // ---- auto: delete the upload of a cancelled or rejected job (one per run)
  w.add(n.pg('Pull one', `UPDATE jobs SET locked_at = now() WHERE id = (SELECT id FROM jobs WHERE status IN ('cancelled', 'rejected') AND youtube_id IS NOT NULL
  AND (locked_at IS NULL OR locked_at < now() - interval '90 minutes') ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *, 'SC-' || lpad(id::text, 4, '0') AS job;`));
  w.c('Auto mode?', 'Pull one', 0);
  const P = "$('Pull one').first().json";
  w.add(n.exec('Channel for delete', 'sc.channel', { caller: 'sc.publish' }, { err: true }));
  w.add(n.iff('Same channel?', [[`={{ $json.ok === true && (!${P}.channel_id || ${P}.channel_id === $json.channel_id) }}`, 'boolean:true']]));
  w.add(n.iff('Old channel?', [[`={{ $('Channel for delete').first().json.ok === true }}`, 'boolean:true']]));
  w.add(n.alert('Alert old channel', `'cancel_old_channel:' + ${P}.job`, `${P}.job + ': delete it in Studio on the old channel'`,
    `${P}.job + ' was cancelled, but its video ' + ${P}.youtube_id + ' is on channel ' + ${P}.channel_id + ', which ShortCircuit no longer uploads to. Delete it in Studio on that channel.'`));
  w.add(n.http('Find video', { url: `${YT}/videos`, auth: 'yt', query: { part: 'snippet', id: `={{ ${P}.youtube_id }}` }, err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(n.iff('Ours to delete?', [[`={{ ($json.items ?? []).length === 0 || $json.items[0].snippet?.channelId === $('Channel for delete').first().json.channel_id }}`, 'boolean:true']]));
  w.add(n.iff('Still there?', [['={{ ($json.items ?? []).length > 0 }}', 'boolean:true']]));
  w.add(n.ytDelete('Delete video', `={{ ${P}.youtube_id }}`));
  w.add(n.pg('Clear upload', `UPDATE jobs SET youtube_id = NULL, locked_at = NULL, updated_at = now() WHERE id = $1;`, [`${P}.id`]));
  w.add(n.pg('Release', `UPDATE jobs SET locked_at = NULL, last_error = left($2, 2000) WHERE id = $1;`, [`${P}.id`, "String($json.error?.message ?? $json.reason ?? 'not deleted')"]));
  w.chain('Pull one', 'Channel for delete', 'Same channel?', 'Find video', 'Ours to delete?', 'Still there?', 'Delete video', 'Clear upload');
  w.c('Channel for delete', 'Release', 1);
  w.c('Same channel?', 'Old channel?', 1).c('Old channel?', 'Alert old channel', 0).c('Alert old channel', 'Clear upload').c('Old channel?', 'Release', 1);
  w.c('Find video', 'Release', 1).c('Ours to delete?', 'Release', 1).c('Still there?', 'Clear upload', 1).c('Delete video', 'Release', 1);

  // ---- manual: the upload pack
  w.add(n.pg('Approved jobs', `SELECT *, 'SC-' || lpad(id::text, 4, '0') AS job FROM jobs WHERE status = 'approved' AND locked_at IS NULL ORDER BY slot_at;`));
  w.c('Auto mode?', 'Approved jobs', 1);
  w.add(n.code('Pack', `// No node builds the upload pack (escaping, links, metadata).
${ESC}
${META}
const jobs = $input.all().map((i) => i.json).filter((j) => j.id);
if (!jobs.length) return [];
const soon = jobs.some((j) => new Date(j.slot_at).getTime() < Date.now() + 36 * 3600e3);
if (jobs.length < 3 && !soon) return [];
const rows = jobs.map((j) => {
  const late = new Date(j.slot_at).getTime() < Date.now();
  return '<hr><h3>' + esc(j.job) + ' · ' + esc(j.script?.title) + '</h3>' + button(j.drive_link, 'Download from Drive')
    + '<p><b>Publish:</b> ' + (late ? '<b>slot passed: publish now</b>' : esc(fmt(j.slot_at))) + '</p>'
    + '<p><b>Title</b><br>' + esc(j.script?.title) + '</p><p><b>Description</b><br><span style="white-space:pre-wrap">' + esc(desc(j.script ?? {}, j.brief ?? {})) + '</span></p>'
    + '<p><b>Tags</b> (paste exactly, the sc- tag included)<br>' + esc(tags(j.script ?? {}, j.id).join(', ')) + '</p>';
}).join('');
const html = page('Upload pack — ' + jobs.length + ' videos', '<p>Upload to <b>' + esc($env.CHANNEL_HANDLE) + '</b> in YouTube Studio and schedule each one at its time. Category: Science &amp; Technology; not made for kids.</p>' + rows);
return [{ json: { ids: jobs.map((j) => j.id), first: jobs[0].id, outbox: { subject: 'ShortCircuit upload pack — ' + jobs.length + ' videos', html } } }];`));
  // one statement: a row may be changed only once per statement (a second CTE update is ignored)
  w.add(n.pg('Finish pack', `UPDATE jobs SET status = 'awaiting_upload', updated_at = now(),
  outbox = CASE WHEN id = $2 THEN $3::jsonb ELSE outbox END
WHERE id = ANY($1::int[]) AND status = 'approved' RETURNING id, outbox IS NOT NULL AS has_outbox;`, ['$json.ids', '$json.first', n.J('$json.outbox')]));
  w.add(n.filter('Pack mail', [['={{ $json.has_outbox }}', 'boolean:true']]));
  w.add(n.sendJobMail('Send pack', '$json.id'));
  w.chain('Approved jobs', 'Pack', 'Finish pack', 'Pack mail', 'Send pack');
  w.guard('Claim');
  w.guard('Pull one');
  return w;
}

// ---------------- sc.livecheck ----------------
export function scLivecheck() {
  const w = new WF('sc.livecheck', { timer: true, description: 'Hourly: sc.channel → the channel\'s last 50 uploads → matches them to jobs by the sc-#### tag → scheduled / live / done / cancelled, saves metrics, alerts slot_missed. Any API error → no job changes (PLAN §10.6).' });
  w.add(n.cron('Hourly', '7 * * * *'));
  w.add(n.exec('Channel', 'sc.channel', { caller: 'sc.livecheck' }));
  w.add(n.iff('Channel ok?', [['={{ $json.ok }}', 'boolean:true']]));
  w.chain('Hourly', 'Channel', 'Channel ok?');
  const CH = "$('Channel').first().json.channel_id";
  w.add(n.http('Uploads playlist', { url: `${YT}/channels`, auth: 'yt', query: { part: 'contentDetails', id: `={{ ${CH} }}` }, retry: { tries: 3, wait: 10000 } }));
  w.add(n.http('Recent uploads', { url: `${YT}/playlistItems`, auth: 'yt', query: { part: 'contentDetails', maxResults: '50', playlistId: '={{ $json.items[0].contentDetails.relatedPlaylists.uploads }}' }, retry: { tries: 3, wait: 10000 } }));
  w.add(n.http('Videos', { url: `${YT}/videos`, auth: 'yt', query: { part: 'snippet,status,statistics', id: "={{ ($json.items ?? []).map(i => i.contentDetails.videoId).join(',') || 'none' }}" }, retry: { tries: 3, wait: 10000 } }));
  w.add(n.pg('Jobs', `SELECT id, status, youtube_id, channel_id, slot_at, slot_date, drive_file_id, script->>'title' AS title, 'SC-' || lpad(id::text, 4, '0') AS job
FROM jobs WHERE status NOT IN ('done', 'failed') OR (youtube_id IS NULL AND updated_at > now() - interval '30 days');`, [], { always: true }));
  // Errors in the three calls above stop the run (no error output): an empty list from an
  // error must never read as "every video is gone".
  w.chain('Channel ok?', 'Uploads playlist', 'Recent uploads', 'Videos', 'Jobs');
  w.nodes.find((x) => x.name === 'Jobs').executeOnce = true;
  w.add(n.code('Match', `// No node matches videos to jobs by a hidden tag and decides each job's next state.
const ch = $('Channel').first().json.channel_id;
const vids = ($('Videos').first().json.items ?? []).filter((v) => v.snippet?.channelId === ch);
const jobs = $input.all().map((i) => i.json).filter((j) => j.id);
const byTag = new Map(); const byTitle = new Map();
for (const v of vids) { for (const t of v.snippet.tags ?? []) { const m = /^sc-([0-9]{4,})$/i.exec(t); if (m) byTag.set(Number(m[1]), v); } byTitle.set(String(v.snippet.title).trim(), v); }
const acts = [];
for (const j of jobs) {
  const v = byTag.get(j.id) ?? (j.title ? byTitle.get(String(j.title).trim()) : undefined);
  const ours = !j.channel_id || j.channel_id === ch;
  if (j.status === 'awaiting_upload' && v) acts.push({ type: 'scheduled', id: j.id, youtube_id: v.id });
  else if (v && !j.youtube_id && j.status !== 'awaiting_upload') acts.push({ type: 'save_id', id: j.id, youtube_id: v.id, job: j.job, status: j.status });
  if (j.status === 'scheduled' && ours && j.youtube_id) {
    const sv = vids.find((x) => x.id === j.youtube_id) ?? v;
    if (sv && sv.status?.privacyStatus === 'public') acts.push({ type: 'live', id: j.id });
    else if (!sv) acts.push({ type: 'gone_check', id: j.id, youtube_id: j.youtube_id });
  }
}
const stats = vids.map((v) => ({ id: v.id, views: Number(v.statistics?.viewCount ?? 0), likes: Number(v.statistics?.likeCount ?? 0), comments: Number(v.statistics?.commentCount ?? 0) }));
return [{ json: { acts, stats } }];`));
  w.c('Jobs', 'Match');
  w.add(n.splitOut('One action', 'acts'));
  w.nodes.at(-1).parameters.options = { destinationFieldName: 'a' };
  w.add(n.sw('Action', ['scheduled', 'save_id', 'live', 'gone_check'].map((t) => [t, [['={{ $json.a.type }}', 'string:equals', t]]])));
  w.chain('Match', 'One action', 'Action');
  w.add(n.pg('To scheduled', `UPDATE jobs SET status = 'scheduled', youtube_id = $2, channel_id = $3, updated_at = now() WHERE id = $1 AND status = 'awaiting_upload';`, ['$json.a.id', '$json.a.youtube_id', CH]));
  w.add(n.pg('Save id', `UPDATE jobs SET youtube_id = $2, channel_id = $3, updated_at = now() WHERE id = $1 AND youtube_id IS NULL RETURNING id;`, ['$json.a.id', '$json.a.youtube_id', CH]));
  w.add(n.iff('Delete in Studio?', [["={{ $env.PUBLISH_MODE !== 'auto' && ['cancelled', 'rejected'].includes($('Action').item.json.a.status) }}", 'boolean:true']]));
  w.add(n.alert('Alert Studio', "'cancel_in_studio:' + $('Action').item.json.a.job", "$('Action').item.json.a.job + ': delete it in Studio'",
    "$('Action').item.json.a.job + ' was cancelled or rejected, but its video is on the channel (' + $('Action').item.json.a.youtube_id + '). Delete it in YouTube Studio.'", { each: true }));
  w.add(n.pg('To live', `UPDATE jobs SET status = 'live', updated_at = now() WHERE id = $1 AND status = 'scheduled';`, ['$json.a.id']));
  w.add(n.http('Confirm gone', { url: `${YT}/videos`, auth: 'yt', query: { part: 'id', id: '={{ $json.a.youtube_id }}' }, err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(n.iff('Gone?', [['={{ Array.isArray($json.items) && $json.items.length === 0 }}', 'boolean:true']]));
  w.add(n.pg('To cancelled', `UPDATE jobs SET status = 'cancelled', slot_at = NULL, slot_date = NULL, updated_at = now() WHERE id = $1 AND status = 'scheduled' AND channel_id = $2;`, ["$('Action').item.json.a.id", CH]));
  w.c('Action', 'To scheduled', 0).c('Action', 'Save id', 1).c('Action', 'To live', 2).c('Action', 'Confirm gone', 3);
  w.chain('Save id', 'Delete in Studio?', 'Alert Studio');
  w.chain('Confirm gone', 'Gone?', 'To cancelled');
  // 5. live → Drive file deleted → done; a job on an older channel → done 24 h after its slot
  w.add(n.pg('To finish', `SELECT id, drive_file_id FROM jobs WHERE status = 'live'
  OR (status = 'scheduled' AND channel_id IS NOT NULL AND channel_id <> $1 AND slot_at < now() - interval '24 hours');`, [CH], { always: true }));
  w.nodes.at(-1).executeOnce = true;
  w.add(n.iff('Has Drive file?', [['={{ $json.drive_file_id }}', 'string:notEmpty']]));
  w.add(n.driveDelete('Delete Drive file', '={{ $json.drive_file_id }}'));
  w.add(n.iff('Already gone?', [["={{ /not ?found|404/i.test(String($json.error?.message ?? $json.error ?? '')) }}", 'boolean:true']]));
  w.add(n.pg('To done', `UPDATE jobs SET status = 'done', drive_file_id = NULL, drive_link = NULL, updated_at = now() WHERE id = $1 AND status IN ('live', 'scheduled');`, ["$('To finish').item.json.id"]));
  w.c('Match', 'To finish').chain('To finish', 'Has Drive file?', 'Delete Drive file', 'To done');
  w.c('Has Drive file?', 'To done', 1).c('Delete Drive file', 'Already gone?', 1).c('Already gone?', 'To done', 0);
  // 6. missed slots (jobs on an older channel cannot be seen from here: left out)
  w.add(n.pg('Missed slots', `SELECT to_char(slot_date, 'YYYY-MM-DD') AS day, 'SC-' || lpad(id::text, 4, '0') AS job, status FROM jobs
WHERE slot_at < now() - interval '1 hour' AND slot_at > now() - interval '3 days' AND status NOT IN ('live', ${list(ENDED)})
  AND (channel_id IS NULL OR channel_id = $1);`, [CH]));
  w.nodes.at(-1).executeOnce = true;
  w.add(n.alert('Alert missed', "'slot_missed:' + $json.day", "'No Short went live on ' + $json.day",
    "'The slot of ' + $json.job + ' (' + $json.day + ') passed more than an hour ago and the video is not live; the job is ' + $json.status + '.'", { each: true }));
  w.c('Match', 'Missed slots').c('Missed slots', 'Alert missed');
  // 7. metrics snapshots at 24 h, 48 h and 7 d (each taken once)
  w.add(n.pg('Metrics', `INSERT INTO metrics (job_id, age_h, views, likes, comments)
SELECT j.id, a.age, (s->>'views')::int, (s->>'likes')::int, (s->>'comments')::int
FROM jsonb_array_elements($1::jsonb) s
JOIN jobs j ON j.youtube_id = s->>'id' AND j.status IN ('live', 'done')
CROSS JOIN (VALUES (24), (48), (168)) a(age)
WHERE j.slot_at <= now() - make_interval(hours => a.age) AND j.slot_at > now() - make_interval(hours => a.age + 24)
ON CONFLICT DO NOTHING;`, [n.J("$('Match').first().json.stats")]));
  w.nodes.at(-1).executeOnce = true;
  w.c('Match', 'Metrics');
  w.guard('Missed slots', undefined, 'day');
  w.guard('To finish');
  return w;
}

// ---------------- sc.housekeeping ----------------
export function scHousekeeping() {
  const w = new WF('sc.housekeeping', { timer: true, description: 'Sunday 03:00: prunes the renderer clip cache, deletes Drive files of no active job, drops audit rows older than 90 days (PLAN §7, §10.6).' });
  w.add(n.cron('Sunday 03:00', '0 3 * * 0'));
  w.add(n.http('Prune cache', { method: 'POST', url: 'http://renderer:8000/cache/prune', soft: true, timeout: 60000 }));
  w.add(n.pg('Drop old rows', `WITH a AS (DELETE FROM reviews WHERE answered_at < now() - interval '90 days' RETURNING 1),
b AS (DELETE FROM master_log WHERE created_at < now() - interval '90 days' RETURNING 1)
SELECT (SELECT count(*) FROM a) AS reviews, (SELECT count(*) FROM b) AS master_log;`));
  w.add(n.pg('Drive state', `SELECT (SELECT value FROM config_seen WHERE key = 'drive_ready') AS folder_id,
  coalesce((SELECT json_agg(drive_file_id) FROM jobs WHERE drive_file_id IS NOT NULL AND status NOT IN ('cancelled', 'rejected', 'failed', 'done')), '[]'::json) AS keep;`));
  w.add(n.iff('Folder known?', [['={{ $json.folder_id }}', 'string:notEmpty']]));
  w.add(n.driveSearch('Ready files', `={{ "'" + $json.folder_id + "' in parents and trashed = false" }}`));
  w.add(n.filter('Orphans', [["={{ !!$json.id && !$('Drive state').first().json.keep.includes($json.id) }}", 'boolean:true']]));
  w.add(n.driveDelete('Delete orphan', '={{ $json.id }}'));
  w.add(n.pg('Forget file', `UPDATE jobs SET drive_file_id = NULL, drive_link = NULL WHERE drive_file_id = $1;`, ["$('Orphans').item.json.id"]));
  w.chain('Sunday 03:00', 'Prune cache', 'Drop old rows', 'Drive state', 'Folder known?', 'Ready files', 'Orphans', 'Delete orphan', 'Forget file');
  return w;
}

// ---------------- sc.config ----------------
export function scConfig() {
  const w = new WF('sc.config', { description: 'On n8n start, hourly and by hand: applies a changed OWNER_EMAIL (note + fresh review forms + Drive share) or CHANNEL_HANDLE (sc.channel; awaiting_upload → approved on a new channel). Makes the Drive folders on the first run (PLAN §1, §10.6).' });
  w.add(n.n8nStarted());
  w.add(n.cron('Hourly', '17 * * * *'));
  w.add(n.manual());
  w.add(n.pg('Seen', `SELECT coalesce(json_object_agg(key, value), '{}'::json) AS seen FROM config_seen;`));
  w.nodes.at(-1).executeOnce = true;
  for (const t of ['Instance started', 'Hourly', 'Manual']) w.c(t, 'Seen');
  w.add(n.code('Changes', `// No node compares stored settings with $env and lists what to do.
const s = $input.first().json.seen ?? {};
const owner = $env.OWNER_EMAIL ?? ''; const handle = $env.CHANNEL_HANDLE ?? '';
const first = !s.owner_email;
return [{ json: { seen: s, first, owner, handle,
  folders: !s.drive_folder || !s.drive_ready,
  owner_changed: !first && s.owner_email !== owner,
  share: s.drive_owner !== owner,
  channel: first || !s.channel_id || s.channel_handle !== handle } }];`));
  w.c('Seen', 'Changes');
  const CH = "$('Changes').first().json";
  const store = (name, key, valueExpr) => n.pg(name, `INSERT INTO config_seen (key, value, changed_at) VALUES ($1, $2, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, changed_at = now() RETURNING key;`, [`'${key}'`, valueExpr]);
  const logChange = (name, whatExpr) => n.pg(name, `INSERT INTO master_log (task, result) VALUES ('config', $1::jsonb);`, [n.J(whatExpr)]);

  // a. Drive folders ShortCircuit/ and ShortCircuit/ready/ (first run only)
  w.add(n.iff('Need folders?', [[`={{ ${CH}.folders }}`, 'boolean:true']]));
  w.add(n.driveCreateFolder('Make ShortCircuit', 'ShortCircuit'));
  w.add(store('Store folder', 'drive_folder', '$json.id'));
  w.add(n.driveCreateFolder('Make ready', 'ready', "={{ $('Make ShortCircuit').first().json.id }}"));
  w.add(store('Store ready', 'drive_ready', '$json.id'));
  w.add(n.alert('Alert folders', "'drive_folders_failed'", "'Could not make the Drive folders'", "'sc.config could not create ShortCircuit/ready/ in the bot Drive: ' + ($json.error?.message ?? $json.error ?? 'unknown') + '. Check the Drive Bot credential; the next hourly run tries again.'"));
  w.chain('Changes', 'Need folders?', 'Make ShortCircuit', 'Store folder', 'Make ready', 'Store ready');
  w.c('Make ShortCircuit', 'Alert folders', 1).c('Make ready', 'Alert folders', 1);

  // 2a. new OWNER_EMAIL: note first, then fresh forms
  w.add(n.iff('Owner changed?', [[`={{ ${CH}.owner_changed || ${CH}.first }}`, 'boolean:true']]));
  w.c('Changes', 'Owner changed?');
  w.add(n.iff('First run?', [[`={{ ${CH}.first }}`, 'boolean:true']]));
  w.add(store('Store owner', 'owner_email', `${CH}.owner`));
  w.add(n.pg('Waiting reviews', `SELECT 'SC-' || lpad(id::text, 4, '0') AS job, status, script->>'title' AS title FROM jobs WHERE status IN ('script_review', 'needs_human', 'video_review') ORDER BY id;`, [], { always: true }));
  w.add(n.code('Owner note', `// No node HTML-escapes text.
${ESC}
const rows = $input.all().map((i) => i.json).filter((j) => j.job);
const list = rows.length ? '<ul>' + rows.map((r) => '<li>' + esc(r.job) + ' · ' + esc(r.status) + ' · ' + esc(r.title) + '</li>').join('') + '</ul><p>Each gets a fresh review form at this address, with a full time window. Forms mailed to the old address no longer count.</p>' : '<p>No job is waiting for a review right now.</p>';
return [{ json: { subject: 'ShortCircuit now mails you here', html: page('ShortCircuit now mails you here', '<p>OWNER_EMAIL was changed to this address. Every ShortCircuit mail comes here from now on.</p>' + list) } }];`));
  w.add(n.exec('Mail owner note', 'sc.mail', { subject: '={{ $json.subject }}', html: '={{ $json.html }}' }, { err: true }));
  w.add(n.pg('Fresh forms', `UPDATE jobs SET review_sent_at = NULL, review_url = NULL, updated_at = now() - interval '11 minutes'
WHERE status IN ('script_review', 'needs_human', 'video_review') RETURNING id;`, [], { always: true }));
  w.add(store('Store new owner', 'owner_email', `${CH}.owner`));
  w.add(logChange('Log owner', `{ changed: 'OWNER_EMAIL', from_set: true }`));
  w.chain('Owner changed?', 'First run?', 'Store owner');
  w.c('First run?', 'Waiting reviews', 1).chain('Waiting reviews', 'Owner note', 'Mail owner note', 'Fresh forms', 'Store new owner', 'Log owner');

  // 2b. Drive share follows OWNER_EMAIL (Viewer, user only; never public), old access removed
  w.add(n.iff('Share needed?', [[`={{ ${CH}.share }}`, 'boolean:true']]));
  w.c('Changes', 'Share needed?');
  w.add(n.pg('Folder id', `SELECT value AS folder_id FROM config_seen WHERE key = 'drive_folder';`));
  w.add(n.iff('Folder made?', [['={{ $json.folder_id }}', 'string:notEmpty']]));
  w.add(n.driveShareFolder('Share folder', '={{ $json.folder_id }}', `={{ ${CH}.owner }}`));
  w.add(n.iff('Old address?', [[`={{ ${CH}.seen.drive_owner }}`, 'string:notEmpty']]));
  w.add(n.http('Permissions', { url: `={{ '${DRIVE}/files/' + $('Folder id').first().json.folder_id + '/permissions' }}`, auth: 'drive', query: { fields: 'permissions(id,emailAddress,type,role)' }, err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(n.code('Old permission', `// No node picks one permission by e-mail address.
const old = String($('Changes').first().json.seen.drive_owner ?? '').toLowerCase();
const p = ($input.first().json.permissions ?? []).find((x) => x.type === 'user' && x.role !== 'owner' && String(x.emailAddress).toLowerCase() === old && old !== String($env.OWNER_EMAIL).toLowerCase());
return p ? [{ json: { permission_id: p.id } }] : [{ json: { permission_id: null } }];`));
  w.add(n.iff('Remove?', [['={{ $json.permission_id }}', 'string:notEmpty']]));
  w.add(n.http('Remove old access', { method: 'DELETE', url: `={{ '${DRIVE}/files/' + $('Folder id').first().json.folder_id + '/permissions/' + $json.permission_id }}`, auth: 'drive', err: true, retry: { tries: 3, wait: 10000 } }));
  w.add(store('Store drive owner', 'drive_owner', `${CH}.owner`));
  w.add(n.alert('Alert share', "'drive_share_failed'", "'Could not share the Drive folder'", `'sc.config could not share ShortCircuit/ with ' + ${CH}.owner + ' or remove the old address: ' + ($json.error?.message ?? $json.error ?? 'unknown') + '. Share ShortCircuit/ with OWNER_EMAIL by hand (Viewer); the next hourly run tries again.'`));
  w.chain('Share needed?', 'Folder id', 'Folder made?', 'Share folder', 'Old address?', 'Permissions', 'Old permission', 'Remove?', 'Remove old access', 'Store drive owner');
  w.c('Old address?', 'Store drive owner', 1).c('Remove?', 'Store drive owner', 1);
  w.c('Share folder', 'Alert share', 1).c('Permissions', 'Alert share', 1).c('Remove old access', 'Alert share', 1);

  // 3. CHANNEL_HANDLE: sc.channel; a new channel id sends a new pack for jobs awaiting upload
  w.add(n.iff('Channel changed?', [[`={{ ${CH}.channel }}`, 'boolean:true']]));
  w.c('Changes', 'Channel changed?');
  w.add(n.exec('Channel', 'sc.channel', { caller: 'sc.config' }, { err: true }));
  w.add(n.iff('Channel ok?', [['={{ $json.ok }}', 'boolean:true']]));
  w.add(n.iff('New channel?', [[`={{ !!${CH}.seen.channel_id && ${CH}.seen.channel_id !== $json.channel_id }}`, 'boolean:true']]));
  w.add(n.pg('Repack', `UPDATE jobs SET status = 'approved', outbox = NULL, updated_at = now() WHERE status = 'awaiting_upload' RETURNING id;`, [], { always: true }));
  w.nodes.at(-1).executeOnce = true;
  w.add(store('Store channel id', 'channel_id', "$('Channel').first().json.channel_id"));
  w.add(store('Store handle', 'channel_handle', `${CH}.handle`));
  w.add(logChange('Log channel', `{ changed: 'CHANNEL_HANDLE', handle: ${CH}.handle, channel_id: $('Channel').first().json.channel_id, previous_channel_id: ${CH}.seen.channel_id ?? null }`));
  w.chain('Channel changed?', 'Channel', 'Channel ok?', 'New channel?', 'Repack', 'Store channel id', 'Store handle', 'Log channel');
  w.c('New channel?', 'Store channel id', 1);
  return w;
}
