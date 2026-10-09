# 字段与统计口径

完整机器格式见技能内 `scripts/shared/schema.json`。使用它组装文件，不让用户自己填写 JSON。schema_version 为 `2.0`，真实数据为 `dataset_kind: user_reported`，货币为 `CNY`。`quota_samples` 与 `cost_periods` 至少一类非空；单包最多 20 个额度样本、12 个周期、合计 1000 个任务及 256 KiB。

## 从现有插件记录整理

`collect-dsh.mjs` 只提供账本中的白名单数值。插件费用可能按目录单价估算，不能直接填成账单实付；会话可能包含多个任务，不能默认一条会话就是一个验收任务。把插件数值与当前授权范围内的任务记录对应，无法对应的部分列为缺项。

```text
node "<技能目录>/scripts/client/collect-dsh.mjs" --start YYYY-MM-DD --end YYYY-MM-DD --dsh-home "<已确认的DSH根目录>" --out "<新的本地观察.json>"
```

未传 `--dsh-home` 时只读取已设置的 `DSH_HOME`，不会扫描候选目录。采集结果为 `dsh-observations-1`，`upload_ready=false`。日期沿用账本本地日期，不擅自改成 UTC；总量只累加日统计，会话与模型明细是同批调用的其他视角，不能再次加总。原会话与提供商／模型键已换成本次序号别名，不凭别名猜模型身份。

`api_equivalent_usd` 与 `recorded_api_cost_estimate_usd` 都是美元口径的账本估算，不能改字段名后直接当人民币或实付。未知字段为 `null` 并列入 `missing`；不要照着整个缺项列表机械询问，先用当前会话的已知事实补充，只问这次贡献仍缺的必要数据。

来源说明、文件位置与原始业务内容只保留在本地整理笔记，不增加进上传对象。模型、提供商和套餐使用公开名称对应的简短标识；工作流在本地可用匿名代号，CLI 会另做 HMAC 别名。不在 `provider_id`、`plan_id`、`subject_id`、`price_snapshot_id` 中塞入账号、客户名或密钥。

## 完整周期成本

每个 `cost_periods[]` 需具备：

- 公开的提供商、套餐与模型标识；混用多个模型时 `subject_kind=workflow`，不把组合表现归给其中某个裸模型。
- `period_start`、`period_end`：UTC 时间，格式 `YYYY-MM-DDTHH:mm:ssZ`。只有周期已结束、全部尝试过的任务均纳入，才可将 `complete_period`、`all_attempted_tasks_included` 设为 `true`。
- `task_type`：`bugfix`、`feature`、`refactor`、`tests`、`docs`；`difficulty`：`simple`、`medium`、`complex`。一个成本周期对应同一类、同一难度的任务组，不能把一笔完整订阅费复制到多个分组。混合用途账单无法归属时，先保留草稿。
- `acceptance_standard`：`test_suite_passed`、`review_approved`、`spec_checklist_passed`；需要实际的测试、审阅或功能清单验收依据，不能从“代码写完”推断已验收。
- `payment_category`：`standard`、`promotional`、`credit`、`trial`、`unknown`。实付金额由 `subscription_cny + overage_cny + other_api_cny - refund_cny` 得到，赠送额度与常规付款不混为同类。
- 每项任务：本地去重用 `task_id`、`attempt_count`（含首次及重试）、`accepted`、`human_minutes`、`token_usage`、`api_equivalent_cny`。失败与未验收任务都保留，不能为提高成功率删掉。

代码量、人工时间和尝试次数均需记录依据。未知值不能用零代替；必要项缺失时先询问缺项或暂存草稿。

## 脱敏工作摘要

每项任务可附 `work_summary`，只包含三个枚举：

| 字段 | 可用值 |
|---|---|
| `function_category` | `interface` 界面、`api` 接口、`data_processing` 数据处理、`automation` 自动化、`integration` 集成、`infrastructure` 基础设施、`testing` 测试、`documentation` 文档、`other` 其他 |
| `code_change_band` | `not_applicable` 不涉及代码行、`1_50`、`51_200`、`201_500`、`501_1000`、`1000_plus` |
| `difficulty` | `simple` 简单、`medium` 中等、`complex` 复杂；须等于所属周期难度 |

功能描述落到上表类别，不传“某客户的支付系统”等具体业务。若在本地有可信的代码变更统计，将其转为区间后再写数据；原始行数不放进 JSON。行数只说明规模，不当作代码质量或验收得分。摘要可省略，省略不会删除任务本身。

`not_applicable` 只表示该项工作不涉及代码行。代码量未知或用户不提供时，可不附该项工作摘要或询问补充，不能把未知写成不适用。

难度以需求范围、涉及组件和验收要求判断并让用户核对，不能只按行数决定。现有周期分组已确定时不要另给任务摘要不同难度。

## Token 与额度

`token_usage` 必填 `token_semantics`、`reasoning_in_output` 和输入／输出／缓存读取／缓存写入／推理／归一化总 Token。先核实来源口径，再算总量：缓存与推理已包含在输入或输出中时不能重复相加。缺失细项不自动补零。

额度样本要有同一额度池、同一重置窗口的前后快照，时间递增、已用百分点增加、累计 Token 不回退；目录价格快照保持一致。记录 `quota_source`、`window_type`、`coverage`。只有官方 API／官方 CLI／用户快照来源、固定重置窗口、覆盖完整的样本进入公开统计；滚动窗口或覆盖未知只能本地观察，不能改标签使其合格。

`api_equivalent_cny` 表示该价格快照下的等价费用，不能代替订阅实付。既有完整账期不具备时，可以贡献独立、合格的额度样本，不必凑造成本周期。

## 传输与保存

用户预览的 `payload.json` 是实际待发字段；它含随机任务标识、数值、枚举工作摘要与额度快照，服务端重算后仅保存周期和额度摘要以及工作摘要计数分布，不保存逐任务工作描述。前后端源代码以 MIT 开放，用户贡献没有因此自动套用 MIT 数据许可。

当前同一成本组至少 5 份不同贡献才公开聚合；工作摘要分布还需至少 5 份含摘要贡献。该数量是公开门槛，不等于 5 个经过身份核验的独立用户。
