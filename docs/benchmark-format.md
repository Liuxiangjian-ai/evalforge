# EvalForge → 数据结构与评分协议

本文件定义 v0.1 的公开数据契约。导出文件、UI 与测试都以这里的字段为准。

## 1. 试验记录（Trial Record）

由 `src/host/ctgov.js` 从 ClinicalTrials.gov API v2 的原始 study 归一化而来；原始 JSON 完整保留在 `raw`。

| 字段 | 说明 |
| --- | --- |
| `nct_id` | 注册号，`^NCT\d{8}$` 校验，不合规的记录直接丢弃 |
| `brief_title` / `official_title` | 标题 |
| `brief_summary` / `detailed_description` | 摘要 |
| `conditions[]` | 疾病/适应症 |
| `phase` / `phases[]` | 阶段（`NA` 表示不适用） |
| `study_type` | `INTERVENTIONAL` / `OBSERVATIONAL` / `EXPANDED_ACCESS` |
| `design_info` | allocation / intervention_model / masking / primary_purpose |
| `interventions[]` | `{type,name,description,other_names,arm_group_labels}` |
| `arm_groups[]` | `{label,type,description,intervention_names}` |
| `eligibility_criteria` | 归一化的纳排文本（换行保留在 `raw` 中） |
| `eligibility_fields` | sex / min/max age / healthy_volunteers / std_ages |
| `primary_outcomes[]` | `{measure,description,time_frame}` |
| `secondary_outcomes[]` | 同上 |
| `enrollment` | `{count,type}` |
| `overall_status` / `why_stopped` / `has_results` | 结局相关字段（完成预测任务会排除） |
| `study_dates` | start / primary_completion / completion / first_posted / last_update_posted / status_verified |
| `record_version` | `lastUpdatePost > statusVerified > firstPost` 拼接，用于证据版本追溯 |
| `source` | `{registry, api_url, source_url, fetched_at, query, raw_complete}` |
| `missing_fields[]` | 缺失字段清单（不补零、不臆造） |
| `raw` | 原始 API JSON |

去重：同一 `nct_id` 只保留一份；遇到更新的 `record_version` 时替换内容但保留最早 `fetched_at`。

## 2. Benchmark 题目（Item）

```json
{
  "id": "MED-000001",
  "task_type": "endpoint_selection",
  "query": "完整题干（含试验背景与提问句）",
  "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
  "ground_truth": {
    "answer": "B",
    "type": "registry_reference",
    "source_field": "primaryOutcomes",
    "field_path": "protocolSection.outcomesModule.primaryOutcomes",
    "value": "注册字段原文",
    "note": "Registered reference, not a claim of medical optimality."
  },
  "rubric": { "type": "exact_match", "max_score": 1 },
  "evidence": {
    "nct_id": "NCT06297603",
    "registry": "ClinicalTrials.gov",
    "source_url": "https://clinicaltrials.gov/study/NCT06297603",
    "api_url": "https://clinicaltrials.gov/api/v2/studies/NCT06297603",
    "record_version": "2026-11-12|2026-01-22|2003-07-31",
    "last_update_posted": "2026-11-12",
    "fetched_at": "2026-11-14T12:44:17.944Z",
    "source_field": "primaryOutcomes",
    "field_path": "protocolSection.outcomesModule.primaryOutcomes",
    "original_text": "与正确选项逐字一致的注册文本"
  },
  "quality": {
    "source_verified": true,
    "unique_answer": true,
    "expert_reviewed": false,
    "temporal_validation_required": false,
    "experimental": false,
    "status": "valid",
    "checks": [ { "rule": "gt_traceability", "status": "pass", "detail": "..." } ],
    "llm_review": { "status": "not_run", "note": "..." }
  },
  "distractor_sources": [
    { "nct_id": "NCT05936151", "kind": "registry_outcome", "condition_overlap": 0.4 }
  ],
  "context": { "condition": "...", "phase": "PHASE3", "study_type": "INTERVENTIONAL" },
  "dedupe_key": "sha256(task_type|nct_id|normalized_ground_truth)",
  "generated_at": "2026-11-14T13:05:38.819Z",
  "prompt_version": "evalforge-mcq-v2"
}
```

### 2.1 三种任务

| task_type | GT 来源 | 选项构造 | 备注 |
| --- | --- | --- | --- |
| `endpoint_selection` | `protocolSection.outcomesModule.primaryOutcomes` | 其它试验的主要终点（优先同疾病、同阶段、长度相近、使用次数少） | 排除同概念不同时间点的干扰项，避免"多个都算对" |
| `eligibility_criteria_matching` | `protocolSection.eligibilityModule.eligibilityCriteria` 中的一条 | 同极性（inclusion/exclusion）纳排条目；不足 3 条时使用**有记录的数字变异**作为干扰项，并置 `quality.synthetic_distractors=true` | 不生成虚构患者病历 |
| `trial_completion_prediction` | `protocolSection.statusModule.overallStatus` | 二分选项（completed / early stop） | 实验性：题干排除状态、终止原因、完成日期、结果、实际入组；始终 `temporal_validation_required=true`，不进入正式评测 |

### 2.2 唯一答案规则

生成时保证：

1. 正确选项逐字来自注册字段（`evidence.original_text` 与选项完全一致）。
2. 干扰项与正确答案、干扰项之间不得"近重复"：同时比较概念词集合与数字阈值，`isNearDuplicateOption()` 定义阈值。
3. 终点任务额外做"同测量家族"检查（例如 `HbA1c` 与 `glycated haemoglobin` 归一为同一概念），避免时间点不同的同族终点并存。
4. 长度比控制在 0.6–1.6，降低"最长选项即答案"的捷径。

## 3. 质量检查（QC）

六条确定性规则，全部记录在 `quality.checks`：

| 规则 | 判定 | 失败示例 |
| --- | --- | --- |
| `gt_traceability` | `evidence.original_text` 必须逐字出现在对应注册字段中 | 证据文本不在原始字段 |
| `answer_uniqueness` | 选项数量正确、GT 恰有一个匹配项、选项两两相似度 < 0.8 | 两个选项语义相同 |
| `question_completeness` | 题干 ≥ 80 字符、无占位符、以问号结尾 | 题干残留 `{disease}` |
| `option_validity` | 每个选项 12–420 字符、无 `all of the above`、无重复 | 选项重复 |
| `data_leakage` | 题干与答案 3-gram 包含率 < 0.5；完成预测题不得含状态词 | 题干粘进答案原文 |
| `evidence_consistency` | 选项与证据文本（归一化后）完全一致；完成预测按状态映射校验 | 选项被改写 |

聚合规则：

- 任意 `fail` → `invalid`（默认不进入评测，除非显式 `include_invalid`）。
- 任意 `warn` → `needs_review`。
- 全部 `pass` → `valid`。
- 证据不足的实验性题（`temporal_validation_required`）强制降级为 `needs_review`，永不进入正式评测。

LLM 辅助审查字段 `quality.llm_review` 预留，v0.1 恒为 `not_run`，且与确定性检查分开记录。

## 4. 运行配置（Run）

```json
{
  "id": "run-20261114133203-n18g0g",
  "status": "queued|running|completed|completed_with_errors|cancelled|failed",
  "benchmark_id": "...",
  "benchmark_hash": "sha256(...)",
  "prompt_version": "evalforge-mcq-v2",
  "models": [ { "id": "native-1", "kind": "native", "provider": "deepseek-account", "model": "deepseek-flash" } ],
  "settings": {
    "temperature": 0.2,
    "maxTokens": 8192,
    "concurrency": 3,
    "retries": 1,
    "timeoutMs": 180000,
    "repeats": 1,
    "shuffle_options": false,
    "include_needs_review": false,
    "include_invalid": false,
    "include_experimental": false
  },
  "items": [ "运行时的题目快照（与题库解耦，保证复现）" ],
  "results": [ "cell" ],
  "progress": { "total": 24, "done": 24, "success": 21, "parse_failed": 0, "error": 3, "percent": 100 }
}
```

### 4.1 单元（Cell）

```json
{
  "cell_key": "MED-000001|native-1|0",
  "item_id": "MED-000001",
  "model_id": "native-1",
  "model_label": "deepseek-account · DeepSeek-V4.1-Flash",
  "repeat": 0,
  "status": "success | parse_failed | error",
  "response_text": "模型原始输出（截断至 8000 字符）",
  "parsed_answer": "B",
  "canonical_answer": "B",
  "ground_truth": "B",
  "correct": true,
  "option_map": { "A": "C", "B": "A", "C": "B", "D": "D" },
  "display_order": ["C", "A", "B", "D"],
  "derived_from_reasoning": false,
  "latency_ms": 1234,
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "finish_reason": "stop",
  "attempts": 1,
  "error": null
}
```

评分：`canonical = option_map[parsed] ?? parsed`，`correct = canonical === ground_truth.answer`。

**失败处理**：`status=error`（API/超时/额度/空输出）与 `status=parse_failed`（无法解析出唯一选项）都不计入准确率分母，分别统计为“失败率”和“未解析率”。

**推理截断恢复**：当输出预算耗尽但思维链末尾已出现唯一选项时，记为 `success` 并置 `derived_from_reasoning=true`，CSV 单列标注，Meta-Eval 汇总计数。这样既不丢真实作答，也不伪装成正常回答。

## 5. Meta-Eval 指标

| 指标 | 定义 | 注意事项 |
| --- | --- | --- |
| 准确率 | `correct / scored` | `scored` 不含失败与未解析 |
| Macro-F1 | 以选项标签为类别，宏平均 | 题目选项均匀随机，F1 ≈ Accuracy 属正常 |
| 难度 | 先算每个模型的正确率，再对模型取平均，`difficulty = 1 − p_correct` | 重复采样不均衡不会放大偏差；同时报告 `n_models`、`n_cells` |
| 区分度 | `P(high) − P(low)` | 只有运行前声明 `capability_groups` 才标为 `declared`（正式）；否则用本次整体准确率切分，标为 `exploratory`（描述性），不得当作能力结论 |
| 单调性 | 声明 `version_order` 后计算 Spearman ρ | 明确标注“版本顺序不代表医学能力递增” |
| 稳定性 | 重复采样的模态一致率、逐次正确率波动、选项顺序效应 | 需要 `repeats > 1`；同时记录每种选项排列的准确率 |
| 高争议题 | `0 < p_correct < 1` 且最接近 0.5 | 附带样本数，避免小样本误读 |

所有表格都带 `n`；样本不足时显示 `—` 而不是排名。

## 6. 导出文件

| 文件 | 内容 |
| --- | --- |
| `benchmark.jsonl` | 每题一行，含 GT、证据链、QC、干扰项来源 |
| `eval_results.csv` | 每 cell 一行：run_id、question_id、task_type、model、response、parsed、canonical、GT、correct、derived_from_reasoning、latency、tokens、status、error |
| `eval_results.json` | 完整 run 对象 + meta 分析 |
| `meta_eval_report.md` | 人类可读报告：来源、方法、构成、模型、评分、难度、区分度/稳定性、失败、局限、可复现性 |

导出内容不含任何 API Key；日志与错误消息在写盘前统一经过 `redactSecrets()`。
