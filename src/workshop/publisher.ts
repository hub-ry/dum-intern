import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import type { BuildInput, BuildOptions, BuildResult } from './types.ts';
import { MAX_TITLE, MAX_AMBITION, MAX_CONCEPT, MAX_TEXT, MAX_TEACHINGS_PER_GOAL, validateBuildResult } from './validate.ts';

const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const TESTID_RE = /^[a-z][a-z0-9-]{0,48}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_PNG = 4 * 1024 * 1024;
const CLI_TIMEOUT_MS = 600_000;
const VERIFY_TIMEOUT_MS = 90_000;
const RM_TIMEOUT_MS = 10_000;
const CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const HOST_MACHINERY = [
  'Claude Code CLI invoked in print mode with no tools, no hooks, no MCP and a strict JSON schema to generate the creation source',
  'Node publisher (src/workshop/publisher.ts) validating inputs, source, and verifier output host-side without executing model JavaScript',
  'Inline browser rendering: a single self-contained HTML document with inline CSS/JS and a forced restrictive Content-Security-Policy',
  'Playwright verification inside an isolated, offline, read-only, unprivileged Docker container that screenshots cumulative tested state',
  'Hosting requirement: demo.html must be served from a separate sandbox origin by the parent application',
];

const Id = z.string().regex(ID_RE);
const InputSchema = z.object({
  id: Id,
  goal: z.object({ id: Id, title: z.string().min(1).max(MAX_TITLE), ambition: z.string().max(MAX_AMBITION), context: z.string() }),
  teachings: z
    .array(z.object({ id: Id, concept: z.string().min(1).max(MAX_CONCEPT), text: z.string().min(1).max(MAX_TEXT), createdAt: z.string().min(1).max(64) }))
    .min(1)
    .max(MAX_TEACHINGS_PER_GOAL),
  globalContext: z.string(),
  correction: z.string().max(MAX_TEXT).optional(),
  parentId: Id.optional(),
  parent: z.object({ html: z.string().min(1).max(200000), presentation: z.unknown() }).optional(),
}).refine((input) => (input.parentId !== undefined) === (input.parent !== undefined), { message: 'Parent ID and verified parent creation must be provided together' });

const ActionSchema = z.strictObject({
  kind: z.enum(['click', 'fill']),
  target: z.string().regex(TESTID_RE),
  value: z.string().max(500),
  expectedBefore: z.string().max(2000),
  expectedAfter: z.string().min(1).max(2000),
});
const PanelSchema = z.strictObject({
  caption: z.string().min(1).max(600),
  code: z.string().max(4000),
  teachingIds: z.array(Id).max(20),
  observe: z.string().regex(TESTID_RE),
  expected: z.string().min(1).max(2000),
  actions: z.array(ActionSchema).min(0).max(4),
});
const ModelSchema = z.strictObject({
  title: z.string().min(1).max(120),
  html: z.string().min(1).max(160000),
  panels: z.array(PanelSchema).min(3).max(8),
  supportingMachinery: z.array(z.string().min(1).max(300)).min(1).max(12),
});
type ModelOutput = z.infer<typeof ModelSchema>;

const CliResultSchema = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  structured_output: z.unknown().optional(),
  modelUsage: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  total_cost_usd: z.number().optional(),
});

const ReportSchema = z.strictObject({
  ok: z.literal(true),
  nonce: z.string().regex(HEX64),
  sourceHash: z.string().regex(HEX64),
  initialSha256: z.string().regex(HEX64),
  panels: z
    .array(
      z.strictObject({
        actual: z.string().max(2000),
        actions: z
          .array(
            z.strictObject({
              kind: z.enum(['click', 'fill']),
              target: z.string().regex(TESTID_RE),
              before: z.string().max(2000),
              after: z.string().max(2000),
              beforeHash: z.string().regex(HEX64),
              afterHash: z.string().regex(HEX64),
            }),
          )
          .max(4),
        image: z.string().regex(/^panel-[1-8]\.png$/),
        sha256: z.string().regex(HEX64),
      }),
    )
    .min(3)
    .max(8),
});

const SYSTEM_PROMPT = `You are the Workshop publisher. Build ONE small, real, deterministic, interactive creation as a single self-contained HTML document that genuinely exercises the concepts the learner was taught. Input (stdin JSON): goal, globalContext, optional parent (verified HTML and presentation to revise), teachings (chronological; the LAST teaching is the most recent and MUST be the centerpiece), optional correction (a revision request: fix exactly what it says while keeping the creation's identity).
Rules:
- html: complete document with <head> and <body>, inline <style> and inline <script> only. No external resources, no <script src>, <link>, <iframe>, <object>, <embed>, <base>, <meta http-equiv>, no fetch/XHR/WebSocket/workers/storage, no timers, no Math.random/Date dependence for visible output. Everything must render deterministically at 1100x760 without scrolling.
- Interactivity only through elements carrying data-testid attributes matching ^[a-z][a-z0-9-]{0,48}$ (unique per document). Buttons for click, inputs/textareas for fill.
- panels (3..8) are a cumulative walkthrough on ONE page: panel 1 shows the initial state and has zero actions; later panels perform 0..4 actions (click/fill, value is '' for click) that MUST visibly change the trimmed innerText of the 'observe' element, then 'expected' is the exact trimmed innerText of that element after the actions. Include at least one 'branch' exercise: a different input path leading to a different observable result. At least one action overall must change text.
- Every action declares expectedBefore and expectedAfter: exact trimmed innerText of that panel's observe element immediately before and after the action. These values must differ. Each is checked in the browser, not assumed from your narration.
- Each panel's code must be an EXACT verbatim substring of the inline JavaScript source (or '' when none applies); at least one panel must have nonempty code. Captions explain which taught concepts the code applies and why in plain language. Put record IDs only in the teachingIds metadata field, using IDs from the provided teachings; never print UUIDs in captions. Do not invent quotes, claim mastery, or restate the teaching text or goal context inside the demo.
- supportingMachinery: 1..12 short distinct items describing what the creation relies on (browser APIs, data structures, CSS techniques), each clearly different.
- Never emit file paths, test code, or anything outside the schema.`;

interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number; signal?: AbortSignal }
interface RunResult { code: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], o: RunOpts): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new Error(`${cmd} aborted before start`));
    const child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, shell: false });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let done = false;
    const killGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const onAbort = () => fail(new Error(`${cmd} aborted`));
    const timer = setTimeout(() => fail(new Error(`${cmd} timed out after ${o.timeoutMs}ms`)), o.timeoutMs);
    const cleanup = () => { clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };
    const fail = (e: Error) => { if (done) return; done = true; cleanup(); killGroup(); reject(e); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    child.on('error', fail);
    child.stdout.on('data', (b: Buffer) => { outLen += b.length; if (outLen > MAX_OUTPUT) return fail(new Error(`${cmd} stdout exceeded ${MAX_OUTPUT} bytes`)); out.push(b); });
    child.stderr.on('data', (b: Buffer) => { errLen += b.length; if (errLen > MAX_OUTPUT) return fail(new Error(`${cmd} stderr exceeded ${MAX_OUTPUT} bytes`)); err.push(b); });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      cleanup();
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => { /* consumer closed early */ });
    child.stdin.end(o.stdin ?? '');
  });
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const shq = (s: string) => (/^[A-Za-z0-9_/:=.,@-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const tail = (s: string, n = 2000) => (s.length > n ? s.slice(-n) : s);

async function preflightImage(signal?: AbortSignal): Promise<{ tag: string; id: string }> {
  const tag = process.env.DUM_WORKSHOP_BROWSER_IMAGE || 'dum-workshop-browser:1';
  let r: RunResult;
  try {
    r = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], { env: process.env, timeoutMs: 30_000, signal });
  } catch (e) {
    throw new Error(`Docker is required for workshop verification but could not be invoked: ${(e as Error).message}`);
  }
  const id = r.stdout.trim();
  if (r.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new Error(
      `Prerequisite missing: Docker image ${tag} unavailable (docker image inspect exit ${r.code}). Build it first with: docker build -f src/workshop/publisher.Dockerfile -t dum-workshop-browser:1 .`,
    );
  }
  return { tag, id };
}

async function prepareJobDir(artifactRoot: string, id: string): Promise<string> {
  if (typeof artifactRoot !== 'string' || !artifactRoot) throw new Error('artifactRoot is required');
  const resolved = path.resolve(artifactRoot);
  const st = await fs.lstat(resolved);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('artifactRoot must be a real directory, not a symlink');
  const real = await fs.realpath(resolved);
  if (real !== resolved) throw new Error(`artifactRoot must be canonical (${resolved} resolves to ${real})`);
  if (real.includes(',')) throw new Error('artifactRoot must not contain commas (Docker bind-mount syntax)');
  const jobDir = path.join(real, id);
  await fs.mkdir(jobDir, { mode: 0o755 }); // exclusive: fails with EEXIST, never overwrites
  return jobDir;
}

function pickUsage(usage: Record<string, Record<string, unknown>> | undefined) {
  const keys = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests', 'costUSD'];
  const out: Record<string, Record<string, number>> = {};
  for (const [model, u] of Object.entries(usage ?? {})) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(model)) continue;
    const sel: Record<string, number> = {};
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) sel[k] = v;
    }
    out[model] = sel;
  }
  return out;
}

async function generate(input: BuildInput, signal?: AbortSignal) {
  const exe = process.env.DUM_CLAUDE_EXECUTABLE || 'claude';
  const requestedModel = process.env.DUM_WORKSHOP_MODEL || 'fable';
  const effort = process.env.DUM_WORKSHOP_EFFORT || 'medium';
  const schema = JSON.stringify(z.toJSONSchema(ModelSchema, { target: 'draft-07' }));
  const args = [
    '-p',
    '--model', requestedModel,
    '--effort', effort,
    '--safe-mode',
    '--tools', '',
    '--disable-slash-commands',
    '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true }),
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--no-chrome',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', schema,
    '--system-prompt', SYSTEM_PROMPT,
  ];
  const stdin = JSON.stringify({
    goal: input.goal,
    teachings: input.teachings,
    globalContext: input.globalContext,
    parent: input.parent ?? null,
    correction: input.correction ?? null,
    parentId: input.parentId ?? null,
  });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dum-workshop-cli-'));
  let r: RunResult;
  try {
    r = await run(exe, args, { cwd, env: process.env, stdin, timeoutMs: CLI_TIMEOUT_MS, signal });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
  if (r.code !== 0) {
    let diagnostic = r.stderr.trim() || r.stdout.trim();
    for (const [name, value] of Object.entries(process.env)) {
      if (value && value.length >= 8 && /key|token|secret|password|credential/i.test(name)) diagnostic = diagnostic.replaceAll(value, '[redacted credential]');
    }
    for (const text of [input.goal.context, input.goal.ambition, input.globalContext, input.correction, input.parent?.html, input.parent ? JSON.stringify(input.parent.presentation) : undefined, ...input.teachings.map((t) => t.text)]) {
      if (text && text.length >= 8) {
        diagnostic = diagnostic.replaceAll(text, '[private input]').replaceAll(JSON.stringify(text).slice(1, -1), '[private input]');
      }
    }
    diagnostic = diagnostic.replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi, '[redacted credential]');
    throw new Error(`Model CLI exited with ${r.code} (requested ${requestedModel}, no fallback): ${tail(diagnostic) || 'no diagnostic output'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error('Model CLI produced non-JSON output');
  }
  if (Array.isArray(parsed)) parsed = parsed.find((m) => m && typeof m === 'object' && (m as { type?: string }).type === 'result');
  const res = CliResultSchema.safeParse(parsed);
  if (!res.success) throw new Error('Model CLI result has unexpected shape');
  const cli = res.data;
  if (cli.is_error) throw new Error(`Model CLI reported an error (${cli.subtype ?? 'unknown'})`);
  if (cli.subtype !== undefined && cli.subtype !== 'success') throw new Error(`Model CLI failed: ${cli.subtype}`);
  if (cli.structured_output === undefined || cli.structured_output === null) throw new Error('Model CLI returned no structured_output');
  const model = ModelSchema.safeParse(cli.structured_output);
  if (!model.success) throw new Error(`Model output failed schema validation: ${model.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8).join('; ')}`);
  const modelUsage = pickUsage(cli.modelUsage);
  const canonicalModels = Object.keys(modelUsage);
  if (!canonicalModels.length) throw new Error('Model CLI returned no model usage metadata');
  if (requestedModel.startsWith('claude-') && !canonicalModels.includes(requestedModel)) {
    throw new Error(`Requested model ${requestedModel} does not match canonical model(s) ${canonicalModels.join(', ')}`);
  }
  return {
    model: model.data,
    meta: { requestedModel, effort, canonicalModels, modelUsage, totalCostUSD: cli.total_cost_usd ?? null },
  };
}

function extractInlineJs(html: string): string[] {
  const parts: string[] = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) parts.push(m[1]);
  return parts;
}

function validateModel(model: ModelOutput, input: BuildInput): string {
  const html = model.html;
  if (!/<head[\s>]/i.test(html) || !/<body[\s>]/i.test(html)) throw new Error('Demo HTML must contain <head> and <body>');
  if (/<script\b[^>]*\ssrc\s*=/i.test(html)) throw new Error('Demo HTML must not load external scripts');
  if (/<(iframe|object|embed|base|link)[\s>/]/i.test(html)) throw new Error('Demo HTML must not contain iframe/object/embed/base/link elements');
  if (/<meta\b[^>]*http-equiv/i.test(html)) throw new Error('Demo HTML must not contain http-equiv meta tags');
  const js = extractInlineJs(html);
  if (!js.some((source) => source.trim())) throw new Error('Demo HTML has no inline JavaScript');
  for (const t of input.teachings) {
    const txt = t.text.trim();
    if (txt.length >= 60 && html.includes(txt)) throw new Error('Demo HTML must not embed teaching text');
  }
  for (const ctx of [input.goal.context.trim(), input.globalContext.trim()]) {
    if (ctx.length >= 60 && html.includes(ctx)) throw new Error('Demo HTML must not embed private context');
  }

  const known = new Set(input.teachings.map((t) => t.id));
  const recent = input.teachings.at(-1)!;
  let hasCode = false;
  let recentRef = false;
  let actions = 0;
  model.panels.forEach((p, i) => {
    if (i === 0 && p.actions.length) throw new Error('First panel must not have actions');
    for (const id of p.teachingIds) if (!known.has(id)) throw new Error(`Panel ${i + 1} references unknown teaching ${id}`);
    if (p.teachingIds.includes(recent.id)) recentRef = true;
    if (p.code.length) {
      if (!js.some((source) => source.includes(p.code))) throw new Error(`Panel ${i + 1} code is not a verbatim substring of an inline script`);
      hasCode = true;
    }
    actions += p.actions.length;
  });
  if (!hasCode) throw new Error('At least one panel must show real source code');
  if (!recentRef) throw new Error(`Most recent teaching ${recent.id} is not referenced by any panel`);
  if (!actions) throw new Error('At least one panel must perform an action');
  return html.replace(/<head\b[^>]*>/i, (m) => `${m}<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
}

function checkPng(buf: Buffer) {
  if (buf.length > MAX_PNG) throw new Error('capture exceeds 4MB');
  if (buf.length < 24 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('capture is not a PNG');
  if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') throw new Error('capture missing IHDR');
  if (buf.readUInt32BE(16) !== 1100 || buf.readUInt32BE(20) !== 760) throw new Error('capture has wrong dimensions');
}

async function verify(jobDir: string, imageId: string, nonce: string, sourceHash: string, panels: ModelOutput['panels'], signal?: AbortSignal) {
  const captures = path.join(jobDir, 'captures');
  let uid = process.getuid?.() ?? 10001;
  let gid = process.getgid?.() ?? 10001;
  if (uid === 0) {
    uid = 10001;
    gid = 10001;
    await fs.chown(captures, uid, gid);
  }
  const name = `dum-verify-${randomBytes(8).toString('hex')}`;
  const args = [
    'run', '--rm', '--pull=never', '--name', name, '--network', 'none', '--user', `${uid}:${gid}`,
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--tmpfs', '/tmp:rw,size=256m,nosuid', '--pids-limit', '128', '--memory', '768m', '--memory-swap', '768m',
    '--cpus', '1', '--ulimit', 'nofile=1024:1024', '--stop-timeout', '1',
    '--mount', `type=bind,src=${jobDir},dst=/creation,readonly`,
    '--mount', `type=bind,src=${captures},dst=/captures`,
    imageId, 'node', '/opt/workshop/publisher-verifier.mjs',
  ];
  const command = ['docker', ...args].map(shq).join(' ');
  let r: RunResult;
  try {
    r = await run('docker', args, { env: process.env, timeoutMs: VERIFY_TIMEOUT_MS, signal });
  } finally {
    await run('docker', ['rm', '-f', name], { env: process.env, timeoutMs: RM_TIMEOUT_MS }).catch(() => undefined);
  }
  if (r.code !== 0) throw new Error(`Verification failed in container: ${tail(r.stderr) || tail(r.stdout) || `exit ${r.code}`}`);

  const reportPath = path.join(captures, 'report.json');
  const rst = await fs.lstat(reportPath);
  if (rst.isSymbolicLink() || !rst.isFile() || rst.size > MAX_OUTPUT) throw new Error('Verifier report is invalid');
  const parsed = ReportSchema.safeParse(JSON.parse(await fs.readFile(reportPath, 'utf8')));
  if (!parsed.success) throw new Error('Verifier report failed schema validation');
  const report = parsed.data;
  if (report.nonce !== nonce) throw new Error('Verifier report nonce mismatch');
  if (report.sourceHash !== sourceHash) throw new Error('Verifier report source hash mismatch');
  if (report.panels.length !== panels.length) throw new Error('Verifier report panel count mismatch');
  let changed = 0;
  report.panels.forEach((rp, i) => {
    const mp = panels[i];
    if (rp.actual !== mp.expected) throw new Error(`Panel ${i + 1} actual text differs from expected`);
    if (rp.image !== `panel-${i + 1}.png`) throw new Error(`Panel ${i + 1} image name mismatch`);
    if (rp.actions.length !== mp.actions.length) throw new Error(`Panel ${i + 1} action count mismatch`);
    rp.actions.forEach((ra, j) => {
      const ma = mp.actions[j];
      if (ra.kind !== ma.kind || ra.target !== ma.target) throw new Error(`Panel ${i + 1} action ${j + 1} mismatch`);
      if (ra.before !== ma.expectedBefore || ra.after !== ma.expectedAfter) throw new Error(`Panel ${i + 1} action ${j + 1} actual state differs from declared before/after assertions`);
      if (ra.before === ra.after || ra.beforeHash === ra.afterHash) throw new Error(`Panel ${i + 1} action ${j + 1} produced no change`);
      changed++;
    });
  });
  if (!changed) throw new Error('No action produced a verified change');

  const allow = new Set(['report.json', ...panels.map((_, i) => `panel-${i + 1}.png`)]);
  const entries = await fs.readdir(captures);
  for (const e of entries) if (!allow.has(e)) throw new Error(`Unexpected capture file ${e}`);
  for (let i = 0; i < panels.length; i++) {
    const file = path.join(captures, `panel-${i + 1}.png`);
    const st = await fs.lstat(file);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error(`Capture ${i + 1} is not a regular file`);
    if (st.size > MAX_PNG) throw new Error(`Capture ${i + 1} exceeds 4MB`);
    const buf = await fs.readFile(file);
    checkPng(buf);
    if (sha256(buf) !== report.panels[i].sha256) throw new Error(`Capture ${i + 1} hash mismatch`);
  }
  await fs.rm(reportPath, { force: true });
  return { report, command };
}

export async function buildCreation(input: BuildInput, options: BuildOptions): Promise<BuildResult> {
  const parsedInput = InputSchema.safeParse(input);
  if (!parsedInput.success) throw new Error(`Invalid build input: ${parsedInput.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).slice(0, 8).join('; ')}`);
  const inp = parsedInput.data as BuildInput;
  if (new Set(inp.teachings.map((t) => t.id)).size !== inp.teachings.length) throw new Error('Teaching IDs must be unique');
  if (inp.teachings.some((t) => !Number.isFinite(Date.parse(t.createdAt)))) throw new Error('Teaching timestamps must be valid');
  if (inp.parent) inp.parent.presentation = validateBuildResult(inp.parent.presentation, new Set(inp.teachings.map((t) => t.id)));
  inp.teachings.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const { signal } = options;
  const image = await preflightImage(signal);
  const jobDir = await prepareJobDir(options.artifactRoot, inp.id);
  try {
    const { model, meta } = await generate(inp, signal);
    const html = validateModel(model, inp);
    signal?.throwIfAborted();
    const sourceHash = sha256(html);
    const nonce = randomBytes(32).toString('hex');
    const manifestPath = path.join(jobDir, '.verify.json');
    await fs.writeFile(path.join(jobDir, 'demo.html'), html, { flag: 'wx' });
    await fs.writeFile(
      manifestPath,
      JSON.stringify({ panels: model.panels.map((p) => ({ observe: p.observe, expected: p.expected, actions: p.actions })), sourceHash, nonce }),
      { flag: 'wx' },
    );
    await fs.mkdir(path.join(jobDir, 'captures'), { mode: 0o755 });
    const { report, command } = await verify(jobDir, image.id, nonce, sourceHash, model.panels, signal);
    signal?.throwIfAborted();
    const sourceStat = await fs.lstat(path.join(jobDir, 'demo.html'));
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 200_000 ||
        sha256(await fs.readFile(path.join(jobDir, 'demo.html'))) !== sourceHash) throw new Error('Verified demo source changed');
    await fs.rm(manifestPath, { force: true });
    const modelMeta = { requestedModel: meta.requestedModel, effort: meta.effort, canonicalModels: meta.canonicalModels, modelUsage: meta.modelUsage, totalCostUSD: meta.totalCostUSD };
    const output = JSON.stringify({ report, model: modelMeta }, null, 2);
    await fs.writeFile(path.join(jobDir, 'verification.json'), JSON.stringify({ report, model: modelMeta }, null, 2), { flag: 'wx' });
    const result = validateBuildResult({
      title: model.title,
      panels: model.panels.map((p, i) => ({
        image: `captures/panel-${i + 1}.png`,
        code: p.code || undefined,
        caption: p.caption,
        teachingIds: p.teachingIds,
      })),
      demoPath: 'demo.html',
      verification: { command, output },
      supportingMachinery: [...model.supportingMachinery, `Creation source generated by ${meta.canonicalModels.join(', ')} (requested ${meta.requestedModel}, effort ${meta.effort}); this does not retrain the model`, ...HOST_MACHINERY],
    }, new Set(inp.teachings.map((t) => t.id)));
    await fs.writeFile(path.join(jobDir, 'creation.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
    return result;
  } catch (e) {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Workshop publish failed for ${inp.id}: ${(e as Error).message}`);
  }
}
