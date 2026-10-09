// One targeted browser check. Creates its own loopback-only MemoryTestStore server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { MemoryTestStore } from './memory-store.js';
import { fixture } from './fixtures.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const artifactDir=path.join(root,'docs/evidence/privacy-acceptance-20261009');
await mkdir(artifactDir,{recursive:true});
const playwrightPath=process.env.PLAYWRIGHT_MODULE || 'C:/Users/57752/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const {chromium}=await import(pathToFileURL(playwrightPath).href);
const store=new MemoryTestStore();
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
server.on('request',createApp({store,appOrigin:origin,anonymizationSecret:'isolated-privacy-browser-only-secret',writeLimit:100}));
const results=[];let browser;const pageErrors=[];
const pass=(name,details={})=>results.push({name,status:'passed',...details});
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
  const posts=[];page.on('request',request=>{if(request.method()==='POST')posts.push(request.postDataJSON());});
  const data=fixture();
  for(const row of [...data.quota_samples,...data.cost_periods]){row.subject_kind='workflow';row.subject_id='internal-payroll-project';}
  data.quota_samples[0].window_id='customer-acme-window';data.quota_samples[0].coverage='partial';
  data.cost_periods[0].tasks.forEach((task,index)=>{task.task_id=`internal-ticket-${index}`;});
  const input={name:'original-private-filename.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))};
  const importContribution=async()=>{
    await page.locator('#contribution-file').setInputFiles(input);
    await page.locator('#contribution-preview').waitFor({state:'visible'});
    return JSON.parse(await page.locator('#contribution-preview .summary-json').textContent());
  };
  await page.goto(`${origin}/#contribute`);const first=await importContribution();
  assert.equal(posts.length,0);assert.equal(await page.locator('#contribution-consent').isChecked(),false);assert.equal(await page.locator('#submit-contribution').isDisabled(),true);
  assert.equal(await page.locator('#contribution-preview [data-field="attempted_tasks"] .metric-value').innerText(),'3项');
  assert.equal(await page.locator('#contribution-preview [data-field="accepted_tasks"] .metric-value').innerText(),'2项');
  assert.equal(await page.locator('#contribution-preview [data-field="unaccepted_tasks"] .metric-value').innerText(),'1项');
  const previewText=await page.locator('#contribution-preview').innerText();
  for(const value of ['internal-payroll-project','customer-acme-window','internal-ticket-','original-private-filename'])assert.equal(previewText.includes(value),false);
  pass('贡献预览不触发 POST，未勾选不能提交；实际字段无原标识，验收统计为 3/2/1');

  await page.screenshot({path:path.join(artifactDir,'contribution-desktop.png'),fullPage:true});
  await page.reload();const again=await importContribution();
  assert.equal(first.cost_periods[0].subject_id,again.cost_periods[0].subject_id);
  assert.notEqual(first.cost_periods[0].tasks[0].task_id,again.cost_periods[0].tasks[0].task_id);
  const storage=await page.evaluate(async()=>{
    const request=indexedDB.open('dsh-local-privacy-v1',1);
    const database=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const transaction=database.transaction('keys','readonly'),objectStore=transaction.objectStore('keys');
    const all=objectStore.getAll(),keys=objectStore.getAllKeys();
    const values=await new Promise((resolve,reject)=>{transaction.oncomplete=()=>resolve({values:all.result,keys:keys.result});transaction.onerror=()=>reject(transaction.error);});
    database.close();const key=values.values[0];let exportRejected=false;try{await crypto.subtle.exportKey('raw',key);}catch{exportRejected=true;}
    return {count:values.values.length,keys:values.keys,cryptoKey:key instanceof CryptoKey,extractable:key.extractable,algorithm:key.algorithm.name,length:key.algorithm.length,exportRejected,localStorageCount:localStorage.length};
  });
  assert.deepEqual(storage,{count:1,keys:['workflow-hmac-v1'],cryptoKey:true,extractable:false,algorithm:'HMAC',length:256,exportRejected:true,localStorageCount:0});
  pass('刷新后工作流别名稳定；IndexedDB 只存不可导出的 256 位 HMAC CryptoKey，无原文件、名称或映射');

  await page.locator('#contribution-consent').check();
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/contributions')&&response.request().method()==='POST');
  await page.locator('#submit-contribution').click();const response=await responsePromise,created=await response.json();
  assert.equal(response.status(),201);await page.locator('#receipt-panel').waitFor({state:'visible'});
  assert.equal(posts.length,1);assert.deepEqual(posts[0].data,again);
  for(const value of ['internal-payroll-project','customer-acme-window','internal-ticket-','original-private-filename','workflow-hmac-v1'])assert.equal(JSON.stringify(posts[0]).includes(value),false);
  assert.equal(posts[0].data.cost_periods[0].tasks.length,3);assert.equal(created.summary.quota_results.length,0);
  pass('主动同意后仅发送预览中的去标识逐任务记录；服务器剔除不合格额度并重新计算');

  const downloadPromise=page.waitForEvent('download');await page.locator('#download-contribution-summary').click();
  const downloaded=JSON.parse(await readFile(await (await downloadPromise).path(),'utf8'));
  assert.deepEqual(downloaded,created.summary);assert.match(downloaded.cost_results[0].subject_id,/^workflow-[a-f0-9]{20}$/);
  assert.equal(JSON.stringify(downloaded).includes('task_id'),false);
  assert.equal(JSON.stringify([...store.records.values()]).includes('internal-payroll-project'),false);
  pass('贡献摘要下载与服务器实际保存 summary 完全一致，原任务和工作流名未入库');

  await page.goto(`${origin}/#community`);await page.locator('.community-group').waitFor();
  assert.equal(await page.locator('#community-content .acceptance-statistics').count(),0);
  assert.equal((await store.community()).cost_groups[0].metrics,null);
  pass('未达到 5 份贡献门槛时，新增验收统计不泄露隐藏指标');

  await page.goto(`${origin}/#workspace`);await page.locator('[data-mode="local"]').click();
  await page.locator('#local-file').setInputFiles(input);await page.locator('#local-results .acceptance-statistics').waitFor();
  const localDownloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'下载可分享的脱敏摘要 ↓',exact:true}).click();
  const localSummary=JSON.parse(await readFile(await (await localDownloadPromise).path(),'utf8'));
  assert.match(localSummary.cost_results[0].subject_id,/^wf-[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(localSummary).includes('internal-payroll-project'),false);assert.equal(posts.length,1);
  pass('本地分析摘要导出也替换工作流名，不增加上传请求');

  await page.goto(`${origin}/#contribute`);await page.locator('#withdraw-id').fill(created.receipt.contribution_id);await page.locator('#withdraw-key').fill(created.receipt.withdrawal_key);
  await page.locator('#withdraw-form button').click();await page.locator('#withdraw-status').filter({hasText:'已撤回'}).waitFor();assert.equal(store.records.size,0);
  pass('撤回后隔离存储归零；未连接或写入生产数据库');

  await page.setViewportSize({width:390,height:844});await importContribution();
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo({top:0,behavior:'instant'});});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(artifactDir,'contribution-mobile.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  await page.locator('#clear-contribution-preview').click();assert.equal(await page.locator('#contribution-preview').isVisible(),false);assert.equal(await page.locator('#submit-contribution').isDisabled(),true);
  assert.deepEqual(pageErrors,[]);
  pass('手机贡献页无整页横向溢出，清除预览后不能提交，浏览器无脚本错误');
} catch(error) {
  results.push({name:'browser-run',status:'failed',error:error.message});process.exitCode=1;
} finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  const report={date:new Date().toISOString(),scope:'targeted privacy and acceptance changes only',storage:'isolated MemoryTestStore',production_written:false,passed:results.filter(row=>row.status==='passed').length,failed:results.filter(row=>row.status==='failed').length,results,page_errors:pageErrors};
  await writeFile(path.join(artifactDir,'results.json'),JSON.stringify(report,null,2),'utf8');console.log(JSON.stringify(report,null,2));
}
