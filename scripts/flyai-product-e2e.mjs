import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Product boundary probe for the installed package.  The model relay and FlyAI
// CLI are local fixtures; no upstream API or user state is touched.
// Usage: node scripts/flyai-product-e2e.mjs <installed-gotry-bin> <new-output-dir>
const [binaryArg, outputArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg, 'Expected installed GoTry binary and a new output directory');
const binary = resolve(binaryArg);
const output = resolve(outputArg);
assert.ok(existsSync(binary), `Installed GoTry binary is missing: ${binary}`);
assert.ok(!existsSync(output), 'Preserve prior evidence by using a new output directory');
mkdirSync(output, { recursive: true });

const candidateKey = 'synthetic-flyai-key-521-abcdef';
const modelKey = 'synthetic-model-only';
const boundary = 'Controlled installed GoTry product + local SSE model/CLI fixtures; no live provider acceptance.';
const commands = [
  'search-flight', 'search-train', 'search-hotel', 'search-poi',
  'keyword-search', 'ai-search', 'search-marriott-hotel', 'search-marriott-package',
];
const commandKind = new Map([
  ['search-flight', 'flight'], ['search-train', 'train'], ['search-hotel', 'hotel'],
  ['search-poi', 'poi'], ['keyword-search', 'keyword'], ['ai-search', 'ai'],
  ['search-marriott-hotel', 'marriott-hotel'], ['search-marriott-package', 'marriott-package'],
]);

const chunk = (delta, finish = null) => `data: ${JSON.stringify({
  id: 'flyai-product-e2e', object: 'chat.completion.chunk', created: 1,
  model: 'controlled-model', choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;
const toolReply = calls => chunk({
  role: 'assistant',
  tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: 'function',
    function: { name: 'gotry_flyai_search', arguments: JSON.stringify(call.args) },
  })),
}) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalReply = () => chunk({
  role: 'assistant',
  content: 'Controlled FlyAI product boundary complete; fixture observations are not live availability.',
}) + chunk({}, 'stop') + 'data: [DONE]\n\n';

const allCalls = [
  { id: 'flyai-flight', args: { kind: 'flight', from: '上海', to: '杭州', date: '2026-10-01', seatClassName: '经济舱' } },
  { id: 'flyai-train', args: { kind: 'train', from: '上海', to: '杭州', date: '2026-10-02', transportNo: 'G123' } },
  { id: 'flyai-hotel', args: { kind: 'hotel', to: '杭州', checkIn: '2026-10-15', checkOut: '2026-10-17', sort: 'price_asc' } },
  { id: 'flyai-poi', args: { kind: 'poi', to: '杭州', poiLevel: 5, category: '博物馆' } },
  { id: 'flyai-keyword', args: { kind: 'keyword', query: '杭州西湖' } },
  { id: 'flyai-ai', args: { kind: 'ai', query: '杭州周末旅行建议' } },
  { id: 'flyai-marriott-hotel', args: { kind: 'marriott-hotel', to: '杭州', checkIn: '2026-10-15', checkOut: '2026-10-17', hotelBrands: '万豪', hotelName: '杭州万豪' } },
  { id: 'flyai-marriott-package', args: { kind: 'marriott-package', keyword: '杭州', sortType: 'price_asc' } },
];

const successTransport = (command) => ({
  adultPrice: 888,
  jumpUrl: `https://fixture.invalid/${command}`,
  journeys: [{ segments: [{
    marketingTransportNo: command === 'search-flight' ? 'E2E521' : 'G123',
    marketingTransportName: 'Fixture Transport',
    depDateTime: '2026-10-01 08:00:00',
    arrDateTime: '2026-10-01 11:00:00',
    depStationName: '上海虹桥', arrStationName: '杭州东', duration: 180,
    seatClassName: '经济舱',
  }] }],
});
const successHotel = (command) => ({
  name: command === 'search-marriott-hotel' ? 'Fixture Marriott Hotel' : 'Fixture Hotel',
  star: '5', price: '¥7xx', rate: '4.8', address: 'Fixture Road', interestsPoi: 'West Lake',
  shId: 'hotel-521', detailUrl: `https://fixture.invalid/${command}/jump`,
  mainPic: `https://fixture.invalid/${command}/main.jpg`, score: '4.8', scoreDesc: 'Excellent',
  review: 'Fixture review', brandName: 'Fixture Brand', latitude: '30.25', longitude: '120.16',
});
const successItem = command => {
  if (command === 'search-flight' || command === 'search-train') return successTransport(command);
  if (command === 'search-hotel' || command === 'search-marriott-hotel') return successHotel(command);
  if (command === 'search-poi') return {
    id: 'poi-521', name: 'Fixture Museum', mainPic: 'https://fixture.invalid/poi/main.jpg',
    jumpUrl: 'https://fixture.invalid/poi/jump', address: 'Fixture Street', freePoiStatus: '收费',
    ticketInfo: { price: '¥80', priceDate: '2026-10-01', ticketName: '成人票' },
  };
  if (command === 'keyword-search') return { info: {
    title: 'Fixture Keyword', jumpUrl: 'https://fixture.invalid/keyword/jump',
    picUrl: 'https://fixture.invalid/keyword/pic.jpg', price: '¥7xx', scoreDesc: '4.8', star: '5', tags: ['fixture'],
  } };
  if (command === 'search-marriott-package') return {
    name: 'Fixture Marriott Package', brandName: '万豪', hotelName: '杭州万豪', cityName: '杭州',
    price: '¥7xx', detailUrl: 'https://fixture.invalid/package/jump',
    mainPic: 'https://fixture.invalid/package/main.jpg', sellingPoint: 'Fixture package',
  };
  return null;
};

function writeFakeNpx(path) {
  const successItems = Object.fromEntries(commands.map(command => [command, successItem(command)]));
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const commands = ${JSON.stringify(commands)};
const successItems = ${JSON.stringify(successItems)};
const command = args.find(value => commands.includes(value));
const kind = command ? ({${[...commandKind.entries()].map(([key, value]) => JSON.stringify(key) + ':' + JSON.stringify(value)).join(',')}})[command] : 'unknown';
const eventsPath = process.env.GOTRY_FLYAI_EVENTS;
const event = { source: process.env.GOTRY_FLYAI_PRODUCT_RUN === '1' ? 'product' : 'setup', command, kind, args, pid: process.pid, keyPresent: Boolean(process.env.FLYAI_API_KEY), at: Date.now() };
if (eventsPath) fs.appendFileSync(eventsPath, JSON.stringify(event) + '\\n');
const scenario = process.env.GOTRY_FLYAI_SCENARIO || 'success';
const root = process.env.GOTRY_FLYAI_FIXTURE_ROOT || process.cwd();
const marker = path.join(root, '.ordinary-429-seen');
if (scenario === 'auth-401') { process.stderr.write('HTTP 401 Invalid API key fixture'); process.exit(41); }
if (scenario === 'trial-429') { process.stderr.write('HTTP 429 Trial limit reached fixture'); process.exit(42); }
if (scenario === 'ordinary-429' && !fs.existsSync(marker)) { fs.writeFileSync(marker, 'seen'); process.stderr.write('HTTP 429 ordinary rate limit fixture'); process.exit(43); }
let payload;
if (scenario === 'malformed') payload = { data: { itemList: [{}] }, systemMessage: 'fixture malformed response' };
else if (scenario === 'empty') payload = { data: { itemList: [] }, systemMessage: 'fixture empty response' };
else if (command === 'ai-search') payload = { data: { answer: 'Fixture AI result', maskedPrice: '¥7xx' }, systemMessage: 'fixture observation' };
else payload = { data: { itemList: command && successItems[command] ? [successItems[command]] : [] }, systemMessage: 'fixture observation' };
process.stdout.write(JSON.stringify(payload));
`;
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function runProcess(args, env, cwd, input = '', timeoutMs = 20_000) {
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let signal = null;
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { stdout += data.toString(); });
  child.stderr.on('data', data => { stderr += data.toString(); });
  const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const result = await new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.once('error', rejectResult);
    child.once('close', (code, closedSignal) => {
      clearTimeout(timer); signal = closedSignal;
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
    if (input) child.stdin.end(input); else child.stdin.end();
  }).finally(() => { if (timedOut) kill(); });
  return result;
}

async function runModelProduct({ root, env, scenario, prompt, relay }) {
  let stage = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
      response.writeHead(404).end(); return;
    }
    let raw = '';
    request.on('data', data => { raw += data.toString(); });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw);
        relay.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (stage++ === 0) {
          const calls = scenario === 'success' ? allCalls : [{ id: `flyai-${scenario}`, args: { kind: 'flight', from: '上海', to: '杭州', date: '2026-10-01' } }];
          response.end(toolReply(calls));
        } else response.end(finalReply());
      } catch (error) {
        relay.push({ fixtureError: String(error), raw });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(finalReply());
      }
    });
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  const runEnv = {
    ...env,
    LLM_API_KEY: modelKey,
    LLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
    LLM_MODEL: 'controlled-model',
    GOTRY_FLYAI_PRODUCT_RUN: '1',
    GOTRY_FLYAI_SCENARIO: scenario,
  };
  let result;
  try {
    result = await runProcess([prompt], runEnv, join(root, 'cwd'), '', 60_000);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolveClose => server.close(resolveClose));
  }
  return result;
}

function toolMessages(relay) {
  return relay.flatMap(body => (body.messages ?? []).filter(message => message.role === 'tool'));
}

function assertNoKey(values) {
  for (const [label, value] of values) assert.doesNotMatch(String(value), new RegExp(candidateKey, 'g'), `credential leaked in ${label}`);
}

const report = { binary, node: process.version, boundary, validated: false, cases: [] };

async function runCase(scenario) {
  const root = mkdtempSync(join(tmpdir(), `gotry-flyai-${scenario}-`));
  const home = join(root, 'home');
  const cwd = join(root, 'cwd');
  const bin = join(root, 'bin');
  const eventsPath = join(root, 'events.jsonl');
  for (const dir of [home, cwd, bin]) mkdirSync(dir, { recursive: true });
  const fakeNpx = join(bin, 'npx');
  writeFakeNpx(fakeNpx);
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HOME: home,
    DSH_HOME: join(home, 'dsh'),
    TMPDIR: root,
    GOTRY_TURN_HANDOFF_ROOT: cwd,
    GOTRY_SESSION_LIVE: '0',
    GOTRY_HBCLI_LIVE: '0',
    GOTRY_HOTELBYTE_SKILLS_LIVE: '0',
    GOTRY_FLYAI_EVENTS: eventsPath,
    GOTRY_FLYAI_FIXTURE_ROOT: root,
    GOTRY_FLYAI_CLI_BIN: fakeNpx,
    GOTRY_FLYAI_VERIFY_TIMEOUT_MS: '5000',
    FLYAI_API_KEY: scenario === 'success' ? undefined : candidateKey,
  };
  const cleanEnv = Object.fromEntries(Object.entries(baseEnv).filter(([, value]) => value !== undefined));
  const relay = [];
  let setup = null;
  let status = null;
  let doctor = null;
  if (scenario === 'success') {
    setup = await runProcess(['setup', 'flyai', '--stdin'], cleanEnv, cwd, `${candidateKey}\n`, 15_000);
    status = await runProcess(['setup', 'flyai', '--status'], cleanEnv, cwd, '', 15_000);
    doctor = await runProcess(['doctor'], cleanEnv, cwd, '', 20_000);
  }
  const prompt = scenario === 'success'
    ? '请严格调用 gotry_flyai_search 一次，依次执行 flight、train、hotel、poi、keyword、ai、marriott-hotel、marriott-package 八类只读查询，再报告每类受控观测。'
    : `请调用 gotry_flyai_search 做一次 ${scenario} 场景的只读查询，并原样说明结构化结果。`;
  const product = await runModelProduct({ root, env: cleanEnv, scenario, prompt, relay });
  const events = readJsonLines(eventsPath);
  const artifacts = {
    setup: setup ? { ...setup } : null,
    status: status ? { ...status } : null,
    doctor: doctor ? { ...doctor } : null,
    product: { ...product },
    events,
    relay,
  };
  const row = { scenario, root, events, relayRequests: relay.length, setup, status, doctor, product, passed: false };
  report.cases.push(row);
  writeFileSync(join(output, `${scenario}-evidence.json`), JSON.stringify(artifacts, null, 2));
  writeFileSync(join(output, `${scenario}-events.jsonl`), existsSync(eventsPath) ? readFileSync(eventsPath) : '');
  writeFileSync(join(output, `${scenario}-relay.json`), JSON.stringify(relay, null, 2));
  writeFileSync(join(output, `${scenario}-stdout.log`), product.stdout);
  writeFileSync(join(output, `${scenario}-stderr.log`), product.stderr);

  const productEvents = events.filter(event => event.source === 'product');
  const observations = toolMessages(relay);
  const relayText = JSON.stringify(relay);
  assertNoKey([
    ['setup stdout', setup?.stdout ?? ''], ['setup stderr', setup?.stderr ?? ''],
    ['status stdout', status?.stdout ?? ''], ['status stderr', status?.stderr ?? ''],
    ['doctor stdout', doctor?.stdout ?? ''], ['doctor stderr', doctor?.stderr ?? ''],
    ['product stdout', product.stdout], ['product stderr', product.stderr],
    ['relay', relayText], ['events', JSON.stringify(events)],
  ]);
  assert.equal(product.timedOut, false, `${scenario} product timed out`);
  assert.equal(product.code, 0, `${scenario} product failed: ${product.stderr}`);
  assert.match(product.stdout, /Controlled FlyAI product boundary complete/);
  assert.ok(relay.every(body => !body.fixtureError), 'relay fixture parser failed');

  if (scenario === 'success') {
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /已保存|验证/);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /source=config|已验证|verified/i);
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, /FlyAI/i);
    const configPath = join(home, '.flyai', 'config.json');
    assert.ok(existsSync(configPath), 'setup did not write isolated FlyAI config');
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'FlyAI config is not mode 0600');
    assert.deepEqual(new Set(productEvents.map(event => event.kind)), new Set(commands.map(command => commandKind.get(command))));
    const byKind = new Map(productEvents.map(event => [event.kind, event]));
    assert.ok(byKind.get('flight').args.includes('--origin') && byKind.get('flight').args.includes('上海'));
    assert.ok(byKind.get('train').args.includes('--transport-no') && byKind.get('train').args.includes('G123'));
    assert.ok(byKind.get('hotel').args.includes('--sort') && byKind.get('hotel').args.includes('price_asc'));
    assert.ok(byKind.get('poi').args.includes('--poi-level') && byKind.get('poi').args.includes('5'));
    assert.ok(byKind.get('marriott-hotel').args.includes('--hotel-brands') && byKind.get('marriott-hotel').args.includes('万豪'));
    assert.ok(byKind.get('marriott-package').args.includes('--sort-type') && byKind.get('marriott-package').args.includes('price_asc'));
    assert.match(relayText, /¥7xx/);
    assert.match(relayText, /fixture\.invalid\/search-hotel\/jump/);
    assert.match(relayText, /fixture observation/);
    assert.ok(observations.some(message => message.tool_call_id === 'flyai-hotel'));
  } else if (scenario === 'ordinary-429') {
    assert.equal(productEvents.length, 2, 'ordinary 429 should be retried once');
    assert.match(relayText, /hit|Fixture Transport/);
  } else if (scenario === 'auth-401') {
    assert.equal(productEvents.length, 1, '401 must not be retried');
    assert.match(relayText, /auth-error|鉴权失败|401/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  } else if (scenario === 'trial-429') {
    assert.equal(productEvents.length, 1, 'Trial 429 must not be retried');
    assert.match(relayText, /needs-setup|额度已用尽|Trial limit reached/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  } else if (scenario === 'malformed') {
    assert.equal(productEvents.length, 1, 'malformed response must not be retried');
    assert.match(relayText, /malformed|itemList/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  } else if (scenario === 'empty') {
    assert.equal(productEvents.length, 1);
    assert.match(relayText, /"verdict":"miss"|0 条|0\/0/);
  }
  row.passed = true;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  assertNoKey([`${scenario} receipt`, readFileSync(join(output, 'receipt.json'), 'utf8')]);
  console.log(JSON.stringify({ scenario, passed: true, productEvents: productEvents.length, relayRequests: relay.length }));
}

try {
  for (const scenario of ['success', 'auth-401', 'trial-429', 'ordinary-429', 'malformed', 'empty']) await runCase(scenario);
  report.validated = true;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ...report, validated: false, error: String(error?.stack ?? error) }, null, 2));
  throw error;
}
