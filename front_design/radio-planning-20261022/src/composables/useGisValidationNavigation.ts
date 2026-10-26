import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useResourceReadStore } from '../stores/resource-read';
import { useResourceEditStore } from '../stores/resource-edit';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { gisResourceTarget, type GisResourceTarget, type GisValidationIssue } from '../services/gis-validation';

interface Navigation {
  showResource: (target: GisResourceTarget) => void;
}

export function useGisValidationNavigation(navigation: Navigation) {
  const auth=useAuthStore(),preview=useResourceReadStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore();
  const notice=ref(''); let serial=0,epoch=0;
  onBeforeUnmount(()=>{serial++;});
  const disabled=computed(()=>!auth.can('situation.view')||editor.busy||gis.busy||editor.importOpen);
  const context=()=>JSON.stringify([auth.generation,auth.can('situation.view'),editor.context,preview.workspace?.revision,
    gis.scene?.situation.snapshotId,gis.mapMode]);
  watch(context,()=>{epoch++;notice.value='';},{flush:'sync'});
  watch(()=>gis.validationIssues,()=>{notice.value='';});
  function reason(issue:GisValidationIssue) {
    if(issue.source==='resource') {
      if(editor.context!=='gis'||!editor.canEdit)return '当前不可编辑此资源';
      return gisResourceTarget(issue,editor.resources,editor.form)?'':'对象不存在或身份不明确，无法定位';
    }
    return '任务输入请在网络规划页面检查';
  }
  async function locate(issue:GisValidationIssue) {
    // 清单旧按钮、离页回调和另一次定位均不能采纳到新的上下文。
    if(disabled.value||!gis.validationIssues.includes(issue))return;
    notice.value=reason(issue);if(notice.value)return;
    const token=++serial,version=epoch;
    const current=()=>token===serial&&version===epoch&&!disabled.value&&!reason(issue);
    if(issue.source==='resource') {
      const target=gisResourceTarget(issue,editor.resources,editor.form)!;
      if(!(await editor.focusGisIssue(target.kind,target.id,target.field,current))||!current())return;
      const fresh=gisResourceTarget(issue,editor.resources,editor.form);
      if(!fresh)return;
      navigation.showResource(fresh);
      notice.value=!Object.hasOwn(editor.form!.fields,fresh.field)?'已打开对象表单，此字段没有可编辑控件。'
        :!fresh.coordinate?'已定位字段；当前没有有效坐标，未移动地图。':'';
    }
  }
  return {notice,disabled,reason,locate};
}
