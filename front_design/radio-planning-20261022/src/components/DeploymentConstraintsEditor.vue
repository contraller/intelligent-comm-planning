<template>
  <fieldset
    class="deployment-editor"
    :disabled="disabled"
    data-validation-field="deploymentConstraints"
    tabindex="-1"
  >
    <legend>部署筛选条件</legend>
    <label class="check"
      ><input
        type="checkbox"
        :checked="!!modelValue"
        v-on="{ change: checkAction(controls.enable) }"
      />设置部署筛选条件</label
    >
    <p
      v-if="!modelValue"
      class="muted"
      >未设置；不会根据预设补填旧任务。</p
    >
    <template v-else>
      <p class="muted">留空表示未指定。条件由服务处理；这里仅校验格式。改动只写入任务草稿。</p>
      <label
        v-for="key in scalarKeys"
        :key="key"
        >{{ deploymentLabels[key]
        }}<input
          :data-validation-field="'deploymentConstraints.' + key"
          :aria-invalid="
            inlineIssues && fieldIssues(issues, 'deploymentConstraints.' + key).length > 0
          "
          inputmode="decimal"
          :value="numberText(key, modelValue[key])"
          v-on="{ input: inputAction(controls.scalar, key) }"
        /><small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.' + key)"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.' + key) }}</small
        ></label
      >
      <fieldset
        data-validation-field="deploymentConstraints.elevationRangeM"
        tabindex="-1"
        ><legend>海拔范围 / m</legend
        ><label
          v-for="(label, index) in ['下界', '上界']"
          :key="label"
          >{{ label
          }}<input
            inputmode="decimal"
            :value="numberText('elevation' + index, modelValue.elevationRangeM?.[index])"
            v-on="{ input: inputAction(controls.elevation, index) }" /></label
        ><small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.elevationRangeM')"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.elevationRangeM') }}</small
        ></fieldset
      >
      <label
        >允许地物（分号分隔，可填写其他名称）<input
          data-validation-field="deploymentConstraints.allowedLandcover"
          :aria-invalid="
            inlineIssues && fieldIssues(issues, 'deploymentConstraints.allowedLandcover').length > 0
          "
          :value="modelValue.allowedLandcover?.join(';') ?? ''"
          placeholder="草地;耕地;林地;建成区"
          v-on="{ input: inputAction(controls.covers) }"
        /><small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.allowedLandcover')"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.allowedLandcover') }}</small
        ></label
      >
      <fieldset
        data-validation-field="deploymentConstraints.losRequiredNodeIds"
        class="los-nodes"
        tabindex="-1"
        ><legend>要求全部通视的节点</legend
        ><p class="muted">可选择未参与任务的已保存节点；不自动增加通联需求。</p>
        <label
          v-for="node in nodes"
          :key="node.id"
          class="check"
          ><input
            type="checkbox"
            :checked="modelValue.losRequiredNodeIds.includes(node.id)"
            v-on="{ change: checkAction(controls.los, node.id) }"
          />{{ node.name }} · {{ node.id }}</label
        >
        <p v-if="!nodes.length">暂无节点选项</p
        ><div
          v-for="id in modelValue.losRequiredNodeIds"
          :key="id"
          >已选 {{ id }}
          <button
            type="button"
            class="text-link"
            v-on="{ click: controls.los.bind(null, id, false) }"
            >移除</button
          ></div
        >
        <small
          v-if="
            inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.losRequiredNodeIds')
          "
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.losRequiredNodeIds') }}</small
        >
      </fieldset>
      <fieldset
        data-validation-field="deploymentConstraints.forcedInclude"
        tabindex="-1"
        ><legend>强制部署点 / WGS84</legend>
        <div
          v-for="(point, index) in modelValue.forcedInclude"
          :key="index"
          class="coordinate-row"
          ><label
            >经度<input
              inputmode="decimal"
              :value="numberText('point' + index + 'lon', point.lon)"
              v-on="{ input: inputAction(controls.point, index, 'lon') }" /></label
          ><label
            >纬度<input
              inputmode="decimal"
              :value="numberText('point' + index + 'lat', point.lat)"
              v-on="{ input: inputAction(controls.point, index, 'lat') }" /></label
          ><button
            type="button"
            class="text-link"
            v-on="{ click: controls.removePoint.bind(null, index) }"
            >移除点</button
          ></div
        >
        <button
          type="button"
          class="btn small"
          :disabled="modelValue.forcedInclude.length >= deploymentLimits.points"
          v-on="{ click: controls.addPoint.bind(null) }"
          >增加强制点</button
        >
        <small
          v-if="inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.forcedInclude')"
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.forcedInclude') }}</small
        >
      </fieldset>
      <fieldset
        data-validation-field="deploymentConstraints.forcedExcludePolygons"
        tabindex="-1"
        ><legend>禁部署区 / WGS84</legend>
        <fieldset
          v-for="(polygon, p) in modelValue.forcedExcludePolygons"
          :key="p"
          ><legend>禁区 {{ p + 1 }}</legend
          ><button
            type="button"
            class="text-link"
            v-on="{ click: controls.removePolygon.bind(null, p) }"
            >移除禁区</button
          >
          <fieldset
            v-for="(ring, r) in polygon.coordinates"
            :key="r"
            ><legend>{{ r === 0 ? '外环' : '内环 ' + r }}</legend
            ><div
              v-for="(point, i) in ring"
              :key="i"
              class="coordinate-row"
              ><label
                v-for="(axis, a) in ['经度', '纬度']"
                :key="axis"
                >{{ axis
                }}<input
                  inputmode="decimal"
                  :value="numberText(`vertex${p}-${r}-${i}-${a}`, point[a])"
                  v-on="{ input: inputAction(controls.vertex, p, r, i, a) }" /></label
              ><button
                type="button"
                class="text-link"
                v-on="{ click: controls.removeVertex.bind(null, p, r, i) }"
                >移除坐标</button
              ></div
            >
            <div class="toolbar"
              ><button
                type="button"
                class="btn small"
                v-on="{ click: controls.addVertex.bind(null, p, r) }"
                >增加坐标</button
              ><button
                type="button"
                class="btn small"
                v-on="{ click: controls.close.bind(null, p, r) }"
                >用首点闭合</button
              ><button
                v-if="r > 0"
                type="button"
                class="text-link"
                v-on="{ click: controls.removeRing.bind(null, p, r) }"
                >移除内环</button
              ></div
            > </fieldset
          ><button
            type="button"
            class="btn small"
            v-on="{ click: controls.addRing.bind(null, p) }"
            >增加内环</button
          > </fieldset
        ><button
          type="button"
          class="btn small"
          :disabled="modelValue.forcedExcludePolygons.length >= deploymentLimits.polygons"
          v-on="{ click: controls.addPolygon.bind(null) }"
          >增加禁区</button
        >
        <p class="muted"
          >环需至少三个不同顶点并闭合。最多100个强制点、20个禁区、2000个环坐标。超出任务区域的坐标仍原样保留，由服务判断。</p
        >
        <small
          v-if="
            inlineIssues && fieldIssueMessage(issues, 'deploymentConstraints.forcedExcludePolygons')
          "
          class="field-error"
          role="alert"
          >{{ fieldIssueMessage(issues, 'deploymentConstraints.forcedExcludePolygons') }}</small
        >
      </fieldset>
    </template>
    <p
      v-if="
        inlineIssues &&
        issues.some((issue) =>
          ['deploymentConstraints', 'deploymentConstraints.shape'].includes(issue.field),
        )
      "
      class="field-error"
      role="alert"
      >{{
        issues
          .filter((issue) =>
            ['deploymentConstraints', 'deploymentConstraints.shape'].includes(issue.field),
          )
          .map((issue) => issue.message)
          .join('；')
      }}</p
    >
    <ul
      v-if="issues.length && !inlineIssues"
      class="notice warn"
      role="alert"
      ><li
        v-for="issue in issues"
        :key="issue.field"
        >{{ issue.message }}</li
      ></ul
    >
  </fieldset>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import type { DeploymentConstraints } from '../types/deployment-constraints';
import { fieldIssueMessage, fieldIssues } from '../services/planning-issue-display';
import {
  deploymentConstraintIssues,
  deploymentLabels,
  deploymentLimits,
  emptyDeploymentConstraints,
} from '../services/deployment-constraints';
const props = defineProps<{
  modelValue?: DeploymentConstraints | null;
  nodes: { id: string; name: string }[];
  owner: string;
  disabled?: boolean;
  inlineIssues?: boolean;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: DeploymentConstraints | null];
  pending: [value: boolean];
}>();
const raw = ref<Record<string, string>>({});
let alive = true,
  lastInput = '';
const epoch = ref(0);
const serial = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    typeof item === 'number' && !Number.isFinite(item) ? '无效数值' : item,
  );
watch(
  () => props.owner,
  () => {
    epoch.value++;
    raw.value = {};
  },
  { flush: 'sync' },
);
watch(
  () => props.disabled,
  () => {
    epoch.value++;
  },
  { flush: 'sync' },
);
watch(
  () => props.modelValue,
  (value) => {
    if (serial(value) !== lastInput) raw.value = {};
  },
  { deep: true, flush: 'sync' },
);
const issues = computed(() => deploymentConstraintIssues(props.modelValue));
watch(issues, (value) => emit('pending', !!value.length), { immediate: true });
onBeforeUnmount(() => {
  alive = false;
  epoch.value++;
  emit('pending', false);
});
const scalarKeys = ['maxSlopeDeg', 'roadMaxDistanceM', 'minSiteSpacingM', 'gridStepM'] as const;
const numberText = (key: string, value: number | null | undefined) =>
  raw.value[key] ?? (value == null || !Number.isFinite(value) ? '' : String(value));
const text = (event: Event) => (event.target as HTMLInputElement).value;
const checked = (event: Event) => (event.target as HTMLInputElement).checked;
// v-on 对象保留当次闭包，不让迟到的 DOM 事件调用新一代控件。
const inputAction =
  <T extends unknown[]>(action: (...args: [...T, string]) => void, ...args: T) =>
  (event: Event) =>
    action(...args, text(event));
const checkAction =
  <T extends unknown[]>(action: (...args: [...T, boolean]) => void, ...args: T) =>
  (event: Event) =>
    action(...args, checked(event));
// 每组事件捕获任务和编辑代次；失权、切任务及卸载后的旧控件不能回写。
const controls = computed(() => {
  const owner = props.owner,
    generation = epoch.value,
    disabled = props.disabled;
  const valid = () =>
    alive && !disabled && !props.disabled && owner === props.owner && generation === epoch.value;
  const send = (value: DeploymentConstraints | null) => {
    if (!valid()) return;
    lastInput = serial(value);
    emit('update:modelValue', value);
  };
  const change = (action: (value: DeploymentConstraints) => void) => {
    if (!valid() || !props.modelValue) return;
    const value = structuredClone(toRaw(props.modelValue));
    action(value);
    send(value);
  };
  const numeric = (key: string, input: string, nullable = true) => {
    raw.value[key] = input;
    return input.trim() === '' ? (nullable ? null : NaN) : Number(input);
  };
  return {
    enable: (enabled: boolean) => send(enabled ? emptyDeploymentConstraints() : null),
    scalar: (key: (typeof scalarKeys)[number], input: string) => {
      if (valid())
        change((value) => {
          value[key] = numeric(key, input);
        });
    },
    elevation: (index: number, input: string) => {
      if (valid())
        change((value) => {
          const other = 1 - index,
            pair = value.elevationRangeM ? [...value.elevationRangeM] : [NaN, NaN];
          pair[index] = numeric('elevation' + index, input, false)!;
          value.elevationRangeM =
            input.trim() === '' &&
            !Number.isFinite(pair[other]) &&
            !(raw.value['elevation' + other] ?? '').trim()
              ? null
              : (pair as [number, number]);
        });
    },
    covers: (input: string) =>
      change((value) => {
        value.allowedLandcover = input.trim() ? input.split(';').map((item) => item.trim()) : null;
      }),
    los: (id: string, enabled: boolean) =>
      change((value) => {
        value.losRequiredNodeIds = enabled
          ? [...new Set([...value.losRequiredNodeIds, id])]
          : value.losRequiredNodeIds.filter((item) => item !== id);
      }),
    point: (index: number, axis: 'lon' | 'lat', input: string) => {
      if (valid())
        change((value) => {
          value.forcedInclude[index][axis] = numeric('point' + index + axis, input, false)!;
        });
    },
    addPoint: () => change((value) => value.forcedInclude.push({ lon: NaN, lat: NaN })),
    removePoint: (index: number) =>
      change((value) => {
        value.forcedInclude.splice(index, 1);
        raw.value = {};
      }),
    addPolygon: () =>
      change((value) => value.forcedExcludePolygons.push({ type: 'Polygon', coordinates: [[]] })),
    removePolygon: (index: number) =>
      change((value) => {
        value.forcedExcludePolygons.splice(index, 1);
        raw.value = {};
      }),
    addRing: (polygon: number) =>
      change((value) => value.forcedExcludePolygons[polygon].coordinates.push([])),
    removeRing: (polygon: number, ring: number) =>
      change((value) => {
        value.forcedExcludePolygons[polygon].coordinates.splice(ring, 1);
        raw.value = {};
      }),
    vertex: (polygon: number, ring: number, index: number, axis: number, input: string) => {
      if (valid())
        change((value) => {
          value.forcedExcludePolygons[polygon].coordinates[ring][index][axis] = numeric(
            `vertex${polygon}-${ring}-${index}-${axis}`,
            input,
            false,
          )!;
        });
    },
    addVertex: (polygon: number, ring: number) =>
      change((value) => value.forcedExcludePolygons[polygon].coordinates[ring].push([NaN, NaN])),
    removeVertex: (polygon: number, ring: number, index: number) =>
      change((value) => {
        value.forcedExcludePolygons[polygon].coordinates[ring].splice(index, 1);
        raw.value = {};
      }),
    close: (polygon: number, ring: number) =>
      change((value) => {
        const points = value.forcedExcludePolygons[polygon].coordinates[ring];
        if (points.length && serial(points[0]) !== serial(points.at(-1)))
          points.push([...points[0]]);
      }),
  };
});
</script>
<style scoped>
.deployment-editor,
fieldset {
  min-width: 0;
  display: grid;
  gap: 10px;
  border: 1px solid var(--line);
  padding: 12px;
}
.deployment-editor {
  margin-top: 12px;
  grid-template-columns: minmax(0, 1fr);
}
label {
  display: grid;
  gap: 6px;
  font-size: 12px;
}
input {
  width: 100%;
  min-width: 0;
}
.check {
  display: flex;
  flex-direction: row;
  align-items: center;
}
.check input {
  width: auto;
}
/* 节点目录只在约束组内滚动，避免挤占其他条件。 */
.los-nodes {
  max-height: 300px;
  overflow: auto;
}
.coordinate-row {
  display: flex;
  gap: 8px;
  align-items: end;
}
.coordinate-row label {
  flex: 1;
  min-width: 0;
}
.toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.muted {
  font-size: 11px;
  line-height: 1.8;
}
.notice {
  padding-left: 20px;
  overflow-wrap: anywhere;
}
/* 规划字段级反馈沿用统一警示色，不影响其他调用的默认呈现。 */
.field-error {
  display: block;
  color: #ffca8d;
  font-size: 12px;
  grid-column: 1 / -1;
}
[aria-invalid='true'] {
  border-color: #ffca8d;
}
</style>
