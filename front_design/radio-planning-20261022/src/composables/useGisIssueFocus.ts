import { nextTick, ref, watch } from 'vue';
import { focusGisField } from '../services/gis-validation';
import type { useResourceEditStore } from '../stores/resource-edit';

export function useGisIssueFocus(editor: ReturnType<typeof useResourceEditStore>) {
  // GIS 定位只操作当前表单，抽屉动画结束后再次核对请求，避免焦点落到旧对象。
  const fieldRoot = ref<HTMLElement | null>(null);
  async function focusIssue() {
    const request = editor.issueFocus;
    if (!request || editor.context !== 'gis' || !editor.canEdit || editor.picking) return;
    await nextTick();
    if (
      editor.issueFocus === request &&
      editor.form?.id === request.id &&
      editor.canEdit &&
      !editor.picking
    )
      focusGisField(fieldRoot.value, request.field);
  }
  watch(
    () => editor.issueFocus,
    () => {
      void focusIssue();
    },
  );
  function locateField(field: string) {
    if (editor.form)
      void editor.focusGisIssue(
        editor.form.kind,
        editor.form.id,
        field === 'coordinate' ? 'longitude' : field,
      );
  }
  return { fieldRoot, focusIssue, locateField };
}
