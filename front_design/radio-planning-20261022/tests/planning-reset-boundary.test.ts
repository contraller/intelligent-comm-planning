import { readFileSync } from 'node:fs';
import { compileScript,compileTemplate,parse } from 'vue/compiler-sfc';
import { describe,expect,it } from 'vitest';
const filename='src/views/PlanningApiView.vue';
const source=readFileSync(new URL('../'+filename,import.meta.url),'utf8');
describe('正式HTTP规划页重置边界',()=>{
  it('无安全草稿契约时明确禁用，不调用旧后台历史清空命令',()=>{
    const button=source.match(/<button\s+v-if="auth\.can\('planning\.reset'\)"[\s\S]*?<\/button/)?.[0];
    expect(button).toBeDefined();expect(button).toMatch(/\sdisabled\s/);
    expect(button).toContain('重置规划草稿不可用，后台历史保留');
    expect(button).toContain('后台任务、作业、方案与回执历史均保留');expect(button).not.toContain('@click');
    expect(source).not.toContain('@click="planning.reset"');
  });
  it('保留现有任务编辑入口并通过真实SFC编译，不新增删除契约',()=>{
    const descriptor=parse(source,{filename}).descriptor;
    const script=compileScript(descriptor,{id:filename});
    const template=compileTemplate({source:descriptor.template!.content,filename,id:filename,compilerOptions:{bindingMetadata:script.bindings}});
    expect(template.errors).toEqual([]);expect(source).toContain('<TaskApiPanel');
    expect(source).not.toContain('resetPlanningData(');expect(source).not.toContain('DELETE');
  });
});
