import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Actual installed package + host + tools; only model/provider responses are fixtures.
// Usage: node scripts/parallel-search-behavior-e2e.mjs <installed-gotry-bin> <new-output-dir>
const [binaryArg, outputArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg, 'Expected installed GoTry binary and a new output directory');
const binary = resolve(binaryArg), output = resolve(outputArg);
assert.ok(existsSync(binary));
assert.ok(!existsSync(output), 'Preserve prior evidence by using a new output directory');
mkdirSync(output, { recursive: true });
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'behavior', object: 'chat.completion.chunk', created: 1, model: 'controlled-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const toolReply = calls => chunk({ role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }) + chunk({}, 'tool_calls') + 'data: [DONE]\n\n';
const finalReply = () => chunk({ role: 'assistant', content: 'Controlled behavior probe complete; fixture results are not live availability.' }) + chunk({}, 'stop') + 'data: [DONE]\n\n';
const hotel = (destination, id) => ({ id, name: 'gotry_hotel_search', args: { destination, checkIn: '2027-01-15', checkOut: '2027-01-17' } });
const directory = (keyword, id) => ({ id, name: 'gotry_anything_search', args: { keyword, contentType: 'city' } });
const report = { binary, node: process.version, featureAccepted: false, boundary: 'Local model/provider replay through the actual installed product. No live provider or autonomous planner acceptance.', cases: [] };

for (const scenario of ['partial-failure', 'dependency']) {
  const root = mkdtempSync(join(tmpdir(), 'gotry-search-behavior-'));
  const home = join(root, 'home'), cwd = join(root, 'cwd'), bin = join(root, 'bin'), eventsPath = join(root, 'events.jsonl');
  for (const dir of [home, cwd, bin]) mkdirSync(dir, { recursive: true });
  const city = `E2ECity${root.slice(-6)}`;
  writeFileSync(join(bin, 'hbcli'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);if(!args.includes('search'))process.exit(77);
const hotel=args.includes('hotel-list');const event=phase=>fs.appendFileSync(process.env.GOTRY_TEST_EVENTS,JSON.stringify({phase,args,pid:process.pid,at:Date.now()})+'\\n');
event('start');setTimeout(()=>{event('end');
 if(process.env.GOTRY_TEST_SCENARIO==='partial-failure' && !hotel && args.includes('南京')){fs.writeFileSync(2,'CONTROLLED_SOURCE_FAILURE');process.exit(7);}
 const body=hotel?{list:args.includes('杭州')?[{id:91901,name:{zh:'受控酒店一',en:'Controlled Hotel One'},star:4,minPrice:{amount:123,currency:'CNY'}}]:[]}:{candidates:process.env.GOTRY_TEST_SCENARIO==='dependency'?[{type:'city',region:{id:77,name:{zh:process.env.GOTRY_TEST_CITY}}}]:[]};
 fs.writeFileSync(1,JSON.stringify(body));},300);
`, { mode: 0o700 });
  const bodies = [], errors = []; let stage = 0, derivedCity = null;
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) { response.writeHead(404).end(); return; }
    let raw = ''; request.on('data', data => raw += data); request.on('end', () => {
      try {
        const body = JSON.parse(raw); bodies.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = (body.tools ?? []).map(tool => tool.function?.name ?? tool.name);
        if (!tools.includes('gotry_hotel_search') || !tools.includes('gotry_anything_search')) { response.end(finalReply()); return; }
        if (stage === 0) {
          stage++;
          response.end(toolReply(scenario === 'partial-failure'
            ? [hotel('杭州', 'partial-0'), directory('杭州', 'partial-1'), hotel('南京', 'partial-2'), directory('南京', 'partial-3')]
            : [directory('opaque-destination-key', 'dependency-directory')]));
          return;
        }
        if (scenario === 'dependency' && stage === 1) {
          const prior = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'dependency-directory');
          assert.ok(prior, 'Dependent call requires the actual prior tool observation');
          derivedCity = /\[city\] (\S+) destinationId=77/.exec(prior.content)?.[1];
          assert.equal(derivedCity, city);
          stage++;
          response.end(toolReply([hotel(derivedCity, 'dependency-hotel')])); return;
        }
        response.end(finalReply());
      } catch (error) { errors.push(String(error)); response.end(finalReply()); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PATH: bin + ':' + process.env.PATH, HOME: home, DSH_HOME: join(home, 'dsh'), TMPDIR: root, SHELL: '/bin/zsh', LLM_API_KEY: 'synthetic-only', LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LLM_MODEL: 'controlled-model', GOTRY_LOCALE: 'en', GOTRY_TURN_HANDOFF_ROOT: cwd, GOTRY_SESSION_LIVE: '0', GOTRY_HBCLI_LIVE: '0', GOTRY_HOTELBYTE_SKILLS_LIVE: '0', GOTRY_TEST_EVENTS: eventsPath, GOTRY_TEST_SCENARIO: scenario, GOTRY_TEST_CITY: city };
  const start = Date.now(); let stdout = '', stderr = '', timedOut = false, code;
  const child = spawn(binary, [scenario === 'dependency' ? 'Resolve the opaque destination key, then use the returned city to query hotels for January 15-17, 2027.' : 'Compare Hangzhou and Nanjing hotels and destination directories for January 15-17, 2027. Preserve each source, including failures.'], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  let timer;
  try {
    code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 60000);
      child.once('error', reject); child.once('close', resolve);
    });
  } finally {
    clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  // The last model request contains every completed tool observation exactly once.
  const messages = bodies.filter(body => body.messages?.some(message => message.role === 'tool')).at(-1)?.messages.filter(message => message.role === 'tool') ?? [];
  let active = 0, peak = 0;
  for (const event of events) { active += event.phase === 'start' ? 1 : -1; peak = Math.max(peak, active); }
  const row = { scenario, root, code, timedOut, totalMs: Date.now() - start, peak, events, messages, derivedCity, errors };
  report.cases.push(row);
  for (const [name, value] of [['stdout.log', stdout], ['stderr.log', stderr], ['relay.json', JSON.stringify(bodies, null, 2)]]) writeFileSync(join(output, scenario + '-' + name), value);
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
  assert.equal(code, 0, stderr); assert.equal(timedOut, false); assert.deepEqual(errors, []); assert.equal(active, 0);
  assert.match(stdout, /Controlled behavior probe complete/);
  if (scenario === 'partial-failure') {
    assert.equal(events.length, 8); assert.equal(peak, 4);
    assert.deepEqual(messages.map(message => message.tool_call_id), ['partial-0', 'partial-1', 'partial-2', 'partial-3']);
    assert.match(messages[0].content, /受控酒店一/); assert.match(messages[0].content, /123/); assert.match(messages[0].content, /91901/);
    assert.match(messages[1].content, /→ miss/); assert.match(messages[2].content, /实时 0 家/);
    assert.match(messages[3].content, /→ unavailable/); assert.match(messages[3].content, /CONTROLLED_SOURCE_FAILURE/);
    assert.match(messages[3].content, /hbcli-anything@error@/); assert.doesNotMatch(messages[3].content, /→ (?:hit|miss)/);
  } else {
    assert.equal(events.length, 4); assert.equal(peak, 1); assert.equal(derivedCity, city);
    assert.deepEqual(messages.map(message => message.tool_call_id), ['dependency-directory', 'dependency-hotel']);
    assert.ok(events[1].at <= events[2].at, 'Dependent provider must start after directory result');
    assert.ok(events[2].args.includes(city), 'Hotel query must use city from the prior tool result');
    assert.match(messages[0].content, /→ hit/); assert.match(messages[1].content, /实时 0 家/);
  }
  row.passed = true;
  console.log(JSON.stringify({ scenario, passed: true, peak, totalMs: row.totalMs }));
}
report.validated = true;
writeFileSync(join(output, 'receipt.json'), JSON.stringify(report, null, 2));
