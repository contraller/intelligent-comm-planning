import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useAuthStore } from '../stores/auth';
import { usePreviewStore } from '../stores/preview';
import { useResourceEditStore } from '../stores/resource-edit';
import { useGisWorkspaceStore } from '../stores/gis-workspace';
import { usePlanningStore } from '../stores/planning';
import { gisResourceTarget, gisTaskTarget, type GisResourceTarget, type GisValidationIssue } from '../services/gis-validation';

interface Navigation {
  showResource: (target: GisResourceTarget) => void;
  showTask: () => void;
  taskReason: (issue: GisValidationIssue) => string;
  focusTask: (issue: GisValidationIssue) => Promise<boolean>;
}

export function useGisValidationNavigation(navigation: Navigation) {
  const auth=useAuthStore(),preview=usePreviewStore(),editor=useResourceEditStore(),gis=useGisWorkspaceStore(),planning=usePlanningStore();
  const notice=ref(''); let serial=0,epoch=0;
  onBeforeUnmount(()=>{serial++;});
  const disabled=computed(()=>!auth.can('situation.view')||editor.busy||gis.busy||planning.busy||editor.importOpen||!!planning.importRequest);
  const context=()=>JSON.stringify([auth.generation,auth.can('situation.view'),editor.context,preview.data?.resourceMeta.revision,
    preview.data?.situation.snapshotId,planning.taskId,planning.draft,gis.mapMode]);
  watch(context,()=>{epoch++;notice.value='';},{flush:'sync'});
  watch(()=>gis.validationIssues,()=>{notice.value='';});
  function reason(issue:GisValidationIssue) {
    if(issue.source==='resource') {
      if(editor.context!=='gis'||!editor.canEdit)return '当前不可编辑此资源';
      return gisResourceTarget(issue,editor.resources,editor.form)?'':'对象不存在或身份不明确，无法定位';
    }
    if(!auth.can('planning.view')||!auth.can('planning.execute'))return '当前不可编辑任务输入';
    return gisTaskTarget(issue,planning.draft)?'':'任务或通联需求已不存在，无法定位';
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
    } else {
      notice.value=navigation.taskReason(issue);if(notice.value)return;
      if(editor.form&&!(await editor.closeForm()))return;
      if(!current())return;
      notice.value=navigation.taskReason(issue);if(notice.value)return;
      navigation.showTask();
      if(!(await navigation.focusTask(issue)))notice.value='当前表单无法精确定位，请检查任务输入。';
    }
  }
  return {notice,disabled,reason,locate};
}
