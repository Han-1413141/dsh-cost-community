# 在 DSH 或 Codex 中贡献成本与工作摘要

安装后，在编码会话中说：

> 用 $dsh-cost-contribute 整理本次工作的成本与脱敏摘要，先给我预览，确认后再上传。

技能整理你指定范围的插件统计与工作记录，生成通用功能类别、代码量区间、难度和验收摘要。你可以修改或删去工作摘要，查看这一版后说“确认上传这一版”，即可从会话直接上传。无需打开网站，也无需编写 JSON。网站用于查看聚合比较，网页导入保留为另一个入口。

## 安装

需 Node.js 22 或 24。克隆本仓库后，在仓库根目录执行对应命令：

```sh
# 检查目标路径与同名目录
node skills/install.mjs --target codex --check
# 安装至 Codex 用户技能目录
node skills/install.mjs --target codex --write
```

DSH 使用：

```sh
node skills/install.mjs --target dsh --check
node skills/install.mjs --target dsh --write
```

Codex 默认安装到 `~/.codex/skills/dsh-cost-contribute`，设置 `CODEX_HOME` 时采用其 `skills` 子目录。DSH 默认安装到 `~/.dsh/skills/dsh-cost-contribute`，设置 `DSH_HOME` 时采用其 `skills` 子目录。需要指定其他技能根目录时增加 `--skills-root <目录>`。安装器不会覆盖同名技能。

DSH 的 `dsh-skill-filesystem` 插件可发现其用户技能目录，说明见 [DSH 官方技能目录文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.zh.md)。已有配置若关闭默认目录，需使用该配置实际扫描的技能根目录。文件安装成功不表示当前会话已经加载；在宿主技能目录中确认名称，再调用。Codex 会话未刷新列表时，可新建会话使用。

本技能是可单独复制的目录包，`dsh-cost-contribute/` 包含指令与运行脚本，不需要 npm 安装。直接分发整个目录时，将它放进宿主实际扫描的技能根目录即可。

## 使用范围

插件账本辅助读取只提供数值观察；实付账单、完整账期和任务验收需要真实记录。技能会补问缺失事实，不把 API 估算当成付款，不把会话数当成已完成任务数。

本地预览包含全部待发字段。服务器重算后保存周期与额度摘要，工作摘要只保存各类别计数，不保存原始业务描述、代码、路径或精确代码行数。上传成功会在用户数据目录保存撤回凭证；在会话中说明要撤回哪份贡献即可。

## 维护运行脚本

主要代码位于仓库 `client/` 与 `shared/`。更新后执行 `node skills/install.mjs --sync`，刷新技能中 `scripts/client/`、`scripts/shared/` 的自包含快照与 SHA-256 清单。安装器会核对快照和源码一致。快照仅含代码与 schema，不包含本机密钥、草稿或撤回凭证。
