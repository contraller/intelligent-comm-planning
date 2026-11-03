import { describe, expect, it } from 'vitest';
import { Workbook } from 'exceljs';
import { buildKnowledgeCases } from '../src/services/knowledge-case-builder';
import {
  knowledgeCaseTemplate,
  parseKnowledgeCaseFile,
} from '../src/services/knowledge-case-files';
import { initialKnowledgeWorkspace, knowledgeCatalog } from '../src/mocks/knowledge-presets';
import { applyKnowledgeDraft, validateKnowledgeDraft } from '../src/services/knowledge-validation';
import { KNOWLEDGE_MAX_OPERATIONS } from '../src/config/demo';
import type { KnowledgeCaseInput } from '../src/types/knowledge-case';

const base = () => initialKnowledgeWorkspace().versions[1];
const input = (): KnowledgeCaseInput => ({
  caseId: 'FC-INPUT-01',
  title: '离线构建验证案例',
  faultType: 'HW_FAILURE',
  objectType: 'DEVICE',
  deviceClass: 'HF',
  cause: '供电连接松动',
  component: '供电接头',
  solution: '按核准规程恢复连接并复测',
  source: '本地受控维修规程，测试条目',
  symptoms: ['供电告警'],
  steps: [
    { order: 1, text: '记录告警并按规程检查供电连接' },
    { order: 2, text: '复核告警与通联状态' },
  ],
});
let count = 0;
const ids = () => String(++count);

describe('结构化故障知识构建', () => {
  it('五类明确输入生成完整关系，草稿发布前不修改已发布基线', () => {
    const source = base(),
      before = JSON.stringify(source),
      preview = buildKnowledgeCases([input()], source, knowledgeCatalog(), ids);
    expect(preview.issues).toEqual([]);
    expect(preview.draft).not.toBeNull();
    const draft = preview.draft!;
    validateKnowledgeDraft(source, draft);
    for (const type of [
      'Fault',
      'Case',
      'FaultType',
      'ObjectType',
      'Symptom',
      'Cause',
      'Component',
      'DiagnosisStep',
      'Solution',
    ])
      expect(draft.entities.some((e) => e.type === type)).toBe(true);
    expect(new Set(draft.relations.map((r) => r.type))).toEqual(
      new Set([
        'recordedIn',
        'instanceOf',
        'occursOn',
        'hasSymptom',
        'causedBy',
        'locatedAt',
        'resolvedBy',
        'diagnosedBy',
        'constrainedBy',
      ]),
    );
    expect(draft.entities.filter((e) => e.type === 'DiagnosisStep').map((e) => e.name)).toEqual([
      '01:记录告警并按规程检查供电连接',
      '02:复核告警与通联状态',
    ]);
    expect(JSON.stringify(source)).toBe(before);
    expect(draft.entities.length + draft.relations.length).toBeLessThanOrEqual(
      KNOWLEDGE_MAX_OPERATIONS,
    );
  });
  it('相同已发布案例全部复用，重复导入不产生新变更', () => {
    const source = base(),
      first = buildKnowledgeCases([input()], source, knowledgeCatalog(), ids).draft!;
    const published = { ...source, ...applyKnowledgeDraft(source, first) };
    const again = buildKnowledgeCases([input()], published, knowledgeCatalog(), ids);
    expect(again.draft).toBeNull();
    expect(again.entityCount).toBe(0);
    expect(again.relationCount).toBe(0);
    expect(again.issues[0].message).toContain('全部内容已存在');
  });
  it.each(['cause', 'solution', 'component', 'faultType'] as const)(
    '已有案例的 %s 不同须显式修改，导入不拼接互斥结论',
    (field) => {
      const source = base(),
        first = buildKnowledgeCases([input()], source, knowledgeCatalog(), ids).draft!;
      const published = { ...source, ...applyKnowledgeDraft(source, first) },
        changed = input();
      changed[field] = field === 'faultType' ? 'SW_CONFIG' : '另一条知识';
      expect(buildKnowledgeCases([changed], published, knowledgeCatalog(), ids).draft).toBeNull();
    },
  );
  it('步骤不连续、重复现象、无来源及超限整批拒绝', () => {
    const bad = input();
    bad.steps[1].order = 4;
    bad.symptoms.push(bad.symptoms[0]);
    bad.source = '';
    const rejected = buildKnowledgeCases([bad], base(), knowledgeCatalog(), ids);
    expect(rejected.draft).toBeNull();
    expect(rejected.issues.length).toBeGreaterThanOrEqual(3);
    const many = Array.from({ length: 6 }, (_, i) => ({
      ...input(),
      caseId: 'FC-BATCH-' + i,
      cause: '原因' + i,
      solution: '方案' + i,
    }));
    expect(
      buildKnowledgeCases(many, base(), knowledgeCatalog(), ids).issues.some(
        (i) => i.field === '容量',
      ),
    ).toBe(true);
  });
  it('未知部件允许留空，缺少现象/步骤时不能生成草稿', () => {
    const value = input();
    value.component = '';
    expect(buildKnowledgeCases([value], base(), knowledgeCatalog(), ids).draft).not.toBeNull();
    value.symptoms = [];
    value.steps = [];
    expect(buildKnowledgeCases([value], base(), knowledgeCatalog(), ids).draft).toBeNull();
  });
  it.each(['title', 'deviceClass', 'component'] as const)(
    '已有案例的%s变更或清空不会被静默忽略',
    (field) => {
      const source = base(),
        first = buildKnowledgeCases([input()], source, knowledgeCatalog(), ids).draft!;
      const published = { ...source, ...applyKnowledgeDraft(source, first) },
        changed = input(),
        before = JSON.stringify(published);
      if (field === 'title') changed.title = '另一标题';
      else changed[field] = '';
      const result = buildKnowledgeCases([changed], published, knowledgeCatalog(), ids);
      expect(result.draft).toBeNull();
      expect(
        result.issues.some(
          (i) =>
            i.field ===
            { title: '案例标题', deviceClass: '设备类别', component: '故障部件' }[field],
        ),
      ).toBe(true);
      expect(JSON.stringify(published)).toBe(before);
    },
  );
});

describe('离线Excel导入预检', () => {
  it('模板往返保留现象和有序步骤，沿同一构建校验产生草稿', async () => {
    const file = await knowledgeCaseTemplate(),
      parsed = await parseKnowledgeCaseFile(file);
    expect(parsed.issues).toEqual([]);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0].steps.map((s) => s.order)).toEqual([1, 2]);
    expect(buildKnowledgeCases(parsed.cases, base(), knowledgeCatalog(), ids).draft).not.toBeNull();
  });
  it('公式、孤立关联、隐藏业务表明确返回工作表行字段错误', async () => {
    const template = await knowledgeCaseTemplate(),
      book = new Workbook();
    await book.xlsx.load(template.bytes as never);
    book.getWorksheet('知识条目')!.getCell('G2').value = { formula: '1+1', result: 2 };
    book.getWorksheet('故障现象')!.getCell('A2').value = '不存在的条目';
    book.getWorksheet('排故步骤')!.state = 'hidden';
    const parsed = await parseKnowledgeCaseFile({
      name: '预检.xlsx',
      bytes: new Uint8Array(await book.xlsx.writeBuffer()),
    });
    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheet: '知识条目', row: 2, field: '原因' }),
        expect.objectContaining({ sheet: '故障现象', row: 2, field: '条目标识' }),
        expect.objectContaining({ sheet: '排故步骤', field: '工作表' }),
      ]),
    );
  });
  it('错误文件类型和超出5MiB文件在解析前拒绝', async () => {
    await expect(
      parseKnowledgeCaseFile({ name: '资料.csv', bytes: new Uint8Array() }),
    ).rejects.toThrow('.xlsx');
    await expect(
      parseKnowledgeCaseFile({ name: '资料.xlsx', bytes: new Uint8Array(5 * 1024 * 1024 + 1) }),
    ).rejects.toThrow('5 MiB');
  });
});
