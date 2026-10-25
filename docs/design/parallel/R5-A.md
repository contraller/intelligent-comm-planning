# R5-A 缺失接收带宽资料核查与补充

## 1. 授权和写入范围

2026-10-24 主集成批准本组仅创建以下两个文件，使用 apply_patch、UTF-8 无 BOM：

- `data/supplements/coverage_rx_bandwidth_v1.json`
- `docs/design/parallel/R5-A.md`

本组不改业务代码、原型号 CSV、手册、DEM、旧前端、共享台账、数据库或服务，不提交 Git。现有 R4 脏成果保留。资料以外的项目脚本、新隔离库事务、来源冻结、正常新规划和端到端验证由主集成负责。

早期 exec helper 曾报告日志写入时磁盘空间不足；主确认 login:false 恢复，未要求清理。本组没有删除、复制依赖、下载或解压大文件。

## 2. 四型号精确映射

| model_id | model_name | device_class | 原 bandwidth_khz | 本次构造补充值 |
|---|---|---|---|---|
| DM-0001 | AN/PRC-150(C) | HF | 空字符串 | 3 kHz |
| DM-0002 | RF-7800H-MP | HF | 空字符串 | 3 kHz |
| DM-0003 | RF-5800H-MP | HF | 空字符串 | 3 kHz |
| DM-0008 | FT-891 | HF | 空字符串 | 3 kHz |

`data/raw/equipment_docs/device_model.csv` 与 `data/synthetic/nodes/device_models_v1.csv` 当前字节 SHA256 均为：

`a983a1cb38582e81200c17afc00340a99187ce03f77f79bbdac7f15018b53b1a`

原 `source_doc` 分别为 `PRC-150_用户操作手册.pdf`、`RF-7800H-MP_数据手册.pdf`、`RF-5800H-MP_数据手册.pdf`、`FT891_操作手册.pdf`。它们不是本次构造值的来源标签，主的补充流程应保留原字符串。

## 3. 既有 planner 假设核查

`scripts/devicespec.py` 的 `SpecFiller._median_of` 先读取同 `device_class` 各非空字段的分号首项，转为数值并排序，取 `values[len(values) // 2]`；仅当该频段没有可用值时，`bandwidth` 才使用 `STANDARD_BANDWIDTH_KHZ`。偶数项时采用上中位值，不是两个中间值的平均数。

当前 HF 已知首项按型号顺序为：

- DM-0004：24 kHz。
- DM-0005：0.5 kHz，原字段 `0.5;2.4;2.7;3` 的首项。
- DM-0006：3 kHz。
- DM-0007：2.1 kHz，原字段 `2.1;2.7;3;3.3` 的首项。

排序后 `[0.5, 2.1, 3, 24]` 的上中位值为 3 kHz，因此四个空型号在现有 planner 中的有效带宽均为 3 kHz。`scripts/planning/feasibility.py` 的 `stations_from_nodes` 和 `radio_from_device` 复用该规则；`scripts/planning/actual_search.py` 的 `bandwidth_audit` 将原空值标为同频段推定假设。

已执行只读内存比较：读取原型号表，深拷贝后仅把四个空值设为字符串 `3`，分别调用现有 `SpecFiller.bandwidth` 比较全部 16 型号。结果为 `all_model_effective_bandwidths_equal=true`。没有回写文件、加载 DEM、连接数据库或运行新规划。

核查时 `scripts/devicespec.py` SHA256：

`632f82e87ed10295548e9c725ab0495296aec47a8dbc4b9cff740361286e64c6`

该比较证明当前型号表下的带宽数值一致，不证明新规划拓扑、覆盖结果或现场性能一致。资源补充后既有算法审计可能按单值字段记录 `MODEL_SINGLE_VALUE`；该枚举不能单独作为厂家实参证据，必须同时保留本次构造来源标签。

## 4. 本地原件与厂家来源

早期 `rg --files` 清单未包括被忽略的导入目录，不能据此判断本地没有原件。后续已确认 `data/imported/data_zip_20260911/raw/docs/` 存在相应 PDF；现有 `source/data.zip` 也包含相同资料。本组先从 ZIP 内存读取，再核对已存在原件及哈希，没有新增解压文件。`docs/input/` 的 DOCX 按段落检索未发现四型号名称或“接收带宽”，该检索不涵盖图片 OCR。

### 4.1 DM-0001 / AN/PRC-150(C)

本地原件为 291 页操作手册，出版号 `10515-0103-4100`、`June 2007 Rev. G`。PDF 第 182 页、正文 `4-37` 列出 USB/LSB 的 IF BANDWIDTH 为 2.0、2.4、2.7、3.0 kHz；CW 为 0.35、0.5、1.0、1.5 kHz。下一页菜单图对应正文 `4-38`。

该证据支持 3 kHz 是部分模式的可选 IF 宽度，不证明设备当前设置或实测等效噪声带宽。手册中的跳频频带范围不是本次覆盖接收带宽。

`data/raw/maintenance_docs/docs_index.csv` 对该文件的“仅保修条款”描述与完整 PDF 不符。本组只记录差异，不改索引或原件。

### 4.2 DM-0002 / RF-7800H-MP

本地原 `source_doc` 指向的两页数据手册为 `5/13 DS-488F`。第 1 页 3 至 24 kHz 描述数据传输带宽；第 2 页接收机规格未提供接收滤波宽度或等效噪声带宽。

另有本地 `RF-7800H-MP_产品数据表.pdf`，`07/2019 DS488K` 第 2 页列 `Channel Spacing/Bandwidth`；在线厂家 `10/2022 DS488M` 相应栏目也列 HF 至 24 kHz、VHF 25 kHz。这些不同版本不能合并成设备当前接收设置，也不能把 10 Hz 步进当作接收带宽。

厂家在线来源：[L3Harris RF-7800H-MP DS488M 数据表](https://www.l3harris.com/sites/default/files/2022-10/cs-tcom-rf-7800h-mp-wideband-hf-vhf-tactical-radio-system-datasheet.pdf)。本次仅在线读取，未下载另存。

### 4.3 DM-0003 / RF-5800H-MP

本地两页厂家数据表为 `08/04 DS-211H`。全文及第 2 页接收机规格未提供接收滤波宽度或等效噪声带宽。灵敏度、数据速率、互调测试频率间隔不能换算为本次所需接收带宽；3 kHz 保留为项目既有假设。

### 4.4 DM-0008 / FT-891

本地操作手册副本含第三方封装页，PDF 第 63 页对应正文第 57 页。接收机选择性表按模式及衰减口径列值，SSB/CW 的 -6 dB 条目为 `2.4 kHz or better`；它不是设备当前设置或实测等效噪声带宽。

厂家 `FT-891 CAT Operation Reference Book`，`1909-C`，PDF/正文第 18 页的 SH WIDTH 表明确列出 SSB Wide 的 P3=20 对应 3000 Hz，默认项为 2400 Hz。此证据支持 3 kHz 为可选宽度，不能把默认项或可选项认定为项目设备已配置值。

厂家在线来源：[Yaesu FT-891 CAT 手册](https://yaesu.com/Files/4CB893D7-1018-01AF-FA97E9E9AD48B50C/FT-891_CAT_OM_ENG_1909-C.pdf?ts=3%2F26%2F2026+6%3A44%3A28+PM)。在线高级手册完整读取曾因文件大小超限失败，未将该失败读取作为已核验依据，也未下载大文件。

各本地资料的完整路径、页码、版本及 SHA256 已登记在补充 JSON 的 `source_evidence`，不在本文重复整份原文。

## 5. 资料承载及交接契约

采用主已批准的核心字段：`schema_version=1`、`supplement_id=R5-HF-RX-3KHZ-V1`、`data_origin=SYNTHETIC_COVERAGE_ASSUMPTION`、`unit=kHz`、中文 `notice`、字符串数组 `basis`，以及四条精确 `models`。每条 model 仅包含 `model_id`、`model_name`、`device_class=HF` 和数值 `value_khz=3`。

附加 `base_model_sources`、`planner_basis`、`source_evidence`、`limitations` 保存审核依据。它们不改变主脚本消费的核心模型字段。JSON 不内嵌自身哈希，主应对最终文件字节计算 SHA256 并冻结到新资源。

主拟定的新资源字符串字段保持如下交接口径，本组不执行写库：

- `bandwidth_origin='SYNTHETIC_COVERAGE_ASSUMPTION'`。
- `bandwidth_source_id='R5-HF-RX-3KHZ-V1'`。
- `bandwidth_source_sha256` 为本资料最终字节 SHA256。
- `bandwidth_source_note='构造覆盖接收假设，沿项目既有HF推定3kHz；非厂家实参、非设备生效确认'`。

四个型号的新资源表 `bandwidth_khz` 应按现有快照字符串约束写为 `3`。`source_doc` 保留。新库由主显式调用 `datasets.commit_device_change` 生成新资源版本并正常新规划，不重写旧 Plan、旧选择、旧覆盖缓存或 CSV。

该承载不新增 profile API，也不承诺旧单值来源枚举已经能够独立说明构造属性；主须在结果来源中保留上述明确标签。

## 6. 验证和最终摘要

2026-10-24 实际执行一次不落盘的 Python `-B` 核验，退出码 0，结果 `validation=PASS`：

- 两个交付文件严格 UTF-8 解码通过，均无 BOM。
- JSON 无重复键或非有限数值，核心字段、固定来源标识、单位和中文边界说明通过。
- 四条 model 的字段集合、唯一 ID、精确名称、HF 分类及数值 3 通过；逐项匹配两份原 CSV，四个原带宽仍为空。
- 两份原 CSV、四份本地手册及 planner 源文件的实际 SHA256 均与补充资料登记值一致。
- 再次只读调用现有 SpecFiller 比较全部 16 型号，补充前后的有效带宽全部相等，四个目标型号均为 3 kHz。

资料 JSON 最终字节数：`6910`。

资料 JSON 最终 SHA256：

`2c09234b39e30c968dcd6f7cc4caa229f2b12ba494934ba9b3b0d907f8590ebf`

上述摘要基于实际文件字节，由主脚本消费并再次独立核对。若主后续编辑 JSON，必须重新计算摘要，不沿用本文旧值。本次核验没有新增测试文件或输出证据文件。

本组不执行端到端验证。新隔离库事务、来源标签冻结、正常新规划、覆盖显式选择、缓存及旧版本兼容、真实 HTTP、浏览器展示和耗时验证由主集成执行并登记；当前未将上述事项记为通过。

## 7. 主补充脚本的独立只读审阅

2026-10-24，主授权本组只读复核 `scripts/supplement_coverage_models.py`、`tests/test_coverage_model_supplement.py`，并仅追加本记录。复核范围为独立 CLI 使用下的路径保护、文件及数据库副作用、四型号只补空、来源摘要和重放冲突。结论：无阻塞问题，可按主既定隔离流程继续。

本次再次读取的脚本和测试字节 SHA256 与前次只读内存探针核验时相同：

- `scripts/supplement_coverage_models.py`：`8c2ffcbf7348d7d8f9eb0818e0c822bab59041e032b415991bcff8d1bfe03630`。
- `tests/test_coverage_model_supplement.py`：`a05b1a151d16808b7f5f5e4b0e5a9990e7476539f290493fb9d757ec8bf4f2c6`。

审阅依据：

- 路径入口在脚本第 61 行，CLI 第 128 行先完成检查再设置显式数据库地址并进入资源处理。仅接受本树已存在的 r4/r5 隔离运行目录及同名配套绝对数据库路径；拒绝相对路径、内存库、查询参数和解析后路径变化。脚本没有初始化库、建表、创建目录或文件的操作，不读取隐式默认库地址。
- 第 91 行起先完整检查四型号的精确名称、HF 分类、原带宽空值及无既有带宽来源字段，再统一更新四行。第 101 行仅增加构造带宽及其来源字段，保留 `source_doc`；其他表不在变更回调内。
- 第 26、58 行按资料实际原始字节计算 SHA256；第 114 行起的请求摘要绑定操作、基准版本、资料标识及字节摘要，交由现有 `datasets.commit_device_change` 统一事务处理。该实现先查回执，再查基准版本，并将新版本、当前指针和回执一起提交；旧资源版本不覆写。同请求同身份同摘要重放，身份或摘要不同冲突，旧版本的新请求拒绝。
- 非 object 和重复 JSON 字段保护已在实际源码中；四型号的 ID、名称、类别、数量和数值 3 有严格校验。测试 fixture 已用 `initialize()` 初始化后再由 `current()` 获取基准快照，没有把带 `changed` 的初始化回执当快照。
- 专项测试有旧版本不变、全部表精确差异、来源文件清单不变、重放、操作者冲突、旧版本、新请求不得覆盖已补值，以及最后一个目标型号已有值时整批拒绝的断言。

本组独立执行的证据仅为前次不落盘的 AST 与内存资料探针：实际文件摘要匹配，四型号取值正确，非 object、重复键、BOM、未知型号、重复型号、错名称、错频段、布尔带宽、非有限带宽及越界带宽共 11 项拒绝探针通过。本次只重新核对字节摘要和源码，没有复跑会创建临时库的 pytest，没有调用脚本 CLI、连接运行库或执行浏览器操作。

非阻塞的专项测试补强建议仍保留：同请求号下资料字节改变应返回 1206；合法隔离目录下缺失配套库文件、运行目录与数据库不匹配应被拒绝。它们是补充脚本专项测试的覆盖建议，不是已发现的代码阻塞项；本组未将其他入口测试的通过结果替代为本脚本实跑证据。

主回报“补充及入口专项 45 项通过”、资料 SHA 一致、`.23` 真实 LOCAL 的 23 次请求通过，并正在执行补充前基准的完整 DEM 规划。上述信息在此仅注明为主回报，本组未独立复跑或核验其运行证据；完整 DEM 规划及后续覆盖结论不在本条审阅中提前登记为完成。原失败证据由主保留，本组没有修改或删除。

本次追加后资料 JSON 及两份原 CSV 的实际摘要仍分别与第 6 节及第 2 节一致；没有修改主脚本、专项测试或其他共享文件。
