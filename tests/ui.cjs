// Browser integration checks with fixed sample sessions (no private logs).
// Requires Google Chrome; WMAD_HEADED=1 opens visible test windows.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.WMAD_NO_UPDATE_CHECK = '1';
const { DemoWatcher } = require('../src/demo');
const { createServer } = require('../src/server');
const screenshots = process.env.WMAD_SCREENSHOTS;
async function waitForFiniteAnimations(page) {
  try {
    await page.waitForFunction(() => document.getAnimations({ subtree: true }).every((animation) =>
      animation.effect?.getTiming().iterations === Infinity || !['running', 'pending'].includes(animation.playState)), null, { timeout: 10000 });
  } catch (error) {
    const active = await page.evaluate(() => document.getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity && ['running', 'pending'].includes(animation.playState))
      .map((animation) => ({ name: animation.animationName || animation.transitionProperty, state: animation.playState })));
    throw new Error(`Timed out waiting for finite UI animations: ${JSON.stringify(active)} (${error.message})`);
  }
}
async function screenshot(page, name) {
  if (!screenshots) return;
  await waitForFiniteAnimations(page);
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name + '.png') });
}
async function screenshotElement(page, locator, name) {
 if (!screenshots) return;
 await waitForFiniteAnimations(page);
 fs.mkdirSync(screenshots, { recursive: true });
 await locator.screenshot({ path: path.join(screenshots, name + '.png') });
}
const clientsOnly = process.env.WMAD_UI_CLIENTS_ONLY === '1';
const messageFormatOnly = process.env.WMAD_UI_MESSAGE_FORMAT_ONLY === '1';
const checks=[];
const check=(name)=>{checks.push(name);console.log('PASS',name)};
const sessions = [
 {key:'claude:one', id:'one', agent:'claude',project:'claude-project',status:'thinking'},
 {key:'codex:two', id:'two', agent:'codex',project:'codex-project',status:'waiting'},
 {key:'gemini:three', id:'three', agent:'gemini',project:'gemini-project',status:'tool',activity:'Read: index.js'},
 {key:'omp:four', id:'real-omp-id', agent:'omp',project:'omp-project',status:'tool',activity:'read file.js',resumeCommand:"omp --cwd 'C:\\demo project\\O''Brien' --session-dir 'C:\\sessions' --resume 'real-omp-id'"},
 {key:'claude:done', id:'done', agent:'claude',project:'finished-project',status:'done'},
 {key:'codex:sub', id:'sub', agent:'codex',project:'sub-project',status:'thinking',subagent:true},
].map(s=>({...s,lastEventAt:Date.now(),turnStartedAt:Date.now()-1000,cwd:'/demo/'+s.project}));
async function stable(page){
 await page.waitForFunction(()=>typeof office!=='undefined' && office?.framesShown>4);
 await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
}
async function openSettings(page) {
 if (!(await page.locator('#settingsMenu').getAttribute('open') !== null)) await page.click('#settingsMenu > summary');
}
async function badges(target){
 return target.evaluate(()=>{
  const found=[];const original=office.agentBadge;
  office.agentBadge=function(a,...rest){found.push(a.short);return original.call(this,a,...rest)};
  office.frame(performance.now());office.agentBadge=original;return found;
 });
}
// The agent panel replaced the list view on the dashboard.
async function rowKeys(t){return t.locator('#side .srow').evaluateAll(rows=>rows.map(r=>r.dataset.key))}
async function openAgent(t,key){await t.click(`#side .srow[data-key="${key}"]`);await t.waitForFunction(()=>document.getElementById('side').classList.contains('detail'))}
async function backToList(t){await t.click('#sideBack');await t.waitForFunction(()=>!document.getElementById('side').classList.contains('detail'))}
async function resumeOf(t,key){await openAgent(t,key);const b=t.locator('#detailBody .copy');const v=(await b.count())?await b.getAttribute('data-copy'):null;await backToList(t);return v}
async function checkFullScreenInsets(page) {
 for (const width of [320,480,1280]) {
  await page.setViewportSize({width,height:800});
  await page.waitForFunction(()=>{
   const side=document.getElementById('side').getBoundingClientRect();
   const office=document.getElementById('officeWrap').getBoundingClientRect();
   return Math.abs(side.top-office.top)<1;
  });
  const boxes=await page.evaluate(()=>Object.fromEntries(['header','conn','officeSignals','side'].map(id=>{
   const el=id==='header'?document.querySelector('header'):document.getElementById(id);
   if(!el)throw new Error(`Missing layout element: ${id}`);
   const r=el.getBoundingClientRect();return [id,{top:r.top,bottom:r.bottom,height:r.height}];
  })));
  assert.ok(boxes.conn.top>=boxes.header.bottom-1,`${width}px connection card overlaps the toolbar: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.side.top>=boxes.conn.bottom-1,`${width}px side panel covers connection health: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.side.top>=boxes.officeSignals.bottom-1,`${width}px side panel covers status notes: ${JSON.stringify(boxes)}`);
  assert.ok(boxes.side.height>0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px dashboard overflows horizontally`);
  await screenshot(page,`dashboard-top-${width}`);
 }
 await page.setViewportSize({width:1280,height:960});
}
async function checkSideBelowStatus(page, context) {
 const boxes=await page.evaluate(()=>{
  const rect=id=>document.getElementById(id).getBoundingClientRect();
  return {officeHidden:document.getElementById('officeWrap').getClientRects().length===0,
   side:rect('side').top,connection:rect('conn').bottom,signals:rect('officeSignals').bottom};
 });
 assert.equal(boxes.officeHidden,true,`${context}: main office should be hidden while it is in Document PiP`);
 assert.ok(boxes.side>=boxes.connection-1&&boxes.side>=boxes.signals-1,
  `${context}: side panel covers connection health or status notes: ${JSON.stringify(boxes)}`);
}
// The agent filter lives in a toolbar menu.
async function filterAgent(t,v){if(!(await t.evaluate(()=>document.getElementById('agentMenu').open)))await t.click('#agentMenu > summary');await t.click(`#agentChips [data-v="${v}"]`);await t.keyboard.press('Escape')}
async function drawnLogos(target) {
 await target.waitForFunction(()=>Object.values(OFFICE_AGENT_BADGES).every(b=>b.image.complete&&b.image.naturalWidth>0));
 return target.evaluate(()=>{
  const found=new Set();const ctx=office.ctx;const original=ctx.drawImage;
  ctx.drawImage=function(img,...args){
   for(const [key,badge] of Object.entries(OFFICE_AGENT_BADGES)) if(img===badge.image) found.add(key);
   return original.call(this,img,...args);
  };
  try {office.frame(performance.now());} finally {ctx.drawImage=original;}
  return [...found].sort();
 });
}
(async()=>{
 const watcher = new DemoWatcher().start();
 const server = createServer(watcher, { demo: true, privacy: false });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 const base = `http://127.0.0.1:${server.address().port}`;
 let browser;
 const errors=[];
 try {
  const translations = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/i18n.js'), 'utf8'), translations);
  const keys = Object.keys(translations.window.I18N.en).sort();
  for (const lang of Object.values(translations.window.I18N)) assert.deepEqual(Object.keys(lang).sort(), keys);
  check('all nine languages provide every UI string');
  browser=await chromium.launch({headless:process.env.WMAD_HEADED !== '1',channel:'chrome',ignoreDefaultArgs:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'],args:['--window-size=1280,960']});
  const context=await browser.newContext({viewport:{width:1280,height:960},locale:'en-US'});
  await context.addInitScript(sessions=>{
  window.EventSource=class {
   constructor(){window.__events=this;setTimeout(()=>{if(!this.closed)this.send({now:Date.now(),sessions})},0)}
   send(value){this.onmessage?.({data:typeof value==='string'?value:JSON.stringify(value)})}
   fail(){this.onerror?.({type:'error'})}
   open(){this.onopen?.({type:'open'})}
   close(){this.closed=true}
  };
   window.__notifications=[];
   window.Notification=class {static permission='granted';constructor(title,options){window.__notifications.push({title,options})}};
  },sessions);
  context.on('page',p=>p.on('pageerror',e=>errors.push(String(e))));
  const page=await context.newPage();await page.goto(base);
  assert.equal(await page.evaluate(()=>typeof WMADNotificationRules),'object','the served dashboard loads its notification rules module');
  await stable(page);
  await page.waitForFunction(()=>state.connection==='connected'&&state.lastUpdateAt!==null);
  if (messageFormatOnly) await page.evaluate(()=>{store.set('lang','zh-TW');state.lang='zh-TW';applyLang('zh-TW');render()});
  if (!messageFormatOnly) {
  assert.equal(await page.locator('#conn').isVisible(),true);
  assert.match(await page.locator('#conn').innerText(),/Connected/);
  let mainUpdate=await page.evaluate(()=>state.lastUpdateAt);
  await page.evaluate(()=>__events.fail());await page.waitForFunction(()=>state.connection==='disconnected');
  assert.equal(await page.evaluate(()=>state.lastUpdateAt),mainUpdate);
  assert.match(await page.locator('#conn').innerText(),/current agent state is unconfirmed/);
  await page.evaluate(()=>__events.open());
  assert.equal(await page.evaluate(()=>state.connection),'disconnected');
  await page.evaluate(s=>__events.send({now:Date.now(),sessions:s}),sessions);
  await page.waitForFunction(()=>state.connection==='connected');
  mainUpdate=await page.evaluate(()=>state.lastUpdateAt);
  check('main page retains its last update through disconnect and recovers only on a valid snapshot');
  assert.equal(await page.evaluate(()=>state.full&&document.body.classList.contains('full')),true,'full screen is the default');
  assert.equal(await page.locator('#side .srow').count()>0,true,'the agent panel lists the team');
  check('full screen with the agent panel is the default');
  assert.equal(await page.locator('#fullBtn').count(),0,'there is no way back to the old layout');
  await checkFullScreenInsets(page);
  const diagnosticSources=[
   {agent:'claude',state:'empty',lastSuccessAt:Date.now()-60_000,reason:'no_recent_logs'},
   {agent:'codex',state:'read_error',lastSuccessAt:null,reason:'reading_denied'},
   {agent:'gemini',state:'missing',lastSuccessAt:null,reason:'not_found'},
   {agent:'copilot',state:'parse_error',lastSuccessAt:Date.now()-20_000,reason:'invalid_json'},
   {agent:'kimi',state:'unavailable',lastSuccessAt:null,reason:'not_instrumented'},
   {agent:'dsh',state:'read_error',lastSuccessAt:null,reason:'read_failed'},
   {agent:'grok',state:'empty',lastSuccessAt:Date.now()-30_000,reason:'no_recent_logs'},
   {agent:'omp',state:'missing',lastSuccessAt:null,reason:'not_found'},
  ];
  await page.setViewportSize({width:320,height:640});
  await page.emulateMedia({colorScheme:'dark'});
  await page.evaluate(sources=>onData({now:Date.now(),sessions:[],sources}),diagnosticSources);
  await page.waitForFunction(()=>state.data.sessions.length===0&&document.querySelectorAll('#sourcesPanel .source-entry').length===8,null,{timeout:10000});
  assert.equal(await page.locator('#sourcesMenu > summary').isVisible(),true,'the source menu remains reachable with no sessions');
  await page.click('#sourcesMenu > summary');
  await page.waitForFunction(()=>document.getElementById('sourcesMenu').open&&document.getElementById('sourcesPanel').getClientRects().length>0,null,{timeout:10000});
  const diagnosticText=await page.locator('#sourcesPanel').innerText();
  assert.match(diagnosticText,/Not installed or source path not found/);
  assert.match(diagnosticText,/No logs in the selected time range/);
  assert.match(diagnosticText,/Read access was denied/);
  assert.match(diagnosticText,/Could not parse the log source/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the open source menu fits a 320px window');
  const sourcePanelBox=await page.locator('#sourcesPanel').boundingBox();
  assert.ok(sourcePanelBox&&sourcePanelBox.x>=0&&sourcePanelBox.x+sourcePanelBox.width<=320,`source menu stays inside the narrow window: ${JSON.stringify(sourcePanelBox)}`);
  const recoveredReadAt=Date.now()-5*60*1000;
  await page.evaluate(([sources,readAt])=>onData({now:Date.now(),sessions:[],sources:sources.map(source=>source.agent==='codex'
   ? {...source,state:'ok',lastSuccessAt:readAt,reason:null} : source)}),[diagnosticSources,recoveredReadAt]);
  await page.waitForFunction(()=>{
   const row=[...document.querySelectorAll('#sourcesPanel .source-entry')].find(item=>item.querySelector('.source-agent')?.textContent==='Codex');
   return row?.querySelector('.source-state')?.textContent==='Available';
  },null,{timeout:10000});
  assert.equal(await page.locator('#sourcesMenu').evaluate(menu=>menu.open),true,'the source menu stays open when diagnostics recover');
  assert.equal(await page.locator('#sourcesMenu > summary').evaluate(summary=>document.activeElement===summary),true,'recovery keeps keyboard focus on the menu');
  assert.match(await page.locator('#sourcesPanel').innerText(),/Last successful content read/);
  await page.evaluate(()=>{applyLang('zh-TW');render()});
  await page.waitForFunction(()=>langCode==='zh-TW'&&document.querySelector('#sourcesPanel .setting-label')?.textContent==='Agent 記錄來源',null,{timeout:10000});
  assert.match(await page.locator('#sourcesPanel').innerText(),/未安裝或找不到來源路徑/);
  await screenshot(page,'source-diagnostics-320-dark-zh-tw');
  const bottomSource=page.locator('#sourcesPanel .source-entry').last();
  await bottomSource.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>{
   const panel=document.getElementById('sourcesPanel'), row=panel?.querySelector('.source-entry:last-child');
   if(!panel||!row)return false;
   const p=panel.getBoundingClientRect(), r=row.getBoundingClientRect();
   return r.top>=p.top&&r.bottom<=p.bottom;
  },null,{timeout:10000});
  assert.match(await bottomSource.innerText(),/OMP/,'the last source entry can be reached by scrolling');
  await page.evaluate(()=>{applyLang('en');render()});
  await page.waitForFunction(()=>langCode==='en',null,{timeout:10000});
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.getElementById('sourcesMenu').open,null,{timeout:10000});
  check('eight source diagnostics fit and scroll at 320px; labels localize and an error recovers in-place');

  const evidenceAt=Date.now()-30*60*1000;
  const contentReadAt=Date.now()-90*60*1000;
  const priorLogAt=Date.now()-24*60*60*1000;
  const evidenceSession={key:'codex:evidence',id:'evidence',agent:'codex',project:'evidence-project',status:'tool',activity:'Read: app.js',
   lastEventAt:priorLogAt,turnStartedAt:Date.now()-1000,statusEvidence:{kind:'assistant_message',at:evidenceAt},
   sourceHealth:{state:'ok',lastSuccessAt:contentReadAt,reason:null}};
  await page.evaluate(([session,readAt])=>onData({now:Date.now(),sessions:[session],sources:[{agent:'codex',state:'ok',lastSuccessAt:readAt,reason:null}]}),[evidenceSession,contentReadAt]);
  await page.setViewportSize({width:480,height:800});
  await page.emulateMedia({colorScheme:'light'});
  await page.waitForFunction(()=>document.querySelector('#side .srow[data-key="codex:evidence"]'),null,{timeout:10000});
  await openAgent(page,'codex:evidence');
  await page.waitForFunction(()=>document.querySelector('#detailBody .state-evidence')?.getClientRects().length>0,null,{timeout:10000});
  const expectedEventTime=await page.evaluate(at=>new Intl.DateTimeFormat(langCode,{dateStyle:'medium',timeStyle:'short'}).format(new Date(at)),evidenceAt);
  const expectedReadTime=await page.evaluate(at=>new Intl.DateTimeFormat(langCode,{dateStyle:'medium',timeStyle:'short'}).format(new Date(at)),contentReadAt);
  const detailText=await page.locator('#detailBody').innerText();
  assert.match(detailText,/Assistant message/);
  assert.ok(detailText.includes(expectedEventTime),'detail shows the original state-event time');
  assert.ok(detailText.includes(expectedReadTime),'detail shows the last successful content-read time');
  assert.match(detailText,/Last successful content read/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'the detail evidence fits a 480px window');
  await screenshot(page,'status-evidence-480-light');
  await backToList(page);
  await page.setViewportSize({width:1280,height:960});
  check('session detail separates state-event time from successful content-read time');
  assert.equal(await page.locator('h1 [data-t]').innerText(),"What's my agent doing");
  assert.equal(await page.evaluate(()=>state.showSub),false,'subagents stay hidden by default for every provider');
  await openSettings(page);await page.check('#showSub');await page.keyboard.press('Escape');
  const ompChild={key:'omp:child',id:'child',agent:'omp',project:'omp-project',cwd:'/demo/omp-project',title:'Worker > Child',status:'thinking',subagent:true,parentId:'real-omp-id',resumeCommand:null,lastEventAt:Date.now(),turnStartedAt:Date.now()};
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),[...sessions,ompChild]);
  await openAgent(page,'omp:child');
  assert.equal(await page.locator('#detailBody .dtitle').innerText(),'Worker > Child');
  assert.equal(await page.locator('#detailBody .copy').count(),0);
  await backToList(page);
  assert.equal(await page.evaluate(()=>officeOpts.label(state.data.sessions.find(s=>s.key==='omp:child'))),'Worker > Child');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  await openSettings(page);await page.uncheck('#showSub');await page.keyboard.press('Escape');
  check('OMP subagents show their name without an invalid Resume command');
  await page.evaluate(()=>{window.__chimes=[];chime=k=>window.__chimes.push(k);state.sound=true;});
  const lead=sessions.find(s=>s.agent==="claude"&&!s.subagent);
  const staleLead={...lead,status:'tool',lastEventAt:Date.now()-13*60*1000,staleAfterMs:600000};
  await page.evaluate(([s,b,stale])=>{onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool'}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'waiting'}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?{...b,status:'tool'}:x)});
    onData({now:Date.now(),sessions:s.map(x=>x.key===b.key?stale:x)});},[sessions,lead,staleLead]);
  assert.deepEqual(await page.evaluate(()=>window.__chimes),['attention'],'a needs-you transition chimes once; old log age does not add a stuck alert');
  assert.equal(await page.evaluate(key=>state.data.sessions.find(s=>s.key===key).status,lead.key),'tool','staleness preserves the last observed status');
  assert.equal(await page.locator(`#side .srow[data-key="${lead.key}"] .freshness.stale`).count(),1);
  await openAgent(page,lead.key);assert.equal(await page.locator('#detailBody .evidence .stale').count(),1);await backToList(page);
  await page.evaluate(s=>{state.sound=false;onData({now:Date.now(),sessions:s})},sessions);
  assert.equal(await page.locator('#sound').isChecked(),false,'sound is off by default');
  check('needs-you alerts chime once and stale logs preserve observed status without a stuck alert');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s.map((x,i)=>({...x,context:i===0?{used:180000,window:200000}:null})),
    summary:JSON.parse('{"day":"d","turns":12,"tokens":2460000,"agents":2,"byAgent":{"claude":{"sessions":1,"turns":8,"tokens":2000000},"codex":{"sessions":1,"turns":4,"tokens":460000}},"projects":{"__proto__":8,"api":4}}')}),sessions);
  assert.equal(await page.locator('#todayTokens').innerText(),'2.46M');
  await page.click('#todayMenu > summary');
  assert.equal(await page.locator('#todayPanel').isVisible(),true);
  assert.match(await page.locator('#todayPanel').innerText(),/12[\s\S]*2\.46M[\s\S]*__proto__/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#todayPanel').isVisible(),false);
  await openAgent(page,sessions[0].key);
  assert.equal(await page.locator('#detailBody .ctx.full').count(),1,'a 90% context fill is shown as nearly full');
  await backToList(page);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  check('the Today panel and context bars show usage and close with Escape');
  assert.equal(await page.locator('#showAgent').isChecked(),true);
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  assert.equal(await page.locator('#agentLegend img').evaluateAll(imgs=>imgs.length===4&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  check('all four agent icons load and show in 2D and the legend; OMP uses a neutral mark');
  await filterAgent(page,'omp');
  assert.deepEqual(await rowKeys(page),['omp:four']);
  assert.equal(await page.locator('#side .srow img').getAttribute('src'),'/assets/agents/omp.svg');
  await openAgent(page,'omp:four');
  assert.equal(await page.locator('#detailBody .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})});
  await page.click('#detailBody .copy');
  assert.equal(await page.evaluate(()=>window.__copied),sessions.find(s=>s.agent==='omp').resumeCommand);
  await backToList(page);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  assert.deepEqual(await page.evaluate(()=>state.agents),['omp']);assert.deepEqual(await rowKeys(page),['omp:four']);
  check('OMP filter, agent panel, Resume copy and saved filter work');
  await filterAgent(page,'all');await filterAgent(page,'claude');await filterAgent(page,'codex');
  assert.deepEqual((await rowKeys(page)).map(k=>k.split(':')[0]).sort(),['claude','claude','codex']);
  assert.deepEqual(await page.evaluate(()=>state.agents),['claude','codex']);
  await filterAgent(page,'codex');assert.deepEqual(await page.evaluate(()=>state.agents),['claude']);
  for (const a of ['codex','gemini','omp']) await filterAgent(page,a);
  assert.deepEqual(await page.evaluate(()=>state.agents),[],'picking every client is the same as all');
  await page.evaluate(()=>{localStorage.setItem('wmad.agent',JSON.stringify('gemini'));localStorage.removeItem('wmad.agents')});await page.reload();await stable(page);
  assert.deepEqual(await page.evaluate(()=>state.agents),['gemini'],'an old single-agent filter carries over');
  await filterAgent(page,'all');
  check('the agent filter picks any number of clients, all of them, or carries an old choice over');
  await filterAgent(page,'all');
  await openSettings(page);await page.check('#showSub');
  assert.equal((await badges(page)).length,6);
  check('2D shows four providers and subagents without duplicate badges');
  await openSettings(page);await page.uncheck('#showAgent');assert.equal((await badges(page)).length,0);
  assert.equal(await page.locator('#agentLegend').isVisible(),false);
  await page.reload();await stable(page);mainUpdate=await page.evaluate(()=>state.lastUpdateAt);assert.equal(await page.locator('#showAgent').isChecked(),false);
  await openSettings(page);await page.check('#showAgent');check('badge toggle hides markers and legend and persists across reload');
  await page.click('#qualSeg [data-v=high]');
  await page.waitForFunction(()=>officeKind==='high:office'&&office?.loaded&&office.framesShown>4,{},{timeout:30000});
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  await screenshot(page, 'office-3d');
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  check('3D shows the same four provider badges');
  if (!clientsOnly) {
  await page.click('#pipBtn');await page.waitForFunction(()=>!!popout.win);
  const pip=context.pages().find(p=>p!==page);assert.ok(pip);
  await pip.setViewportSize({width:480,height:400});
  const frame=await (async()=>{for(let i=0;i<100;i++){const f=pip.frames().find(f=>f.url().includes('?pip=1'));if(f)return f;await new Promise(r=>setTimeout(r,50))}throw Error('No compact frame')})();
  await frame.waitForFunction(()=>office?.loaded&&office.framesShown>4);
  assert.equal(await frame.evaluate(()=>innerWidth),480);
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s}),sessions);
  await frame.waitForFunction(()=>state.connection==='connected');
  assert.equal(await frame.locator('#conn').isVisible(),true);
  const pipUpdate=await frame.evaluate(()=>state.lastUpdateAt);
  await Promise.all([page.evaluate(()=>__events.fail()),frame.evaluate(()=>__events.fail())]);
  await Promise.all([
   page.waitForFunction(()=>state.connection==='disconnected'),
   frame.waitForFunction(()=>state.connection==='disconnected'),
  ]);
  assert.equal(await page.evaluate(()=>state.lastUpdateAt),mainUpdate);
  assert.equal(await frame.evaluate(()=>state.lastUpdateAt),pipUpdate);
  assert.match(await frame.locator('#conn').innerText(),/current agent state is unconfirmed/);
  assert.equal(await frame.evaluate(()=>innerWidth),480);
  const offlinePipStatus=await frame.locator('#conn').boundingBox();
  assert.ok(offlinePipStatus&&offlinePipStatus.x>=0&&offlinePipStatus.x+offlinePipStatus.width<=480&&offlinePipStatus.y+offlinePipStatus.height<=400);
  await Promise.all([page.evaluate(()=>__events.open()),frame.evaluate(()=>__events.open())]);
  assert.equal(await frame.evaluate(()=>state.connection),'disconnected');
  await Promise.all([
   page.evaluate(s=>__events.send({now:Date.now(),sessions:s}),sessions),
   frame.evaluate(s=>__events.send({now:Date.now(),sessions:s}),sessions),
  ]);
  await Promise.all([
   page.waitForFunction(()=>state.connection==='connected'),
   frame.waitForFunction(()=>state.connection==='connected'),
  ]);
  await checkSideBelowStatus(page,'Document PiP after connection recovery');
  check('main and Document PiP keep independent connection and last-update state through loss and recovery');
  assert.deepEqual(await drawnLogos(frame),['claude','codex','gemini','omp']);
  assert.equal(await page.evaluate(()=>office.visible),false);
  assert.equal(await frame.evaluate(()=>state.quality),'high');
  assert.equal(await frame.locator('#pipBtn').isVisible(),false);
  await frame.waitForFunction(()=>!document.getElementById('office').classList.contains('loading'));await page.waitForTimeout(400);await screenshot(pip, 'pip-3d');
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  check('real Document PiP opens 3D at compact size and suspends the main office');
  await filterAgent(page,'omp');await frame.waitForFunction(()=>state.agents.join()==='omp');
  await frame.click('#viewSeg [data-v=list]');
  assert.equal(await frame.locator('.card').count(),1);
  assert.equal(await frame.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await frame.click('#viewSeg [data-v=office]');
  check('OMP is in the pop-out filter and list with the right Resume command');
  await openSettings(page);await page.uncheck('#showAgent');await frame.waitForFunction(()=>!state.showAgent&&!office.showAgent);
  const pipUpdateBeforeLanguage=await frame.evaluate(()=>state.lastUpdateAt);
  await page.click('#langMenu > summary');await page.click('#langList [data-lang="zh-TW"]');await frame.waitForFunction(()=>langCode==='zh-TW');
  assert.equal(await frame.evaluate(()=>state.lastUpdateAt),pipUpdateBeforeLanguage);
  assert.equal(await frame.evaluate(()=>state.connection),'connected');
  await filterAgent(page,'all');await filterAgent(page,'codex');await frame.waitForFunction(()=>state.agents.join()==='codex');
  await frame.click('#viewSeg [data-v=list]');await page.waitForFunction(()=>state.view==='list');
  assert.equal(await frame.locator('#conn').isVisible(),true);
  const compactSessions=[
   {key:'codex:pending-error',id:'pending-error',agent:'codex',project:'pending-error',status:'error',error:'Permission denied',needsInput:true,pendingRequests:[{id:'q1',kind:'question',summary:'Choose a recovery action'}]},
   {key:'codex:error',id:'error',agent:'codex',project:'error-project',status:'error',error:'Tool crashed'},
   {key:'codex:unknown',id:'unknown',agent:'codex',project:'unknown-project',status:'unknown',lastEventAt:null},
   {key:'codex:working',id:'working',agent:'codex',project:'working-project',status:'tool',activity:'Read: app.js'},
   {key:'codex:done',id:'done',agent:'codex',project:'done-project',status:'done'},
   {key:'codex:idle',id:'idle',agent:'codex',project:'idle-project',status:'idle'},
  ].map(s=>({...s,lastEventAt:s.lastEventAt===null?null:s.lastEventAt??Date.now()-11*60*1000,turnStartedAt:Date.now()-1000,cwd:'/demo/'+s.project}));
  await frame.evaluate(s=>{window.__events?.close();onData({now:Date.now(),sessions:s})},compactSessions);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),compactSessions);
  await frame.waitForFunction(()=>document.querySelectorAll('.card[data-key]').length===4&&['codex:pending-error','codex:error','codex:unknown','codex:working'].every(key=>document.querySelector(`.card[data-key="${key}"]`)));
  assert.equal(await frame.locator('section').count(),4);
  assert.deepEqual((await frame.locator('section h2').allTextContents()).map(t=>t.trim().split(/\s+/)[0]),['需要你','錯誤','狀態未知','工作中']);
  assert.equal(await frame.locator('.card[data-key="codex:pending-error"]').count(),1);
  assert.equal(await frame.locator('.card[data-key="codex:pending-error"] .err').innerText(),'Permission denied');
  assert.match(await frame.locator('.card[data-key="codex:pending-error"] .pending').innerText(),/Choose a recovery action/);
  assert.equal(await frame.locator('.card[data-key="codex:error"] .err').innerText(),'Tool crashed');
  assert.match(await frame.locator('.card[data-key="codex:unknown"] .evidence').innerText(),/日誌時間未知/);
  assert.equal(await frame.locator('.card[data-key="codex:working"] .stale').isVisible(),true);
  assert.equal(await frame.locator('.card[data-key="codex:done"],.card[data-key="codex:idle"]').count(),0);
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await frame.locator('.card .agent.claude').count(),0);
  await frame.waitForFunction(()=>{
   const imgs=[...document.querySelectorAll('.card .agent img')];
   return imgs.length>0&&imgs.every(img=>img.complete);
  });
  const compactLogos=await frame.locator('.card .agent img').evaluateAll(imgs=>imgs.map(img=>({src:img.src,width:img.naturalWidth})));
  assert.ok(compactLogos.length>0&&compactLogos.every(img=>img.width>0),`compact provider logos should finish loading: ${JSON.stringify(compactLogos)}`);
  await screenshot(pip, 'pip-list');
  check('compact list keeps pending errors in Needs you and shows errors, unknown status, and fresh/stale evidence');
  const summarySessions=[
   ...compactSessions,
   {key:'codex:same-a',id:'same-a',agent:'codex',project:'Same project',cwd:'/workspace/a',status:'tool',activity:'Read: a.js',lastEventAt:Date.now(),turnStartedAt:Date.now()-1000},
   {key:'codex:same-b',id:'same-b',agent:'codex',project:'Same project',cwd:'/workspace/b',status:'error',error:'Other project failed',lastEventAt:Date.now(),turnStartedAt:Date.now()-1000},
   {key:'codex:outside',id:'outside',agent:'codex',project:'Outside project',cwd:'/workspace/outside',status:'tool',activity:'Read: outside.js',lastEventAt:Date.now(),turnStartedAt:Date.now()-1000},
  ];
  await page.evaluate(()=>{state.view='office';store.set('view','office');syncControls();render()});
  await frame.waitForFunction(()=>state.view==='office');
  await Promise.all([
   frame.evaluate(s=>onData({now:Date.now(),sessions:s}),summarySessions),
   page.evaluate(s=>onData({now:Date.now(),sessions:s}),summarySessions),
  ]);
  const mainRowsBeforePipFilter=await rowKeys(page);
  await openSettings(page);await page.check('#pipSummary');
  await frame.waitForFunction(()=>state.pipSummary&&document.querySelector('.pip-summary'));
  await page.uncheck('#notifyDone');await frame.waitForFunction(()=>state.notifyDone===false);
  await page.check('#notifyDone');await frame.waitForFunction(()=>state.notifyDone===true);
  assert.equal(await frame.evaluate(()=>state.view),'office','the compact-summary preference leaves the saved office view intact');
  assert.equal(await frame.locator('#officeWrap').isVisible(),false,'collapsed summary hides the office renderer');
  assert.equal(await frame.locator('#pipSummaryToggle').isVisible(),true);
  assert.equal(await frame.locator('#summary').isVisible(),false,'the summary tiles do not duplicate the header counters');
  assert.equal(await frame.locator('[data-pip-scope]').innerText(),await frame.evaluate(()=>L.pipProjectScope(0)),'the summary identifies its all-project scope');
  assert.equal(await frame.locator('.pip-summary [data-group="needsYou"] strong').innerText(),'1');
  assert.equal(await frame.locator('.pip-summary [data-group="errors"] strong').innerText(),'2');
  assert.equal(await frame.locator('.pip-summary [data-group="working"] strong').innerText(),'3');
  assert.equal(await frame.locator('#conn').isVisible(),true);
  assert.equal(await frame.evaluate(()=>state.connection==='connected'&&state.lastUpdateAt!==null),true);
  assert.ok((await frame.locator('#connState').innerText()).trim(),'connection state text stays visible in the selected locale');
  assert.ok((await frame.locator('#connTime').innerText()).trim(),'last-receipt time stays visible in the selected locale');
  await openSettings(frame);
  const duplicateChoices=frame.locator('#pipProjectsList .pip-project-option').filter({hasText:'Same project'});
  assert.equal(await duplicateChoices.count(),2,'same project names remain separate choices');
  await frame.locator('#notifyPause').selectOption('15');
  await frame.waitForFunction(()=>state.notifyPausedUntil>Date.now());
  const pipPauseDeadline=await frame.evaluate(()=>state.notifyPausedUntil);
  await page.waitForFunction(deadline=>state.notifyPausedUntil===deadline,pipPauseDeadline);
  await frame.click('#notifyResume');
  await page.waitForFunction(()=>state.notifyPausedUntil===0);
  check('notification categories sync main-to-PiP and pause/resume sync PiP-to-main');
  const projectA=frame.locator('#pipProjectsList [data-pip-project="cwd:/workspace/a"]');
  await projectA.focus();
  await frame.evaluate(()=>onData({now:Date.now(),sessions:state.data.sessions}));
  assert.equal(await frame.evaluate(()=>document.activeElement?.dataset.pipProject),'cwd:/workspace/a','a routine snapshot keeps keyboard focus in the project chooser');
  await pip.keyboard.press('Space');
  await frame.waitForFunction(()=>state.pipProjects.includes('cwd:/workspace/a'));
  await page.waitForFunction(()=>state.pipProjects.includes('cwd:/workspace/a'));
  await frame.click('#settingsMenu > summary');
  assert.deepEqual(await rowKeys(page),mainRowsBeforePipFilter,'the PiP project filter does not change main-page rows');
  assert.equal(await page.evaluate(()=>state.view),'office','the main dashboard stays in its saved view');
  assert.equal(await page.evaluate(()=>state.full),true,'the main dashboard stays in full-screen mode while PiP is filtered');
  assert.equal(await page.evaluate(()=>state.data.sessions.length),summarySessions.length,'the main page retains the full source snapshot');
  assert.equal(await frame.locator('.pip-summary [data-group="needsYou"] strong').innerText(),'0');
  assert.equal(await frame.locator('.pip-summary [data-group="errors"] strong').innerText(),'0');
  assert.equal(await frame.locator('.pip-summary [data-group="working"] strong').innerText(),'1');
  assert.equal(await frame.locator('[data-pip-scope]').innerText(),await frame.evaluate(()=>L.pipProjectScope(1)),'the selected-project scope remains visible beside its counts');
  const notificationsBeforeOutsideProject=await page.evaluate(()=>__notifications.length);
  const outsideNeeds=summarySessions.map(s=>s.key==='codex:outside'?{...s,needsInput:true,pendingRequests:[{id:'outside-q',kind:'question',summary:'Outside project request'}]}:s);
  await Promise.all([
   frame.evaluate(s=>onData({now:Date.now(),sessions:s}),outsideNeeds),
   page.evaluate(s=>onData({now:Date.now(),sessions:s}),outsideNeeds),
  ]);
  assert.equal(await page.evaluate(()=>__notifications.length),notificationsBeforeOutsideProject+1,'the main page still notifies for a session outside the PiP filter');
  assert.equal(await frame.evaluate(()=>__notifications.length),0,'the PiP remains silent');
  assert.deepEqual([...(await rowKeys(page))].sort(),[...mainRowsBeforePipFilter].sort(),'main rows stay unfiltered after an out-of-project request');
  check('PiP project filters preserve same-name paths, chooser keyboard focus, main rows, office and notifications');
  for(const [width,height,scheme] of [[320,360,'dark'],[480,400,'light']]) {
   await pip.setViewportSize({width,height});await pip.emulateMedia({colorScheme:scheme});
   await frame.waitForFunction(w=>innerWidth===w,width);
   await frame.waitForFunction(()=>document.documentElement.scrollWidth<=innerWidth);
   await waitForFiniteAnimations(frame);
   const geometry=await frame.evaluate(()=>({width:innerWidth,height:innerHeight,conn:document.getElementById('conn').getBoundingClientRect().toJSON(),summary:document.querySelector('.pip-summary').getBoundingClientRect().toJSON()}));
   assert.ok(geometry.conn.bottom<=height&&geometry.conn.width<=width,`${width}x${height} keeps connection and time visible: ${JSON.stringify(geometry)}`);
   assert.ok(geometry.summary.width<=width&&geometry.summary.top>=geometry.conn.bottom,`${width}x${height} keeps the compact summary below connection health: ${JSON.stringify(geometry)}`);
   await screenshot(pip,`pip-summary-${width}-${scheme}`);
  }
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s.filter(x=>x.key!=='codex:same-a')}),outsideNeeds);
  await frame.waitForFunction(()=>document.querySelector('[data-pip-no-matches]'));
  await openSettings(frame);
  const unavailableProject=frame.locator('#pipProjectsList .pip-project-option.unavailable');
  assert.equal(await unavailableProject.count(),1,'a selected project missing from later data remains visible as unavailable');
  const unavailableText=await unavailableProject.innerText();
  const unavailableLabel=await frame.evaluate(()=>L.pipUnavailable);
  assert.ok(unavailableText.includes(unavailableLabel),`unavailable project label should use the current locale: ${JSON.stringify({unavailableText,unavailableLabel,langCode:await frame.evaluate(()=>langCode)})}`);
  assert.equal(await unavailableProject.locator('small').innerText(),'/workspace/a');
  assert.deepEqual(await frame.evaluate(()=>state.pipProjects),['cwd:/workspace/a'],'missing selected projects never broaden the filter');
  assert.equal(await frame.locator('[data-pip-scope]').innerText(),await frame.evaluate(()=>L.pipProjectScope(1)),'an unavailable saved selection still counts toward the visible filter scope');
  await frame.click('[data-pip-clear]');
  await frame.waitForFunction(()=>state.pipProjects.length===0&&!document.querySelector('[data-pip-no-matches]'));
  await page.waitForFunction(()=>state.pipProjects.length===0);
  await frame.locator('#pipSummaryToggle').focus();await pip.keyboard.press('Enter');
  await frame.waitForFunction(()=>state.pipSummaryExpanded&&document.querySelector('.card[data-key="codex:pending-error"]'));
  assert.equal(await frame.evaluate(()=>state.view),'office','expanding uses the existing list without rewriting the saved office view');
  assert.equal(await frame.locator('#officeWrap').isVisible(),false,'expanded list does not run the hidden office renderer');
  assert.equal(await frame.locator('#viewSeg').isVisible(),false,'summary mode hides a contradictory office/list selector');
  await page.uncheck('#pipSummary');
  await frame.waitForFunction(()=>!state.pipSummary&&!state.pipSummaryExpanded&&document.getElementById('officeWrap').style.display!=='none');
  await page.check('#pipSummary');
  await frame.waitForFunction(()=>state.pipSummary&&!state.pipSummaryExpanded&&document.querySelector('.pip-summary'));
  assert.equal(await frame.evaluate(()=>state.view),'office','main-tab off/on resets the PiP summary to collapsed without changing its saved view');
  await frame.locator('#pipSummaryToggle').focus();await pip.keyboard.press('Space');
  await frame.waitForFunction(()=>state.pipSummaryExpanded&&document.querySelector('.card[data-key="codex:pending-error"]'));
  await frame.locator('#pipSummaryToggle').focus();await pip.keyboard.press('Space');
  await frame.waitForFunction(()=>!state.pipSummaryExpanded&&document.querySelector('.pip-summary'));
  await openSettings(frame);await frame.uncheck('#pipSummary');
  await page.waitForFunction(()=>!state.pipSummary);
  assert.equal(await frame.locator('#pipSummaryToggle').isVisible(),false,'the toolbar toggle stays hidden when the opt-in is off');
  assert.equal(await frame.locator('#officeWrap').isVisible(),true,'turning summary off restores the saved office view');
  check('PiP summary expands by keyboard, cross-window off/on resets it, and the PiP toggle restores the saved office view');
  await page.evaluate(()=>{__notifications.length=0});
  await frame.evaluate(()=>{__notifications.length=0});
  const next=sessions.map(s=>s.key==='codex:sub'?{...s,status:'done',subagent:false}:s);
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s}),next);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),next);
  assert.equal(await frame.evaluate(()=>__notifications.length),0);
  assert.equal(await page.evaluate(()=>__notifications.length),1);
  check('only the main page emits completion notifications');
  const recovering=compactSessions.map(s=>s.key==='codex:pending-error'?{...s,status:'tool',error:'',needsInput:false,pendingRequests:[],activity:'Run: retry'}:s);
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s}),recovering);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),recovering);
  const failedAgain=recovering.map(s=>s.key==='codex:pending-error'?{...s,status:'error',error:'Could not connect to runner',needsInput:true,pendingRequests:[{id:'q2',kind:'question',summary:'Choose a recovery step'}]}:s);
  await frame.evaluate(s=>onData({now:Date.now(),sessions:s}),failedAgain);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),failedAgain);
  assert.equal(await frame.evaluate(()=>__notifications.length),0);
  assert.equal(await page.evaluate(()=>__notifications.length),2);
  assert.equal(await page.evaluate(()=>__notifications[1].title),'pending-error：錯誤');
  const errorBody=await page.evaluate(()=>__notifications[1].options.body);
  assert.match(errorBody,/Could not connect to runner/);
  assert.match(errorBody,/Choose a recovery step/);
  check('one main-page error notification keeps the error and simultaneous response together; PiP stays silent');
  await filterAgent(page,'all');
  await frame.click('#viewSeg [data-v=office]');await openSettings(page);await page.check('#showAgent');await frame.click('#qualSeg [data-v=mid]');
  await frame.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  await page.waitForFunction(()=>state.quality==='mid');
  const foreground=await context.newPage();await foreground.goto('about:blank');await foreground.bringToFront();
  const before=await frame.evaluate(()=>({frames:office.framesShown,visible:document.visibilityState}));
  await new Promise(r=>setTimeout(r,1100));
  const after=await frame.evaluate(()=>({frames:office.framesShown,visible:document.visibilityState}));
  assert.ok(after.frames>before.frames,JSON.stringify({before,after}));
  await foreground.close();check('pop-out keeps animating while another tab is foreground');
  await pip.close();await page.waitForFunction(()=>!popout.win&&office.visible);
  await page.bringToFront();await page.waitForFunction(()=>office.framesShown>4);
  await page.click('#pipBtn');await page.waitForFunction(()=>!!popout.win);
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.win&&office.visible);
  check('native close and button close restore the main view; reopening works');
  await page.evaluate(()=>{documentPictureInPicture.requestWindow=()=>Promise.reject(new Error('Test rejection'))});
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.busy&&!document.getElementById('pipError').hidden);
  assert.equal(await page.evaluate(()=>office.visible),true);
  assert.equal(await page.locator('#pipBtn').isEnabled(),true);
  check('request failure gives a translated error and leaves the dashboard usable');
  // App web views expose Document PiP but can't open its window: fall back to the video pop-out.
  await page.evaluate(()=>{const e=new Error('Internal error: no window');e.name='InvalidStateError';documentPictureInPicture.requestWindow=()=>Promise.reject(e)});
  await page.click('#pipBtn');await page.waitForFunction(()=>!popout.busy&&!!popout.stream);
  assert.equal(await page.locator('#pipError').isVisible(),false,'no error when the video pop-out can stand in');
  assert.equal(await page.locator('#pipPreview').isVisible(),true);
  await page.click('#closePreview');await page.waitForFunction(()=>!popout.stream);
  assert.equal(await page.evaluate(()=>popout.documentBroken),true,'later clicks go straight to the video pop-out');
  await page.evaluate(()=>{popout.documentBroken=false});
  check('a browser that cannot open the pop-out window falls back to the video pop-out');
  // Force only the capability branch; rendering and MediaStream remain real.
  const fallback=await context.newPage();
  await fallback.setViewportSize({width:1280,height:800});
  await fallback.addInitScript(()=>Object.defineProperty(window,'documentPictureInPicture',{value:undefined}));
  await fallback.goto(base+'/?view=office&quality=high');await stable(fallback);
  await fallback.waitForFunction(()=>office.loaded&&office.framesShown>4);
  await fallback.click('#pipBtn');
  await fallback.waitForFunction(()=>!!popout.stream&&!popout.busy&&document.getElementById('pipVideo').videoWidth>0);
  await fallback.setViewportSize({width:480,height:400});
  await fallback.waitForFunction(()=>document.getElementById('pipVideo').getBoundingClientRect().width>=400);
  assert.equal(await fallback.locator('#pipPreview').isVisible(),true);
  await fallback.evaluate(()=>__events.fail());await fallback.waitForFunction(()=>state.connection==='disconnected');
  const overlay=await fallback.evaluate(()=>{
   const c=popout.captureContext,original=c.fillText,originalRect=c.fillRect,originalDraw=c.drawImage,values=[],images=[];
   let band;
   c.fillText=function(text,...args){values.push({text:String(text),font:c.font,y:args[1],width:c.measureText(String(text)).width,maxWidth:args[2]});return original.call(this,text,...args)};
   c.fillRect=function(...args){if(args[0]===0&&args[1]===0&&args[2]===popout.captureCanvas.width&&args[3]<popout.captureCanvas.height)band={top:args[1],height:args[3]};return originalRect.call(this,...args)};
   c.drawImage=function(image,...args){if(args.length>=4)images.push({top:args[1],height:args[3]});return originalDraw.call(this,image,...args)};
   try {popout.drawPreview(office)} finally {c.fillText=original;c.fillRect=originalRect;c.drawImage=originalDraw}
   return {videoWidth:document.getElementById('pipVideo').getBoundingClientRect().width,canvasWidth:popout.captureCanvas.width,canvasHeight:popout.captureCanvas.height,band,lines:values,images};
  });
  assert.equal(overlay.lines.length,2);
  assert.ok(overlay.videoWidth<=480&&overlay.videoWidth>=400);
  assert.ok(overlay.band&&overlay.band.top===0&&overlay.band.height>=80&&overlay.band.height<=100,'connection text sits in a dedicated top band');
  assert.ok(overlay.images.length>0&&overlay.images.every(image=>image.top>=overlay.band.height),'office rendering stays below the connection band');
  for (const line of overlay.lines) {
   const fontSize=Number(line.font.match(/(\d+(?:\.\d+)?)px/)?.[1]);
   assert.ok(line.y+fontSize<=overlay.band.height,`${line.text} should fit vertically inside the top band`);
   assert.ok(fontSize*overlay.videoWidth/overlay.canvasWidth>=11,`${line.font} should remain legible at 480px: ${overlay.videoWidth}px video`);
   assert.ok(line.width<=line.maxWidth,`${line.text} must fit without horizontal compression`);
  }
  const overlayText=overlay.lines.map(line=>line.text).join('\n');
  assert.match(overlayText,/Dashboard disconnected|儀表板連線中斷/);
  assert.match(overlayText,/Last data update|最後資料更新/);
  await screenshot(fallback,'video-connection-disconnected');
  await fallback.locator('#pipVideo').hover();
  await screenshotElement(fallback,fallback.locator('#pipVideo'),'video-preview-480');
  await fallback.evaluate(()=>__events.open());
  assert.equal(await fallback.evaluate(()=>state.connection),'disconnected');
  await fallback.evaluate(s=>__events.send({now:Date.now(),sessions:s}),sessions);
  await fallback.waitForFunction(()=>state.connection==='connected');
  const colors=await fallback.evaluate(()=>{
   const data=popout.captureContext.getImageData(0,0,960,540).data;const values=new Set();
   for(let i=0;i<data.length;i+=160)values.add(`${data[i]},${data[i+1]},${data[i+2]}`);
   window.__stream=popout.stream;return values.size;
  });
  assert.ok(colors>20,'preview includes rendered 3D content rather than a blank frame');
  await fallback.setViewportSize({width:1280,height:800});
  await fallback.click('#qualSeg [data-v=mid]');await fallback.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  assert.equal(await fallback.evaluate(()=>popout.stream===__stream),true);
  await fallback.click('#closePreview');await fallback.waitForFunction(()=>!popout.stream);
  assert.equal(await fallback.evaluate(()=>__stream.getTracks().every(t=>t.readyState==='ended')),true);
  assert.equal(await fallback.evaluate(()=>document.getElementById('pipVideo').srcObject),null);
  check('video fallback captures 3D + overlay, survives renderer changes and releases media tracks on stop');
  const compact=await context.newPage();await compact.goto(base+'/?pip=1&view=list');
  await compact.waitForFunction(()=>state.loaded);
  await compact.evaluate(()=>{__events.close();onData({now:Date.now(),sessions:[]})});
  assert.match(await compact.locator('#main').innerText(),/目前沒有|No agents/);
  await compact.reload();assert.equal(await compact.evaluate(()=>PIP),true);
  check('empty compact list explains the quiet state and retains compact mode after reload');
  await page.bringToFront();
  await openSettings(page);
  await page.locator('#settingsMenu > summary').press('Escape');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  assert.equal(await page.locator('#settingsMenu > summary').evaluate(el=>el===document.activeElement),true);
  await openSettings(page);await page.click('h1');
  assert.equal(await page.locator('#settingsPanel').isVisible(),false);
  }
  const magpieSessions = [
   ...sessions,
   {key:'opencode:remote',id:'remote',agent:'opencode',agentName:'OpenCode',source:'magpie',status:'thinking',title:'Gateway task',lastEventAt:Date.now()},
   {key:'omp:remote',id:'remote',agent:'omp',source:'magpie',status:'thinking',lastEventAt:Date.now()},
   {key:'magpie:remote',id:'remote',agent:'magpie',agentName:'Magpie',source:'magpie',status:'unknown',lastEventAt:Date.now()},
  ];
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),magpieSessions);
  assert.equal(await page.locator('#side .srow[data-key="opencode:remote"] .nm').innerText(),'OpenCode');
  assert.equal(await resumeOf(page,'opencode:remote'),null);
  assert.equal(await resumeOf(page,'omp:remote'),null);
  assert.ok(await resumeOf(page,'omp:four'));
  assert.ok(await resumeOf(page,'claude:one'));
  await filterAgent(page,'opencode');
  assert.equal(await page.locator('#side .srow').count(),1);
  assert.equal(await page.locator('#agentChips [data-v=opencode]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#agentChips [data-v=opencode]').getAttribute('title'),'OpenCode');
  await filterAgent(page,'all');
  await filterAgent(page,'magpie');
  assert.deepEqual(await rowKeys(page),['magpie:remote'],'unknown Magpie sessions stay visible when the idle filter is off');
  assert.equal(await page.evaluate(()=>state.data.sessions.find(s=>s.key==='magpie:remote').status),'unknown');
  // A list under the pointer holds still until it leaves; move away before the update.
  await page.mouse.move(5,400);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),magpieSessions);
  assert.equal(await page.locator('#side .srow').count(),1,'a successful snapshot without a live request does not turn unknown into idle');
  await page.reload();await page.waitForFunction(()=>state.loaded);
  await page.evaluate(s=>{__events.close();onData({now:Date.now(),sessions:s})},magpieSessions);
  assert.deepEqual(await page.evaluate(()=>state.agents),['magpie']);
  await filterAgent(page,'all');
  for (const quality of ['mid','high']) {
   await page.click(`#qualSeg [data-v=${quality}]`);
   await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
   assert.equal(await page.evaluate(()=>office.people.has('opencode:remote')),true);
  }
  await page.hover('#side .srow >> nth=0');
  const before=await rowKeys(page);
  await page.evaluate(([s,k])=>onData({now:Date.now(),sessions:s.map(x=>x.key===k?{...x,status:'done'}:x)}),[magpieSessions,before[0]]);
  assert.deepEqual(await rowKeys(page),before,'rows hold still under the pointer');
  await page.mouse.move(5,400);
  assert.notDeepEqual(await rowKeys(page),before,'and catch up once it leaves');
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),magpieSessions);
  check('Magpie clients reuse the agent panel, filters, idle visibility and both offices without invalid resume commands');
  const nativeClients = [
   {key:'kimi:one',id:'one',sessionId:'one',agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
   {key:'dsh:two',id:'two',agent:'dsh',status:'waiting',activity:'Shell',cwd:'/demo/dsh'},
   {key:'grok:three',id:'three',agent:'grok',status:'tool',activity:'Read',cwd:'/demo/grok'},
   {key:'kimi:one/agent-1',id:'one/agent-1',sessionId:'one',parentId:'one',subagent:true,agent:'kimi',status:'thinking',cwd:'/demo/kimi'},
  ].map(s=>({...s,lastEventAt:Date.now()}));
  await page.evaluate(s=>{state.agents=[];state.showSub=false;onData({now:Date.now(),sessions:s})},nativeClients);
  await page.evaluate(s=>onData({now:Date.now(),sessions:s}),nativeClients);
  assert.equal(await page.locator('#agentLegend img').count(),3, 'old providers leave the legend');
  for (const agent of ['kimi','dsh','grok']) {
   assert.equal(await page.locator(`#agentChips button[data-v="${agent}"]`).count(),1);
   const logo=page.locator(`#agentChips button[data-v="${agent}"] img`);
   await page.waitForFunction(agent=>{
    const img=document.querySelector(`#agentChips button[data-v="${agent}"] img`);
    return img?.complete&&img.naturalWidth>0;
   },agent);
   assert.equal(await logo.evaluate(img=>img.complete&&img.naturalWidth>0),true);
   assert.equal(await page.locator(`#agentLegend img[src="/assets/agents/${agent}.svg"]`).count(),1);
  }
  assert.equal(await page.locator('#side .srow').count(),3);
  assert.match(await resumeOf(page,'dsh:two'),/dsh tui --resume 'two'/);
  assert.match(await resumeOf(page,'kimi:one'),/kimi --session 'one'/);
  assert.match(await resumeOf(page,'grok:three'),/grok --resume 'three'/);
  await filterAgent(page,'kimi');
  assert.equal(await page.locator('#side .srow').count(),1);
  assert.equal(await page.locator('#agentLegend img').count(),1);
  assert.equal(await page.locator('#agentLegend img').getAttribute('src'),'/assets/agents/kimi.svg');
  await openSettings(page);await page.check('#showSub');
  assert.equal(await page.locator('#side .srow').count(),2);
  await filterAgent(page,'all');
  for (const quality of ['mid','high']) {
   await page.click(`#qualSeg [data-v=${quality}]`);
   await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
   // Reused renderers animate the previous fixture's people walking out.
   await page.waitForFunction(keys=>office.people.size===keys.length&&keys.every(k=>office.people.has(k)),nativeClients.map(s=>s.key));
   assert.deepEqual([...new Set(await badges(page))].sort(),['Ds','Gr','Ki']);
   assert.deepEqual(await drawnLogos(page),['dsh','grok','kimi']);
   assert.equal(await page.evaluate(()=>office.people.has('kimi:one/agent-1')),true);
   await page.evaluate(s=>onData({now:Date.now(),sessions:s.filter(x=>x.agent==='kimi')}),nativeClients);
   assert.equal(await page.locator('#agentLegend img').count(),1, 'two Kimi sessions share one legend entry');
   await page.evaluate(()=>onData({now:Date.now(),sessions:[]}));
   assert.equal(await page.locator('#agentLegend img').count(),0);
   assert.equal(await page.locator('#agentLegend').isHidden(),true);
   await page.evaluate(s=>onData({now:Date.now(),sessions:s}),nativeClients);
   assert.equal(await page.locator('#agentLegend img').count(),3);
   assert.equal(await page.locator('#agentLegend').isVisible(),true);
  }
  check('Kimi, DSH and Grok support filters, subagents, resume commands and packaged logos in both offices');
  check('agent legends follow current sessions and filters, disappear when empty and return without duplicates in 2D/3D');
  for (const colorScheme of ['light','dark']) {
   await page.emulateMedia({colorScheme});
   await openSettings(page);
   for (const agent of ['kimi','dsh','grok']) {
    const selector=`#agentChips [data-v="${agent}"] img`;
    const filter=await page.locator(selector).evaluate(img=>getComputedStyle(img).filter);
    assert.equal(filter,colorScheme==='dark'&&agent!=='dsh'?'invert(1)':'none');
   }
   for (const agent of ['kimi','grok']) {
    const filter=await page.locator(`#side .srow img[src="/assets/agents/${agent}.svg"]`).first().evaluate(img=>getComputedStyle(img).filter);
    assert.equal(filter,colorScheme==='dark'?'invert(1)':'none');
   }
   await screenshot(page,`panel-${colorScheme}`);
   await page.locator('#settingsMenu > summary').press('Escape');
   for(const quality of ['mid','high']) {
    await page.click(`#qualSeg [data-v=${quality}]`);
    await page.waitForFunction(q=>officeKind.startsWith(q)&&office.framesShown>4&&(q!=='high'||office.loaded),quality);
    assert.deepEqual(await drawnLogos(page),['dsh','grok','kimi']);
    await screenshot(page,`office-${quality}-${colorScheme}`);
   }
  }
  check('agent panel, filters, legend and both offices preserve light/dark native logos');
  const fallbackPage=await context.newPage();
  await fallbackPage.route('**/assets/agents/kimi.svg',route=>route.abort());
  await fallbackPage.goto(base);
  await fallbackPage.waitForFunction(()=>state.loaded);
  await fallbackPage.evaluate(s=>{__events.close();state.agents=[];state.showSub=true;onData({now:Date.now(),sessions:s})},nativeClients);
  await fallbackPage.click('#qualSeg [data-v=mid]');
  await fallbackPage.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4&&OFFICE_AGENT_BADGES.kimi.image.complete);
  assert.equal(await fallbackPage.evaluate(()=>OFFICE_AGENT_BADGES.kimi.image.naturalWidth),0);
  assert.equal(await fallbackPage.evaluate(()=>{
   const texts=[],ctx=office.ctx,original=ctx.fillText;
   ctx.fillText=function(text,...args){texts.push(text);return original.call(this,text,...args)};
   try {office.frame(performance.now());} finally {ctx.fillText=original;}
   return texts.includes('Ki');
  }),true);
  await fallbackPage.close();
  check('a failed Kimi image still draws the existing canvas initials');
  if (!clientsOnly) {
  for (const width of [320,390,768,1280]) {
   await page.setViewportSize({width,height:800});
   for (const colorScheme of ['light','dark']) {
    await page.emulateMedia({colorScheme});
    await openSettings(page);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const status=await page.locator('#conn').boundingBox();
    assert.ok(status&&status.x>=0&&status.x+status.width<=width&&status.y+status.height<=800);
    const panel=await page.locator('#settingsPanel').boundingBox();
    assert.ok(panel.x>=0 && panel.x+panel.width<=width);
    await page.locator('#settingsMenu > summary').press('Escape');
    await screenshot(page,`toolbar-${width}-${colorScheme}`);
   }
  }
  check('settings close with Escape/outside click, restore focus, and fit narrow and wide screens in both themes');
  }
  }
  const formatKey='codex:message-format', otherFormatKey='codex:message-format-other';
  const formatPrompt='## Ask\n- Keep foo_bar';
  const formatReply='**Finished** [details](javascript:alert(1))';
  const longCodeLine=`const value = "${'x'.repeat(260)}";`;
  const formatSource=[
   '# Message preview','', '## Safe formatting','', '- first item','- second item','', '> quoted safely','',
   '```js',longCodeLine,'```','',
   'Use `x < y` and [documentation](https://example.com/docs?a=1&b=2).','',
   '<script>window.__formatPayload = true</script>',
   '<img src="https://example.invalid/pixel.png" onerror="window.__formatPayload = true">',
   '![remote image](https://example.invalid/markdown-image.png)',
   ...Array.from({length:12},(_,index)=>`source line ${index+1}: ${'path_name '.repeat(4)}`),
  ].join('\n');
  assert.ok(formatSource.length<=1500,'the fixture stays within the transcript snippet limit');
  const formatSession={key:formatKey,id:'message-format',agent:'codex',project:'format-project',cwd:'/demo/format-project',
   title:'### Original title',prompt:formatPrompt,reply:formatReply,status:'done',activity:'Read: **important_file.js**',
   error:'ERROR: **raw error**',pendingRequests:[{summary:'**Grant access** to [file](javascript:alert(1))'}],
   lastEventAt:Date.now()-60_000,turnStartedAt:Date.now()-120_000};
  const otherFormatSession={...formatSession,key:otherFormatKey,id:'message-format-other',project:'other-format-project',
   cwd:'/demo/other-format-project',title:null,prompt:null,reply:null,error:null,pendingRequests:[],
   activity:'Read: other_file.js',lastEventAt:Date.now()};
  let formatMessages=[
   {role:'user',text:formatSource,at:Date.now()-30_000},
   {role:'assistant',text:'**Assistant reply**\n\nUse _carefully_.',at:Date.now()-20_000},
   {role:'tool',text:'**plain tool**',at:Date.now()-10_000},
  ];
  const updatedFormatText='## Transcript updated\n\n- the source view stays on';
  let formatTranscriptFetches=0;
  const externalImageRequests=[];
  await page.route('**/api/transcript*',async route=>{
   const key=new URL(route.request().url()).searchParams.get('key');
   if(key===formatKey){
    formatTranscriptFetches++;
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messages:formatMessages,private:false})});
   } else if(key===otherFormatKey){
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({messages:[{role:'user',text:'[source](javascript:alert(1))',at:Date.now()}],private:false})});
   } else await route.continue();
  });
  await page.route('https://example.invalid/**',async route=>{externalImageRequests.push(route.request().url());await route.abort()});
  await page.evaluate(()=>{store.set('lang','en');state.lang='en';applyLang('en');render()});
  await page.waitForFunction(()=>langCode==='en',null,{timeout:10000});
  await page.evaluate(s=>onData({now:Date.now(),sessions:[...state.data.sessions,s]}),formatSession);
  await page.waitForFunction(()=>langCode==='en',null,{timeout:10000});
  await page.waitForFunction(key=>document.querySelector(`#side .srow[data-key="${key}"]`),formatKey,{timeout:10000});
  const cardSummary=await page.evaluate(s=>{
   const host=document.createElement('div');host.innerHTML=card(s,Date.now());
   return {prompt:host.querySelector('.q')?.textContent,promptTitle:host.querySelector('.q')?.title,
    reply:host.querySelector('.r')?.textContent,replyTitle:host.querySelector('.r')?.title,title:host.querySelector('.title')?.textContent};
  },formatSession);
  assert.equal(cardSummary.prompt,'Ask Keep foo_bar');
  assert.equal(cardSummary.promptTitle,formatPrompt);
  assert.equal(cardSummary.reply,'Finished details');
  assert.equal(cardSummary.replyTitle,formatReply);
  assert.equal(cardSummary.title,formatSession.title,'the original card title stays intact');
  const rowActivity=await page.locator(`#side .srow[data-key="${formatKey}"] .st > span:not(.freshness)`).innerText();
  assert.match(rowActivity,/Grant access to file/);
  assert.match(rowActivity,/ERROR: \*\*raw error\*\*/,'error output remains unchanged');
  assert.match(rowActivity,/Read: \*\*important_file\.js\*\*/,'tool activity remains unchanged');
  assert.match(rowActivity,/Original title/);
  assert.match(rowActivity,/Finished details/);
  await openAgent(page,formatKey);
  await page.waitForFunction(()=>document.querySelector('#detailBody .msg.user pre')&&document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='false',null,{timeout:10000});
  await waitForFiniteAnimations(page);
  assert.equal(await page.evaluate(()=>typeof MessageFormat),'object','the served dashboard loads the message renderer');
  assert.equal(await page.locator('#detailBody .msg.user h1').innerText(),'Message preview');
  assert.equal(await page.locator('#detailBody .msg.user h2').innerText(),'Safe formatting');
  assert.equal(await page.locator('#detailBody .msg.user li').count(),2);
  assert.equal(await page.locator('#detailBody .msg.user blockquote').innerText(),'quoted safely');
  assert.equal(await page.locator('#detailBody .msg.user a').getAttribute('href'),'https://example.com/docs?a=1&b=2');
  assert.equal(await page.locator('#detailBody .msg.user img, #detailBody .msg.user script').count(),0);
  assert.equal(await page.evaluate(()=>window.__formatPayload),undefined);
  assert.deepEqual(externalImageRequests,[],'Markdown images and raw image tags make no network request');
  assert.equal(await page.locator('#detailBody .msg.tool .msg-content').textContent(),'**plain tool**','tool messages stay plain');
  const codeBox=await page.locator('#detailBody .msg.user pre').evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
  assert.ok(codeBox.scrollWidth>codeBox.width,'long fenced code scrolls inside the message bubble');
  await page.setViewportSize({width:320,height:640});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'formatted messages do not overflow a 320px page');
  const sourceToggle=page.locator('#messageViewToggle');
  assert.equal(await sourceToggle.innerText(),'Show source');
  await page.locator('#detailBody').evaluate(el=>{el.scrollTop=0});
  await sourceToggle.evaluate(el=>el.focus({preventScroll:true}));
  const beforeToggleScroll=await page.locator('#detailBody').evaluate(el=>el.scrollTop);
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='true',null,{timeout:10000});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'messageViewToggle','keyboard focus stays on the replacement toggle');
  assert.equal(await page.locator('#detailBody').evaluate(el=>el.scrollTop),beforeToggleScroll,'switching views does not jump to the conversation bottom');
  assert.equal(await page.locator('#detailBody .msg.user .msg-content').textContent(),formatSource,'source mode shows the exact received text');
  assert.equal(await sourceToggle.innerText(),'Show formatted');
  formatMessages=[...formatMessages,{role:'assistant',text:updatedFormatText,at:Date.now()}];
  await page.evaluate(key=>onData({now:Date.now(),sessions:state.data.sessions.map(s=>s.key===key?{...s,lastEventAt:Date.now()}:s)}),formatKey);
  await page.waitForFunction(expected=>{
   const messages=[...document.querySelectorAll('#detailBody .msg.assistant .msg-content')];
   return messages.at(-1)?.textContent===expected&&document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='true';
  },updatedFormatText,{timeout:10000});
  assert.equal(await page.evaluate(()=>document.activeElement.id),'messageViewToggle','focus stays on the toggle after the transcript refresh');
  assert.ok(formatTranscriptFetches>=2,'a newer session event reloads the transcript');
  await page.setViewportSize({width:1280,height:960});
  await waitForFiniteAnimations(page);
  await backToList(page);
  await openAgent(page,formatKey);
  await page.waitForFunction(()=>document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='true',null,{timeout:10000});
  await waitForFiniteAnimations(page);
  await page.locator('#messageViewToggle').press('Space');
  await page.waitForFunction(()=>document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='false',null,{timeout:10000});
  for(const view of [
   {width:320,scheme:'light',language:'en'},
   {width:320,scheme:'dark',language:'zh-TW'},
   {width:480,scheme:'light',language:'zh-TW'},
   {width:480,scheme:'dark',language:'en'},
  ]){
   await page.setViewportSize({width:view.width,height:800});
   await page.emulateMedia({colorScheme:view.scheme});
   await page.evaluate(language=>{applyLang(language);render()},view.language);
   await page.waitForFunction(language=>langCode===language,view.language,{timeout:10000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${view.width}px ${view.scheme} message view has no page overflow`);
   if(view.language==='zh-TW') assert.equal(await page.locator('#messageViewToggle').innerText(),'顯示原文');
   await page.locator('#detailBody .msg.user').scrollIntoViewIfNeeded();
   await screenshot(page,`message-view-${view.width}-${view.scheme}-${view.language}`);
  }
  await waitForFiniteAnimations(page);
  await backToList(page);
  await page.evaluate(s=>onData({now:Date.now(),sessions:[...state.data.sessions,s]}),otherFormatSession);
  await openAgent(page,otherFormatKey);
  await page.waitForFunction(()=>document.querySelector('#messageViewToggle')?.getAttribute('aria-pressed')==='false',null,{timeout:10000});
  assert.equal(await page.locator('#detailBody .msg.user .msg-content').textContent(),'source','opening another session resets to formatted view');
  check('conversation Markdown, safe source toggle, summaries, session updates and narrow view behave correctly');
  assert.deepEqual(errors,[]);check('no uncaught browser errors');
  console.log('TOTAL',checks.length);
 } finally {
  await browser?.close();
  watcher.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
