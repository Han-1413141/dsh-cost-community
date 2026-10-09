import { analyzeDataset, anonymizeAnalysis, acceptanceSummary, CONSENT_VERSION } from '/shared/analysis.js';
import { prepareContribution } from '/shared/privacy.js';

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = (value, digits = 0) => Number(value).toLocaleString('zh-CN', {minimumFractionDigits: digits, maximumFractionDigits: digits});
const money = value => value === null ? '—' : number(value, 2);
const labels = {bugfix:'缺陷修复',feature:'功能开发',refactor:'代码重构',tests:'测试编写',docs:'文档编写',simple:'简单',medium:'中等难度',complex:'复杂',test_suite_passed:'测试集通过',review_approved:'评审通过',spec_checklist_passed:'需求清单通过',model:'单模型',workflow:'多模型组合',standard:'常规付费',promotional:'优惠付费',credit:'赠送额度',trial:'试用',official_api:'官方 API 读数',official_cli:'官方 CLI 读数',user_snapshot:'用户快照',local_estimate:'本地估算',fixed_reset:'固定重置窗口',rolling:'滚动窗口',complete:'覆盖全部客户端',partial:'覆盖部分客户端',unknown:'未知'};
const label = value => labels[value] || value || '未声明';
let activeRoute = 'home';
let contributionData = null;
let contributionGeneration = 0;
let localGeneration = 0;
let receipt = null;
let localResult = null;
let communityLoading = false;
let serviceHealth = null;

function setStatus(element, message, type = '') {
  element.textContent = message;
  element.className = `form-status ${type}`.trim();
}
function route() {
  const hash = location.hash.slice(1) || 'home';
  const page = hash.startsWith('method-') ? 'methods' : ['home','workspace','community','contribute','methods'].includes(hash) ? hash : 'home';
  const changed = page !== activeRoute;
  activeRoute = page;
  $$('.page').forEach(el => { el.hidden = el.id !== `page-${page}`; });
  $$('[data-route]').forEach(el => { if (el.dataset.route === page) el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
  document.title = `${{home:'编码成本透明化与性价比普惠',workspace:'成本工作台',community:'社区观察',contribute:'贡献数据',methods:'方法与来源'}[page]} · DSH Cost Meter`;
  if (hash.startsWith('method-')) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
  else if (changed) window.scrollTo({top:0, behavior:'instant'});
  if (page === 'community') loadCommunity();
}
window.addEventListener('hashchange', route);
route();

function activateMode(mode, focus = false) {
  $$('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === mode;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    $(`#panel-${button.dataset.mode}`).hidden = !selected;
    if (selected && focus) button.focus();
  });
}
$$('[data-mode]').forEach(button => {
  button.addEventListener('click', () => activateMode(button.dataset.mode));
  button.addEventListener('keydown', e => {
    const modes = ['demo','local','calc'];
    if (['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
      e.preventDefault(); const index = modes.indexOf(button.dataset.mode);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : 2)) % 3;
      activateMode(modes[next], true);
    }
  });
});

function publicName(row) {
  if (row.plan_id?.startsWith('example-plan-')) return `构造套餐 ${row.plan_id.slice(-1).toUpperCase()}`;
  return row.plan_id || row.subject_id;
}
function metric(title, value, unit, sub = '') {
  return `<div><span class="metric-label">${escapeHTML(title)}</span><strong class="metric-value">${escapeHTML(value)}<small>${escapeHTML(unit)}</small></strong>${sub ? `<span class="metric-sub">${escapeHTML(sub)}</span>` : ''}</div>`;
}
function acceptanceBlock(rows) {
  if (!rows.length) return '';
  const s = acceptanceSummary(rows);
  return `<section class="acceptance-statistics" aria-label="验收任务统计"><div class="acceptance-heading"><h3>验收任务统计</h3><span>每个完整周期内按任务去重，再合计</span></div><div class="acceptance-values"><div data-field="attempted_tasks">${metric('不同任务总数',number(s.attempted_tasks),'项')}</div><div data-field="accepted_tasks">${metric('已验收任务',number(s.accepted_tasks),'项')}</div><div data-field="unaccepted_tasks">${metric('未验收任务',number(s.unaccepted_tasks),'项')}</div><div data-field="acceptance_rate">${metric('任务验收率',s.acceptance_rate === null ? '—' : number(s.acceptance_rate * 100,1),'%')}</div></div><p class="acceptance-attempts">全部尝试 <strong>${number(s.total_attempts)}</strong> 次 · 重试 <strong>${number(s.retry_attempts)}</strong> 次 · 未通过验收的尝试 <strong>${number(s.failed_attempts)}</strong> 次</p><p class="footnote">每项任务最多计一次验收通过；重试不增加不同任务数。各周期分别计数，不代表跨周期去重后的项目或用户数。</p></section>`;
}
function quotaPanel(q, raw, demo) {
  const before = raw?.before?.used_percent ?? 0;
  const after = raw?.after?.used_percent ?? q.delta_percentage_points;
  const width = Math.max(0,Math.min(100,after - before));
  const dimensions = [q.subject_kind && label(q.subject_kind), q.window_type && label(q.window_type),q.quota_source && label(q.quota_source),q.coverage && label(q.coverage)].filter(Boolean);
  return `<section class="panel"><div class="panel-header"><div><h2>${escapeHTML(publicName(q))} · 每 1% 额度价值</h2><p>${escapeHTML(q.provider_id)} / ${escapeHTML(q.subject_id)}</p></div><span class="small-label">QUOTA VALUE</span></div><div class="quota-layout"><div class="quota-explain"><span class="metric-label">同一窗口内，已用额度变化</span><div class="big-number">${number(q.delta_percentage_points, 1)}<small>个百分点</small></div><div class="quota-track" aria-hidden="true"><span class="quota-track-fill" style="left:${before}%;width:${width}%"></span><i style="left:${before}%"></i><i style="left:${after}%"></i></div><div class="track-labels"><span>起始 ${number(before,1)}%</span><span>结束 ${number(after,1)}%</span></div><p style="margin-top:12px">${dimensions.map(escapeHTML).join(' · ') || `窗口长度 ${number(q.window_duration_seconds / 3600,1)} 小时`}</p></div><div class="quota-values">${metric('每 1% 对应 Token',number(q.tokens_per_percentage_point),'Token',`期间新增 ${number(q.delta_tokens)} Token`)}${metric('每 1% 对应 API 等价费用',number(q.api_equivalent_cny_per_percentage_point,4),'元',`期间 API 等价费用 ${number(q.delta_api_equivalent_cny,4)} 元`)}</div></div><div class="panel-foot"><strong>API 等价费用 ≠ 订阅实付</strong>　${demo ? '以上为构造样例。' : '以上依据导入的数据与计数声明。'}${q.community_eligible === false ? '本地估算、滚动窗口或覆盖不完整的样本仅作个人观察，不进入社区额度聚合。' : '目录价、窗口与采集覆盖范围共同决定结果。'}</div></section>`;
}
function barChart(rows, field, title, unit, teal = false) {
  const maxValue = Math.max(0,...rows.map(row => row[field] ?? 0));
  const scale = maxValue > 0 ? Math.ceil(maxValue / 4) * 4 : 4;
  return `<div class="comparison-chart ${teal ? 'chart-teal' : ''}"><div class="chart-heading">${escapeHTML(title)} <span style="color:#95a6b5;font-weight:400">/ ${escapeHTML(unit)}</span></div>${rows.map(row => `<div class="bar-row"><span class="bar-label">${escapeHTML(publicName(row))}</span><div class="bar-track"><div class="bar-fill" style="width:${(row[field] ?? 0) / scale * 100}%"></div></div><span class="bar-value">${row[field] === null ? '—' : number(row[field], field === 'paid_cny_per_accepted_task' ? 2 : 0)}</span></div>`).join('')}<div class="chart-axis" aria-hidden="true">${[0,1,2,3,4].map(t => `<span>${number(scale*t/4)}</span>`).join('')}</div></div>`;
}
function costPanel(rows, demo) {
  const first = rows[0];
  const chips = [label(first.task_type),label(first.difficulty),label(first.acceptance_standard),`${first.period_duration_days} 天完整周期`,first.cohort_month,first.payment_category && label(first.payment_category)].filter(Boolean);
  const anyNull = rows.some(row => row.paid_cny_per_accepted_task === null);
  const insight = anyNull ? '验收数为 0 时，单位任务成本显示“—”；周期支出仍保留，不记为零成本。' : '一起看净实付、验收率与人工时间；单项金额更低，并不自动代表整体更划算。';
  return `<section class="panel"><div class="panel-header"><div><h2>${escapeHTML(label(first.task_type))} · 同组任务比较</h2><p>${demo ? '构造样例展示成本与人工投入之间的取舍' : '仅在以下条件一致的记录之间比较'}</p></div><span class="small-label">TASK VALUE</span></div><div class="group-chips">${chips.map(c => `<span>${escapeHTML(c)}</span>`).join('')}</div>${acceptanceBlock(rows)}<div class="comparison-charts">${barChart(rows,'paid_cny_per_accepted_task','每项验收任务净实付','元')}${barChart(rows,'human_minutes','人工投入总时长','分钟',true)}</div><div class="insight-strip">${insight}</div><div class="table-scroll"><table class="data-table"><caption class="sr-only">同组任务成本、验收与尝试次数</caption><thead><tr><th>套餐 / 统计对象</th><th>净实付</th><th>验收 / 全部任务</th><th>验收率</th><th>全部尝试</th><th>未通过验收的尝试</th><th>重试次数</th></tr></thead><tbody>${rows.map(p => `<tr><td><strong>${escapeHTML(publicName(p))}</strong><br><small>${escapeHTML(p.subject_id)} · ${escapeHTML(label(p.subject_kind))}</small></td><td>¥ ${money(p.net_paid_cny)}</td><td>${p.accepted_tasks} / ${p.attempted_tasks}</td><td>${number(p.acceptance_rate * 100,1)}%</td><td>${p.total_attempts}</td><td>${p.failed_attempts}</td><td>${p.retry_attempts}</td></tr>`).join('')}</tbody></table></div><div class="panel-foot">净实付 = 订阅 + 超额 + 其他 API − 退款。失败与重试支出保留在周期总额中；验收率按全部不同任务计算。</div></section>`;
}
function groupCosts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.task_type,row.difficulty,row.acceptance_standard,row.period_duration_days,row.cohort_month,row.payment_category || ''].join('|');
    if (!groups.has(key)) groups.set(key,[]); groups.get(key).push(row);
  }
  return [...groups.values()];
}
function renderAnalysis(target, result, data, demo = false) {
  const quotaOptions = result.quota_results.length > 1 ? `<div class="quota-switch"><label>额度样本<select class="quota-sample-select">${result.quota_results.map((q,i)=>`<option value="${i}">${escapeHTML(publicName(q))} · ${escapeHTML(q.subject_id)}</option>`).join('')}</select></label><span>独立窗口分别换算，不把不同套餐额度直接相加</span></div>` : '';
  target.innerHTML = quotaOptions + (result.quota_results.length ? `<div class="selected-quota">${quotaPanel(result.quota_results[0],data.quota_samples[0],demo)}</div>` : '') + groupCosts(result.cost_results).map(rows => costPanel(rows,demo)).join('');
  const select=$('.quota-sample-select',target);
  if(select)select.addEventListener('change',()=>{const i=Number(select.value);$('.selected-quota',target).innerHTML=quotaPanel(result.quota_results[i],data.quota_samples[i],demo);});
}
async function loadDemo() {
  const target = $('#demo-results');
  try {
    const response = await fetch(`/samples/${$('#demo-select').value}.json`, {cache:'no-cache'});
    if (!response.ok) throw new Error('构造样例加载失败，请稍后重试。');
    const data = await response.json(); renderAnalysis(target,analyzeDataset(data),data,true);
  } catch(error) { target.innerHTML = `<p class="form-status error">${escapeHTML(error.message)}</p>`; }
}
$('#demo-select').addEventListener('change',loadDemo);
loadDemo();

async function readJSON(file) {
  if (!file) return null;
  if (file.size > 256 * 1024) throw new Error('文件超过 256 KiB，请按一个完整周期拆分。');
  let value; try { value = JSON.parse(await file.text()); } catch { throw new Error('JSON 格式无效，请检查文件结构。'); }
  return value;
}
function describeError(error) {
  return `${error.message || '操作未完成，请重试。'}${error.path ? `（${error.path}）` : ''}`;
}
$('#local-file').addEventListener('change',async event => {
  const target = $('#local-results'); target.innerHTML = ''; localResult = null; const generation = ++localGeneration;
  try {
    const data = await readJSON(event.target.files[0]); if (!data) return;
    if (generation !== localGeneration) return;
    localResult = analyzeDataset(data); renderAnalysis(target,localResult,data,data.dataset_kind === 'synthetic');
    setStatus($('#local-status'),`已在本地完成校验与分析：${localResult.totals.quota_samples} 组额度样本，${localResult.totals.cost_periods} 个完整周期。文件未上传。`,'success');
    const exportButton = document.createElement('button'); exportButton.className='button button-outline'; exportButton.textContent='下载可分享的脱敏摘要 ↓';
    exportButton.addEventListener('click',async () => {
      exportButton.disabled = true;
      try {
        const prepared = await prepareContribution(data);
        if (generation !== localGeneration) return;
        downloadJSON(anonymizeAnalysis(prepared.analysis),'dsh-local-analysis.json');
      } catch(error) { setStatus($('#local-status'),describeError(error),'error'); }
      finally { exportButton.disabled = false; }
    });
    const sharingNote = document.createElement('p'); sharingNote.className='helper-line'; sharingNote.textContent='导出仅含去标识的周期与额度摘要。是否公开分享及采用何种数据许可由你决定；网站代码的 MIT 许可不自动适用于这份数据。'; target.prepend(exportButton,sharingNote);
  } catch(error) { setStatus($('#local-status'),describeError(error),'error'); }
});
function formNumbers(form) { return Object.fromEntries([...new FormData(form)].map(([key,value]) => [key,Number(value)])); }
function calcQuota(event) {
  event?.preventDefault(); const form=$('#quota-form'), values=formNumbers(form), target=$('#quota-calc-result');
  target.classList.remove('error');
  if (!form.checkValidity() || Object.values(values).some(value => !Number.isFinite(value)) || values.after<=values.before || values.after>100 || values.before<0 || values.tokens<0 || !Number.isSafeInteger(values.tokens) || values.equivalent<0) {
    target.classList.add('error');target.textContent='请填写有效数值；结束已用额度必须高于起始额度，不能跨越重置或回退。';return;
  }
  const pp=Number((values.after-values.before).toFixed(10));
  target.innerHTML=metric('每 1% 对应 Token',number(values.tokens/pp),'Token')+metric('每 1% 对应 API 等价费用',number(values.equivalent/pp,4),'元');
}
function calcPaid(event) {
  event?.preventDefault();const form=$('#paid-form'),v=formNumbers(form),target=$('#paid-calc-result');target.classList.remove('error');
  const net=v.subscription+v.extra-v.refund;
  if (!form.checkValidity() || Object.values(v).some(value=>!Number.isFinite(value)||value<0)||net<0||v.accepted>v.attempted||!Number.isSafeInteger(v.accepted)||!Number.isSafeInteger(v.attempted)||v.attempted<1) {
    target.classList.add('error');target.textContent='退款不能超过总支出，验收任务数不能超过全部任务数，任务数须为整数。';return;
  }
  target.innerHTML=metric('每项验收任务净实付',v.accepted?money(net/v.accepted):'—','元',v.accepted?`周期净实付 ${money(net)} 元`:'本周期尚无验收任务')+metric('任务验收率',number(v.accepted/v.attempted*100,1),'%',`全部 ${number(v.attempted)} 项 · 已验收 ${number(v.accepted)} 项 · 未验收 ${number(v.attempted-v.accepted)} 项；人工 ${number(v.human,1)} 分钟`);
}
$('#quota-form').addEventListener('submit',calcQuota);$('#paid-form').addEventListener('submit',calcPaid);calcQuota();calcPaid();

async function api(path, options={}) {
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(path,{...options,signal:controller.signal,credentials:'same-origin',headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}});
    let data;try {data=await response.json();}catch{throw new Error('服务暂时未返回有效结果，请稍后重试。');}
    if(!response.ok) {const error=new Error(data.error?.message||`请求失败（${response.status}）`);error.code=data.error?.code;error.path=data.error?.path;throw error;}
    return data;
  } catch(error) {if(error.name==='AbortError')throw new Error('请求超时，请稍后重试。');if(error instanceof TypeError)throw new Error('网络连接失败，请检查连接后重试。');throw error;}finally{clearTimeout(timeout);}
}
async function loadHealth() {
  try {
    serviceHealth=await api('/api/health');
    if(serviceHealth.trial?.enabled) {
      const raw=serviceHealth.trial.storage_expires_at;
      const date=raw?new Date(raw).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric'}):'试运行结束时';
      const note=document.createElement('p');note.className='trial-notice';note.textContent=`试运行：当前数据存储至 ${date}。请保存个人导出与撤回凭证。`;
      $('#page-contribute .page-heading').after(note);
      const methodNote=note.cloneNode(true);$('#method-privacy').append(methodNote);
    }
  } catch { /* Community and contribution requests show actionable errors in their own context. */ }
}
loadHealth();

function communityGroup(item,kind,minimum) {
  const g=item.group,meta=kind==='quota'?[`${number(g.window_duration_seconds/3600,1)} 小时窗口`,g.quota_source&&label(g.quota_source),g.window_type&&label(g.window_type),g.coverage&&label(g.coverage)]:[label(g.task_type),label(g.difficulty),label(g.acceptance_standard),`${g.period_duration_days} 天`,g.cohort_month,g.payment_category&&label(g.payment_category)];
  const m=item.metrics;
  const metrics=item.published&&m ? `<div class="quota-values">${kind==='quota'?metric('每 1% 对应 Token',number(m.tokens_per_percentage_point),'Token')+metric('每 1% API 等价费用',number(m.api_equivalent_cny_per_percentage_point,4),'元'):metric('每项验收任务净实付',money(m.paid_cny_per_accepted_task),'元')+metric('人工投入',number(m.human_minutes),'分钟')}</div>${kind==='cost'?acceptanceBlock([m]):''}`:'';
  return `<article class="panel community-group"><div class="community-group-head"><div><h3>${escapeHTML(g.plan_id)} · ${escapeHTML(g.subject_id)}</h3><p>${escapeHTML(g.provider_id)} · ${escapeHTML(label(g.subject_kind))} · ${kind==='quota'?'额度价值':'任务成本'}</p></div><span class="status-badge ${item.published?'badge-teal':'badge-blue'}">${item.published?'已达到披露门槛':`积累样本 · ${item.contribution_count}/${minimum} 份贡献编号`}</span></div><div class="group-chips">${meta.filter(Boolean).map(v=>`<span>${escapeHTML(v)}</span>`).join('')}</div>${metrics}<p>${item.contribution_count} 份不同贡献编号 · ${item.sample_count??item.period_count} ${kind==='quota'?'组额度样本':'个完整周期'}${item.published?' · 用户自报、未经逐条独立核验':' · 未达披露门槛，指标暂不公开'}</p></article>`;
}
async function loadCommunity() {
  if(communityLoading)return;communityLoading=true;const button=$('#refresh-community');button.disabled=true;setStatus($('#community-status'),'');
  try {
    const data=await api('/api/community');
    const totals=`<div class="community-metrics"><div><strong>${number(data.totals.contributions)}</strong><span>份有效贡献记录</span></div><div><strong>${number(data.totals.quota_samples)}</strong><span>组额度采样</span></div><div><strong>${number(data.totals.cost_periods)}</strong><span>个完整成本周期</span></div></div>`;
    const empty=`<div class="empty-community"><div class="empty-symbol" aria-hidden="true">∅</div><h2>真实社区，等待第一份贡献</h2><p>这里暂时没有有效贡献记录。每组达到 ${data.minimum_contributions} 份不同贡献编号后才会披露统计指标；你可以先用构造样例了解计算方式。</p><a class="button button-outline" href="#workspace">体验构造样例 →</a></div>`;
    const groups=data.quota_groups.map(g=>communityGroup(g,'quota',data.minimum_contributions)).join('')+data.cost_groups.map(g=>communityGroup(g,'cost',data.minimum_contributions)).join('');
    $('#community-content').innerHTML=totals+(data.totals.contributions===0?empty:groups?`<div class="group-list">${groups}</div>`:'<div class="empty-community"><h2>正在积累可公开比较的样本</h2><p>已有贡献暂未形成满足公开条件的统计组。本地估算、滚动窗口与覆盖不完整的额度记录不进入社区额度聚合。</p></div>');
  }catch(error){$('#community-content').innerHTML='<div class="empty-community"><div class="empty-symbol" aria-hidden="true">—</div><h2>社区数据暂时无法读取</h2><p>当前未获得真实数据，不显示示例填充。请稍后刷新；本地分析与快速计算仍可使用。</p><a class="button button-outline" href="#workspace">打开本地工作台 →</a></div>';setStatus($('#community-status'),describeError(error),'error');}finally{communityLoading=false;button.disabled=false;}
}
$('#refresh-community').addEventListener('click',loadCommunity);

function resetContribution() {
  contributionGeneration++;contributionData=null;$('#contribution-preview').replaceChildren();$('#contribution-preview').hidden=true;$('#consent-area').hidden=true;$('#contribution-consent').checked=false;$('#submit-contribution').disabled=true;setStatus($('#contribution-status'),'');
}
$('#contribution-file').addEventListener('change',async event=>{
  resetContribution();const generation=contributionGeneration;try{
    const data=await readJSON(event.target.files[0]);if(!data)return;
    analyzeDataset(data);
    if(data.dataset_kind!=='user_reported')throw new Error('构造样例只能在工作台体验，不能贡献到真实社区。请使用自己有权分享的真实脱敏记录。');
    const prepared=await prepareContribution(data);if(generation!==contributionGeneration)return;
    contributionData=prepared.data;const result=prepared.analysis;
    const subjects=[...new Set([...result.quota_results,...result.cost_results].map(row=>`${row.provider_id} / ${row.plan_id} / ${row.subject_id}（${label(row.subject_kind)}）`))];
    $('#contribution-preview').innerHTML=`<div class="preview-heading"><h3>发送前预览</h3><span class="status-badge badge-teal">已在本地替换标识</span></div><div class="preview-summary"><div><strong>${result.totals.quota_samples}</strong><span>组额度采样</span></div><div><strong>${result.totals.cost_periods}</strong><span>个完整周期</span></div><div><strong>${prepared.privacy.task_alias_count}</strong><span>条去标识任务记录</span></div></div>${acceptanceBlock(result.cost_results)}<div class="preview-subjects">${subjects.map(escapeHTML).join('<br>')}</div><p class="footnote">任务和窗口已换成临时随机别名；工作流别名由本浏览器保存的随机密钥生成。原任务名、窗口名、工作流名和本地密钥不会发送。提供商、套餐、模型、额度池和价格快照仍是公开比较字段，请确认其中没有个人或单位名称。</p><p class="footnote">发送内容包括去标识的逐任务统计记录、验收结果、尝试次数、人工分钟、Token、费用及额度快照。服务器重新计算后只保存周期与额度摘要，不保存逐任务记录和原始快照。“完整周期、覆盖全部任务、单模型或组合归属”仍由你声明。</p><details class="payload-preview"><summary>查看实际待发送的数据字段与数值</summary><pre class="summary-json">${escapeHTML(JSON.stringify(prepared.data,null,2))}</pre><p class="footnote">仅在你勾选并提交后，附加 consent.accepted=true 和授权版本 ${escapeHTML(CONSENT_VERSION)} 发送这份数据。</p></details><button id="clear-contribution-preview" class="text-action" type="button">清除本次预览</button>`;
    $('#clear-contribution-preview').addEventListener('click',()=>{resetContribution();$('#contribution-file').value='';setStatus($('#contribution-status'),'已清除本次待发送记录。');});
    $('#contribution-preview').hidden=false;$('#consent-area').hidden=false;setStatus($('#contribution-status'),'文件已在本地校验并替换标识。尚未发送，请核对实际数据预览后再决定。','success');
  }catch(error){if(generation===contributionGeneration)setStatus($('#contribution-status'),describeError(error),'error');}
});
$('#contribution-consent').addEventListener('change',event=>{$('#submit-contribution').disabled=!event.target.checked||!contributionData;});
function downloadJSON(data,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('#submit-contribution').addEventListener('click',async()=>{
  if(!contributionData||!$('#contribution-consent').checked)return;
  const button=$('#submit-contribution'),generation=contributionGeneration;button.disabled=true;button.textContent='正在提交…';$('#contribution-file').disabled=true;
  if($('#clear-contribution-preview'))$('#clear-contribution-preview').disabled=true;
  try{
    const result=await api('/api/contributions',{method:'POST',body:JSON.stringify({consent:{accepted:true,version:CONSENT_VERSION},data:contributionData})});
    receipt=result.receipt||{contribution_id:result.contribution_id,withdrawal_key:result.withdrawal_key};
    const savedReceipt=receipt,savedSummary=result.summary;
    $('#receipt-panel').innerHTML=`<h3>贡献已收到</h3><p>服务器已保存统计摘要，达到披露门槛后才显示组内指标。请立即下载撤回凭证；密钥只在创建时返回，离开页面后无法再次获取。</p><code>${escapeHTML(result.contribution_id)}</code><button id="download-receipt" class="button button-primary">下载撤回凭证 ↓</button><button id="download-contribution-summary" class="button button-outline" style="margin-left:8px">下载可分享的脱敏摘要 ↓</button><p class="footnote">这份文件使用服务器实际保存的周期与额度摘要。你可自行公开分享并选择数据许可；下载不会替你公开单份摘要，MIT 代码许可不自动适用于用户数据。</p>`;
    $('#receipt-panel').hidden=false;$('#consent-area').hidden=true;setStatus($('#contribution-status'),'提交成功。撤回凭证仅保留在当前页面内存中，请自行下载。','success');
    $('#download-receipt').addEventListener('click',()=>downloadJSON(savedReceipt,`dsh-withdrawal-${savedReceipt.contribution_id}.json`));
    $('#download-contribution-summary').disabled=!savedSummary;
    $('#download-contribution-summary').addEventListener('click',()=>{if(savedSummary)downloadJSON(savedSummary,'dsh-contributed-summary.json');});
    if(generation===contributionGeneration)contributionData=null;
  }catch(error){setStatus($('#contribution-status'),describeError(error),'error');button.disabled=!$('#contribution-consent').checked||!contributionData;}finally{button.textContent='同意并提交去标识记录 →';$('#contribution-file').disabled=false;if($('#clear-contribution-preview'))$('#clear-contribution-preview').disabled=false;}
});
$('#show-withdraw').addEventListener('click',()=>$('#withdraw-section').scrollIntoView({behavior:'smooth'}));
$('#receipt-file').addEventListener('change',async event=>{
  try{
    const data=await readJSON(event.target.files[0]);if(!data)return;
    if(typeof data.contribution_id!=='string'||typeof data.withdrawal_key!=='string'||data.contribution_id.length>100||data.withdrawal_key.length>200)throw new Error('这不是有效的撤回凭证：需要 contribution_id 和 withdrawal_key。');
    $('#withdraw-id').value=data.contribution_id;$('#withdraw-key').value=data.withdrawal_key;setStatus($('#withdraw-status'),'凭证已在本地读取。点击“撤回这份贡献”后执行撤回。');
  }catch(error){setStatus($('#withdraw-status'),describeError(error),'error');}
});
$('#withdraw-form').addEventListener('submit',async event=>{
  event.preventDefault();const id=$('#withdraw-id').value.trim(),key=$('#withdraw-key').value.trim(),button=$('button',event.target);
  if(!id||!key)return;button.disabled=true;
  try{
    await api(`/api/contributions/${encodeURIComponent(id)}`,{method:'DELETE',headers:{Authorization:`Bearer ${key}`}});
    setStatus($('#withdraw-status'),'已撤回，这份记录立即停止计入社区聚合。','success');$('#withdraw-key').value='';$('#withdraw-id').value='';$('#receipt-file').value='';
    if(receipt?.contribution_id===id){receipt=null;$('#receipt-panel').hidden=true;}
  }catch(error){setStatus($('#withdraw-status'),describeError(error),'error');}finally{button.disabled=false;}
});
