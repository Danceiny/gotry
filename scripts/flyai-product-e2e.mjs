import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const ymd = value => value.toISOString().slice(0, 10);
const addDays = days => new Date(Date.now() + days * 86_400_000);
const fixtureDates = { flight: ymd(addDays(14)), train: ymd(addDays(15)), checkIn: ymd(addDays(21)), checkOut: ymd(addDays(23)) };

const chunk = (delta, finish = null) => `data: ${JSON.stringify({
  id: 'flyai-product-e2e', object: 'chat.completion.chunk', created: 1,
  model: 'controlled-model', choices: [{ index: 0, delta, finish_reason: finish }],
})}\n\n`;
const toolReply = calls => chunk({
  role: 'assistant',
  tool_calls: calls.map((call, index) => ({
    index, id: call.id, type: 'function',
    function: { name: call.name ?? 'gotry_flyai_search', arguments: JSON.stringify(call.args) },
  })),
}) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalReply = () => chunk({
  role: 'assistant',
  content: 'Controlled FlyAI product boundary complete; fixture observations are not live availability.',
}) + chunk({}, 'stop') + 'data: [DONE]\n\n';

const allCalls = [
  { id: 'flyai-flight', args: { kind: 'flight', from: '上海', to: '杭州', date: fixtureDates.flight, seatClassName: '经济舱' } },
  { id: 'flyai-train', args: { kind: 'train', from: '上海', to: '杭州', date: fixtureDates.train, transportNo: 'G123' } },
  { id: 'flyai-hotel', args: { kind: 'hotel', to: '杭州', checkIn: fixtureDates.checkIn, checkOut: fixtureDates.checkOut, sort: 'price_asc' } },
  { id: 'flyai-poi', args: { kind: 'poi', cityName: '杭州', poiLevel: 5, category: '博物馆' } },
  { id: 'flyai-keyword', args: { kind: 'keyword', query: '杭州西湖' } },
  { id: 'flyai-ai', args: { kind: 'ai', query: '杭州周末旅行建议' } },
  { id: 'flyai-marriott-hotel', args: { kind: 'marriott-hotel', to: '杭州', checkIn: fixtureDates.checkIn, checkOut: fixtureDates.checkOut, keyWords: '万豪,杭州万豪' } },
  // The official 1.0.16 invocation uses only --keyword for this command.
  { id: 'flyai-marriott-package', args: { kind: 'marriott-package', keyword: '杭州' } },
];

const successTransport = (command) => ({
  journeys: [{ journeyType: '直达', segments: [{
    arrCityAbroad: false, arrCityCode: '330100', arrCityName: '杭州',
    arrDateTime: `${command === 'search-flight' ? fixtureDates.flight : fixtureDates.train} 11:00:00`,
    arrStationCode: 'HGH', arrStationName: '杭州东站', arrStationShortName: '杭州东', arrTerm: null,
    arrWeekAbbrName: '周日', depCityAbroad: null, depCityCode: '310100', depCityName: '上海',
    depDateTime: `${command === 'search-flight' ? fixtureDates.flight : fixtureDates.train} 08:00:00`,
    depStationCode: 'AOH', depStationName: '上海虹桥站', depStationShortName: '上海虹桥', depTerm: null,
    depWeekAbbrName: '周日', duration: '180', marketingTransportName: command === 'search-flight' ? 'Fixture Air' : '高铁',
    marketingTransportNo: command === 'search-flight' ? 'E2E521' : 'G123', miles: null, quantity: null,
    seatClassName: command === 'search-flight' ? '经济舱' : '二等座', stopInfos: null, transportType: command === 'search-flight' ? '飞机' : '火车',
  }], totalDuration: '180', transferDuration: '' }],
  jumpUrl: `https://fixture.invalid/${command}`,
  price: '5x', totalDuration: '180',
});
const successHotel = (command) => ({
  address: 'Fixture Road', commissionMoneyYuan: null, decorationTime: '2024',
  detailUrl: `https://fixture.invalid/${command}/jump`, latitude: '30.25', longitude: '120.16',
  mainPic: `https://fixture.invalid/${command}/main.jpg`,
  name: command === 'search-marriott-hotel' ? 'Fixture Marriott Hotel' : 'Fixture Hotel',
  price: command === 'search-marriott-hotel' ? '¥360起/晚' : '¥1xx', rate: null,
  star: command === 'search-marriott-hotel' ? '高档型' : '经济型',
  ...(command === 'search-marriott-hotel' ? { nearbyPoi: 'West Lake', shid: 'hotel-521' } : { interestsPoi: 'West Lake', shId: 'hotel-521' }),
});
const successItem = command => {
  if (command === 'search-flight' || command === 'search-train') return successTransport(command);
  if (command === 'search-hotel' || command === 'search-marriott-hotel') return successHotel(command);
  if (command === 'search-poi') return {
    address: 'Fixture Street', category: '历史古迹', description: 'Fixture description', freePoiStatus: 'FREE',
    id: 'poi-521', jumpUrl: 'https://fixture.invalid/poi/jump', latitude: '30.25', listRank: 'Fixture rank', longitude: '120.16',
    mainPic: 'https://fixture.invalid/poi/main.jpg', name: 'Fixture Museum', poiLevel: null, ticketInfo: null,
  };
  if (command === 'keyword-search') return { info: {
    commissionMoneyYuan: null, jumpUrl: 'https://fixture.invalid/keyword/jump',
    picUrl: 'https://fixture.invalid/keyword/pic.jpg', price: null, rate: null, scoreDesc: null,
    skuCommissionStruct: null, star: null, tags: null, title: 'Fixture Keyword',
  } };
  if (command === 'search-marriott-package') return {
    benefit: null, commissionMoneyYuan: null, detailUrl: 'https://fixture.invalid/package/jump', itemId: 'package-521',
    picUrl: 'https://fixture.invalid/package/main.jpg', price: '￥1199起/2晚', rate: null,
    sellPoint: 'Fixture package', title: 'Fixture Marriott Package',
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
const productRun = process.env.GOTRY_FLYAI_PRODUCT_RUN === '1';
const setupInjection = !productRun && Boolean(command) && args[0] === command;
const productInvocation = productRun && args[0] === '-y' && args[1] === '@fly-ai/flyai-cli@1.0.16';
const configPath = path.join(process.env.HOME || '', '.flyai', 'config.json');
let configKey;
try { configKey = JSON.parse(fs.readFileSync(configPath, 'utf8')).FLYAI_API_KEY; } catch {}
const expectedKey = process.env.GOTRY_FLYAI_EXPECTED_KEY;
const event = { source: productRun ? 'product' : 'setup', command, kind, args, pid: process.pid,
  keyPresent: Boolean(process.env.FLYAI_API_KEY), envKeyMatches: process.env.FLYAI_API_KEY === expectedKey,
  configKeyMatches: configKey === expectedKey, setupInjection, productInvocation, at: Date.now() };
if (eventsPath) fs.appendFileSync(eventsPath, JSON.stringify(event) + '\\n');
if ((!productRun && !setupInjection) || (productRun && !productInvocation)) {
  process.stderr.write('fixture rejected unexpected CLI invocation; only @fly-ai/flyai-cli@1.0.16 is allowed'); process.exit(64);
}
const scenario = process.env.GOTRY_FLYAI_SCENARIO || 'success';
const root = process.env.GOTRY_FLYAI_FIXTURE_ROOT || process.cwd();
const marker = path.join(root, '.ordinary-429-seen');
if (scenario === 'auth-401') { process.stderr.write('HTTP 401 Invalid API key fixture'); process.exit(41); }
if (scenario === 'forbidden-403') { process.stderr.write('HTTP 403 Forbidden fixture'); process.exit(43); }
if (scenario === 'trial-429') { process.stderr.write('HTTP 429 Trial limit reached fixture'); process.exit(42); }
if (scenario === 'sentinel') { process.stdout.write(JSON.stringify({ message: 'SentinelBlockException fixture' })); process.exit(0); }
if (scenario === 'timeout') { setTimeout(() => {}, 2_000); }
if (scenario === 'ordinary-429' && !fs.existsSync(marker)) { fs.writeFileSync(marker, 'seen'); process.stderr.write('HTTP 429 ordinary rate limit fixture'); process.exit(44); }
let payload;
if (scenario === 'malformed') payload = { data: { itemList: [{}] }, systemMessage: 'fixture malformed response' };
else if (scenario === 'empty') payload = { data: { itemList: [] }, systemMessage: 'fixture empty response' };
else if (command === 'ai-search') payload = {
  data: '基于飞猪搜索结果，杭州西湖景区 fixture observation：https://fixture.invalid/ai-result',
  message: 'success', status: 0, systemMessage: 'fixture observation',
};
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

function findFiles(root, wanted) {
  const found = [];
  const queue = [root];
  while (queue.length) {
    const dir = queue.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.name === wanted) found.push(path);
    }
  }
  return found;
}

function decodeToolContent(message) {
  if (typeof message?.content !== 'string') return message?.content ?? {};
  try { return JSON.parse(message.content); } catch {
    const embedded = message.content.match(/\{[\s\S]*\}/)?.[0];
    try { return embedded ? JSON.parse(embedded) : { raw: message.content }; } catch { return { raw: message.content }; }
  }
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

async function runModelProduct({ root, env, scenario, prompt, relay, relayMeta }) {
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
        const toolNames = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name);
        if (toolNames.includes('gotry_flyai_search')) {
          relayMeta.sawSearchTool = true;
          const setupTool = (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === 'gotry_flyai_setup');
          const searchTool = (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === 'gotry_flyai_search');
          if (scenario === 'success' && (!setupTool || !searchTool)) relayMeta.contractErrors.push('required FlyAI model tools missing');
          if (setupTool && JSON.stringify(setupTool.parameters ?? setupTool.function?.parameters ?? {}).match(/api[_-]?key|credential|secret|FLYAI_API_KEY/i)) {
            relayMeta.contractErrors.push('gotry_flyai_setup schema exposes credential input');
          }
          if (searchTool && JSON.stringify(searchTool.parameters ?? searchTool.function?.parameters ?? {}).match(/api[_-]?key|credential|secret|FLYAI_API_KEY/i)) {
            relayMeta.contractErrors.push('gotry_flyai_search schema exposes credential input');
          }
          for (const message of body.messages ?? []) {
            if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
            for (const call of message.tool_calls) {
              if ((call.function?.name ?? call.name) !== 'gotry_flyai_setup') continue;
              let args;
              try { args = JSON.parse(call.function?.arguments ?? '{}'); } catch { args = {}; }
              if (!relayMeta.setupCalls.some(previous => previous.id === call.id)) relayMeta.setupCalls.push({ id: call.id, args });
              if (Object.keys(args).some(key => key !== 'action') || !['status', 'check'].includes(args.action)) {
                relayMeta.contractErrors.push('gotry_flyai_setup received unexpected or credential argument');
              }
            }
          }
        }
        // Initialization requests may not expose tools. They never advance the
        // fixture state; only a relay body containing the search tool can do so.
        if (!toolNames.includes('gotry_flyai_search')) { response.writeHead(204).end(); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (scenario === 'success' && stage === 0) {
          stage = 1; response.end(toolReply([{ id: 'flyai-setup-status', name: 'gotry_flyai_setup', args: { action: 'status' } }]));
        } else if (scenario === 'success' && stage === 1) {
          stage = 2; response.end(toolReply([{ id: 'flyai-setup-check', name: 'gotry_flyai_setup', args: { action: 'check' } }]));
        } else if (scenario === 'success' && stage === 2) {
          stage = 3; response.end(toolReply(allCalls));
        } else if (scenario !== 'success' && stage === 0) {
          stage = 1;
          const timeoutMs = scenario === 'timeout' ? 100 : undefined;
          response.end(toolReply([{ id: `flyai-${scenario}`, args: { kind: 'flight', from: '上海', to: '杭州', date: fixtureDates.flight, ...(timeoutMs ? { timeoutMs } : {}) } }]));
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
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
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
    GOTRY_FLYAI_EXPECTED_KEY: candidateKey,
    FLYAI_API_KEY: scenario === 'success' ? undefined : candidateKey,
  };
  const cleanEnv = Object.fromEntries(Object.entries(baseEnv).filter(([, value]) => value !== undefined));
  const relay = [];
  const relayMeta = { sawSearchTool: false, contractErrors: [], setupCalls: [] };
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
  const product = await runModelProduct({ root, env: cleanEnv, scenario, prompt, relay, relayMeta });
  const events = readJsonLines(eventsPath);
  const factLogs = findFiles(root, 'bookable-facts.jsonl');
  const artifacts = {
    setup: setup ? { ...setup } : null,
    status: status ? { ...status } : null,
    doctor: doctor ? { ...doctor } : null,
    product: { ...product },
    events,
    factLogs,
    relayMeta,
    relay,
  };
  const row = { scenario, root, events, factLogs, relayRequests: relay.length, setup, status, doctor, product, relayMeta, passed: false };
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
  assert.equal(relayMeta.sawSearchTool, true, 'relay never exposed gotry_flyai_search');
  assert.deepEqual(relayMeta.contractErrors, [], relayMeta.contractErrors.join('; '));
  assert.ok(relay.every(body => !body.fixtureError), 'relay fixture parser failed');

  if (scenario === 'success') {
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /已保存|验证/);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /source=config|已验证|verified/i);
    const doctorFlyaiLine = doctor.stdout.split('\n').find(line => /FlyAI/.test(line)) ?? '';
    assert.match(doctorFlyaiLine, /FlyAI.*已验证.*来源 config/);
    const configPath = join(home, '.flyai', 'config.json');
    assert.ok(existsSync(configPath), 'setup did not write isolated FlyAI config');
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).FLYAI_API_KEY, candidateKey, 'isolated config does not contain the setup candidate');
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'FlyAI config is not mode 0600');
    assert.ok(events.some(event => event.source === 'setup' && event.envKeyMatches), 'setup verifier did not receive the candidate key');
    assert.deepEqual(new Set(productEvents.map(event => event.kind)), new Set(commands.map(command => commandKind.get(command))));
    assert.ok(productEvents.every(event => event.productInvocation && event.configKeyMatches), 'product CLI did not use pinned package/config key');
    assert.equal(relayMeta.setupCalls.length, 2, 'model must call gotry_flyai_setup status then check');
    assert.deepEqual(relayMeta.setupCalls.map(call => call.args.action), ['status', 'check']);
    const setupObservations = new Map(observations.filter(message => message.tool_call_id?.startsWith('flyai-setup-')).map(message => [message.tool_call_id, decodeToolContent(message)]));
    assert.equal(setupObservations.get('flyai-setup-status')?.source, 'config');
    assert.equal(setupObservations.get('flyai-setup-status')?.verified, true);
    assert.equal(setupObservations.get('flyai-setup-check')?.checkVerdict, 'hit');
    assert.equal(setupObservations.get('flyai-setup-check')?.source, 'config');
    assert.equal(setupObservations.get('flyai-setup-check')?.verified, true);
    assert.ok(factLogs.length > 0, 'successful flight/train observations should be isolated in a fact log');
    const byKind = new Map(productEvents.map(event => [event.kind, event]));
    assert.ok(byKind.get('flight').args.includes('--origin') && byKind.get('flight').args.includes('上海'));
    assert.ok(byKind.get('train').args.includes('--transport-no') && byKind.get('train').args.includes('G123'));
    assert.ok(byKind.get('hotel').args.includes('--sort') && byKind.get('hotel').args.includes('price_asc'));
    assert.ok(byKind.get('poi').args.includes('--poi-level') && byKind.get('poi').args.includes('5'));
    assert.ok(byKind.get('marriott-hotel').args.includes('--key-words') && byKind.get('marriott-hotel').args.includes('万豪,杭州万豪'));
    assert.ok(byKind.get('marriott-package').args.includes('--keyword') && byKind.get('marriott-package').args.includes('杭州'));
    assert.ok(!byKind.get('marriott-package').args.includes('--sort-type'), 'official Marriott package CLI has no sort-type argument');
    assert.match(relayText, /¥1xx/);
    assert.match(relayText, /fixture\.invalid\/search-hotel\/jump/);
    assert.match(relayText, /fixture observation/);
    assert.ok(observations.some(message => message.tool_call_id === 'flyai-hotel'));
    const byCall = new Map(observations.map(message => [message.tool_call_id, decodeToolContent(message)]));
    for (const call of allCalls) {
      const observation = byCall.get(call.id);
      assert.equal(observation?.verdict, 'hit', `${call.args.kind} did not return hit`);
      if (call.args.kind === 'flight' || call.args.kind === 'train') {
        assert.ok(observation.options?.[0]?.no && observation.options?.[0]?.jumpUrl);
      } else if (call.args.kind === 'hotel' || call.args.kind === 'marriott-hotel') {
        assert.equal(observation.hotels?.[0]?.priceRaw, call.args.kind === 'hotel' ? '¥1xx' : '¥360起/晚');
        assert.ok(observation.hotels?.[0]?.jumpUrl && observation.hotels?.[0]?.mainPic);
      } else if (call.args.kind === 'poi') {
        assert.ok(observation.pois?.[0]?.poiId && observation.pois?.[0]?.jumpUrl);
      } else if (call.args.kind === 'keyword') {
        assert.ok(observation.keywords?.[0]?.title && observation.keywords?.[0]?.picUrl);
      } else if (call.args.kind === 'ai') {
        assert.ok(observation.aiData);
      } else {
        assert.ok(observation.packages?.[0]?.title && observation.packages?.[0]?.picUrl && observation.packages?.[0]?.sellPoint);
      }
    }
  } else if (scenario === 'ordinary-429') {
    assert.equal(productEvents.length, 2, 'ordinary 429 should be retried once');
    assert.match(relayText, /hit|Fixture Transport/);
  } else if (scenario === 'auth-401') {
    assert.equal(productEvents.length, 1, '401 must not be retried');
    assert.match(relayText, /auth-error|鉴权失败|401/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  } else if (scenario === 'forbidden-403') {
    assert.equal(productEvents.length, 1, '403 must not be retried');
    assert.match(relayText, /forbidden|拒绝访问|403/);
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
  } else if (scenario === 'sentinel') {
    assert.equal(productEvents.length, 1, 'Sentinel must not be retried');
    assert.match(relayText, /Sentinel|sentinel/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  } else if (scenario === 'timeout') {
    assert.equal(productEvents.length, 1, 'local timeout termination must invoke the CLI exactly once');
    assert.match(relayText, /timeout|超时/);
    assert.doesNotMatch(relayText, /"verdict":"miss"/);
  }
  if (scenario === 'ordinary-429') assert.ok(factLogs.length > 0, 'recovered hit should be isolated in a fact log');
  // An empty but valid provider result is a legal miss and is persisted as a
  // negative fact by the product. Other failures must not create facts.
  if (scenario === 'empty') assert.ok(factLogs.length > 0, 'legal empty result should persist a negative fact');
  if (!['success', 'ordinary-429', 'empty'].includes(scenario)) assert.deepEqual(factLogs, [], `${scenario} must not write bookable facts`);
  row.passed = true;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  assertNoKey([`${scenario} receipt`, readFileSync(join(output, 'receipt.json'), 'utf8')]);
  console.log(JSON.stringify({ scenario, passed: true, productEvents: productEvents.length, relayRequests: relay.length }));
}

try {
  for (const scenario of ['success', 'auth-401', 'forbidden-403', 'trial-429', 'ordinary-429', 'malformed', 'empty', 'sentinel', 'timeout']) await runCase(scenario);
  report.validated = true;
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
} catch (error) {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ...report, validated: false, error: String(error?.stack ?? error) }, null, 2));
  throw error;
}
