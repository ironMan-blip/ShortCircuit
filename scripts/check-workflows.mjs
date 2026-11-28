// Checks the exported workflows for the fixed targets of PLAN §1 and the Master's tool limits (§4.8).
// usage: node scripts/check-workflows.mjs [workflows dir]   — exit 1 and one line per problem.
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] ?? new URL('../workflows', import.meta.url).pathname;
const MASTER_TOOLS = ['get_job', 'crew_stats', 'list_stuck', 'retry_job', 'redo_job', 'fail_job', 'reject_job'].map((t) => `sc.tool.${t}`);
const problems = [];
const bad = (wf, node, msg) => problems.push(`${wf}: node "${node}": ${msg}`);
const credOf = (n) => Object.values(n.credentials ?? {}).map((c) => c.name);
const httpCredName = (n) => {
  const p = n.parameters ?? {};
  if (p.authentication === 'predefinedCredentialType') return { gmailOAuth2: 'Gmail Bot', youTubeOAuth2Api: 'YouTube Channel', googleDriveOAuth2Api: 'Drive Bot' }[p.nodeCredentialType] ?? credOf(n)[0];
  return credOf(n)[0];
};

const files = fs.readdirSync(dir).filter((f) => f.startsWith('sc.') && f.endsWith('.json'));
if (!files.length) problems.push(`no sc.*.json in ${dir}`);
for (const f of files) {
  const w = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const wf = w.name;
  for (const n of w.nodes) {
    const type = n.type.split('.').pop(); const p = n.parameters ?? {};
    const creds = credOf(n);
    // Gmail: send only in sc.mail, send-and-wait only in sc.review, approval only on reject_job
    if (type === 'gmail' || type === 'gmailTool') {
      const op = p.operation ?? 'send'; const res = p.resource ?? 'message';
      if (type === 'gmailTool') bad(wf, n.name, 'a Gmail tool is attached to an agent');
      else if (res === 'message' && ['send', 'reply'].includes(op) && !(wf === 'sc.mail' && op === 'send')) bad(wf, n.name, `Gmail ${op} outside sc.mail`);
      else if (res === 'message' && op === 'sendAndWait' && wf !== 'sc.review') bad(wf, n.name, 'Gmail send-and-wait outside sc.review');
      else if (res === 'draft' || res === 'thread' && op === 'reply') bad(wf, n.name, `Gmail ${res} ${op}`);
    }
    if (type === 'gmailHitlTool' && !['sc.master', 'sc.master.daily'].includes(wf)) bad(wf, n.name, 'Gmail approval step outside sc.master');
    if (type.startsWith('gmail') && ['send', 'sendAndWait', 'reply'].includes(p.operation ?? 'send')) {
      if (p.sendTo !== '={{ $env.OWNER_EMAIL }}') bad(wf, n.name, 'recipient is not exactly {{ $env.OWNER_EMAIL }}');
      for (const k of ['ccList', 'bccList', 'replyTo', 'senderName']) if (p.options?.[k]) bad(wf, n.name, `has option ${k}`);
    }
    // HTTP Request nodes holding the Google credentials
    if (type === 'httpRequest' || type === 'httpRequestTool') {
      const c = httpCredName(n); const method = (p.method ?? 'GET').toUpperCase();
      if (c === 'Gmail Bot') bad(wf, n.name, 'HTTP Request with the Gmail Bot credential');
      if (c === 'YouTube Channel' && method !== 'GET' && wf !== 'sc.publish') bad(wf, n.name, `YouTube ${method} outside sc.publish`);
      if (c === 'Drive Bot' && method !== 'GET' && !(wf === 'sc.config' && method === 'DELETE' && /\/permissions\//.test(p.url))) bad(wf, n.name, `Drive ${method} by HTTP outside sc.config's permission removal`);
      if (type === 'httpRequestTool') bad(wf, n.name, 'an HTTP Request Tool is attached to an agent');
    }
    // YouTube writes only in sc.publish
    if ((type === 'youTube' || type === 'youTubeTool') && !(['get', 'getAll'].includes(p.operation)) && wf !== 'sc.publish') bad(wf, n.name, `YouTube ${p.resource ?? ''} ${p.operation} outside sc.publish`);
    // Drive shares only in sc.config, only to a user
    if (type === 'googleDrive' || type === 'googleDriveTool') {
      if (p.operation === 'share') {
        if (wf !== 'sc.config') bad(wf, n.name, 'Drive share outside sc.config');
        const perms = [p.permissionsUi?.permissionsValues].flat().filter(Boolean);
        if (!perms.length || perms.some((x) => x.type !== 'user')) bad(wf, n.name, 'Drive share with a permission type other than user');
      }
      if (type === 'googleDriveTool') bad(wf, n.name, 'a Drive tool is attached to an agent');
    }
    if (creds.includes('Gmail Bot') && !type.startsWith('gmail')) bad(wf, n.name, 'uses the Gmail Bot credential');
  }
  // The Master agents: only the seven sc.tool.* workflows (reject_job behind the owner's approval)
  for (const agent of w.nodes.filter((n) => n.type.endsWith('.agent'))) {
    if (!['sc.master', 'sc.master.daily'].includes(wf)) { bad(wf, agent.name, 'an AI Agent outside sc.master'); continue; }
    const into = (name) => Object.entries(w.connections).filter(([, o]) => (o.ai_tool ?? []).flat().some((e) => e.node === name)).map(([from]) => from);
    const walk = (name) => into(name).flatMap((from) => {
      const node = w.nodes.find((x) => x.name === from);
      if (node.type.endsWith('gmailHitlTool')) return [node, ...walk(from).map((t) => ({ ...t, gated: true }))];
      return [node];
    });
    for (const t of walk(agent.name)) {
      if (t.type.endsWith('gmailHitlTool')) continue;
      const target = t.parameters?.workflowId?.cachedResultName;
      if (!t.type.endsWith('.toolWorkflow') || !MASTER_TOOLS.includes(target)) bad(wf, t.name, `agent tool is not one of the seven sc.tool.* (${t.type} ${target ?? ''})`);
      else if (target !== `sc.tool.${t.name}`) bad(wf, t.name, `tool name does not match its workflow ${target}`);
      else if (target === 'sc.tool.reject_job' && !t.gated) bad(wf, t.name, 'reject_job has no owner approval step');
      else if (['retry_job', 'redo_job', 'fail_job', 'reject_job'].includes(t.name) && wf === 'sc.master' && !/\$\('Pick'\)/.test(JSON.stringify(t.parameters?.workflowInputs?.value?.job ?? ''))) bad(wf, t.name, 'job id is not fixed to the claimed job');
    }
  }
}
for (const p of problems) console.log(p);
console.log(problems.length ? `check-workflows: ${problems.length} problem(s)` : `check-workflows: ${files.length} workflows ok`);
process.exit(problems.length ? 1 : 0);
