# 从本地技能贡献统计

`dsh-cost-contribute.mjs` 让技能在终端完成本地预览、明确确认后的上传，以及凭证撤回。不需要打开网页。执行器复用网站的字段校验、统计和去标识函数，仅使用 Node.js 内置模块；支持 Node.js 22–24。

## 输入与准备

输入为 `shared/schema.json` 对应的 v2 数据对象，不是整份插件日志、账单文件或聊天记录。`dataset_kind=user_reported` 表示用户提供的实际数据；`synthetic` 只可生成本地预览，上传前会被拒绝。单个输入及最终请求各不得超过 256 KiB。

```powershell
node client/dsh-cost-contribute.mjs prepare --input "D:\local-data\contribution.json" --out "D:\local-data\review-01"
```

`prepare` 不发起网络请求，也不改输入文件。它先校验原记录，拒绝未知字段、重复任务、无效 Token 口径、缺失验收结果或不完整账期，再生成去标识的草稿。目录必须尚不存在，生成三个 UTF-8 文件：

| 文件 | 内容 |
|---|---|
| `preview.md` | 验收统计、每个周期的比较条件/费用/任务及工作摘要、额度快照，以及完整实际请求 |
| `payload.json` | 待发送请求，含当前版本的贡献用途确认；准备文件本身不表示用户已同意发送 |
| `manifest.json` | 实际请求和预览的 SHA-256、固定目标、授权版本、`review_sha256` |

技能应展示当前预览，包括金额、时间范围、验收标准、任务及工作摘要。用户明确同意上传该版本后，技能才读取 `manifest.review_sha256` 并执行下方命令。用户无需手工抄写哈希；程序中的确认标志是调用者声明，不能证明用户已经阅读，技能不能自行把生成草稿当作确认。

## 确认后的直传

```powershell
node client/dsh-cost-contribute.mjs upload --draft "D:\local-data\review-01" --confirmed-sha256 "<当前 manifest.review_sha256>" --confirm-reviewed
```

上传前再次校验实际文件，并核对预览、请求、端点和版本。任何改动都会使原确认失效，需要重新准备并展示新预览。含工作摘要时请求携带 `consent.work_summary_reviewed=true`；确认必须覆盖当前每项摘要。

默认且唯一的生产目标是 `https://dsh-cost-community.onrender.com`。写请求按该目标设置 `Origin`，拒绝 HTTP 重定向；不需要用户 API Key。实际发送的是去标识逐任务统计与额度快照，服务器重算后只保留统计摘要、去重指纹和撤回所需信息。原任务名、工作流名、窗口名与本地密钥不发送。提供商、套餐、模型、额度池、价格快照等比较字段仍会发送，预览时应确认这些是适合公开的产品标识。

上传结果写入 `upload-state.json`。成功后，草稿目录保存服务端实际返回的 `server-summary.json`，终端只返回贡献编号、摘要路径和私有凭证路径，不打印撤回密钥。服务器可能剔除只适合个人观察的额度记录，服务端摘要是最终保存口径。

网络中断、重定向或服务端结果不明确时，状态标为 `unknown`，原草稿不能再次发送。不自动重试，也不要另建相同草稿绕过。先保留现场、凭证和状态记录，再核实结果。收到明确拒绝时记为 `rejected`，同样不自动重试。

## 本地密钥与撤回

工作流使用本机用户目录中的随机 256 位 HMAC 密钥生成稳定别名；任务和窗口使用本次随机别名。相同用户数据目录的工作流在重复准备时保持别名，浏览器和 CLI 使用不同密钥，不承诺跨设备或跨用户识别同一组合。该密钥不是 API Key，不上传，也不保存原名映射。

- Windows：`%LOCALAPPDATA%\DSHCostCommunity\client\workflow-hmac-key-v1.bin`；目录继承当前用户数据目录的访问权限，不修改系统范围的 ACL。
- Linux/macOS：`~/.local/share/DSHCostCommunity/client/workflow-hmac-key-v1.bin`；目录权限 `0700`，文件权限 `0600`。
- 撤回凭证保存到同目录的 `receipts/<贡献编号>.json`。执行器拒绝把私有状态目录放到 Git 仓库内。

只有用户明确要求撤回时执行：

```powershell
node client/dsh-cost-contribute.mjs withdraw --receipt "<上传结果中的 receipt_path>" --confirm-withdraw
```

该命令只读取此执行器生成的凭证，向其绑定端点发送一次 `DELETE`，并写入同目录的撤回状态文件。成功后该贡献停止计入公开聚合；凭证和本地状态文件留存。结果不明时不自动重发。

## 插件账本观察与统计边界

`collect-dsh.mjs` 是另一个只读采集器，可从 DSH Cost Meter 本地账本生成 `dsh-observations-1` 观察草稿。它不会直接产出可上传数据，主执行器也拒绝这种输入。调用次数不是不同任务或验收次数；API 目录估值不是人民币实付；账本存在记录不代表完整支付周期。技能需要依据用户提供的账单、任务记录和确认，补齐真实缺项后另行形成 v2 数据。

工作摘要只允许功能类别、代码量区间和难度枚举，不收业务描述、源码、路径或精确代码行数。每个任务的摘要计一次，重试不当成新任务；代码量不作为性价比评分。未知信息保留为待补项，不能填假值通过校验。

站内用途是用户自愿分享后参加公开聚合。用户可以自行发布下载的脱敏摘要并选择其数据许可；网站和执行器的 MIT 源码许可不自动授予数据许可。

## 隔离开发验证

`prepare`、`upload` 和 `withdraw` 均可显式传 `--test-endpoint http://127.0.0.1:<port>` 或 `http://[::1]:<port>`。端点必须前后一致且会写入预览与凭证；不接受 `localhost`、其他域名、路径、认证信息或重定向。隔离测试使用构造的测试记录和测试存储，不能向生产写样例。

```powershell
node --test tests/client.test.js
```

技能分发应一起复制 `client/*.mjs` 和 `shared/*.js`，保持相对路径，并在脚本根目录保留 `package.json` 的 `"type":"module"`。无需复制服务器或安装第三方 npm 包。
