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
tasks: [{ task_id, attempt_count, accepted, human_minutes, token_usage, api_equivalent_cny, work_summary? }]
```

净实付为前三项合计减退款，不得为负。一个完整周期只对应一个任务组；混用模型必须标 `workflow`，不能归裸模型。原 `task_id` 用于本地在每个完整周期内验重；只有换成随机任务别名后的记录才允许发送。服务端重算时再次验重，逐任务记录和任务别名均不入库。原型的 `period_is_closed` 改为 `complete_period`，`includes_all_tasks` 改为 `all_attempted_tasks_included`；移除 `record_id`，增加 `refund_cny`。

## 本地分析返回值

### 可选工作摘要

`schema_version` 仍为 `2.0`；旧文件无需添加摘要。每个任务可选 `work_summary`，存在时以下三项全部必填，额外字段拒绝：

```text
work_summary: {
  function_category: "interface"|"api"|"data_processing"|"automation"|"integration"|
    "infrastructure"|"testing"|"documentation"|"other",
  code_change_band: "not_applicable"|"1_50"|"51_200"|"201_500"|"501_1000"|"1000_plus",
  difficulty: "simple"|"medium"|"complex"
}
```

`difficulty` 必须等于所属周期的难度，工作类型沿用周期 `task_type`，验收沿用任务 `accepted`。代码量只接收区间，具体行数、业务描述、源码、路径、文件名都不进入数据协议。区间仅描述工作规模，不作为质量或性价比排名指标。`not_applicable` 只表示工作不涉及代码行；不知道或不愿提供时不填写工作摘要，不能填该值代替未知规模。

浏览器若允许临时填写具体行数，须在本地转换成区间后才构建 `data`；不能在 JSON 中增加原始行数字段。`prepareContribution` 签名不变，保留合法枚举摘要。摘要编辑须以原本地数据为源再次生成待发送数据，并清空贡献同意及工作摘要确认，不能对已经替换的工作流别名重复做 HMAC。

`cost_results[].work_summary_counts` 仅保存直方图计数，不保存逐任务摘要。返回固定结构：

```text
{
  summarized_tasks: 已填写摘要的不同任务数,
  function_category: { interface:0, api:0, data_processing:0, automation:0,
    integration:0, infrastructure:0, testing:0, documentation:0, other:0 },
  code_change_band: { not_applicable:0, "1_50":0, "51_200":0, "201_500":0,
    "501_1000":0, "1000_plus":0 },
  difficulty: { simple:0, medium:0, complex:0 }
}
```

每个填摘要的任务每个维度计一次，失败与未验收任务也保留；重试不重复计摘要。未填摘要不猜测类别。旧库存摘要若没有此字段，在展示和合计中按“未提供工作摘要”处理。共享模块导出 `WORK_SUMMARY_ENUMS`、`hasWorkSummaries(data)`、`summarizeWorkSummaries(costResults)` 供前端复用。

含任何工作摘要的请求额外要求 `consent.work_summary_reviewed=true`，缺失或 false 返回 403 `WORK_SUMMARY_REVIEW_REQUIRED`。这是用户对当前待发内容的确认，不证明真人审核或摘要真实性。所有新上传均使用 `2026-10-09-work-summary-1` 授权版本。

公开成本组仍需要至少 5 份不同贡献编号。组内 `metrics.work_summary_counts` 还需至少 5 份含摘要贡献才返回直方图，否则为 null；`metrics.work_summary_contribution_count` 给出含摘要的贡献份数。低于成本组本身门槛时，整个 metrics 仍为 null。计数保存在既有 JSONB 摘要中，不增加数据表或逐任务存储。

整包内容指纹包含工作摘要；逐成本记录的唯一指纹排除工作摘要，保留原统计事实与工作流别名。这既记录了实际内容，也阻止仅添加、删除或修改摘要后重复提交同一统计记录，且兼容摘要功能之前的记录指纹。它不识别独立真人，也不把不同用户相同起止日期的账期一概判成重复。

构造演示文件为 `/samples/work-summary.json`，`dataset_kind=synthetic`，不能贡献到真实社区。

```text
{ schema_version, dataset_kind, quota_results: [...], cost_results: [...], totals: {...} }
quota_results[]: 公共样本维度 + token_semantics + reasoning_in_output +
  delta_percentage_points, delta_tokens, delta_api_equivalent_cny,
  tokens_per_percentage_point, api_equivalent_cny_per_percentage_point,
  window_duration_seconds, quota_source, window_type, coverage, community_eligible
cost_results[]: 公共周期/任务维度 + payment_category + period_duration_days + cohort_month +
  net_paid_cny, attempted_tasks, accepted_tasks, acceptance_rate,
  total_attempts, failed_attempts, retry_attempts, human_minutes,
  normalized_total_tokens, api_equivalent_cny, paid_cny_per_accepted_task, work_summary_counts
totals: { quota_samples, cost_periods, attempted_tasks, accepted_tasks }
```

`paid_cny_per_accepted_task` 在验收数为 0 时为 `null`。成功率分母为全部不同任务；尝试数单列。多模型 `workflow` 只作为该组合统计。

## HTTP 接口

| 方法 / 路径 | 请求与结果 |
|---|---|
| `GET /api/health` | `{ok:true, status:"ready"|"degraded", storage:"postgres"|"unconfigured", database_available:boolean, contributions_enabled:boolean,workflow_contributions_enabled:boolean,trial:{enabled:boolean,storage_expires_at:ISO日期或null}}` |
| `GET /api/community` | 见下面聚合结构；无数据库返回 503 |
| `POST /api/contributions` | `Content-Type: application/json`；正文 `{consent:{accepted:true,version:"2026-10-09-work-summary-1",work_summary_reviewed?:true},data:<上面数据>}`；成功 201 返回 `{ok:true, contribution_id, withdrawal_key, receipt:{contribution_id,withdrawal_key,created_at,consent_version},summary:<服务端实际保存的摘要>}` |
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
      api_equivalent_cny,paid_cny_per_accepted_task,
      work_summary_contribution_count,work_summary_counts:null|<工作摘要直方图>}}]
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
- 授权版本为 `2026-10-09-work-summary-1`。旧版请求需要刷新页面、核对新说明后重新主动同意；已有数据库摘要和撤回凭证无需迁移。

## 开源代码与用户摘要分享

网站前端、后端及计算代码在 `https://github.com/Han-1413141/dsh-cost-community` 以 MIT 公开。用户数据不自动采用代码许可证。贡献授权明确限定为服务端重算及公开聚合；不会因此公开单份摘要或原始任务记录。

本地分析与贡献成功页均提供“下载可分享的脱敏摘要”。下载的是去标识的周期与额度分析结果，贡献成功页以服务端 `summary` 为准；下载不发起公开操作。是否另行发布以及选择何种数据许可，由用户自行决定。本轮没有新增单份摘要公开接口、数据授权字段或数据库表，也不改变已有贡献的可见性。

## 本地技能执行器

`client/dsh-cost-contribute.mjs` 使用 Node.js 22–24，在本地完成共享校验和去标识，再调用上述贡献及撤回 API；不需要打开网页，也不增加服务器接口、字段或数据库表。它不依赖第三方 npm 包，安装时须保留 `client/`、`shared/` 的相对关系和脚本根目录 `type:module`。

| 命令 | 合同 |
|---|---|
| `prepare --input <v2.json> --out <新目录>` | 零网络；校验原输入后执行 `prepareContribution`；生成 `preview.md`、`payload.json`、`manifest.json`，不覆盖目录。允许 synthetic 仅本地预览。 |
| `upload --draft <目录> --confirmed-sha256 <review_sha256> --confirm-reviewed` | 仅在用户核对当前完整预览并明确同意后执行；读取并校验草稿；synthetic 拒绝；向固定项目 `/api/contributions` 发送一次。 |
| `withdraw --receipt <私有凭证.json> --confirm-withdraw` | 仅在用户明确要求撤回时执行；向凭证绑定端点发送一次 `DELETE`。 |

生产端点固定为 `https://dsh-cost-community.onrender.com`。隔离验证可显式使用 `--test-endpoint http://127.0.0.1:<port>` 或 `http://[::1]:<port>`，三个命令须保持绑定端点；不接受其他服务、子路径或 URL 凭据。所有写请求按固定目标发送 `Origin`，`redirect:error` 禁止跟随重定向，30 秒超时，不自动重试。

`manifest.json` 为 `dsh-cost-draft-v1`，字段是 `format_version`、`created_at`、`endpoint`、`consent_version`、`dataset_kind`、`requires_work_summary_review`、`payload_sha256`、`preview_sha256` 和 `review_sha256`。其中 `review_sha256` 对其余固定顺序字段的 JSON 求 SHA-256，绑定实际 UTF-8 请求与完整预览的字节哈希。上传必须同时匹配该值、文件哈希与 `--confirm-reviewed`；文件、预览、端点或授权版本变动后原确认失效。哈希不证明用户已经阅读，技能必须先取得对所展示版本的明确确认，用户无需手抄哈希。

实际请求沿用当前 `consent` 和 v2 `data`；存在工作摘要时带 `work_summary_reviewed:true`。预览列出每个比较维度、费用分量、任务验收、尝试数、Token、人工时间、工作摘要枚举及完整实际 JSON。`payload.json` 中的授权值是待发送模板，生成草稿不等于已同意上传。实付、完整周期和任务验收必须来自用户提供的数据，不能根据 API 调用数或目录估值推断。

Windows 去标识密钥和撤回凭证保存在 `%LOCALAPPDATA%/DSHCostCommunity/client`，继承用户目录权限；其他平台保存在 `~/.local/share/DSHCostCommunity/client`，目录 `0700`、文件 `0600`。状态目录不能位于 Git 仓库内。随机 32 字节 HMAC 密钥仅本地保存，导入为不可导出的 Web Crypto key 后传给共享去标识函数；不上传、不打印，也不保存原标识映射。CLI 与浏览器的工作流别名各自稳定，不承诺互通或识别独立用户。

成功上传后，草稿保存服务端 `server-summary.json`；私有 `receipts/<UUID>.json` 保存 `dsh-withdrawal-receipt-v1` 凭证，包含端点、贡献编号、撤回密钥、创建时间、授权版本及本次 review hash。终端只返回编号和文件路径，不打印密钥。`upload-state.json` 记录 `succeeded`、明确拒绝时的 `rejected`，或结果不明时的 `unknown`；有过发送记录的草稿不再自动发送。网络结果不明不能另建相同草稿绕过。撤回也保存单独状态并禁止自动重发。

`collect-dsh.mjs` 输出独立的 `dsh-observations-1 / local_observations` 草稿，不可直接用于该执行器上传。需要依据真实来源补全 v2 所需统计字段后另行准备，禁止把调用次数当验收任务或把 USD 目录估值当人民币实付。
