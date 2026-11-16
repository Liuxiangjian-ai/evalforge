# EvalForge

**面向医学 AI 评测的 Benchmark Factory + Eval Harness**，以 DeepSeek Harness 插件形式运行。

它从 [ClinicalTrials.gov API v2](https://clinicaltrials.gov/data-api/api) 抓取真实临床试验注册记录，按规则抽取 Ground Truth，自动生成可追溯的四选一医学评测题，随后在 Harness 内完成多模型批量评测、自动评分、Meta-Eval 与报告导出。**Ground Truth 永远先来自注册字段，模型不参与答案生成。**

> 方法学参考：*Benchmarking and developing large language models using one million clinical trials*, npj Digital Medicine (2026), DOI [10.1038/s41746-026-02933-7](https://doi.org/10.1038/s41746-026-02933-7)（TrialPanorama）。本项目只借鉴其“从注册数据构造任务、同族试验取干扰项、留出最新试验避免泄漏”的思路，题库由本插件实时生成，**未复制论文或任何现成题库**。

---

## 1. 它解决什么问题

| 痛点 | 本插件的做法 |
| --- | --- |
| 医学题库来源不可核验 | 每题保存 NCT ID、字段路径、原文、记录版本、抓取时间，可一键回到注册页面 |
| 题目可能没有唯一答案 | 生成时做概念/数字双重近重复检测，QC 再做一次唯一性校验 |
| 用 LLM 生成题目导致 GT 幻觉 | GT 只来自注册字段；LLM 不参与出题，只在评测时当被测对象 |
| 评测脚本与模型配置割裂 | 直接复用 Harness 已配置的 Provider 与凭据，无需二次填 Key |
| 只看总分，不知道题目好坏 | Meta-Eval 给出难度、区分度、稳定性、高争议题与失败率 |

## 2. 功能一览

### 已实现（v0.1）

**数据采集**
- ClinicalTrials.gov API v2：疾病关键词、Phase、研究类型、试验状态、最大条数
- 分页（`pageToken`）、限流退避、429/5xx 重试、`Retry-After` 支持
- 字段归一化 + 原始 JSON 保留 + 缺失字段标记 + NCT 去重 + 版本更新
- 列表 / 详情 / 官方页面跳转 / 勾选记录 / 本地持久化

**题库生成与质控**
- `endpoint_selection`：主要终点匹配（同疾病、同阶段干扰项）
- `eligibility_criteria_matching`：纳排标准匹配（保持 inclusion/exclusion 极性）
- `trial_completion_prediction`：完成预测（**实验性**，默认关闭，永不进入正式评测）
- 六条确定性 QC 规则 → `valid` / `needs_review` / `invalid`
- 题目预览、编辑、删除、去重键、JSONL 导出

**评测**
- 统一模型接口：Harness 原生 `ctx.llm`（复用已配置 Provider）+ 任意 OpenAI 兼容端点
- 多模型（上限 8）、并发、重试、超时、中断、恢复、进度、原始响应保存
- Exact Match 评分；API 失败与不可解析回复**不计为答错**，单独统计
- 选项顺序按重复轮次打乱，评分时映射回规范答案

**Meta-Eval 与报告**
- 模型/任务准确率、Macro-F1、难度、区分度（声明分组=正式，否则=探索性）、单调性、重复采样稳定性
- 高争议题目、失败统计
- `benchmark.jsonl` / `eval_results.csv` / `eval_results.json` / `meta_eval_report.md`

**工程质量**
- 70 个自动化测试（解析、GT 抽取、去重、QC、评分、运行器、指标、导出）
- 真实网络 + 真实模型的端到端自测（`selfTest` 配置，可在 CI 无界面运行）
- API Key 只进 Harness 凭据存储；日志与导出统一脱敏

### 未实现（明确标记）

- 具备时间证据的 Completion Prediction（缺历史快照 API）
- LLM-as-a-Judge 实际打分（仅预留数据结构与接口）
- 专家盲评、Judge 校准、Judge 偏差检测
- 多数据库接入（PubMed / WHO ICTRP 等）
- 开放式临床方案设计题

## 3. 架构

```text
浏览器（React slot 页面，无构建步骤）
   │  fetch  /api/evalforge/*   （同源、带会话凭据）
   ▼
Host 插件（cordis apply）
   ├── api.js        路由注册与错误映射
   ├── engine.js     编排：采集 / 生成 / 运行 / 导出
   ├── ctgov.js      注册库客户端（重试、分页、归一化、溯源）
   ├── criteria.js   纳排文本切分、可验证性打分、数字变异
   ├── benchmark.js  三类题目生成 + 唯一答案约束 + 去重
   ├── qc.js         六条确定性质量规则
   ├── llm.js        原生 ctx.llm / OpenAI 兼容适配，凭据解析
   ├── runner.js     并发执行、重试、取消、恢复、逐单元持久化
   ├── metrics.js    Meta-Eval
   ├── report.js     JSONL / CSV / JSON / Markdown
   ├── store.js      本地 JSON 持久化（原子写）
   └── selftest.js   无界面端到端自测
```

数据根目录：`$DSH_HOME/evalforge`（可用环境变量 `EVALFORGE_DATA_DIR` 覆盖）。包含 `corpus.json`、`config.json`、`benchmarks/`、`runs/`、`exports/`。

## 4. 安装

### 方式 A：插件管理页面（推荐）

1. 打开 Harness → **插件** → **添加插件**
2. 选择本目录 `dsh-plugin-evalforge`（本地 bundle）
3. 启用后侧边栏出现 **EvalForge**

### 方式 B：脚本安装到当前 profile

```powershell
# 在仓库根目录执行；会把 link 依赖写入 profile 并安装
pwsh -File .\dsh-plugin-evalforge\scripts\install.ps1 -Profile desktop
```

脚本做三件事：写入 `dependencies`（`link:` 指向本目录）、把 `dsh-plugin-evalforge` 加入 `dsh.profile.bundles`、执行 `pnpm install`。安装后重启 Harness 生效。

> 也可以手动完成等价操作；`cordis.patch.yml` 已包含插件行，安装时不需要再写 patch。

## 5. 使用流程

1. **数据采集**：填疾病关键词（如 `Type 2 Diabetes`）、勾选 Phase 与研究类型、设置最大条数 → *开始抓取*
2. **题库构建**：选择任务类型与每任务题数 → *生成题库*；左侧检查题目、GT、证据与 QC，必要时编辑
3. **模型评测**：选题库 → 勾选模型（原生 Provider 自动列出）→ 设 Temperature / Max tokens / 并发 / 重试 / 重复次数 → *开始评测*
4. **Meta-Eval**：查看模型排名、任务维度、难度分布、区分度、高争议题、失败统计
5. **报告导出**：下载四个产物文件

> 提示：推理型模型的输出预算要给足（默认 8192）。预算耗尽时插件会把“思考中已明确给出的唯一选项”标记为 `derived_from_reasoning` 恢复，仍无法判定时按失败统计，而不是判错。

## 6. 模型接入

**原生 Provider（默认）**：插件读取 Harness 的 `ctx.llm` 目录，列出当前 profile 已配置的 Provider 与模型，直接调用，无需任何 Key 输入。

**OpenAI 兼容端点**：可添加自定义 `Base URL + Model ID + 凭据引用名`。Key 通过插件写入 Harness 凭据存储（引用名必须以 `EVALFORGE_` 开头），**不写入配置、日志或报告**。

## 7. 评分与 Meta-Eval 细节

- **Exact Match**：只认选项标签；选项顺序可打乱，评分前用 `option_map` 还原
- **失败口径**：`error` / `parse_failed` 不计入准确率分母，单独报告失败率
- **难度**：先按模型求正确率，再对模型平均，避免重复次数不均衡
- **区分度**：只有运行前声明 `capability_groups` 才视为正式指标；否则用本次整体准确率切分，明确标注为**探索性**
- **稳定性**：`repeats > 1` 时给出模态一致率、逐次正确率波动、选项顺序效应

详见 [docs/benchmark-format.md](docs/benchmark-format.md)。

## 8. 测试与验证

```powershell
npm test          # 70 个单元/集成测试（无需网络）
npm run check     # manifest / 导入 / 客户端 bundle 静态检查
npm run e2e       # 真实 ClinicalTrials.gov 抓取 + 生成（不调用模型）
```

仓库零运行时依赖（`dependencies` 为空），只需 Node 22+。CI 在 Node 22 与 24 上运行同一套检查（见 [.github/workflows/ci.yml](.github/workflows/ci.yml)）。

端到端验证记录见 [docs/validation.md](docs/validation.md)，真实生成的示例产物在 [examples/](examples/)。

## 9. 已知限制

- **注册终点≠医学最优答案**：GT 是历史注册实践，题目评测的是“与注册方案的一致性”
- **Completion Prediction 为实验性**：ClinicalTrials.gov v2 无历史快照接口，无法保证结局前版本；该类题目永不进入正式评测
- **干扰项可能来自合成**：纳排题在同极性真实条目不足时会做数字变异，并置 `synthetic_distractors` 标记、降级为 `needs_review`
- **样本量小**：小样本准确率不稳定，所有表格均给出 `n`；区分度在 ≤2 个模型时无意义
- **推理模型截断**：长选项题目可能耗尽输出预算，计入失败率
- **中英文混排**：注册文本为英文，UI 为中文；题干保持英文原文以避免翻译引入歧义

## 10. 后续路线

1. **时间证据**：接入注册历史快照（或按首次提交日期构建时间切分），让完成预测成为可用的前瞻任务
2. **LLM-as-a-Judge**：实现 rubric 打分、Judge 模型选择、与专家标注的一致性
3. **专家复核工作流**：盲评、复核队列、复核一致性统计
4. **题目增强**：真实同族试验配对（Cochrane 综述），替换数字变异干扰项
5. **更多数据源**：PubMed / WHO ICTRP / ChiCTR
6. **难度自适应采样**：基于历史难度做题目配比

## 11. 目录

```text
dsh-plugin-evalforge/
├── index.js               # Host 入口（导出 apply）
├── client.js              # 浏览器 bundle（window.__ModuleLoader__）
├── cordis.patch.yml       # bundle patch
├── package.json
├── icon.svg
├── LICENSE / CHANGELOG.md / .gitignore
├── .github/workflows/ci.yml
├── locale/{en,zh}.json
├── src/host/              # 后端模块
├── src/shared/            # 常量与文本工具
├── tests/                 # 70 个测试 + 真实记录 fixture
├── scripts/               # check / e2e / fixtures / install
├── examples/              # 真实运行产物（题库 / CSV / 报告）
└── docs/                  # 数据契约、验证记录、截图
```

## 12. 免责声明

本项目用于**模型评测与方法学研究**，不构成临床决策依据。所有题目源自公开注册信息，可能包含注册方自身的表述错误；用于任何真实临床场景前必须经过专家复核。

## 13. 许可证

[MIT](LICENSE)。`examples/` 中的题目派生自 ClinicalTrials.gov 公开注册记录（美国国家医学图书馆），使用须遵守其数据条款；本仓库仅以带 NCT 号与来源链接的形式少量引用。
