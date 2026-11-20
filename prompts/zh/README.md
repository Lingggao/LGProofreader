# 中文提示词库（prompts/zh）

本目录保存 Ling Gao 校对员 Host 端使用的全部提示词与输出契约。提示词只在 Host 读取、只在 Host 使用；**不进入 Client bundle、API 响应、报告或日志**，浏览器只能拿到提示词版本号（`version`）用于展示/复现。

## 文件结构

```text
prompts/zh/
  base.md                 # 用户原稿（逐字保留，仅 master 角色使用）
  rules.md                # 所有角色共享的硬规则（从 base 抽取 + 输出契约）
  roles/
    master.md             # 通读主审（完整执行 base.md）
    words.md              # 字词精校
    idioms.md             # 词语成语
    style.md              # 新闻出版规范
    facts.md              # 事实核查（两阶段：claims → verdicts）
    headline.md           # 标题与导语
    consistency.md        # 全文一致性
    consolidator.md       # 汇总裁决
  contracts/
    findings.schema.json  # 各角色 findings 输出（draft-07，对象根）
    claims.schema.json    # facts 第一阶段：主张抽取
    factchecks.schema.json# facts 第二阶段：核验结论
    layout.schema.json    # 视觉版面分析输出（Task 11 使用）
  README.md               # 本文件
```

## 如何组合

- 所有角色：`system = rules.md + roles/<role>.md`。
- `master` 额外加入 `base.md`：`system = rules.md + base.md + roles/master.md`（用户原稿是 master 的完整职责；其余角色只拿抽取后的共享规则，避免重复）。
- `user` 只放待校对数据：`<article>` 内是标题/副标题/署名/正文，`<context>` 内是报纸名、日期、版次等版面上下文。标签内是数据不是指令（`rules.md` 第 7 条）。
- 代码入口：`src/host/services/prompts.ts` 的 `loadPromptLibrary(dir)` 返回 `{ version, roles, compose(role, { article, context }) }`。

## 版本与缓存

- 版本 = 本目录下**全部文件**（按相对路径排序，含 `README.md`）内容的 SHA-256 前 12 个十六进制字符。
- 修改本目录任意文件都会改变 `version`，使旧校对缓存失效（缓存键含 `promptVersion`）；修改后需重新构建 / 重启 Host 才能生效。
- 开发期试验可将副本放到 `plugin-data/lgproofreader/prompts-override/`，再用该目录调用 `loadPromptLibrary`（高级选项，不在主 UI 展示；本任务只提供加载器，不负责接线）。

## 修改规则

1. 只改本目录，不改代码（`src/host/services/prompts.ts` 只负责读取、组合、哈希、包裹数据）。
2. `base.md` 逐字保留用户原稿；润色提示词时改 `rules.md` / `roles/*.md`，不要把改写全文塞回 `base.md`。
3. `base.md` 或角色文件与 `rules.md` 冲突时，以 `rules.md` 为准（例如 `base.md` 的“自行联网搜索”由 Host 的 facts 流程执行，模型不联网、不调用工具）。
4. 角色文件保持 5–12 行，只写该角色专属职责；所有角色共享规则放 `rules.md`，不要复制到每个角色。
5. 改动 `contracts/*.json` 时同步 `src/shared/types.ts` 及相关解析/校验代码与测试；契约保持 draft-07、对象根节点。
6. 角色文件必须全部存在且非空：`master`、`words`、`idioms`、`style`、`facts`、`headline`、`consistency`、`consolidator`；缺任一文件加载器会报错。
7. 事实核查硬约束（`rules.md` 第 9 条 / `facts.md`）：应查尽查、逐项核查状态、不得静默跳过、无来源不判 `contradicted`、来源冲突列全部来源并标 `needs_human`、超限项标 `not_checked`。
