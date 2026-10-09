# Website API contract · v2.0

前后端共用 `/shared/analysis.js`：`analyzeDataset(data)` 返回分析对象，`anonymizeAnalysis(result)` 返回可导出的摘要；失败抛出带 `code`、`path` 的 `ValidationError`。该模块无依赖、可直接 ESM import，不调用网络。结构 schema 由 `/shared/schema.json` 提供，服务端再用 Ajv 和同一计算模块重验。

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

净实付为前三项合计减退款，不得为负。一个完整周期只对应一个任务组；混用模型必须标 `workflow`，不能归裸模型。`task_id` 只用于本次去重，不入库。原型的 `period_is_closed` 改为 `complete_period`，`includes_all_tasks` 改为 `all_attempted_tasks_included`；移除 `record_id`，增加 `refund_cny`。

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
| `POST /api/contributions` | `Content-Type: application/json`；正文 `{consent:{accepted:true,version:"2026-10-09"},data:<上面数据>}`；成功 201 返回 `{ok:true, contribution_id, withdrawal_key, receipt:{contribution_id,withdrawal_key,created_at,consent_version},summary:<本地分析摘要>}` |
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
- 工作流在个人预览保留本地标识；201 摘要、数据库和公开聚合将 `subject_id` 换成服务端 HMAC 生成的 `workflow-...`，不公开原名称。只对同一声明组合归组，不宣称定义已获独立核验。
- 试运行环境当前数据库截止值为 `2026-11-08T09:11:00Z`，由部署环境变量传入 health；页面显示“试运行，当前数据存储至2026年11月8日，支持下载与撤回”。不承诺 90 天保留。
