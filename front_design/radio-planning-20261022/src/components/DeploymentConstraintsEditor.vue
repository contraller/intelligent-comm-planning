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
      >未设置额外筛选。首次试用可保留未勾选；有选址限制时再启用，不会自动补填旧任务。</p
    >
    <template v-else>
      <p class="muted">用于筛选候选位置和新增部署，已有台站不会被自动搬移。各条件需要同时满足；留空表示不额外指定该项，改动需保存任务后提交规划。</p>
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
        /><small class="muted">{{ scalarHints[key] }}</small
        ><small
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
        ><p class="muted"
          >限制候选位置的地面海拔，不是天线挂高。单位 m；例如下界 200、上界 1500 表示保留海拔 200–1500 m 的位置。上下界须同时填写且下界≤上界；可填有限数值，无固定上下限，均留空表示未指定。</p
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
        /><small class="muted">只保留所填地物类型，名称应与资源数据一致；多个名称用英文分号 ; 分隔。留空表示不按地物类型额外筛选。</small><small
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
        ><p class="muted">候选位置必须与全部勾选节点满足地形通视，勾选越多条件越严格。可选择未参与任务的已保存节点；不自动增加通联需求，无此要求可不选。</p>
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
        <p class="muted"
          >0–{{ deploymentLimits.points }} 个点；经度 -180°～180°，纬度 -90°～90°（含边界），均须填有限数值。</p
        >
        <p class="muted">填写必须纳入新增部署的坐标，经度在前、纬度在后；坐标仍须位于任务及地形范围内，并通过坡度、禁区等条件。无固定位置要求时不增加点。</p>
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
        <p class="muted"
          >0–{{ deploymentLimits.polygons }} 个禁区；经度 -180°～180°，纬度 -90°～90°（含边界），均须填有限数值。所有禁区合计最多 {{ deploymentLimits.coordinates }} 个坐标（含闭合点）。</p
        >
        <p class="muted"
          >每个禁区至少一个环；每环至少三个不同顶点、四个坐标，首尾坐标相同。环不得自交或相交；内环须位于外环内部且不得嵌套。</p
        >
        <p class="muted">用于排除不能新增部署的区域。按边界顺序填写顶点，最后重复第一个坐标闭合；无禁部署区时不增加多边形。</p>
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
          >超出任务区域的坐标仍原样保留，由服务判断。</p
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
// 示例仅解释参数含义，不写入草稿或额外限制取值范围。
const scalarHints = {
  maxSlopeDeg: '允许的最大地面坡度，填 10 表示保留坡度不超过 10° 的位置；越小越严格。可填 0–90°（含边界），留空表示未指定。',
  roadMaxDistanceM: '候选位置到道路的最大距离，填 1000 表示距道路不超过 1 km；表示距离条件，不代表车辆一定能够通行。可填 ≥0 m 的有限数值，无固定上限，留空表示未指定。',
  minSiteSpacingM: '新增部署位置之间的最小距离，填 500 表示至少相隔 500 m；数值越大，位置越分散。可填 ≥0 m 的有限数值，无固定上限，留空表示未指定。',
  gridStepM: '生成候选网格时的采样间距，填 1000 表示按 1 km 间距采样；越小候选越密、计算量越大。留空沿用已有候选表。须为 >0 m 的有限数值；实际允许范围取决于任务区域，单次最多扫描 100000 点，超限时需增大间距或缩小区域，保存前会校验。',
};
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
