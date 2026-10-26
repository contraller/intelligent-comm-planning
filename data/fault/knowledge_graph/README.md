# 合成故障知识图谱

`fault_triples_v1.csv` 由仓库现有的 240 条故障案例派生，运行以下命令可重新生成：

```bash
python scripts/diagnosis/build_fault_graph.py
```

当前生成 1062 条三元组。每条记录的 `source_doc` 指向 `fault_cases_v1.csv#FC-xxxx [CONSTRUCTED]`，可追到生成依据，但该依据仍是合成测试案例，不是现场设备记录或经核验的维修手册。三元组数量也不代表 1062 条独立验证的故障知识。

图谱用于 SR-5 接口联调与功能演示。实际故障诊断的准确率、置信度校准和处置安全性须用独立的真实案例验证。
