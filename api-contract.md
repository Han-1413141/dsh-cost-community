# Website API contract · v2.0 · local-hmac-v1

前后端共用 `/shared/analysis.js`：`analyzeDataset(data)` 返回分析对象，`anonymizeAnalysis(result)` 仅补充摘要标记，本身不替换名称；失败抛出带 `code`、`path` 的 `ValidationError`。浏览器贡献与可分享导出先调用 `/shared/privacy.js` 的异步 `prepareContribution(data)`，得到已替换标识的 `data`、重新计算的 `analysis` 与仅在本地使用的 `privacy` 计数。该模块无依赖、可直接 ESM import，不调用网络。结构 schema 由 `/shared/schema.json` 提供，服务端再用 Ajv 和同一计算模块重验。

## 输入数据

```json
{
  "schema_version": "2.0",
  "dataset_kind": "synthetic",
  "currency": "CNY",
  "quota_samples": [],
  "cost_periods": []
}
```

两类数组至少一类非空。计算允许 `synthetic` 或 `user_reported`；上传仅允许 `user_reported`。不可原样上传原型 v1，字段映射如下。所有对象拒绝未知字段，所有名称只接受 1–48 位公开或匿名标识 `[A-Za-z0-9][A-Za-z0-9._-]*`，不接受账号、自由文本、邮箱或密钥。上限为 256 KiB、20 组额度样本、12 个成本周期、总计 1000 个任务。

每个 `quota_samples[]`：

```text
provider_id, plan_id, subject_kind("model"|"workflow"), subject_id,
quota_pool_id, window_id, window_start, window_end, price_snapshot_id,
quota_source: "official_api"|"official_cli"|"user_snapshot"|"local_estimate",
window_type: "fixed_reset"|"rolling", coverage: "complete"|"partial"|"unknown",
before: { observed_at, used_percent, token_usage, api_equivalent_cny },
after:  { observed_at, used_percent, token_usage, api_equivalent_cny }
```

公共字段从原型前后快照提到样本外层；`model_id` 改为 `subject_id` 并声明 `subject_kind`。UTC 时间统一 `YYYY-MM-DDTHH:mm:ssZ`。`used_percent` 是 0–100 已使用百分比。前后采样须在同一窗口、时间递增、百分比严格增加、累计量不回退。等价金额是用户提供的同一目录价格快照计算值，网站未替用户联网验价，不冒充实付。

`token_usage` 与原型相同：`token_semantics`（`input_includes_cache` / `input_excludes_cache`）、`reasoning_in_output`（boolean）、`input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens`、`reasoning_tokens`、`normalized_total_tokens`。总量须符合非重复相加规则。

每个 `cost_periods[]`：

```text
provider_id, plan_id, subject_kind("model"|"workflow"), subject_id,
period_start, period_end,
complete_period: true, all_attempted_tasks_included: true,
task_type: "bugfix"|"feature"|"refactor"|"tests"|"docs",
difficulty: "simple"|"medium"|"complex",
acceptance_standard: "test_suite_passed"|"review_approved"|"spec_checklist_passed",
payment_category: "standard"|"promotional"|"credit"|"trial"|"unknown",
costs: { subscription_cny, overage_cny, other_api_cny, refund_cny },
tasks: [{ task_id, attempt_count, accepted, human_minutes, token_usage, api_equivalent_cny }]
```

净实付为前三项合计减退款，不得为负。一个完整周期只对应一个任务组；混用模型必须标 `workflow`，不能归裸模型。原 `task_id` 用于本地在每个完整周期内验重；只有换成随机任务别名后的记录才允许发送。服务端重算时再次验重，逐任务记录和任务别名均不入库。原型的 `period_is_closed` 改为 `complete_period`，`includes_all_tasks` 改为 `all_attempted_tasks_included`；移除 `record_id`，增加 `refund_cny`。

## 本地分析返回值

```text
{ schema_version, dataset_kind, quota_results: [...], cost_results: [...], totals: {...} }
quota_results[]: 公共样本维度 + token_semantics + reasoning_in_output +
  delta_percentage_points, delta_tokens, delta_api_equivalent_cny,
  tokens_per_percentage_point, api_equivalent_cny_per_percentage_point,
  window_duration_seconds, quota_source, window_type, coverage, community_eligible
cost_results[]: 公共周期/任务维度 + payment_category + period_duration_days + cohort_month +
  net_paid_cny, attempted_tasks, accepted_tasks, acceptance_rate,
  total_attempts, failed_attempts, retry_attempts, human_minutes,
  normalized_total_tokens, api_equivalent_cny, paid_cny_per_accepted_task
totals: { quota_samples, cost_periods, attempted_tasks, accepted_tasks }
```

`paid_cny_per_accepted_task` 在验收数为 0 时为 `null`。成功率分母为全部不同任务；尝试数单列。多模型 `workflow` 只作为该组合统计。

## HTTP 接口

| 方法 / 路径 | 请求与结果 |
|---|---|
| `GET /api/health` | `{ok:true, status:"ready"|"degraded", storage:"postgres"|"unconfigured", database_available:boolean, contributions_enabled:boolean,workflow_contributions_enabled:boolean,trial:{enabled:boolean,storage_expires_at:ISO日期或null}}` |
| `GET /api/community` | 见下面聚合结构；无数据库返回 503 |
| `POST /api/contributions` | `Content-Type: application/json`；正文 `{consent:{accepted:true,version:"2026-10-09-privacy-1"},data:<上面数据>}`；成功 201 返回 `{ok:true, contribution_id, withdrawal_key, receipt:{contribution_id,withdrawal_key,created_at,consent_version},summary:<服务端实际保存的摘要>}` |
| `DELETE /api/contributions/:id` | `Authorization: Bearer <withdrawal_key>`；成功 `{ok:true,withdrawn:true}`。无效凭证统一 404。撤回后立即不再计入聚合。 |

成功上传后必须显示并支持下载撤回凭证；不要放在 URL、分析日志或 localStorage。撤回密钥只在创建时返回，服务端保存哈希。用户保存凭证后可离开或重新打开撤回页。

所有写请求要求同源 `Origin`（浏览器会自动发送）；服务端支持用 `APP_ORIGIN` 配置部署的规范源。错误一律 `{ok:false,error:{code,message,path?}}`。重要状态：400 无效 JSON；403 Origin / 授权失败；409 内容重复；413 超过 256 KiB；422 结构/口径或 synthetic 上传；429 限流；503 数据库未配置/不可用。未知字段错误不要回显其值。

## 社区聚合结果

```text
{
  ok:true,
  source:"user_reported_unverified",
  minimum_contributions:5,
  totals:{ contributions, quota_samples, cost_periods },
  quota_groups:[{group:{provider_id,plan_id,subject_kind,subject_id,quota_pool_id,
      price_snapshot_id,quota_source,window_type,coverage,window_duration_seconds,token_semantics,reasoning_in_output},
    contribution_count,sample_count,published,metrics:null|{
      delta_percentage_points,delta_tokens,delta_api_equivalent_cny,
      tokens_per_percentage_point,api_equivalent_cny_per_percentage_point}}],
  cost_groups:[{group:{provider_id,plan_id,subject_kind,subject_id,task_type,difficulty,
      acceptance_standard,payment_category,period_duration_days,cohort_month},
    contribution_count,period_count,published,metrics:null|{
      net_paid_cny,attempted_tasks,accepted_tasks,acceptance_rate,total_attempts,
      failed_attempts,retry_attempts,human_minutes,normalized_total_tokens,
      api_equivalent_cny,paid_cny_per_accepted_task}}]
}
```

每组至少 5 个不同贡献编号才返回 metrics；这是记录披露门槛，不是“5 个独立真人”或统计显著性。低于门槛只展示维度、记录数与未发布状态。聚合用 `Σ净实付/Σ验收任务`、`ΣToken/Σ百分点`，不能平均各个比值。没有贡献时 totals 全 0、groups 为空。

前端必须将真实社区与构造演示分开；演示模式不得提供上传按钮。AA 仅方法说明与官网外链，禁止嵌入第三方榜单。本轮不提供自动价格目录抓取。

## 已批准的统计边界补充

- 只有 `quota_source` 为 `official_api`、`official_cli` 或 `user_snapshot`，且 `window_type=fixed_reset`、`coverage=complete`，额度样本才有 `community_eligible=true`。来源仍是用户自报，不等于官方核验。其他额度仅供本地个人计算，不入数据库；若一份提交没有任何可公开额度或成本样本，返回 422 `NO_COMMUNITY_ELIGIBLE_RECORDS`。201 的 summary 是实际保存的摘要，可能少于本地预览记录数。
- 同包拒绝同一额度窗口观察区间重叠、同提供商/套餐账期重叠。服务器把对象键与数组顺序规范化，忽略可改名的 task_id/window_id 后计算内容指纹；整包与逐样本均做唯一约束。该方法不等于识别独立真人。
- `payment_category` 参与成本分组，赠送/试用与常规付费不混成一个值。`cohort_month` 为 period_start 的 UTC 年月。实际贡献的周期结束和后一次采样不能晚于服务端当前时间。
- `failed_attempts` 显示为“未通过验收的尝试”；一次尝试以一次验收结束，并非模型故障率。
- 工作流在本地计算页可显示本地名称，但贡献预览、上传和可分享摘要导出先用本浏览器独有的随机 256 位 HMAC 密钥替换 `subject_id`。服务端再把收到的本地别名转换为 `workflow-...` 后保存和返回，不会收到原工作流名称。不同浏览器的别名不互通，不承诺跨用户识别同一组合；也不验证组合定义或真人身份。
- 试运行环境当前数据库截止值为 `2026-11-08T09:11:00Z`，由部署环境变量传入 health；页面显示“试运行，当前数据存储至2026年11月8日，支持下载与撤回”。不承诺 90 天保留。

## 上传前去标识与验收统计

`prepareContribution` 必须先对原数据运行完整校验，再生成别名，不能先改名后绕过任务重复或窗口一致性检查。返回结构为 `{data, analysis, privacy:{version,task_alias_count,window_alias_count,workflow_alias_count}}`。只有 `data` 放入上传正文，`privacy` 计数、原始数据、本地密钥和映射表都不发送。

- 任务别名为 `task-` 加 32 位随机十六进制；窗口别名为 `window-` 加 32 位随机十六进制。同一次准备中保持相同统计范围内的一致性，再次准备生成新别名。
- 工作流别名为 `wf-` 加 43 位 base64url HMAC-SHA-256；消息包含提供商、套餐和原本地组合标识。随机 256 位非导出 CryptoKey 仅保存在当前站点 IndexedDB 的 `dsh-local-privacy-v1 / keys / workflow-hmac-v1`。存储失败时禁止继续上传，不回退发送原名。
- 本地 schema 允许原标识；上传接口额外检查上述格式，未处理返回 422 `LOCAL_ALIASES_REQUIRED`。格式检查不能证明调用方诚实或数据完全匿名。
- 服务端原有工作流 HMAC 再处理客户端别名；同浏览器原组合重复导入时内容指纹稳定，不同工作流仍参与区分。清除站点数据或换浏览器会改变别名，不实现跨浏览器、跨用户工作流身份验证。
- 页面展示不同任务总数、已验收、未验收、验收率、全部尝试、未通过验收的尝试与重试。验收分母是每个周期内不同任务数，跨周期展示是合计；`未验收 = attempted_tasks - accepted_tasks`，`重试 = total_attempts - attempted_tasks`。验收标准仍为受控枚举与用户声明，没有新增自动验收。
- 实际发送的是去标识逐任务统计记录和额度快照，服务器重算后仅存摘要。前端展开预览展示实际 `data` 字段和数值，不把这一过程称作“只上传汇总”。成功后的摘要下载必须直接使用 201 `summary`，因为服务端可能剔除不合格额度，并再次转换工作流别名。
- 授权版本为 `2026-10-09-privacy-1`。旧版请求需要刷新页面、核对新说明后重新主动同意；已有数据库摘要和撤回凭证无需迁移。

## 开源代码与用户摘要分享

网站前端、后端及计算代码在 `https://github.com/Han-1413141/dsh-cost-community` 以 MIT 公开。用户数据不自动采用代码许可证。贡献授权明确限定为服务端重算及公开聚合；不会因此公开单份摘要或原始任务记录。

本地分析与贡献成功页均提供“下载可分享的脱敏摘要”。下载的是去标识的周期与额度分析结果，贡献成功页以服务端 `summary` 为准；下载不发起公开操作。是否另行发布以及选择何种数据许可，由用户自行决定。本轮没有新增单份摘要公开接口、数据授权字段或数据库表，也不改变已有贡献的可见性。
