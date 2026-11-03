import {describe,it,expect} from 'vitest';
import {Workbook} from 'exceljs';
import {knowledgeCaseTemplate,parseKnowledgeCaseFile} from '../src/services/knowledge-case-files';
import {buildKnowledgeCases} from '../src/services/knowledge-case-builder';
import {initialKnowledgeWorkspace,knowledgeCatalog} from '../src/mocks/knowledge-presets';
describe('结构化Excel模板和整批预检',()=>{
  it('下载模板可以读回，三表关联保留多个步骤和明确类型',async()=>{
    const file=await knowledgeCaseTemplate(),parsed=await parseKnowledgeCaseFile(file);
    expect(parsed.issues).toEqual([]);expect(parsed.cases).toHaveLength(1);expect(parsed.cases[0]).toMatchObject({faultType:'HW_FAILURE',objectType:'DEVICE',component:'',symptoms:['供电告警'],steps:[{order:1,text:'按设备规程检查供电和连接状态'},{order:2,text:'完成处理后复核告警与通联结果'}]});
  });
  it('公式及孤立子表定位到行，不取得可应用的预检资格',async()=>{
    const template=await knowledgeCaseTemplate(),book=new Workbook();await book.xlsx.load(template.bytes as never);
    book.getWorksheet('知识条目')!.getCell('G2').value={formula:'"错误原因"',result:'错误原因'};
    book.getWorksheet('故障现象')!.getCell('A2').value='MISSING';
    const parsed=await parseKnowledgeCaseFile({name:'bad.xlsx',bytes:new Uint8Array(await book.xlsx.writeBuffer())});
    expect(parsed.issues).toEqual(expect.arrayContaining([expect.objectContaining({sheet:'知识条目',row:2,field:'原因'}),expect.objectContaining({sheet:'故障现象',row:2,field:'条目标识'})]));
  });
  it('原型属性名称也不是合法工作表，不静默忽略其内容',async()=>{
    const template=await knowledgeCaseTemplate(),book=new Workbook();await book.xlsx.load(template.bytes as never);
    for(const name of ['constructor','toString','__proto__'])book.addWorksheet(name).addRow(['不能忽略的数据']);
    const parsed=await parseKnowledgeCaseFile({name:'extra.xlsx',bytes:new Uint8Array(await book.xlsx.writeBuffer())});
    expect(parsed.issues.filter(issue=>issue.field==='工作表').map(issue=>issue.sheet)).toEqual(['constructor','toString','__proto__']);
  });
  it('跨表预检将业务错误指向原子表行号，不指向主表第二行',async()=>{
    const template=await knowledgeCaseTemplate(),book=new Workbook();await book.xlsx.load(template.bytes as never);
    book.getWorksheet('故障现象')!.getRow(6).values=['CASE-1','供电告警'];
    book.getWorksheet('排故步骤')!.getCell('B3').value=3;
    const parsed=await parseKnowledgeCaseFile({name:'rows.xlsx',bytes:new Uint8Array(await book.xlsx.writeBuffer())});expect(parsed.issues).toEqual([]);
    const result=buildKnowledgeCases(parsed.cases,initialKnowledgeWorkspace().versions.at(-1)!,knowledgeCatalog());
    expect(result.draft).toBeNull();expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({sheet:'故障现象',row:6}),expect.objectContaining({sheet:'排故步骤',row:3})]));
  });
});
