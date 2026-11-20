# Ling Gao 校对员 · Ling Gao Proofreader

![Ling Gao 校对员](icon.png)

报纸版面智能校对插件，运行在 DeepSeek Harness（DSH）的 Web 界面中。

把单页报纸 PDF 上传到插件后，插件会识别报头、报脚、头条、二条、三条、正文、图片/图说、广告等版面区域，按阅读顺序抽取每篇文章的完整文本；随后由用户显式选择单篇、多篇或本页全部文章，在后台用多个校对角色并行审校，并输出可逐条处理的问题清单与事实核查清单。全程不创建聊天会话、不展示提示词。

> 当前版本：`0.1.0`。详细变更见 [`CHANGELOG.md`](CHANGELOG.md)。

## 功能

- **单页报纸 PDF 导入**：浏览器端用 PDF.js 抽取文字层与坐标、渲染页面图；多页 PDF 会在上传前明确拒绝并提示拆分。
- **版面理解**：候选区块 → 一次视觉分区（只输出分类/分组，不转录正文）→ 确定性文字回填；报头/报脚/广告默认不参与校对。
- **人工校正**：移动/缩放/合并/拆分区域、改区域类型与文章归属、调整阅读顺序、撤销/重做（≥20 步）、编辑文章标题/署名/正文；所有修改只写入插件数据目录，不写回 PDF。
- **显式触发校对**：上传/分析完成后只到 `ready`，必须勾选文章或「本页全部」并确认才开始，绝不自动校对。
- **多角色后台校对**：通读、字词、成语词语、标点规范、标题导语、一致性、事实核查，深度预设（快速/标准/深度），单角色失败或超时不阻塞整个任务，可取消、可重试。
- **事实核查应查尽查**：逐项联网核验，输出已核实/有冲突/未核实/证据不足/未检查清单，带来源；无来源不判错。
- **报告**：不输出改写全文，只列「申请修改哪里、怎样修改」；必改/建议/可选分级，结尾附必须修改条目；支持复制/下载 Markdown 与 JSON。
- **状态与隐私**：左侧栏入口，点开占满 DSH 主窗口；浅色/深色主题；不创建 Agent/会话，不写 session log。

## 安装

Release 同时提供两种安装包：

- **`.tgz`（推荐）**：DSH 侧栏 **Plugins → Add plugin**，粘贴 release 资产 URL 或本地绝对路径（例如 `C:\...\LGProofreader-0.1.0.tgz`）→ Install；
- **`.zip`**：解压到固定目录（例如 `C:\Plugins\LGProofreader`）后，在 **Add plugin** 中粘贴含 `package.json` 的目录绝对路径 → Install。

DSH 的 Add plugin 不支持直接输入 `.zip`，`.zip` 只是下载/解压容器。本版本**针对 DSH Desktop `0.2.2-rc.5` 开发和构建**（`package.json` 的 `engines.dsh` 限定 `>=0.2.2-rc.5 <0.3.0`）。

安装并启用后，左侧栏应出现「Ling Gao 校对员」入口；若没有出现，请确认插件已启用，并重新打开面板或刷新页面。

## 使用

1. 点击左侧栏「Ling Gao 校对员」打开工作台；
2. 上传一份**单页**报纸 PDF（≤150 MB；多页请先拆分）；
3. 等待版面分析完成，检查画布上的区域与文章列表，必要时手动校正；
4. 在「文章」列表勾选要校对的文章（或点「本页全部」），选择深度与是否联网，确认后开始校对；
5. 在校对报告里逐条查看问题、事实核查清单与必改摘要，可复制或下载报告。

## 数据与隐私

- PDF、页面图、版面、提示词覆盖项与校对报告只保存在本机 DSH profile 的 `plugin-data/lgproofreader/` 下，不写入仓库、不上传云端；
- 校对时文章文本与页面图会发送给配置的模型 provider；开启联网事实核查时，事实关键词会发送给搜索 provider（不发送整篇文章）；
- 插件不保存 API Key；模型/搜索凭据由 DSH 的 provider 配置管理；
- 提示词只在 Host 读取与使用，不会通过 API、Client bundle、报告或日志下发到浏览器；
- `.gitignore` 已排除数据目录、PDF、日志与 release 产物。

## 开发

要求 Node.js ≥ 24 与 pnpm。安装依赖：

```bash
pnpm install
```

常用命令：

```bash
pnpm build       # 构建 lib/index.js（Host ESM）与 lib/client.js（DSH ModuleLoader 单文件）
pnpm typecheck   # tsc --noEmit
pnpm test        # Vitest 全量测试
pnpm validate    # 校验 manifest/locale/详情页/图标/产物/提示词/版本，并做安装布局的提示词解析冒烟
pnpm detail      # 重新生成 docs/preview.svg、docs/DETAIL.md、docs/DETAIL.zh.md
pnpm release     # 构建 + 校验 + 生成 release/ 下的 .zip/.tgz/SHA256SUMS.txt
```

构建约定（详见 `scripts/build.mjs` 头部注释）：

- `lib/index.js`：`src/host/index.ts` 的 ESM bundle（`platform=node`、`target=node24`），保留 `import.meta.url` 以便从安装包目录解析 `prompts/zh`；
- `lib/client.js`：`src/client/index.tsx` 的 CJS bundle（`platform=browser`、`target=chrome152`、`jsx=automatic`）外包 `window.__ModuleLoader__.load({ id: "lg-proofreader", factory(require) { … } })`；React 由 DSH 运行时提供，品牌 PNG 以 data URL 内联，PDF.js worker 源码通过 `define` 内联；
- 两个产物都经过 `node --check`；`pnpm validate` 会额外检查提示词/Host 代码没有泄漏进 Client bundle。

提示词位于 `prompts/zh/`（`base.md`、`rules.md`、`roles/*.md`、`contracts/*.schema.json`），只由 Host 读取；修改后重新构建/重启即可，版本哈希会自动更新。修改提示词不需要改代码。

目录结构：

```text
assets/brand/     # Ling Gao 品牌源文件与派生图标（代码许可不自动覆盖品牌资源）
docs/             # 详情页文档与预览图
prompts/          # 校对提示词与 JSON Schema 契约
scripts/          # build / detail / validate / release 脚本与开发基线工具
src/host/         # Host 侧 Cordis 插件（存储、API、版面分析、校对编排）
src/client/       # Client 侧 React 工作台（预构建进 lib/client.js）
src/shared/       # Host/Client 共用类型与纯函数
tests/            # Vitest 单元/集成/UI 测试
lib/              # 构建产物（提交到仓库，供本地目录/git 安装）
icon.png          # 插件管理/详情页图标
```

开发基线（可选，需要 Python 与 `pypdfium2`，不随插件发布）：

```bash
pip install pypdfium2
python scripts/baseline-pdfium.py sample.pdf
```

## 发布

```bash
pnpm release
```

产物：

- `release/LGProofreader-0.1.0.zip`：解压后为 `LGProofreader/` 目录，内容与 `.tgz` 一致；
- `release/LGProofreader-0.1.0.tgz`：npm 兼容安装包，可直接作为 Add plugin 目标；
- `release/SHA256SUMS.txt`：两个产物的 SHA-256。

归档只包含安装所需文件（`package.json`、`cordis.patch.yml`、`icon.png`、`lib/`、`locale/`、`prompts/`、详情页文档、README/CHANGELOG/LICENSE/THIRD_PARTY_NOTICES），**不包含** `src/`、`assets/`、`tests/`、`scripts/`、`node_modules/`、内部设计文档与历史 release。发布与 push 由仓库所有者自行完成。

## 许可

代码采用 MIT 许可证，见 [`LICENSE`](LICENSE)。随 Client bundle 分发的 `pdfjs-dist` 采用 Apache License 2.0，许可文本与第三方声明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。品牌美术资源由 Ling Gao 提供，版权归 Ling Gao；MIT 代码许可不自动覆盖品牌资源，来源与派生说明见**源码仓库**中的 `assets/brand/README.md`（`assets/` 目录不随安装包发布，品牌图仅以内联 data URL 形式进入 `lib/client.js` / `docs/preview.svg`）。


## 验证

- 2026-11-20 完整测试：841 tests；真实浏览器 10/10 样张 ready；UI、取消、错误路径与联网核查进度均通过。脱敏后的测试摘要见 [`docs/testing.md`](docs/testing.md)。
