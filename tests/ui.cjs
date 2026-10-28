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
async function screenshot(page, name) {
  if (!screenshots) return;
  fs.mkdirSync(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name + '.png') });
}
async function screenshotElement(locator, name) {
 if (!screenshots) return;
 fs.mkdirSync(screenshots, { recursive: true });
 await locator.screenshot({ path: path.join(screenshots, name + '.png') });
}
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
  const page=await context.newPage();await page.goto(base);await stable(page);
  await page.waitForFunction(()=>state.connection==='connected'&&state.lastUpdateAt!==null);
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
  assert.equal(await page.locator('h1 [data-t]').innerText(),"What's my agent doing");
  assert.equal(await page.locator('#showAgent').isChecked(),true);
  assert.deepEqual([...new Set(await badges(page))].sort(),['Cl','Cx','G','OMP']);
  assert.deepEqual(await drawnLogos(page),['claude','codex','gemini','omp']);
  assert.equal(await page.locator('#agentLegend img').evaluateAll(imgs=>imgs.length===4&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  check('all four agent icons load and show in 2D and the legend; OMP uses a neutral mark');
  await openSettings(page);await page.click('#agentSeg [data-v=omp]');
  await page.click('#viewSeg [data-v=list]');
  assert.equal(await page.locator('#conn').isVisible(),true);
  assert.equal(await page.locator('.card').count(),1);
  assert.equal(await page.locator('.card .agent.omp').innerText(),'OMP');
  assert.equal(await page.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.evaluate(()=>{window.__copied=null;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})});
  await page.click('.card .copy');
  assert.equal(await page.evaluate(()=>window.__copied),sessions.find(s=>s.agent==='omp').resumeCommand);
  await page.reload();await page.waitForFunction(()=>state.loaded);
  assert.equal(await page.evaluate(()=>state.agent),'omp');assert.equal(await page.locator('.card').count(),1);
  check('OMP filter, list, Resume copy and saved filter work');
  await openSettings(page);await page.click('#agentSeg [data-v=all]');await page.click('#viewSeg [data-v=office]');
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
  check('main and Document PiP keep independent connection and last-update state through loss and recovery');
  assert.deepEqual(await drawnLogos(frame),['claude','codex','gemini','omp']);
  assert.equal(await page.evaluate(()=>office.visible),false);
  assert.equal(await frame.evaluate(()=>state.quality),'high');
  assert.equal(await frame.locator('#pipBtn').isVisible(),false);
  await frame.waitForFunction(()=>!document.getElementById('office').classList.contains('loading'));await page.waitForTimeout(400);await screenshot(pip, 'pip-3d');
  assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  check('real Document PiP opens 3D at compact size and suspends the main office');
  await openSettings(page);await page.click('#agentSeg [data-v=omp]');await frame.waitForFunction(()=>state.agent==='omp');
  await frame.click('#viewSeg [data-v=list]');
  assert.equal(await frame.locator('.card').count(),1);
  assert.equal(await frame.locator('.card .copy').getAttribute('data-copy'),sessions.find(s=>s.agent==='omp').resumeCommand);
  await frame.click('#viewSeg [data-v=office]');
  check('OMP is in the pop-out filter and list with the right Resume command');
  await openSettings(page);await page.uncheck('#showAgent');await frame.waitForFunction(()=>!state.showAgent&&!office.showAgent);
  const pipUpdateBeforeLanguage=await frame.evaluate(()=>state.lastUpdateAt);
  await openSettings(page);await page.selectOption('#langSel','zh-TW');await frame.waitForFunction(()=>langCode==='zh-TW');
  assert.equal(await frame.evaluate(()=>state.lastUpdateAt),pipUpdateBeforeLanguage);
  assert.match(await frame.locator('#conn').innerText(),/儀表板連線正常/);
  await openSettings(page);await page.click('#agentSeg [data-v=codex]');await frame.waitForFunction(()=>state.agent==='codex');
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
  assert.equal(await frame.locator('.card .agent img').evaluateAll(imgs=>imgs.length>0&&imgs.every(img=>img.complete&&img.naturalWidth>0)),true);
  await screenshot(pip, 'pip-list');
  check('compact list keeps pending errors in Needs you and shows errors, unknown status, and fresh/stale evidence');
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
  await openSettings(page);await page.click('#agentSeg [data-v=all]');
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
  // Force only the capability branch; rendering and MediaStream remain real.
  const fallback=await context.newPage();
  await fallback.setViewportSize({width:480,height:400});
  await fallback.addInitScript(()=>Object.defineProperty(window,'documentPictureInPicture',{value:undefined}));
  await fallback.goto(base+'/?view=office&quality=high');await stable(fallback);
  await fallback.waitForFunction(()=>office.loaded&&office.framesShown>4);
  await fallback.click('#pipBtn');
  await fallback.waitForFunction(()=>!!popout.stream&&!popout.busy&&document.getElementById('pipVideo').videoWidth>0);
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
  await screenshotElement(fallback.locator('#pipVideo'),'video-preview-480');
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
  await fallback.click('#qualSeg [data-v=mid]');await fallback.waitForFunction(()=>officeKind==='mid'&&office.framesShown>4);
  assert.equal(await fallback.evaluate(()=>popout.stream===__stream),true);
  await fallback.click('#closePreview');await fallback.waitForFunction(()=>!popout.stream);
  assert.equal(await fallback.evaluate(()=>__stream.getTracks().every(t=>t.readyState==='ended')),true);
  assert.equal(await fallback.evaluate(()=>document.getElementById('pipVideo').srcObject),null);
  check('video fallback captures 3D + overlay, survives renderer changes and releases media tracks on stop');
  await fallback.click('#viewSeg [data-v=list]');assert.equal(await fallback.locator('#pipBtn').isVisible(),false);
  check('view-only fallback is offered only for office mode');
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
  assert.deepEqual(errors,[]);check('no uncaught browser errors');
  console.log('TOTAL',checks.length);
 } finally {
  await browser?.close();
  watcher.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
})().catch(e=>{console.error(e);process.exitCode=1});
