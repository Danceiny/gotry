import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
// Run against an already installed package; never uses the developer's product state.
// node scripts/parallel-search-perf-e2e.mjs <installed-gotry-bin> <new-output-dir> <serial|parallel> [baseline-median-ms|-] [sample-count]
const [binaryArg, outputArg, mode, baselineArg, samplesArg] = process.argv.slice(2);
assert.ok(binaryArg && outputArg && ['serial', 'parallel'].includes(mode), 'Expected installed binary, new output directory, serial|parallel and optional baseline median');
const binary = resolve(binaryArg), outputRoot = resolve(outputArg);
assert.ok(existsSync(binary), 'Installed GoTry binary must exist');
assert.ok(!existsSync(outputRoot), 'Use a new output directory to preserve earlier evidence');
mkdirSync(outputRoot, { recursive: true });
const expectedPeak = mode === 'serial' ? 1 : 4;
const baselineMedianMs = (baselineArg === undefined || baselineArg === '-') ? null : Number(baselineArg);
assert.ok(baselineMedianMs === null || (Number.isFinite(baselineMedianMs) && baselineMedianMs > 0));
const sampleCount = samplesArg === undefined ? 3 : Number(samplesArg), serviceDelayMs=1500;
assert.ok(Number.isInteger(sampleCount) && sampleCount >= 1 && sampleCount <= 20, 'sample-count must be 1..20');
const report={kind:'installed-product-hotel-anything-performance',binary,node:process.version,mode,serviceDelayMs,samples:[],featureAccepted:false,boundary:'Controlled model and provider; actual installed product and host. Not live provider or autonomous planner acceptance.'};
const chunk=(delta,finish=null)=>`data: ${JSON.stringify({id:'baseline',object:'chat.completion.chunk',created:1,model:'controlled-baseline',choices:[{index:0,delta,finish_reason:finish}]})}\n\n`;
const textAnswer=()=>chunk({role:'assistant',content:'Baseline probe complete. All four controlled queries returned no results; no availability claim.'})+chunk({},'stop')+'data: [DONE]\n\n';
for(let sample=0;sample<sampleCount;sample++){
 const root=mkdtempSync(join(tmpdir(),'gotry-519-baseline-case-')); const home=join(root,'home'),cwd=join(root,'cwd'),shim=join(root,'bin'),eventsFile=join(root,'provider.jsonl');
 for(const p of [home,cwd,shim])mkdirSync(p,{recursive:true});
 const shimCode=`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(!a.includes('search'))process.exit(77);const record=(phase)=>fs.appendFileSync(process.env.GOTRY_PROBE_EVENTS,JSON.stringify({phase,pid:process.pid,sub:a.includes('hotel-list')?'hotel-list':'anything',args:a,at:Date.now()})+'\\n');record('start');setTimeout(()=>{record('end');fs.writeFileSync(1,JSON.stringify(a.includes('hotel-list')?{list:[]}:{candidates:[]}));},${serviceDelayMs});\n`;
 writeFileSync(join(shim,'hbcli'),shimCode,{mode:0o700});
 const bodies=[]; let planned=false; let plannerCalls=0;
 const server=createServer((req,res)=>{
  if(req.method!=='POST'||!req.url?.endsWith('/chat/completions')){res.writeHead(404).end();return;}
  let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{
   const body=JSON.parse(raw);bodies.push(body);res.writeHead(200,{'content-type':'text/event-stream'});
   const tools=(body.tools??[]).map(x=>x.function?.name??x.name);
   if(tools.includes('gotry_hotel_search') && tools.includes('gotry_anything_search')){
    plannerCalls++;
    if(!planned){planned=true;const args=[{name:'gotry_hotel_search',args:{destination:'杭州',checkIn:'2027-01-15',checkOut:'2027-01-17'}},{name:'gotry_anything_search',args:{keyword:'杭州',contentType:'city'}},{name:'gotry_hotel_search',args:{destination:'南京',checkIn:'2027-01-15',checkOut:'2027-01-17'}},{name:'gotry_anything_search',args:{keyword:'南京',contentType:'city'}}];
     res.end(chunk({role:'assistant',tool_calls:args.map((x,index)=>({index,id:`probe-${index}`,type:'function',function:{name:x.name,arguments:JSON.stringify(x.args)}}))})+chunk({},'tool_calls')+'data: [DONE]\n\n');return;}
   }
   res.end(textAnswer());
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={PATH:shim+':'+process.env.PATH,HOME:home,DSH_HOME:join(home,'dsh'),SHELL:'/bin/zsh',TMPDIR:root,LLM_API_KEY:'synthetic-local-only',LLM_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,LLM_MODEL:'controlled-baseline',GOTRY_LOCALE:'en',GOTRY_TURN_HANDOFF_ROOT:cwd,GOTRY_SESSION_LIVE:'0',GOTRY_HBCLI_LIVE:'0',GOTRY_HOTELBYTE_SKILLS_LIVE:'0',GOTRY_PROBE_EVENTS:eventsFile};
 const start=Date.now(), monotonicStart=process.hrtime.bigint();let stdout='',stderr='';const child=spawn(binary,['Compare Hangzhou and Nanjing for January 15-17, 2027. For each named city independently query its destination directory and hotel list; all city names and dates are already provided.'],{cwd,env,detached:true,stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 let code;try{code=await new Promise(resolve=>{const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}resolve('timeout');},90000);child.once('exit',x=>{clearTimeout(timer);resolve(x)});});}finally{await new Promise(r=>server.close(r));}
 writeFileSync(join(outputRoot,`sample-${sample}-stdout.log`),stdout);writeFileSync(join(outputRoot,`sample-${sample}-stderr.log`),stderr);
 writeFileSync(join(outputRoot,`sample-${sample}-relay.json`),JSON.stringify(bodies,null,2));
 const events=existsSync(eventsFile)?readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 let inFlight=0,peak=0;for(const event of events){inFlight+=event.phase==='start'?1:-1;peak=Math.max(peak,inFlight);}
 const tools=bodies.flatMap(b=>b.messages??[]).filter(x=>x.role==='tool');
 const row={sample,root,code,totalMs:Date.now()-start,monotonicMs:Number(process.hrtime.bigint()-monotonicStart)/1e6,plannerCalls,events,peak,toolMessageCount:tools.length,toolMessages:tools};report.samples.push(row);
 writeFileSync(join(outputRoot,'receipt.json'),JSON.stringify(report,null,2));
 assert.equal(code,0,stderr.slice(-2000));assert.ok(Math.abs(row.totalMs-row.monotonicMs)<2000,'Clock discontinuity; environment-invalid timing, preserve receipt');assert.equal(events.length,8,JSON.stringify(row));assert.equal(peak,expectedPeak,'Unexpected provider concurrency');assert.equal(inFlight,0);assert.equal(new Set(events.filter(e=>e.phase==='start').map(e=>JSON.stringify(e.args))).size,4);
 assert.equal(tools.length,4,JSON.stringify(row));
 const expected = ['杭州:hbcli 实时 0 家(入住 2027-01-15 → 退房 2027-01-17)\n[实时API:hbcli@TIME]', '杭州 → miss (酒店-be 一切正常但无候选)\n[实时API:hbcli-anything@TIME] 0/0 candidates', '南京:hbcli 实时 0 家(入住 2027-01-15 → 退房 2027-01-17)\n[实时API:hbcli@TIME]', '南京 → miss (酒店-be 一切正常但无候选)\n[实时API:hbcli-anything@TIME] 0/0 candidates'];
 assert.deepEqual(tools.map(t=>t.tool_call_id),['probe-0','probe-1','probe-2','probe-3']);
 assert.deepEqual(tools.map(t=>t.content.replace(/@\d{4}-\d\d-\d\dT[^\]]+/g,'@TIME')),expected); assert.match(stdout,/Baseline probe complete/);
 row.providerSpanMs=events.at(-1).at-events[0].at;console.log(JSON.stringify({sample,code,totalMs:row.totalMs,providerSpanMs:row.providerSpanMs,peak,toolMessageCount:tools.length}));
}
report.validated=true;
const orderedTimes=report.samples.map(s=>s.totalMs).sort((a,b)=>a-b);
report.medianTotalMs=(orderedTimes[Math.floor((sampleCount-1)/2)]+orderedTimes[Math.floor(sampleCount/2)])/2;
report.baselineMedianMs=baselineMedianMs;report.reduction=baselineMedianMs===null?null:1-report.medianTotalMs/baselineMedianMs;report.performanceTargetPassed=report.reduction===null?null:report.reduction>=0.5;
writeFileSync(join(outputRoot,'receipt.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({medianTotalMs:report.medianTotalMs,reduction:report.reduction,performanceTargetPassed:report.performanceTargetPassed,featureAccepted:false}));
