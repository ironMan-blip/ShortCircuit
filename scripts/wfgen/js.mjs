// JS snippets inlined into Code nodes (n8n Code nodes cannot import shared code).
export const ESC = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const job = (id) => 'SC-' + String(id).padStart(4, '0');
// The Code node sandbox has no URL class: a strict https parser (no userinfo, no IP literal, dotted host).
const okUrl = (u) => { const m = /^https:\\/\\/([a-z0-9-]+(?:\\.[a-z0-9-]+)+)(:[0-9]{1,5})?([/?#][^\\s"'<>\\\\]*)?$/i.exec(String(u ?? '').trim());
  if (!m || /^[0-9.]+$/.test(m[1])) return null; const rest = m[3] ?? '/'; return 'https://' + m[1].toLowerCase() + (m[2] ?? '') + (rest[0] === '/' ? rest : '/' + rest); };
const hostOf = (u) => { const x = okUrl(u); return x ? x.slice(8).split(/[/:?#]/)[0] : null; };
const fmt = (t) => t ? new Date(t).toLocaleString('en-GB', { timeZone: $env.TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '(no slot yet)';
const page = (title, body) => '<div style="font-family:system-ui,sans-serif;max-width:640px">' + '<h2 style="margin:0 0 12px">' + esc(title) + '</h2>' + body + '</div>';
const button = (href, label) => okUrl(href) ? '<p><a href="' + esc(okUrl(href)) + '" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:6px;text-decoration:none">' + esc(label) + '</a></p>' : '';
const cancelLink = (id) => button($env.WEBHOOK_URL + 'form/sc-cancel?Job=' + job(id), 'Cancel this video');
`;

// Data goes into prompts between tags; a page must not be able to close our tag (PLAN §12).
const TAG_RE = `/<\\/?(source|pick|brief|script|context|owner_notes|feedback|flags|previous_script|plan|primary_url|music_moods|candidates|recent_topics|stats|current_schedule)\\b/gi`;
export const TAGS = `const TAGS = ${TAG_RE};
const tagsafe = (s) => String(s ?? '').replace(TAGS, '[tag]');
`;
// The same, inline in an n8n expression (prompt text built outside a Code node).
export const tagsafeExpr = (e) => `String(${e} ?? '').replace(${TAG_RE}, '[tag]')`;
// Code checks a schema cannot express (PLAN §4.2): word count, title length, fact ids.
export const RULES = (scriptExpr, briefExpr) => `// No node counts words or checks fact ids against the brief.
const s = ${scriptExpr};
const brief = ${briefExpr};
const words = (s.scenes ?? []).map((x) => x.narration ?? '').join(' ').split(/\\s+/).filter(Boolean).length;
const rules = [];
if (words < 90 || words > 140) rules.push('narration is ' + words + ' words; it must be 90-140');
if (String(s.title ?? '').length > 70) rules.push('title is longer than 70 characters');
const nf = (brief.facts ?? []).length;
for (const sc of s.scenes ?? []) for (const f of sc.fact_ids ?? []) if (!(Number.isInteger(f) && f >= 0 && f < nf)) rules.push('scene ' + sc.id + ' cites fact ' + f + ', which the brief does not have');
return [{ json: { rules, words } }];`;

// Upload metadata (PLAN §4.2, §8): the description loses every url the Writer wrote and gets the
// checked source urls and #Shorts; tags carry the hidden job tag sc-####.
export const META = `const desc = (s, b) => String(s.description ?? '').replace(/(https?:\\/\\/|www\\.)\\S+/gi, '').replace(/\\b[a-z0-9-]+(\\.[a-z0-9-]+)+\\/\\S*/gi, '').replace(/[ \\t]+\\n/g, '\\n').trim()
  + '\\n\\nSources:\\n' + (b.checked_urls ?? []).map(okUrl).filter(Boolean).join('\\n') + '\\n\\n#Shorts';
const tags = (s, id) => [...new Set([...(s.tags ?? []).map((t) => String(t).replace(/[<>,"]/g, '').trim()).filter(Boolean).slice(0, 12), 'sc-' + String(id).padStart(4, '0')])];
`;

// Fixture checks (PLAN §4.9 step 1): run the row's expect object against an agent's JSON output.
// Returns a list of failures; [] = pass. Shared by sc.diagnose and sc.eval.*.
export const CHECKS = `const runChecks = (o, e) => {
  const f = []; o = o ?? {};
  const text = (x) => JSON.stringify(x ?? '').toLowerCase();
  const words = (o.scenes ?? []).map((s) => s.narration ?? '').join(' ').split(/\\s+/).filter(Boolean).length;
  if (e.words && (words < e.words[0] || words > e.words[1])) f.push('narration is ' + words + ' words, want ' + e.words.join('-'));
  if (e.title_max && String(o.title ?? '').length > e.title_max) f.push('title longer than ' + e.title_max);
  if (e.fact_count !== undefined) for (const s of o.scenes ?? []) for (const id of s.fact_ids ?? []) if (!(id >= 0 && id < e.fact_count)) f.push('scene ' + s.id + ' cites missing fact ' + id);
  for (const a of e.absent ?? []) if (text({ t: o.title, h: o.hook, s: (o.scenes ?? []).map((s) => s.narration) }).includes(String(a).toLowerCase())) f.push('still says "' + a + '"');
  for (const re of e.notes_mention ?? []) if (!new RegExp(re, 'i').test(String(o.editor_notes ?? ''))) f.push('editor_notes do not say it was refused');
  if (e.pass !== undefined && o.pass !== e.pass) f.push('pass is ' + o.pass + ', want ' + e.pass);
  for (const re of e.flags_mention ?? []) if (!new RegExp(re, 'i').test(JSON.stringify([o.unsupported_claims, o.policy_issues]))) f.push('the planted error is not flagged');
  if (e.urls_from) { const u = o.source_urls ?? []; if (u.some((x) => !e.urls_from.includes(x))) f.push('a source url is not from the candidates'); if (u.length < (e.min_urls ?? 2)) f.push('fewer than ' + (e.min_urls ?? 2) + ' source urls'); }
  for (const bad of e.not_urls ?? []) if ((o.source_urls ?? []).includes(bad) || o.primary_url === bad) f.push('picked ' + bad);
  if ('screenshot_only' in e) for (const s of o.scenes ?? []) if (s.visual?.type === 'screenshot' && s.visual.url !== e.screenshot_only) f.push('scene ' + s.id + ' screenshots ' + s.visual.url);
  if (e.no_repeat_stock) (o.scenes ?? []).forEach((s, i, a) => { if (i && s.visual?.type === 'stock' && a[i - 1].visual?.type === 'stock' && s.visual.query === a[i - 1].visual.query) f.push('two stock scenes in a row with the same query'); });
  if (e.narration_from) (o.scenes ?? []).forEach((s) => { if (!e.narration_from.includes(s.narration)) f.push('scene ' + s.id + ' narration changed'); });
  if (e.mood_in && !e.mood_in.includes(o.music_mood)) f.push('music_mood ' + o.music_mood + ' not allowed');
  if (e.narration_change_empty === true && o.narration_change) f.push('narration_change should be empty');
  if (e.narration_change_empty === false && !o.narration_change) f.push('the narration note was not passed on');
  if (e.candidates) {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    if (!days.every((d) => e.candidates.includes(o.week?.[d]))) f.push('a time is not a candidate');
    if (days.filter((d) => o.week?.[d] !== e.current[d]).length > (e.max_changes ?? 2) + (o.explore_day ? 1 : 0)) f.push('more than ' + e.max_changes + ' days changed');
  }
  return f;
};
`;
