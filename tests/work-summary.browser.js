// Targeted work-summary browser verification; loopback-only test storage, no production writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { MemoryTestStore } from './memory-store.js';
import { fixture } from './fixtures.js';
import { CONSENT_VERSION } from '../shared/analysis.js';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=path.join(root,'docs/evidence/work-summary-20261009');await mkdir(out,{recursive:true});
const {chromium}=await import(pathToFileURL('C:/Users/57752/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs').href);
const store=new MemoryTestStore(),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
server.on('request',createApp({store,appOrigin:origin,anonymizationSecret:'isolated-work-summary-only-secret',writeLimit:100}));
const checks=[],pageErrors=[],outsideRequests=[],posts=[];let browser;
const pass=(name,details={})=>checks.push({name,status:'passed',...details});
try{
 browser=await chromium.launch({headless:true,channel:'chrome'});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){outsideRequests.push(route.request().url());return route.abort();}return route.continue();});
 page.on('request',r=>{if(r.method()==='POST')posts.push(r.postDataJSON());});
 const data=fixture();data.cost_periods[0].tasks.forEach((task,i)=>task.task_id=`private-feature-${i}`);
 await page.goto(`${origin}/#contribute`,{waitUntil:'networkidle'});
 await page.locator('#contribution-file').setInputFiles({name:'private-business-file.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await page.locator('#actual-contribution-fields').waitFor({state:'attached'});
 const current=async()=>JSON.parse(await page.locator('#actual-contribution-fields').textContent());
 const waitForSummary=async(category,band)=>page.waitForFunction(({category,band})=>{try{const s=JSON.parse(document.querySelector('#actual-contribution-fields').textContent).cost_periods[0].tasks[0].work_summary;return s?.function_category===category&&s?.code_change_band===band;}catch{return false;}},{category,band});
 await page.waitForFunction(()=>{try{return JSON.parse(document.querySelector('#actual-contribution-fields').textContent).cost_periods[0].tasks.length===3;}catch{return false;}});
 assert.equal(posts.length,0);assert.equal(await page.locator('#work-summary-reviewed').isChecked(),false);
 await page.locator('[data-work-key="0:0"] [data-work-toggle]').click();
 assert.equal(await page.locator('#submit-contribution').isDisabled(),true);
 await page.locator('#work-0-0-category').selectOption('api');await page.locator('#work-0-0-lines').fill('137');
 await waitForSummary('api','51_200');
 const prepared1=await current();assert.equal(prepared1.cost_periods[0].tasks.length,3);
 assert.deepEqual(prepared1.cost_periods[0].tasks[0].work_summary,{function_category:'api',code_change_band:'51_200',difficulty:'medium'});
 assert.equal(JSON.stringify(prepared1).includes('private-feature-'),false);assert.equal(JSON.stringify(prepared1).includes('private-business-file'),false);
 assert.equal(JSON.stringify(prepared1).includes('local_lines'),false);assert.equal(JSON.stringify(prepared1).includes('code_lines'),false);
 assert.equal(posts.length,0);pass('添加摘要并将本地137行转换为51–200行；实际发送数据仅保留三个枚举字段，无原名称或精确行数');

 await page.locator('#contribution-consent').check();assert.equal(await page.locator('#submit-contribution').isDisabled(),true);
 await page.locator('#work-summary-reviewed').check();assert.equal(await page.locator('#submit-contribution').isEnabled(),true);
 await page.locator('#work-0-0-category').selectOption('data_processing');await waitForSummary('data_processing','51_200');
 assert.equal(await page.locator('#contribution-consent').isChecked(),false);assert.equal(await page.locator('#work-summary-reviewed').isChecked(),false);assert.equal(await page.locator('#submit-contribution').isDisabled(),true);
 pass('有摘要须分别确认逐项核对与分享；任何编辑更新实际预览并取消两项确认');

 await page.locator('[data-work-key="0:0"] [data-work-toggle]').click();
 await page.waitForFunction(()=>{try{return !JSON.parse(document.querySelector('#actual-contribution-fields').textContent).cost_periods[0].tasks[0].work_summary;}catch{return false;}});
 const removed=await current();assert.equal(removed.cost_periods[0].tasks.length,3);assert.deepEqual(removed.cost_periods[0].costs,data.cost_periods[0].costs);assert.equal(await page.locator('#work-summary-review-label').isVisible(),false);
 pass('移除摘要只删除可选字段；三项任务、验收结果和完整周期费用均保留');

 await page.locator('[data-work-key="0:0"] [data-work-toggle]').click();await page.locator('#work-0-0-category').selectOption('integration');await page.locator('#work-0-0-band').selectOption('201_500');await waitForSummary('integration','201_500');
 await page.locator('[data-work-key="0:1"] [data-work-toggle]').click();await page.locator('#work-0-1-category').selectOption('testing');await page.locator('#work-0-1-band').selectOption('1_50');
 await page.waitForFunction(()=>{try{return JSON.parse(document.querySelector('#actual-contribution-fields').textContent).cost_periods[0].tasks[1].work_summary?.function_category==='testing';}catch{return false;}});
 const toSend=await current();await page.locator('#contribution-consent').check();await page.locator('#work-summary-reviewed').check();
 let release;const hold=new Promise(r=>release=r);
 await page.route('**/api/contributions',async route=>{if(route.request().method()==='POST')await hold;await route.continue();});
 const responsePromise=page.waitForResponse(r=>r.url()===`${origin}/api/contributions`&&r.request().method()==='POST');
 await page.locator('#submit-contribution').click();assert.equal(await page.locator('#work-0-0-category').isDisabled(),true);assert.equal(await page.locator('#contribution-file').isDisabled(),true);assert.equal(await page.locator('#work-summary-reviewed').isDisabled(),true);
 release();const response=await responsePromise,created=await response.json();assert.equal(response.status(),201);await page.locator('#receipt-panel').waitFor({state:'visible'});
 assert.equal(posts.length,1);assert.deepEqual(posts[0].data,toSend);assert.deepEqual(posts[0].consent,{accepted:true,version:CONSENT_VERSION,work_summary_reviewed:true});
 assert.equal(created.summary.cost_results[0].work_summary_counts.summarized_tasks,2);
 assert.equal(created.summary.cost_results[0].work_summary_counts.function_category.integration,1);assert.equal(created.summary.cost_results[0].work_summary_counts.function_category.testing,1);
 const downloadPromise=page.waitForEvent('download');await page.locator('#download-contribution-summary').click();const downloaded=JSON.parse(await readFile(await(await downloadPromise).path(),'utf8'));
 assert.deepEqual(downloaded,created.summary);assert.equal(JSON.stringify(downloaded).includes('task_id'),false);
 pass('主动确认后发送冻结的实际预览与新授权版本；隔离服务器保存/下载的是工作摘要计数，提交中不可编辑');

 await page.locator('#demo-work-summary').click();await page.waitForFunction(()=>document.querySelector('#contribution-status').textContent.includes('构造样例仅在本地演示'));
 assert.equal(await page.locator('#consent-area').isVisible(),false);assert.equal(await page.locator('#submit-contribution').isDisabled(),true);assert.equal(posts.length,1);
 await page.locator('#receipt-panel').evaluate(el=>el.hidden=true);
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,'summary-demo-desktop.png'),fullPage:true});
 const editorBox=await page.locator('.work-summary-editor').boundingBox();await page.screenshot({path:path.join(out,'summary-editor-desktop-detail.png'),fullPage:true,clip:{x:editorBox.x,y:editorBox.y,width:editorBox.width,height:Math.min(editorBox.height,500)}});
 const desktop=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert.equal(desktop.viewport,desktop.width);
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(out,'summary-demo-mobile.png'),fullPage:true});
 const mobile=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth,tableScroll:document.querySelector('.work-summary-table-scroll').scrollWidth,tableWidth:document.querySelector('.work-summary-table-scroll').clientWidth}));assert.equal(mobile.viewport,mobile.width);assert.ok(mobile.tableScroll>mobile.tableWidth);
 pass('构造样例可本地编辑但不能提交；1440桌面与390手机无整页溢出，任务表仅内部横滚',{desktop,mobile});
 await page.setViewportSize({width:1440,height:1000});await page.goto(`${origin}/#workspace`);await page.locator('#demo-select').selectOption('work-summary');
 await page.locator('#demo-results .work-summary-statistics').first().waitFor({state:'visible'});await page.screenshot({path:path.join(out,'summary-statistics-desktop.png'),fullPage:true});
 pass('成本分析呈现填写摘要任务数、功能类别、代码变更区间与难度分布');
 assert.deepEqual(pageErrors,[]);assert.deepEqual(outsideRequests,[]);pass('无浏览器脚本错误、无外部请求、无生产写入');
 await writeFile(path.join(out,'browser-result.json'),JSON.stringify({scope:'Loopback MemoryTestStore only; constructed inputs; no production writes',checked_at:new Date().toISOString(),consent_version:CONSENT_VERSION,passed:checks.length,checks,pageErrors,outsideRequests,isolatedPosts:posts.length},null,2));
 console.log(JSON.stringify({passed:checks.length,checks,pageErrors,outsideRequests},null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));await store.close();}
