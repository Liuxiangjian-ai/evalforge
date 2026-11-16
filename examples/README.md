# 真实生成的示例产物

这些文件来自本机一次**真实**的端到端运行，不是手写样例：

| 文件 | 内容 |
| --- | --- |
| `benchmark.jsonl` | 12 道题（6 主要终点 + 6 纳排标准），含 GT、证据链、QC、干扰项来源 |
| `eval_results.csv` | 24 个评测单元（2 个真实模型）的逐条结果 |
| `meta_eval_report.md` | 该次运行生成的 Markdown 报告 |

## 运行上下文

- 数据源：ClinicalTrials.gov API v2，条件 `Type 2 Diabetes`，`PHASE2/PHASE3`，`INTERVENTIONAL`
- 语料：40 条真实注册记录（抓取 2026-11-14）
- 题库：`EvalForge Type 2 Diabetes v0.1`，seed 42，每任务 6 题，全部 `valid`，ID `MED-000050 … MED-000061`
- 模型：Harness 原生 Provider `deepseek-account` 提供的两个模型
- 运行：`run-20261116140420-yydlyz`，prompt `evalforge-mcq-v2`，temperature 0.2，8192 max tokens
- 结果：V4.1-Flash 75.0%（n=12，0 失败），V4-Pro 72.7%（n=11，1 次超时）

## 重新生成

```powershell
cd dsh-plugin-evalforge
npm run e2e -- --condition "Type 2 Diabetes" --fetch 40 --per-task 6
```

该脚本只做「抓取 + 生成」，不调用模型；模型评测需要插件在 Harness 内运行（因为要复用已配置的 Provider 与凭据）。

## 注意

- 题目是历史注册实践的对照，不代表医学最优方案
- 样本只有 12 题，模型排名不稳定；请以报告中的 `n` 为准
- 完整体验记录（含失败迭代）见 [`../docs/validation.md`](../docs/validation.md)
