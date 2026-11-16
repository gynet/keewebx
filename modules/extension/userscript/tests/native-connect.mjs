// Real isolated-world installer, native postMessage/BroadcastChannel and KDBX acceptance.
// A Chromium WebExtension adapts the GM settings API; this is not native iOS certification.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';


const ROOT = resolve(process.env.KWX_REPO_ROOT || fileURLToPath(new URL('../../../..', import.meta.url)));
const BUN = process.env.KWX_BUN || 'bun';
const APP_SERVER = process.env.KWX_APP_SERVER || 'http://127.0.0.1:39232';
const SOURCE = resolve(process.env.KWX_USERSCRIPT || join(ROOT, 'modules/extension/userscript/keewebx-connect.user.js'));
const STORAGE_EVENTS = process.env.KWX_DISABLE_STORAGE_EVENTS !== '1';
const OUT = resolve(process.env.KWX_E2E_OUTPUT_DIR || mkdtempSync(join(tmpdir(), 'keewebx-native-connect-')));
mkdirSync(OUT,{recursive:true});
const APP = 'https://keewebx.app/app';
const MARK = 'keewebx-native-connect-v1';
const ROUTE_KEY = `${MARK}:selected:${APP}`;
const PREFIX = 'Connect.user.js---';
const DB_PASSWORD = 'Disposable-native-vault-2026!';
const ACCOUNTS = [
 {title:'First fixture account',url:'https://login.example.org/',user:'first-fixture-user',password:'Disposable-first-password!'},
 {title:'Second fixture account',url:'https://signin.example.net/',user:'second-fixture-user',password:'Disposable-second-password!'},
 {title:'Unrelated fixture account',url:'https://wrong.example.com/',user:'unrelated-fixture-user',password:'Disposable-unrelated-password!'},
 {title:'Apex forum fixture account',url:'uscardforum.com',user:'forum-fixture-user',password:'Disposable-forum-password!'}
];
const PRIVATE_VALUES=[DB_PASSWORD,...ACCOUNTS.flatMap(a=>[a.title,a.user,a.password])];
const redact=value=>PRIVATE_VALUES.reduce((result,secret)=>result.replaceAll(secret,'[fixture value]'),String(value));
const report={started:new Date().toISOString(),scope:'Exact installer in Chromium isolated content scripts, native window and BroadcastChannel delivery, native extension storage with GM adapter, real KDBX and native consent', nativeIOSVerified:false,realManagerVerified:false,storageNotifications:STORAGE_EVENTS,steps:[],errors:[]};
const cdpByPage=new WeakMap(), lifecycleByPage=new WeakMap(), gm=new Map(), connectors=new Map();
let context, app, first, second, nativeWorker, originalApp, approvedRoute, appNavigationRequests=0;
let expectedForgeryIds=[];
async function step(name, fn) {
    console.log(JSON.stringify({ step: name, state: 'started' }));
    const started = Date.now();
    try {
        const detail = await fn() || {};
        const result = { name, state: 'passed', milliseconds: Date.now() - started, ...detail };
        report.steps.push(result);
        console.log(JSON.stringify(result));
    } catch (error) {
        report.steps.push({ name, state: 'failed', error: redact(error.message) });
        throw error;
    }
}

// Closed-shadow controls are inspected with CDP, just as in connect.mjs.
async function cdp(page) {
    if (!cdpByPage.has(page)) cdpByPage.set(page, await context.newCDPSession(page));
    return cdpByPage.get(page);
}
async function realVisibility(page) {
    if (!lifecycleByPage.has(page)) {
        // Playwright forces every tab visible through its own CDP session.
        // Disable that override on that session, not a second session whose
        // setting cannot override it. This is pinned to our Playwright version.
        const session=page._connection.toImpl(page).delegate._mainFrameSession._client;
        lifecycleByPage.set(page,session.send('Emulation.setFocusEmulationEnabled',{enabled:false}));
    }
    await lifecycleByPage.get(page);
}
function hostIn(node) {
    if (node.attributes?.some((value, index, attributes) => index % 2 === 0 && value === 'id' && attributes[index + 1] === 'keewebx-userscript-connect')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = hostIn(child); if (found) return found;
    }
}
async function shadowNode(page, selector, index = 0) {
    const session = await cdp(page);
    const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = hostIn(root);
    if (!host?.shadowRoots?.[0]) throw new Error('Closed-shadow Connect widget missing');
    const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: host.shadowRoots[0].nodeId, selector });
    return { session, nodeId: nodeIds[index] };
}
async function shadowValue(page, selector, property = 'textContent', index = 0) {
    const { session, nodeId } = await shadowNode(page, selector, index);
    if (!nodeId) return null;
    const { object } = await session.send('DOM.resolveNode', { nodeId });
    try {
        const { result, exceptionDetails } = await session.send('Runtime.callFunctionOn', {
            objectId: object.objectId, functionDeclaration: 'function(property) { return this[property]; }',
            arguments: [{ value: property }], returnByValue: true
        });
        if (exceptionDetails) throw new Error('CDP closed-shadow read failed');
        return result.value;
    } finally { await session.send('Runtime.releaseObject', { objectId: object.objectId }); }
}
async function shadowClick(page, selector) {
    await page.bringToFront();
    const { session, nodeId } = await shadowNode(page, selector);
    if (!nodeId) throw new Error(`Closed-shadow control missing: ${selector}`);
    await session.send('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { model } = await session.send('DOM.getBoxModel', { nodeId });
    const q = model.content;
    await page.mouse.click((q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4);
}
const action = (page, name) => shadowClick(page, `[data-action="${name}"]`);
const status = page => shadowValue(page, '[role="status"]');
const entries = page => shadowValue(page, '[data-role="entries"]');
const fieldReads = () => app.evaluate(() => globalThis.__kwxNativeTest.wireRequests['kwx-get-entry-fields'] || 0);
const documentState = page => page.evaluate(() => ({ href: location.href, timeOrigin: performance.timeOrigin, boot: globalThis.__kwxNativeTest.documentBoot }));
const consent = () => app.getByRole('dialog', { name: 'Allow browser extension access', exact: true });
async function untilStatus(page, expression, timeout = 10000) {
    await expect.poll(() => status(page), { timeout, message: `Connect status must match ${expression}` }).toMatch(expression);
    return status(page);
}
async function ready(page) {
    await page.waitForLoadState('domcontentloaded');
    await realVisibility(page);
    await expect(page.locator('#keewebx-userscript-connect')).toBeAttached({ timeout: 15000 });
}
async function emptyFields(page) {
    await expect(page.locator('#username')).toHaveValue('');
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}
async function clearFields(page) {
    await page.bringToFront();
    await page.locator('#username').fill('');
    await page.locator('#login-password').fill('');
}
async function lookup(page, account) {
    await page.bringToFront();
    await page.locator('#username').click();
    const readsBefore = await fieldReads();
    if (await shadowValue(page, 'section', 'hidden')) await action(page, 'toggle');
    else { await action(page, 'accounts-tab'); await action(page, 'lookup'); }
    await expect.poll(() => entries(page), { timeout: 15000 }).toContain(account.title);
    const listed = await entries(page);
    for (const other of ACCOUNTS.filter(item => item !== account)) expect(listed).not.toContain(other.title);
    expect(await status(page)).toMatch(/Found 1 matching account/);
    expect(await fieldReads()).toBe(readsBefore);
    await emptyFields(page);
}
async function fill(page, account) {
    const readsBefore = await fieldReads();
    await action(page, 'entry-0');
    await expect(page.locator('#username')).toHaveValue(account.user, { timeout: 10000 });
    await expect(page.locator('#login-password')).toHaveValue(account.password);
    expect(await fieldReads()).toBe(readsBefore + 1);
    expect(await page.evaluate(() => window.formSubmits)).toBe(0);
}

async function settings() {
 const data=await nativeWorker.evaluate(()=>chrome.storage.local.get());
 gm.clear(); for(const [key,value] of Object.entries(data))if(key.startsWith(PREFIX))gm.set(key.slice(PREFIX.length),value);
 return gm;
}
async function prepare(page) {
 await page.bringToFront();
 const pages=context.pages().length;
 await page.locator('#username').click();
 if(await shadowValue(page,'section','hidden'))await action(page,'toggle');
 else {await action(page,'accounts-tab');await action(page,'lookup');}
 await untilStatus(page,/Found 1 matching account/);
 await action(page,'config-tab');
 for(let retry=0;retry<3;retry++){await action(page,'probe');await untilStatus(page,/Connected to the authorized KeeWebX tab/);}
 expect(context.pages().length).toBe(pages);
 await action(page,'open');
 const helper=await expect.poll(()=>context.pages().find(p=>p.url().includes('connect.html')&&!Array.from(connectors.values()).includes(p)),{timeout:12000}).toBeTruthy().then(()=>context.pages().find(p=>p.url().includes('connect.html')&&!Array.from(connectors.values()).includes(p)));
 connectors.set(page,helper);
 await realVisibility(helper);
 await expect(helper.getByRole('status')).toHaveText(/Connection page ready|Connected to your existing/,{timeout:10000});
 await untilStatus(page,/Connected to the authorized KeeWebX tab/);
 await page.bringToFront();
}
async function sameApp() {
 expect(await documentState(app)).toEqual(originalApp);expect(appNavigationRequests).toBe(1);
 await expect(app.locator('.vault')).toBeVisible();await expect(consent()).toHaveCount(0);
 expect(await app.evaluate(()=>globalThis.__kwxNativeTest.consentCount)).toBe(1);
 await settings();expect(gm.get(ROUTE_KEY)).toEqual(approvedRoute);
}
async function cancelPending(page,kind) {
 await clearFields(page);await lookup(page,ACCOUNTS[0]);
 await app.evaluate(()=>globalThis.__kwxNativeTest.holdFields=true);
 await action(page,'entry-0');
 await expect.poll(()=>app.evaluate(()=>globalThis.__kwxNativeTest.heldFields.length)).toBe(1);
 const before=await page.evaluate(()=>window.credentialInputEvents);
 if(kind==='close')await action(page,'close');
 else if(kind==='hidden'){await app.bringToFront();await expect.poll(()=>page.evaluate(()=>document.hidden)).toBe(true);}
 else await page.evaluate(()=>location.hash='changed-during-fill');
 await app.evaluate(()=>globalThis.__kwxNativeTest.releaseFields());
 await page.waitForTimeout(250);
 await emptyFields(page);expect(await page.evaluate(()=>window.credentialInputEvents)).toBe(before);
}
async function setup(bundle) {
 const extension=join(OUT,'extension');mkdirSync(extension,{recursive:true});
 writeFileSync(join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Disposable native Connect fixture',version:'1.0',permissions:['storage'],background:{service_worker:'background.js'},content_scripts:[{matches:['https://*/*'],js:['content.js'],run_at:'document_idle'}]}));
 writeFileSync(join(extension,'background.js'),`const tabs=new Map();globalThis.audit=[];globalThis.muteAppMailbox=false;chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local')for(const [key,value] of Object.entries(changes))globalThis.audit.push({key,value:value.newValue});});chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.op==='getTab')reply(tabs.get(sender.tab.id)??null);else if(message.op==='saveTab'){tabs.set(sender.tab.id,message.value);reply(true);}else if(message.op==='mailboxMuted')reply(globalThis.muteAppMailbox);});`);
 writeFileSync(join(extension,'content.js'),`(()=>{const prefix='${PREFIX}';const GM={info:{scriptHandler:'${STORAGE_EVENTS ? 'Userscripts' : 'Fixture without storage notifications'}',script:{filename:'Connect.user.js'}},
 async listValues(){if(location.href==='${APP}'&&await chrome.runtime.sendMessage({op:'mailboxMuted'}))return [];return Object.keys(await chrome.storage.local.get()).filter(key=>key.startsWith(prefix)).map(key=>key.slice(prefix.length));},
 async getValue(key,fallback){const data=await chrome.storage.local.get(prefix+key);return (prefix+key) in data?data[prefix+key]:fallback;},
 async setValue(key,value){await chrome.storage.local.set({[prefix+key]:value});},async deleteValue(key){await chrome.storage.local.remove(prefix+key);},
 getTab:()=>chrome.runtime.sendMessage({op:'getTab'}),saveTab:value=>chrome.runtime.sendMessage({op:'saveTab',value})};${bundle}})();`);
 context=await chromium.launchPersistentContext(join(OUT,'profile'),{channel:'chromium',headless:true,...(process.env.KWX_BROWSER_PROXY?{proxy:{server:process.env.KWX_BROWSER_PROXY}}:{}),viewport:{width:1280,height:900},args:['--no-sandbox','--disable-extensions-except='+extension,'--load-extension='+extension]});
 nativeWorker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 for(const page of context.pages())await page.close();
 await context.addInitScript(({appUrl,marker})=>{
  if(location.protocol!=='https:')return;
  const observed={documentBoot:crypto.randomUUID(),wireRequests:{},consentCount:0,heldFields:[],holdFields:false,wirePackets:[],lifecycle:[]};globalThis.__kwxNativeTest=observed;
  for(const name of ['freeze','resume','visibilitychange'])document.addEventListener(name,event=>observed.lifecycle.push({name,hidden:document.hidden,trusted:event.isTrusted}));
  const nativePost=window.postMessage.bind(window);
  window.postMessage=(value,...rest)=>{if(observed.holdFields&&value?.kwConnect==='response'&&value.action==='kwx-get-entry-fields'){observed.heldFields.push([value,rest]);return;}return nativePost(value,...rest);};
  observed.releaseFields=()=>{observed.holdFields=false;for(const [value,rest] of observed.heldFields.splice(0))nativePost(value,...rest);};
  addEventListener('message',event=>{if(event.source===window&&event.origin===location.origin&&event.data?.kwConnect==='request'){const action=event.data.action;observed.wireRequests[action]=(observed.wireRequests[action]||0)+1;}});
  const observe=()=>{const seen=new WeakSet();const scan=()=>{for(const dialog of document.querySelectorAll('[role="dialog"],dialog'))if((dialog.getAttribute('aria-label')||dialog.textContent).includes('Allow browser extension access')&&!seen.has(dialog)){seen.add(dialog);observed.consentCount++;}};new MutationObserver(scan).observe(document.body,{childList:true,subtree:true});scan();};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',observe,{once:true});else observe();
  if(location.origin===new URL(appUrl).origin){const channel=new BroadcastChannel(marker+':'+appUrl);channel.onmessage=event=>{if(event.data?.marker===marker)observed.wirePackets.push(event.data.value);};}
 },{appUrl:APP,marker:MARK});
 context.on('page',page=>{page.on('pageerror',error=>report.errors.push(redact(error.message)));page.on('console',m=>{if(/Request payload|Response payload/.test(m.text()))report.errors.push('Unexpected credential payload logging');});});
 await context.route('https://keewebx.app/**',async route=>{const url=new URL(route.request().url());if(route.request().isNavigationRequest()&&url.pathname==='/app')appNavigationRequests++;let path=url.pathname.replace(/^\/app(?=\/|$)/,'')||'/next.html';if(path==='/')path='/next.html';const response=await context.request.get(APP_SERVER+path+url.search);await route.fulfill({response});});
 for(const origin of [...ACCOUNTS.slice(0,2).map(account=>new URL(account.url).origin),'https://www.uscardforum.com','https://www.uscardforum.com.evil.test'])await context.route(origin+'/**',route=>route.fulfill({headers:route.request().url().includes('/isolated')?{'cross-origin-opener-policy':'same-origin'}:{},contentType:'text/html',body:`<!doctype html><title>Disposable login</title><style>body{font:18px system-ui;padding:80px}input{display:block;width:300px;height:40px;margin:12px}</style><h1>Login</h1><form><input id="username" autocomplete="username"><input id="login-password" type="password" autocomplete="current-password"><button>Sign in</button></form><script>window.formSubmits=0;window.credentialInputEvents=0;document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.formSubmits++});for(const input of document.querySelectorAll('input'))input.addEventListener('input',()=>{if(input.value)window.credentialInputEvents++});</script>`}));
}
try {
 const bundle=readFileSync(SOURCE,'utf8');report.bundle={bytes:Buffer.byteLength(bundle),sha256:createHash('sha256').update(bundle).digest('hex')};
 expect(bundle).not.toContain('keewebx-userscript-connect-request-v2:');expect(bundle).toContain('keewebx-connect-mailbox-v1:');
 await step('create real encrypted KDBX with accounts for two distinct origins',async()=>{
  const source=`import * as kdbx from ${JSON.stringify(pathToFileURL(join(ROOT,'modules/db/lib/index.ts')).href)};import {argon2} from ${JSON.stringify(pathToFileURL(join(ROOT,'modules/db/test/test-support/argon2.ts')).href)};import {writeFileSync} from 'node:fs';kdbx.CryptoEngine.setArgon2Impl(argon2);const db=kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(${JSON.stringify(DB_PASSWORD)})),'Disposable Connect');db.header.kdfParameters.set('M',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(32768));db.header.kdfParameters.set('I',kdbx.VarDictionary.ValueType.UInt64,kdbx.Int64.from(2));for(const account of ${JSON.stringify(ACCOUNTS)}){const entry=db.createEntry(db.getDefaultGroup());entry.fields.set('Title',account.title);entry.fields.set('URL',account.url);entry.fields.set('UserName',account.user);entry.fields.set('Password',kdbx.ProtectedValue.fromString(account.password));}writeFileSync(${JSON.stringify(join(OUT,'fixture.kdbx'))},new Uint8Array(await db.save()));`;
  execFileSync(BUN,['--eval',source],{cwd:ROOT,timeout:20000,stdio:['ignore','pipe','pipe']});
 });
 await setup(bundle);
 await step('authorize original unlocked app once using native permission dialog',async()=>{
  app=await context.newPage();await app.goto(APP);await ready(app);
  await app.locator('#open-file-input, #kdbx-file-input').first().setInputFiles(join(OUT,'fixture.kdbx'));
  const fallback=app.getByRole('button',{name:'Use password',exact:true});if(await fallback.isVisible())await fallback.click();
  await app.locator('#password').fill(DB_PASSWORD);await app.locator('#unlock').click();await expect(app.locator('.entry-row').first()).toBeVisible();
  await action(app,'toggle');await action(app,'config-tab');await action(app,'authorize');await expect(consent()).toBeVisible();
  const listing=consent().getByRole('checkbox',{name:'Allow listing and searching entries',exact:true});if(await listing.count())await listing.check();
  await consent().getByRole('button',{name:'Allow',exact:true}).click();await untilStatus(app,/Authorized/);
  await settings();approvedRoute=structuredClone(gm.get(ROUTE_KEY));expect(approvedRoute).toBeTruthy();originalApp=await documentState(app);await sameApp();
 });
 await step('first website establishes native connector and fills only its matching account',async()=>{
  first=await context.newPage();await first.goto(ACCOUNTS[0].url);await ready(first);await prepare(first);await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);await sameApp();
 });
 await step('another independent origin uses same app and same authorization',async()=>{
  second=await context.newPage();await second.goto(ACCOUNTS[1].url);await ready(second);await prepare(second);await lookup(second,ACCOUNTS[1]);await fill(second,ACCOUNTS[1]);await sameApp();
 });
 await step('a bare apex entry is found and filled on its www login page, while a lookalike hostname is excluded',async()=>{
  const forum=await context.newPage(),pages=context.pages().length;
  try {
   await forum.goto('https://www.uscardforum.com/login');await ready(forum);
   await lookup(forum,ACCOUNTS[3]);await fill(forum,ACCOUNTS[3]);await sameApp();
   expect(context.pages().length).toBe(pages);
   await forum.goto('https://www.uscardforum.com.evil.test/login');await ready(forum);
   await forum.bringToFront();await forum.locator('#username').click();
   const reads=await fieldReads();await action(forum,'toggle');
   await untilStatus(forum,/Connected\. No matching accounts found/);
   expect(await entries(forum)).not.toContain(ACCOUNTS[3].title);
   expect(await fieldReads()).toBe(reads);await emptyFields(forum);await sameApp();
  } finally {await forum.close();}
 });
 await step('one browser tab navigates between websites four times without opening another connection page',async()=>{
  const helper=connectors.get(first),boot=await helper.evaluate(()=>performance.timeOrigin),pages=context.pages().length;
  for(const account of [ACCOUNTS[1],ACCOUNTS[0],ACCOUNTS[1],ACCOUNTS[0]]) {
   await first.goto(account.url);await ready(first);
   await lookup(first,account);await fill(first,account);
   expect(context.pages().length).toBe(pages);expect(await helper.evaluate(()=>performance.timeOrigin)).toBe(boot);await sameApp();
  }
 });
 await step('an isolated login document fills through recovery without opening a window',async()=>{
  const pages=context.pages().length;
  await first.goto(ACCOUNTS[0].url+'isolated');await ready(first);
  await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);
  expect(context.pages().length).toBe(pages);await sameApp();
 });
 await step('six alternating fills reuse one authorized app without locking or navigating it',async()=>{
  const pages=context.pages().length;
  for(let i=0;i<3;i++)for(const [page,account] of [[first,ACCOUNTS[0]],[second,ACCOUNTS[1]]]){await clearFields(page);await lookup(page,account);await fill(page,account);await sameApp();}
  expect(context.pages().length).toBe(pages);
 });
 await step('connection test and explicit reconnect preserve existing unlocked vault',async()=>{
  await action(second,'toggle');await action(second,'config-tab');await action(second,'probe');await untilStatus(second,/Connected to the authorized KeeWebX tab/);
  const helper=connectors.get(second),before=await helper.evaluate(()=>performance.timeOrigin),pages=context.pages().length;
  await action(second,'open');await second.bringToFront();await action(second,'probe');await untilStatus(second,/Connected to the authorized KeeWebX tab/);
  expect(await helper.evaluate(()=>performance.timeOrigin)).toBe(before);expect(context.pages().length).toBe(pages);await sameApp();
 });
 await step('closing a pending fill rejects the real delayed encrypted response',()=>cancelPending(first,'close'));
 await step('navigation cancels a pending fill before a real response arrives',()=>cancelPending(first,'navigation'));
 await step('switching away during credential filling cancels its delayed response',()=>cancelPending(first,'hidden'));
 await step('synchronous username handlers cannot redirect password filling to a replacement field',async()=>{
  await clearFields(first);await lookup(first,ACCOUNTS[0]);
  await first.evaluate(()=>{
   document.querySelector('#username').addEventListener('input',()=>{
    const password=document.querySelector('#login-password');globalThis.detachedPassword=password;
    password.replaceWith(password.cloneNode());
   },{once:true});
  });
  await action(first,'entry-0');await untilStatus(first,/changed|no longer|again/i);
  await expect(first.locator('#login-password')).toHaveValue('');
  expect(await first.evaluate(()=>globalThis.detachedPassword.value)).toBe('');
 });
 await step('website reload recovers without replacing the old connector or repeating authorization',async()=>{
  const helper=connectors.get(first),before=await helper.evaluate(()=>performance.timeOrigin),pages=context.pages().length;
  await first.reload();await ready(first);await first.locator('#username').click();await action(first,'toggle');
  await expect(helper.getByRole('status')).toHaveText(/Connection page ready|Connected to your existing/);await first.bringToFront();
  await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);expect(await helper.evaluate(()=>performance.timeOrigin)).toBe(before);expect(context.pages().length).toBe(pages);await sameApp();
 });
 await step('closing the old connector does not create another page during lookup or repeated tests',async()=>{
  await connectors.get(first).close();connectors.delete(first);
  const pages=context.pages().length;
  await clearFields(first);await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);
  await action(first,'toggle');await action(first,'config-tab');
  for(let retry=0;retry<3;retry++){await action(first,'probe');await untilStatus(first,/Connected to the authorized KeeWebX tab/);}
  expect(context.pages().length).toBe(pages);await sameApp();await action(first,'close');
 });
 await step('a frozen app expires lookup safely and recovers on return without a new page or consent',async()=>{
  const pages=context.pages().length,session=await cdp(app);
  await clearFields(first);await first.locator('#username').click();
  expect(await app.evaluate(()=>document.hidden)).toBe(true);
  await session.send('Page.setWebLifecycleState',{state:'frozen'});
  try {
   await action(first,'toggle');
   await untilStatus(first,/Visit your existing KeeWebX tab/,14000);await emptyFields(first);
  } finally {await session.send('Page.setWebLifecycleState',{state:'active'});}
  const lifecycle=await app.evaluate(()=>globalThis.__kwxNativeTest.lifecycle);
  expect(lifecycle.some(event=>event.name==='freeze'&&event.hidden&&event.trusted)).toBe(true);
  expect(lifecycle.some(event=>event.name==='resume'&&event.trusted)).toBe(true);
  await app.bringToFront();await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);
  expect(context.pages().length).toBe(pages);await sameApp();
 });
 await step('a locked app rejects lookup promptly and resumes without new permission after unlock',async()=>{
  await app.bringToFront();await expect(app.locator('#sync-state')).toContainText('Up to date');
  await app.getByRole('button',{name:'Lock',exact:true}).click();await expect(app.locator('#password')).toBeVisible();
  await clearFields(first);await first.locator('#username').click();await action(first,'toggle');
  await untilStatus(first,/locked.*[Uu]nlock/,5000);await emptyFields(first);
  await app.bringToFront();await app.locator('#password').fill(DB_PASSWORD);await app.locator('#unlock').click();
  await expect(app.locator('.entry-row').first()).toBeVisible();await untilStatus(app,/Authorized/);
  await lookup(first,ACCOUNTS[0]);await fill(first,ACCOUNTS[0]);await sameApp();
 });
 await step('closing every website and connector preserves the original app for three fresh website connections',async()=>{
  for(const account of [ACCOUNTS[1],ACCOUNTS[0],ACCOUNTS[1]]) {
   await app.bringToFront();
   for(const page of context.pages())if(page!==app)await page.close();
   connectors.clear();second=undefined;
   expect(context.pages()).toEqual([app]);await sameApp();
   first=await context.newPage();await first.goto(account.url);await ready(first);
   await action(first,'toggle');await action(first,'config-tab');
   for(let retry=0;retry<3;retry++){await action(first,'probe');await untilStatus(first,/Connected to the authorized KeeWebX tab/);}
   await lookup(first,account);await fill(first,account);
   expect(context.pages().length).toBe(2);await sameApp();
  }
 });
 await step('a mailbox timeout reconnects through native messages to the original vault without offering a duplicate app',async()=>{
  await nativeWorker.evaluate(()=>{globalThis.muteAppMailbox=true;});
  try {
   await clearFields(first);await action(first,'toggle');await action(first,'config-tab');await action(first,'probe');
   await untilStatus(first,/Visit your existing KeeWebX tab/,14000);await emptyFields(first);await sameApp();
   expect(await shadowValue(first,'[data-action="open"]')).toBe('Reconnect to existing tab');
   await app.evaluate(({marker,appUrl})=>{
    const channel=new BroadcastChannel(marker+':'+appUrl);globalThis.recoveryForgery=channel;globalThis.recoveryForgeryIds=[];
    channel.onmessage=event=>{
     const packet=event.data?.value?.packet;
     if(packet?.type==='request'&&packet.operation==='hello'){
      globalThis.recoveryForgeryIds.push(packet.id);
      channel.postMessage({marker,value:{packet:{...packet,type:'reply',body:{appBoot:packet.host}},signature:'fixture-invalid-signature'}});
     }
    };
   },{marker:MARK,appUrl:APP});
   const pages=context.pages().length;
   await action(first,'open');
   await expect.poll(()=>context.pages().find(page=>page.url().includes('connect.html'))).toBeTruthy();
   const helper=context.pages().find(page=>page.url().includes('connect.html'));await realVisibility(helper);
   await expect(helper.getByRole('status')).toContainText('Connected to your existing KeeWebX tab',{timeout:12000});
   await expect(helper.getByRole('link',{name:'Open a new KeeWebX tab'})).toBeHidden();
   await untilStatus(first,/Connected to the authorized KeeWebX tab/);
   await helper.getByRole('button',{name:'Back to website'}).click();
   await lookup(first,ACCOUNTS[1]);await fill(first,ACCOUNTS[1]);
   expectedForgeryIds=await app.evaluate(()=>globalThis.recoveryForgeryIds);
   expect(expectedForgeryIds.length).toBeGreaterThan(0);
   expect(context.pages().length).toBe(pages+1);await sameApp();
  } finally {
   await app.evaluate(()=>globalThis.recoveryForgery?.close());
   await nativeWorker.evaluate(()=>{globalThis.muteAppMailbox=false;});
  }
 });
 await step('native and recovery channels retain signed encrypted payloads with no plaintext credentials',async()=>{
  const audit=await nativeWorker.evaluate(()=>globalThis.audit);await settings();
  const allowed=/^Connect\.user\.js---(?:keewebx-userscript-connect-(?:identity|settings)-v1|keewebx-native-connect-v1:selected:|keewebx-connect-mailbox-v1:(?:request|reply):)/;
  expect(audit.length).toBeGreaterThan(0);expect(audit.every(item=>allowed.test(item.key))).toBe(true);
  const serialized=JSON.stringify(audit);for(const secret of PRIVATE_VALUES)expect(serialized).not.toContain(secret);
  const packets=[...await app.evaluate(()=>globalThis.__kwxNativeTest.wirePackets),...audit.filter(item=>item.key.includes('keewebx-connect-mailbox-v1:')&&item.value?.packet).map(item=>item.value)];expect(packets.length).toBeGreaterThan(30);
  const privateActions=new Set(['kwx-pair','kwx-features','kwx-get-entries','kwx-get-entry-fields']);
  const sensitive=packets.map(p=>p.packet?.body).filter(body=>privateActions.has(body?.action));expect(sensitive.length).toBeGreaterThan(10);
  expect(sensitive.every(body=>typeof body.message==='string'&&typeof body.nonce==='string'&&!('values'in body)&&!('suggested'in body))).toBe(true);
  for(const secret of PRIVATE_VALUES)expect(JSON.stringify(packets)).not.toContain(secret);
  const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  const key=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(approvedRoute.publicKey,'base64')])});
  const injected=packets.filter(p=>p.signature==='fixture-invalid-signature'&&expectedForgeryIds.includes(p.packet?.id));
  expect(injected.length).toBe(expectedForgeryIds.length);
  const signedPackets=packets.filter(p=>!injected.includes(p));
  expect(signedPackets.every(p=>verify(null,Buffer.from(stable(p.packet)),key,Buffer.from(p.signature,'base64')))).toBe(true);
  report.storageAudit={historicalWrites:audit.length,encryptedRecoveryPackets:packets.filter(item=>item.packet).length,noPlaintext:true,signedPackets:signedPackets.length,encryptedSensitivePackets:sensitive.length,injectedForgedReplies:injected.length};
 });
 expect(report.errors).toEqual([]);report.passed=true;
} catch(error) {report.passed=false;report.failure=redact(error.stack||error);console.error(report.failure);for(const [name,page] of [['app',app],['first',first],['second',second]])if(page)report[name+'Status']=await status(page).catch(()=>null);process.exitCode=1;}
finally {report.finished=new Date().toISOString();writeFileSync(join(OUT,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({report:join(OUT,'report.json'),passed:report.passed}));await context?.close();}
