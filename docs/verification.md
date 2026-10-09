# 已执行的验证

核验日期：2026 年 10 月 9 日。线上地址：[dsh-cost-community.onrender.com](https://dsh-cost-community.onrender.com)。首次部署源提交为 `5294d1c000e52a8061fc24b9ff4aff04e06a8ef8`。

## 计算与接口

共享计算规则 8 项通过；接口及测试存储 5 项通过。这两组检查分次执行，不表示某一次完整运行包含全部 13 项。测试源在 `tests/analysis.test.js` 与 `tests/api.test.js`，测试内存存储不会被生产入口加载。

## 隔离浏览器流程

9 项通过，完整条目见 [isolated-browser-20261009.json](evidence/isolated-browser-20261009.json)：

1. 构造样例拒绝真实提交。
2. 本地预览不发送请求，同意默认未勾选。
3. 主动同意后保存成功，可下载撤回凭证。
4. 单份贡献不披露指标。
5. 导入凭证并撤回后，社区归零。
6. 未知敏感字段在本地被拒绝，不触网。
7. 撤回密钥未写入浏览器持久存储。
8. 手机工作台无整页横向溢出，宽表在自身容器中滚动。
9. 浏览器脚本无异常。

以上使用隔离的 `MemoryTestStore`，没有向生产社区写数据。

## 真实 PostgreSQL

在 Render 云内通过同区域内部连接执行 `tests/postgres.test.js`，1 项通过、0 失败、0 跳过。测试在随机 `test_<hex>` schema 内执行，检查持久化、新连接读取、唯一约束、事务回滚、聚合和密钥撤回；结束后删除测试 schema。官方日志摘录见 [cloud-postgres-20261009.json](evidence/cloud-postgres-20261009.json)。

早期从本地经公共网络连接的尝试曾因连接中断失败，该结果没有被当作成功；这里的通过结果来自后续实际云内执行。测试完成后，生产启动命令恢复为 `npm start`。真实社区仍为零贡献。

## 线上只读浏览

在真实线上地址使用 Chrome 查看首页、成本工作台、快速计算器、真实社区、贡献页、方法页，分别使用 1440×1000 桌面视口与 390×844 手机视口，共 12 个页面状态。保存整页与视口截图，并实际复看工作台的桌面、手机布局。

结果记录见 [live-browser-20261009.json](evidence/live-browser-20261009.json)：

- `/api/health` 返回 `ready`、`storage=postgres`、数据库可用、模型与工作流贡献均启用。
- `/api/community` 返回 0 份贡献、0 组额度样本、0 个成本周期。
- 页面异常、控制台错误、失败请求和 HTTP 错误响应均为 0。
- 12 个页面状态的 `scrollWidth` 均不超过视口宽度。
- 工作台明确显示“构造样例 · 不代表厂商排名”。
- 浏览器路由禁止写请求；实际网络方法仅 GET，没有发起生产 POST、DELETE 或其他写请求。

截图脚本首次在手机工作台遇到测试脚本的 tab 状态等待超时；调整脚本先选中目标 tab 后，完成上述检查。没有因此改动线上应用代码，也没有把该脚本超时归为页面异常。

## 试运行期限

线上健康接口确认当前到期值 `2026-11-08T09:11:08Z`，即北京时间 2026 年 11 月 8 日 17:11:08。该期限属于本轮资源安排，不是长期数据留存承诺。个人分析支持导出，贡献支持下载撤回凭证。

## 本轮验收统计与本地脱敏修复

本轮只检查新增与受影响的隐私及验收边界，没有重跑前述全部测试，也没有连接生产 PostgreSQL。以下为本地代码验证，不能单独作为已部署证据。

- `node --test tests/privacy.test.js`：5 项通过，0 失败。验证原任务先验重、窗口一致性、稳定 HMAC 与随机别名、不同工作流保留区分、脱敏前后验收/重试/成本口径一致、零验收成本为 null、上传拒绝原标识、服务端返回实际摘要与撤回。输出见 [定向单元与接口记录](evidence/privacy-acceptance-unit-api-20261009.txt)。
- `node tests/privacy.browser.js`：8 项通过，0 失败、0 页面脚本错误。一次隔离 Chrome 检查了未同意不上传、实际网络正文与去标识预览一致、浏览器刷新后工作流别名稳定、IndexedDB 只保存不可导出的随机 CryptoKey、服务端摘要下载、披露门槛、本地导出、撤回和手机展示。结果见 [浏览器结果](evidence/privacy-acceptance-20261009/results.json)。
- 桌面与手机贡献页截图均已复看：[桌面](evidence/privacy-acceptance-20261009/contribution-desktop.png)、[手机](evidence/privacy-acceptance-20261009/contribution-mobile.png)。截图中的数据是独立内存实例使用的构造测试记录，没有进入真实社区。

浏览器检查在测试脚本内创建随机 loopback 端口和空 `MemoryTestStore`，结束后关闭浏览器与 HTTP 服务。没有增加生产调试接口，不保存原始任务标识，不改变数据库 schema。

## AI 编码与开放分享说明补充

首页补充“API 单价不等于完成任务的成本”和同预算关注验收任务数的说明，并将网站源码入口指向已公开的 `Han-1413141/dsh-cost-community`。GitHub 页面实际显示 Public 与 MIT license；原插件入口仍单独保留。

本次只做一轮针对新增页面与下载文案的浏览器检查，没有重跑先前的上传、数据库和统计测试。检查了 1440×1080 与 390×844 首页、源码/许可证链接、贡献授权用途和本地导出：0 写请求、0 页面脚本错误、无整页横向溢出；下载仍是去标识摘要，不含原工作流名或任务明细。桌面和手机截图已复看。

记录见 [开放分享检查](evidence/open-source-sharing-20261009/results.json)、[桌面首页](evidence/open-source-sharing-20261009/home-desktop.png)、[手机首页](evidence/open-source-sharing-20261009/home-mobile.png)。只访问临时 loopback 内存实例；完成后关闭实例。没有新增单份摘要公开接口、数据库结构或用户数据的默认许可，未改变已有贡献可见性。
