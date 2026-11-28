// Workflow JSON builder for ShortCircuit (one-off generator; n8n exports are the source of truth after import).
import crypto from 'crypto';

export const wid = (name) => 'sc' + crypto.createHash('sha1').update(name).digest('hex').slice(0, 14);

export const CRED = {
  pg: { postgres: { id: 'scCredPostgres01', name: 'SC Postgres' } },
  gmail: { gmailOAuth2: { id: 'scCredGmailBot01', name: 'Gmail Bot' } },
  drive: { googleDriveOAuth2Api: { id: 'scCredDriveBot01', name: 'Drive Bot' } },
  yt: { youTubeOAuth2Api: { id: 'scCredYouTube001', name: 'YouTube Channel' } },
  gemini: { googlePalmApi: { id: 'scCredGemini0001', name: 'Gemini' } },
  groq: { groqApi: { id: 'scCredGroq000001', name: 'Groq' } },
  ollama: { ollamaApi: { id: 'scCredOllama0001', name: 'Ollama' } },
  anthropic: { anthropicApi: { id: 'scCredAnthropic1', name: 'Anthropic' } },
  anthropicHeader: { httpHeaderAuth: { id: 'scCredAnthHeader', name: 'Anthropic Header' } },
  cancelForm: { httpBasicAuth: { id: 'scCredCancelForm', name: 'SC Cancel Form' } },
};

export const STUB_CREDS = [
  ['scCredPostgres01', 'SC Postgres', 'postgres', { host: 'postgres', database: 'shortcircuit', user: 'sc_app', password: '', port: 5432, ssl: 'disable' }],
  ['scCredGmailBot01', 'Gmail Bot', 'gmailOAuth2', {}],
  ['scCredDriveBot01', 'Drive Bot', 'googleDriveOAuth2Api', {}],
  ['scCredYouTube001', 'YouTube Channel', 'youTubeOAuth2Api', {}],
  ['scCredGemini0001', 'Gemini', 'googlePalmApi', { host: 'https://generativelanguage.googleapis.com', apiKey: '' }],
  ['scCredGroq000001', 'Groq', 'groqApi', { apiKey: '' }],
  ['scCredOllama0001', 'Ollama', 'ollamaApi', { baseUrl: 'http://host.docker.internal:11434' }],
  ['scCredAnthropic1', 'Anthropic', 'anthropicApi', { apiKey: '' }],
  ['scCredAnthHeader', 'Anthropic Header', 'httpHeaderAuth', { name: 'x-api-key', value: '' }],
  ['scCredCancelForm', 'SC Cancel Form', 'httpBasicAuth', { user: 'owner', password: '' }],
];

let uid = 0;
const nid = () => crypto.createHash('md5').update('n' + uid++).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

export class WF {
  constructor(name, { saveSuccess = false, timer = false, description = '' } = {}) {
    this.name = name; this.nodes = []; this.conns = {}; this.description = description;
    this.settings = {
      executionOrder: 'v1', errorWorkflow: name === 'sc.error' ? undefined : wid('sc.error'),
      saveDataSuccessExecution: saveSuccess ? 'all' : (timer ? 'none' : 'all'),
      saveDataErrorExecution: 'all', saveManualExecutions: true, callerPolicy: 'workflowsFromSameOwner',
    };
  }
  add(n) {
    if (this.nodes.find((x) => x.name === n.name)) throw new Error(`${this.name}: duplicate node ${n.name}`);
    this.nodes.push(n); return n.name;
  }
  // c('A', 'B') ; c('A', 'B', 1) = from output 1 ; c('A','B',0,1) = into input 1
  c(from, to, out = 0, inp = 0, type = 'main') {
    const o = (this.conns[from] ??= {});
    const arr = (o[type] ??= []);
    while (arr.length <= out) arr.push([]);
    arr[out].push({ node: to, type, index: inp });
    return this;
  }
  // A Postgres query that returns no rows still outputs one {success: true} item: put an If
  // after it so the nodes that act per row only see real rows (field: a column every row has).
  guard(from, name = `${from} found?`, field = 'id') {
    const outs = this.conns[from]?.main?.[0] ?? [];
    this.conns[from].main[0] = [];
    this.add(iff(name, [[`={{ $json.${field} }}`, 'string:exists']]));
    this.c(from, name);
    this.conns[name] = { main: [outs] };
    return this;
  }
  chain(...names) { for (let i = 0; i + 1 < names.length; i++) this.c(names[i], names[i + 1]); return this; }
  sub(subnode, root, type) { return this.c(subnode, root, 0, 0, type); }
  layout() {
    const byName = Object.fromEntries(this.nodes.map((n) => [n.name, n]));
    const depth = {}; const incoming = {};
    for (const [f, o] of Object.entries(this.conns)) for (const [t, outs] of Object.entries(o)) for (const lst of outs) for (const e of lst) {
      (incoming[e.node] ??= []).push({ f, t });
    }
    const main = this.nodes.filter((n) => !(incoming[n.name] || []).length || (incoming[n.name] || []).some((e) => e.t === 'main'));
    const subs = this.nodes.filter((n) => !main.includes(n));
    for (const n of main) if (!(incoming[n.name] || []).length) depth[n.name] = 0;
    for (let k = 0; k < 60; k++) for (const [f, o] of Object.entries(this.conns)) for (const lst of (o.main || [])) for (const e of lst) {
      if (depth[f] !== undefined && (depth[e.node] === undefined || depth[e.node] < depth[f] + 1) && depth[f] + 1 < 60) depth[e.node] = depth[f] + 1;
    }
    const rows = {};
    for (const n of main) { const d = depth[n.name] ?? 0; rows[d] = (rows[d] ?? 0); n.position = [d * 260, rows[d] * 220]; rows[d]++; }
    const subCount = {};
    for (const n of subs) {
      const edge = Object.entries(this.conns[n.name] || {})[0];
      const root = edge ? byName[edge[1][0][0].node] : null;
      const rp = root?.position ?? [0, 0]; const k = (subCount[root?.name] = (subCount[root?.name] ?? 0) + 1);
      n.position = [rp[0] + (k - 1) * 140 - 60, rp[1] + 180 + (root && !root.position ? 0 : 0)];
    }
  }
  toJSON() {
    for (const n of this.nodes) { n.id ??= nid(); }
    this.layout();
    for (const [f] of Object.entries(this.conns)) if (!this.nodes.find((n) => n.name === f)) throw new Error(`${this.name}: conn from unknown ${f}`);
    for (const o of Object.values(this.conns)) for (const outs of Object.values(o)) for (const l of outs) for (const e of l)
      if (!this.nodes.find((n) => n.name === e.node)) throw new Error(`${this.name}: conn to unknown ${e.node}`);
    return {
      id: wid(this.name), name: this.name, active: false, isArchived: false,
      nodes: this.nodes, connections: this.conns, settings: this.settings,
      pinData: {}, meta: { templateCredsSetupCompleted: true }, tags: [],
      ...(this.description ? { description: this.description } : {}),
    };
  }
}

// ---------- node helpers ----------
const N = (name, type, typeVersion, parameters, extra = {}) => ({ name, type, typeVersion, parameters, ...extra });
const B = 'n8n-nodes-base.'; const L = '@n8n/n8n-nodes-langchain.';
const onErr = (e) => (e ? { onError: 'continueErrorOutput' } : {});
const retry = (r) => (r ? { retryOnFail: true, maxTries: r.tries ?? 3, waitBetweenTries: r.wait ?? 15000 } : {});

export const every = (name, minutes) => N(name, B + 'scheduleTrigger', 1.3, { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } });
export const cron = (name, expression) => N(name, B + 'scheduleTrigger', 1.3, { rule: { interval: [{ field: 'cronExpression', expression }] } });
export const manual = (name = 'Manual') => N(name, B + 'manualTrigger', 1, {});
export const errorTrigger = (name = 'Error Trigger') => N(name, B + 'errorTrigger', 1, {});
export const n8nStarted = (name = 'Instance started') => N(name, B + 'n8nTrigger', 1, { events: ['init'] });

// inputs: [['job_id','number'], ...]
export const input = (inputs, name = 'Input') => N(name, B + 'executeWorkflowTrigger', 1.1, {
  inputSource: 'workflowInputs', workflowInputs: { values: inputs.map(([n, type]) => ({ name: n, type: type ?? 'any' })) },
});

// SQL with $1.. params; params = array of expression bodies (without {{ }})
export const pg = (name, query, params = [], o = {}) => N(name, B + 'postgres', 2.6, {
  operation: 'executeQuery', query,
  options: {
    ...(params.length ? { queryReplacement: '={{ [' + params.join(', ') + '] }}' } : {}),
    ...(o.tx ? { queryBatching: 'transaction' } : {}),
  },
}, { credentials: CRED.pg, ...onErr(o.err), ...(o.always ? { alwaysOutputData: true } : {}), ...(o.once ? { executeOnce: true } : {}) });

export const code = (name, jsCode, o = {}) => N(name, B + 'code', 2, {
  mode: o.each ? 'runOnceForEachItem' : 'runOnceForAllItems', language: 'javaScript', jsCode,
}, { ...onErr(o.err), ...(o.always ? { alwaysOutputData: true } : {}) });

// assignments: [[name, valueExpr, type]]
export const set = (name, assignments, o = {}) => N(name, B + 'set', 3.4, {
  mode: 'manual', includeOtherFields: !!o.keep,
  ...(o.keep ? { include: 'all' } : {}),
  assignments: { assignments: assignments.map(([n, value, type]) => ({ id: nid(), name: n, value, type: type ?? 'string' })) },
  options: {},
}, o.once ? { executeOnce: true } : {});

const cond = ([left, op, right]) => {
  const [type, operation] = op.split(':');
  const singleValue = ['true', 'false', 'empty', 'notEmpty', 'exists', 'notExists'].includes(operation);
  return { id: nid(), leftValue: left, rightValue: singleValue ? '' : right, operator: { type, operation, ...(singleValue ? { singleValue: true } : {}) } };
};
const conditions = (list, combinator = 'and') => ({
  options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
  conditions: list.map(cond), combinator,
});
// iff('X', [['={{ $json.a }}', 'boolean:true']])
export const iff = (name, list, combinator) => N(name, B + 'if', 2.2, { conditions: conditions(list, combinator), looseTypeValidation: true, options: {} });
export const filter = (name, list, o = {}) => N(name, B + 'filter', 2.2, { conditions: conditions(list), looseTypeValidation: true, options: {} }, o.always ? { alwaysOutputData: true } : {});
// rules: [[outputKey, [cond...]]]; fallback: 'extra' adds a fallback output after the rules
export const sw = (name, rules, o = {}) => N(name, B + 'switch', 3.2, {
  rules: { values: rules.map(([key, list]) => ({ conditions: conditions(list), renameOutput: true, outputKey: key })) },
  looseTypeValidation: true,
  options: o.fallback ? { fallbackOutput: 'extra', renameFallbackOutput: o.fallback } : {},
});

export const stop = (name, messageExpr) => N(name, B + 'stopAndError', 1, { errorMessage: messageExpr });
export const noop = (name) => N(name, B + 'noOp', 1, {});
export const splitOut = (name, field) => N(name, B + 'splitOut', 1, { fieldToSplitOut: field, options: {} });
export const loop = (name) => N(name, B + 'splitInBatches', 3, { options: {} });
export const aggregateAll = (name, dest = 'items') => N(name, B + 'aggregate', 1, { aggregate: 'aggregateAllItemData', destinationFieldName: dest, options: {} }, { alwaysOutputData: true });
export const merge = (name, inputs = 2) => N(name, B + 'merge', 3, { numberInputs: inputs });
export const limit = (name, n = 1) => N(name, B + 'limit', 1, { maxItems: n });

// Execute Workflow (sub-workflow). inputs: {field: expr}
export const exec = (name, target, inputs, o = {}) => N(name, B + 'executeWorkflow', 1.2, {
  workflowId: { __rl: true, value: wid(target), mode: 'list', cachedResultName: target },
  workflowInputs: {
    mappingMode: 'defineBelow', value: inputs, matchingColumns: [], schema: Object.keys(inputs).map((k) => ({
      id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'any', removed: false,
    })), attemptToConvertTypes: false, convertFieldsToString: false,
  },
  mode: o.each ? 'each' : 'once',
  options: { waitForSubWorkflow: o.wait !== false },
}, { ...onErr(o.err), ...retry(o.retry) });

export const readFile = (name, pathExpr, o = {}) => N(name, B + 'readWriteFile', 1, { operation: 'read', fileSelector: pathExpr, options: o.prop ? { dataPropertyName: o.prop } : {} }, onErr(o.err));
export const writeFile = (name, pathExpr, prop = 'data') => N(name, B + 'readWriteFile', 1, { operation: 'write', fileName: pathExpr, dataPropertyName: prop, options: {} });
export const extractText = (name, dest = 'text') => N(name, B + 'extractFromFile', 1, { operation: 'text', destinationKey: dest, options: {} });

// HTTP request. o: {method, url, auth: 'yt'|'drive'|'anthropicHeader', query:{}, headers:{}, json: expr, timeout, proxy, full, never, format, err, retry}
export const http = (name, o) => {
  const p = { method: o.method ?? 'GET', url: o.url };
  if (o.auth === 'yt') Object.assign(p, { authentication: 'predefinedCredentialType', nodeCredentialType: 'youTubeOAuth2Api' });
  if (o.auth === 'drive') Object.assign(p, { authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api' });
  if (o.auth === 'anthropicHeader') Object.assign(p, { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' });
  if (o.query) Object.assign(p, { sendQuery: true, queryParameters: { parameters: Object.entries(o.query).map(([name, value]) => ({ name, value })) } });
  if (o.headers) Object.assign(p, { sendHeaders: true, headerParameters: { parameters: Object.entries(o.headers).map(([name, value]) => ({ name, value })) } });
  if (o.json) Object.assign(p, { sendBody: true, specifyBody: 'json', jsonBody: o.json });
  p.options = {
    timeout: o.timeout ?? 30000,
    ...(o.proxy ? { proxy: o.proxy } : {}),
    ...(o.full || o.never || o.format ? { response: { response: { ...(o.full ? { fullResponse: true } : {}), ...(o.never ? { neverError: true } : {}), ...(o.format ? { responseFormat: o.format } : {}) } } } : {}),
  };
  if (o.soft) Object.assign(o, { err: false });
  const creds = o.auth === 'yt' ? CRED.yt : o.auth === 'drive' ? CRED.drive : o.auth === 'anthropicHeader' ? CRED.anthropicHeader : undefined;
  return N(name, B + 'httpRequest', 4.2, p, { ...(creds ? { credentials: creds } : {}), ...onErr(o.err), ...retry(o.retry),
    ...(o.soft ? { onError: 'continueRegularOutput', alwaysOutputData: true } : {}), ...(o.once ? { executeOnce: true } : {}) });
};

export const rss = (name, url) => N(name, B + 'rssFeedRead', 1.1, { url, options: {} }, { onError: 'continueRegularOutput', alwaysOutputData: true, ...retry({ tries: 2, wait: 5000 }) });
export const htmlExtract = (name, sourceField, values) => N(name, B + 'html', 1.2, {
  operation: 'extractHtmlContent', dataPropertyName: sourceField,
  extractionValues: { values: values.map(([key, cssSelector, returnArray, attribute]) => ({ key, cssSelector, ...(attribute ? { returnValue: 'attribute', attribute } : { returnValue: 'text' }), ...(returnArray ? { returnArray: true } : {}) })) },
  options: { cleanUpText: true },
}, { onError: 'continueRegularOutput' });

// ---------- AI ----------
export const chain = (name, textExpr, systemExpr, o = {}) => N(name, L + 'chainLlm', 1.7, {
  promptType: 'define', text: textExpr, hasOutputParser: o.parser !== false,
  messages: { messageValues: [{ type: 'SystemMessagePromptTemplate', message: systemExpr }, ...(o.image ? [{ type: 'HumanMessagePromptTemplate', messageType: 'imageBinary', binaryImageDataKey: o.image }] : [])] },
  batching: {},
}, { ...onErr(o.err ?? true), ...retry(o.retry ?? { tries: 2, wait: 10000 }) });

export const gemini = (name, modelExpr, temp) => N(name, L + 'lmChatGoogleGemini', 1, { modelName: modelExpr, options: { temperature: temp, maxOutputTokens: 8192 } }, { credentials: CRED.gemini });
export const groq = (name, modelExpr, temp) => N(name, L + 'lmChatGroq', 1, { model: modelExpr, options: { temperature: temp, maxTokensToSample: 8192 } }, { credentials: CRED.groq });
export const ollama = (name, modelExpr, temp) => N(name, L + 'lmChatOllama', 1, { model: modelExpr, options: { temperature: temp, numCtx: 16384, keepAlive: '10m', think: false, format: 'json' } }, { credentials: CRED.ollama });
// effort: expression or literal; maxTokens
export const anthropic = (name, effortExpr, maxTokens = 16000) => N(name, L + 'lmChatAnthropic', 1.6, {
  model: { __rl: true, mode: 'id', value: '={{ $env.MASTER_MODEL }}' },
  options: { maxTokensToSample: maxTokens, thinkingMode: 'adaptive', effort: effortExpr },
}, { credentials: CRED.anthropic });

export const parser = (name, schemaExprOrObj, o = {}) => N(name, L + 'outputParserStructured', 1.3, {
  schemaType: 'manual', inputSchema: typeof schemaExprOrObj === 'string' ? schemaExprOrObj : JSON.stringify(schemaExprOrObj, null, 2),
  ...(o.autoFix ? { autoFix: true } : {}),
});

export const agent = (name, textExpr, systemExpr, o = {}) => N(name, L + 'agent', 2.2, {
  promptType: 'define', text: textExpr, hasOutputParser: true,
  options: { systemMessage: systemExpr, maxIterations: o.maxIterations ?? 10, returnIntermediateSteps: true },
}, onErr(true));

// workflow tool: inputs {field: expr}; fromAI fields use $fromAI
export const tool = (name, target, description, inputs) => N(name, L + 'toolWorkflow', 2.2, {
  description,
  workflowId: { __rl: true, value: wid(target), mode: 'list', cachedResultName: target },
  workflowInputs: {
    mappingMode: 'defineBelow', value: inputs, matchingColumns: [], schema: Object.keys(inputs).map((k) => ({
      id: k, displayName: k, required: false, defaultMatch: false, display: true, canBeUsedToMatch: true, type: 'string', removed: false,
    })), attemptToConvertTypes: false, convertFieldsToString: false,
  },
});

export const guardrailJailbreak = (name, textExpr) => N(name, L + 'guardrails', 1, {
  operation: 'classify', text: textExpr, guardrails: { jailbreak: { value: { threshold: 0.7 } } },
}, { onError: 'continueRegularOutput' }); // errors land on the Fail output as {error}
export const guardrailPii = (name, textExpr) => N(name, L + 'guardrails', 1, {
  operation: 'sanitize', text: textExpr, guardrails: { pii: { value: { type: 'all' } } },
}, { onError: 'continueRegularOutput', alwaysOutputData: true }); // sanitize drops error items: callers check guardrailsInput

// ---------- Google ----------
export const gmailSend = (name, subjectExpr, htmlExpr) => N(name, B + 'gmail', 2.1, {
  sendTo: '={{ $env.OWNER_EMAIL }}', subject: subjectExpr, emailType: 'html', message: htmlExpr,
  options: { appendAttribution: false },
}, { credentials: CRED.gmail, ...retry({ tries: 3, wait: 15000 }), onError: 'continueErrorOutput', webhookId: nid() });

export const gmailSendAndWait = (name, subjectExpr, htmlExpr, fields, deadlineExpr, o = {}) => N(name, B + 'gmail', 2.1, {
  operation: 'sendAndWait', sendTo: '={{ $env.OWNER_EMAIL }}', subject: subjectExpr, message: htmlExpr,
  responseType: 'customForm', defineForm: 'fields',
  formFields: { values: fields },
  options: {
    appendAttribution: false, messageButtonLabel: o.button ?? 'Review',
    responseFormTitle: o.title ?? 'ShortCircuit review', responseFormButtonLabel: 'Send',
    limitWaitTime: { values: { limitType: 'atSpecifiedTime', maxDateAndTime: deadlineExpr } },
  },
}, { credentials: CRED.gmail, ...retry({ tries: 3, wait: 15000 }), onError: 'continueErrorOutput', webhookId: nid() });

export const gmailApprovalTool = (name, subjectExpr, messageExpr) => N(name, B + 'gmailHitlTool', 2.1, {
  operation: 'sendAndWait', sendTo: '={{ $env.OWNER_EMAIL }}', subject: subjectExpr, message: messageExpr,
  responseType: 'approval',
  approvalOptions: { values: { approvalType: 'double', approveLabel: 'Approve', disapproveLabel: 'Decline' } },
  options: { appendAttribution: false, limitWaitTime: { values: { limitType: 'afterTimeInterval', resumeAmount: 1, resumeUnit: 'hours' } } },
}, { credentials: CRED.gmail, webhookId: nid() });

const rl = (value, mode = 'id') => ({ __rl: true, value, mode });
export const driveUpload = (name, nameExpr, folderExpr) => N(name, B + 'googleDrive', 3, {
  name: nameExpr, driveId: rl('My Drive', 'list'), folderId: rl(folderExpr), options: {},
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveUpdate = (name, fileIdExpr) => N(name, B + 'googleDrive', 3, {
  operation: 'update', fileId: rl(fileIdExpr), changeFileContent: true, inputDataFieldName: 'data', options: {},
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveDownload = (name, fileIdExpr) => N(name, B + 'googleDrive', 3, {
  operation: 'download', fileId: rl(fileIdExpr), options: {},
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveDelete = (name, fileIdExpr) => N(name, B + 'googleDrive', 3, {
  operation: 'deleteFile', fileId: rl(fileIdExpr), options: { deletePermanently: true },
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveShareFolder = (name, folderExpr, emailExpr) => N(name, B + 'googleDrive', 3, {
  resource: 'folder', operation: 'share', folderNoRootId: rl(folderExpr),
  permissionsUi: { permissionsValues: { role: 'reader', type: 'user', emailAddress: emailExpr } },
  options: { sendNotificationEmail: true },
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveCreateFolder = (name, nameExpr, parentExpr) => N(name, B + 'googleDrive', 3, {
  resource: 'folder', name: nameExpr, driveId: rl('My Drive', 'list'), folderId: rl(parentExpr ?? 'root', parentExpr ? 'id' : 'list'), options: {},
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput' });
export const driveSearch = (name, queryExpr) => N(name, B + 'googleDrive', 3, {
  resource: 'fileFolder', searchMethod: 'query', queryString: queryExpr, returnAll: true, filter: {}, options: { fields: ['id', 'name', 'parents'] },
}, { credentials: CRED.drive, ...retry({ tries: 3, wait: 20000 }), onError: 'continueErrorOutput', alwaysOutputData: true });

export const ytUpload = (name, o) => N(name, B + 'youTube', 1, {
  resource: 'video', operation: 'upload', title: o.title, regionCode: 'US', categoryId: '28', binaryProperty: 'data',
  options: { description: o.description, tags: o.tags, privacyStatus: o.privacy, publishAt: o.publishAt, selfDeclaredMadeForKids: false, notifySubscribers: false },
}, { credentials: CRED.yt, ...retry({ tries: 2, wait: 30000 }), onError: 'continueErrorOutput' });
export const ytDelete = (name, idExpr) => N(name, B + 'youTube', 1, { resource: 'video', operation: 'delete', videoId: idExpr, options: {} },
  { credentials: CRED.yt, ...retry({ tries: 3, wait: 15000 }), onError: 'continueErrorOutput' });

// ---------- forms ----------
export const formTrigger = (name, o) => N(name, B + 'formTrigger', 2.2, {
  authentication: 'basicAuth', formTitle: o.title, formDescription: o.description ?? '',
  formFields: { values: o.fields }, options: { path: o.path, appendAttribution: false, buttonLabel: o.button ?? 'Submit' },
}, { credentials: { httpBasicAuth: CRED.cancelForm.httpBasicAuth }, webhookId: nid() });
export const formEnd = (name, titleExpr, messageExpr) => N(name, B + 'form', 1, {
  operation: 'completion', respondWith: 'text', completionTitle: titleExpr, completionMessage: messageExpr, options: {},
}, { webhookId: nid() });

// ---------- data tables / evaluations ----------
export const dtGet = (name, table) => N(name, B + 'dataTable', 1, { resource: 'row', operation: 'get', dataTableId: { __rl: true, value: table, mode: 'name' }, returnAll: true, options: {} }, { alwaysOutputData: true });
export const evalTrigger = (name, table) => N(name, B + 'evaluationTrigger', 4.6, { source: 'dataTable', dataTableId: { __rl: true, value: table, mode: 'name' } });
export const evalMetrics = (name, metrics) => N(name, B + 'evaluation', 4.7, {
  operation: 'setMetrics', metric: 'customMetrics',
  metrics: { assignments: metrics.map(([n, v]) => ({ id: nid(), name: n, value: v, type: 'number' })) },
});
export const evalCorrectness = (name, expectedExpr, actualExpr) => N(name, B + 'evaluation', 4.7, {
  operation: 'setMetrics', metric: 'correctness', expectedAnswer: expectedExpr, actualAnswer: actualExpr, options: {},
});
export const evalCheck = (name) => N(name, B + 'evaluation', 4.7, { operation: 'checkIfEvaluating' });

// Reusable SQL-snippet: the worker claim (PLAN §10.3)
export const CLAIM_SQL = (statuses, extraWhere = '') => `UPDATE jobs SET locked_at = now(), attempts = attempts + 1, updated_at = now()
WHERE id = (SELECT id FROM jobs
            WHERE status = ANY(ARRAY[${statuses.map((s) => `'${s}'`).join(', ')}]) AND attempts < 3
              AND (locked_at IS NULL OR locked_at < now() - interval '90 minutes')${extraWhere}
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *, 'SC-' || lpad(id::text, 4, '0') AS job;`;

// Fail branch: keep the job, record the error, release the lock (PLAN §10.3)
export const FAIL_SQL = `UPDATE jobs SET last_error = left($2, 2000), locked_at = NULL, render_started_at = NULL, updated_at = now() WHERE id = $1;`;
export const failNode = (name = 'Fail', idExpr = "$('Claim').first().json.id") =>
  pg(name, FAIL_SQL, [idExpr, `String($json.error?.message ?? $json.error ?? $json.message ?? 'unknown error') + ' @ ' + ($json.error?.node?.name ?? $prevNode.name)`]);

export const ACTIVE = ['new', 'script_review', 'needs_human', 'revising', 'script_approved', 'video_review', 'video_editing', 'approved', 'awaiting_upload', 'scheduled'];

// ---------- ShortCircuit call patterns ----------
// sc.llm call for one agent. user: expression body for the user message (without {{ }}).
export const llm = (name, agent, user, o = {}) => exec(name, 'sc.llm', {
  agent, prompt: o.prompt ?? agent, user_content: '={{ ' + user + ' }}',
  chain: o.chain ?? `={{ $env.LLM_CHAIN_${agent.toUpperCase()} }}`,
  exclude_provider: o.exclude ? '={{ ' + o.exclude + ' }}' : '',
  temperature: `={{ ${o.temp ?? 0.4} }}`,
}, { err: true });
// sc.ask_master judge call. Never throws (PLAN §5.1).
export const askMaster = (name, task, jobIdExpr, contextExpr, o = {}) => exec(name, 'sc.ask_master', {
  task, job_id: jobIdExpr ? '={{ ' + jobIdExpr + ' }}' : '', context: '={{ ' + contextExpr + ' }}',
  image_path: o.image ? '={{ ' + o.image + ' }}' : '',
}, { err: true });
// Start sc.review and do not wait (PLAN §10.3 review order).
export const startReview = (name, jobIdExpr, kindExpr, reasonExpr = "''", o = {}) => exec(name, 'sc.review', {
  job_id: '={{ ' + jobIdExpr + ' }}', kind: '={{ ' + kindExpr + ' }}', reason: '={{ ' + reasonExpr + ' }}',
}, { wait: false, each: o.each });
export const sendJobMail = (name, jobIdExpr, o = {}) => exec(name, 'sc.mail', { job_id: '={{ ' + jobIdExpr + ' }}' }, { err: true, each: o.each });
export const alert = (name, keyExpr, subjectExpr, textExpr, o = {}) => exec(name, 'sc.alert', {
  key: '={{ ' + keyExpr + ' }}', subject: '={{ ' + subjectExpr + ' }}', text: '={{ ' + textExpr + ' }}',
}, { err: true, each: o.each });
// JSON for a jsonb query parameter
export const J = (expr) => `JSON.stringify(${expr})`;
