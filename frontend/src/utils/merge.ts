/**
 * 按对象三路合并引擎（航点 / 航线参数 / 成果影像通用）。
 *
 * 语义：
 * - base：双方共同的底本（上次同步时的快照），本标签页改动时不推进。
 * - local：本标签页当前希望保留的版本。
 * - remote：数据库中读到的对方（其他标签页）版本。
 *
 * 规则：
 * - 仅一方改动的字段 → 自动合入改动方的值（“其他改动照常合入”）。
 * - 双方都改且取值不同 → 记为冲突，列出底本/本方/对方三方值，选定前不写回。
 * - 双方都改且取值相同 → 视为一致，不冲突。
 * - 一方删除、另一方修改 → 记为删除冲突。
 */

export type ConflictChoice = 'local' | 'remote';

export type ObjectType = 'waypoint' | 'line' | 'asset';

export interface FieldDef<T> {
  key: keyof T;
  label: string;
  unit?: string;
  format?: (value: unknown) => string;
}

export interface FieldConflict {
  /** 唯一键：${objectType}:${objectId}:${field} */
  key: string;
  objectId: string;
  objectType: ObjectType;
  missionId: string;
  /** 字段名；'__delete__' 表示对象整体删除冲突 */
  field: string;
  fieldLabel: string;
  unit?: string;
  base: unknown;
  local: unknown;
  remote: unknown;
  choice?: ConflictChoice;
}

export interface MergeResult<T> {
  merged: T[];
  conflicts: FieldConflict[];
  conflictedIds: Set<string>;
  removedIds: string[];
}

/** 宽松相等：基本类型直接比较，对象/数组按 JSON 序列化比较 */
export function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  // NaN 视为相等
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return false;
}

/** 字段展示值：优先用字段自定义 format，其次按单位/类型兜底 */
export function formatFieldValue(def: FieldDef<unknown> | undefined, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (def?.format) return def.format(value);
  if (typeof value === 'number') {
    const digits = Number.isInteger(value) ? 0 : 2;
    return `${value.toFixed(digits)}${def?.unit ? ` ${def.unit}` : ''}`;
  }
  return String(value);
}

/**
 * 三路合并。T 必须有 id 与 missionId。
 */
export function threeWayMerge<T extends { id: string; missionId: string }>(
  base: T[],
  local: T[],
  remote: T[],
  objectType: ObjectType,
  fieldDefs: FieldDef<T>[],
): MergeResult<T> {
  const baseMap = new Map(base.map((o) => [o.id, o]));
  const localMap = new Map(local.map((o) => [o.id, o]));
  const remoteMap = new Map(remote.map((o) => [o.id, o]));
  const ids = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const merged: T[] = [];
  const conflicts: FieldConflict[] = [];
  const conflictedIds = new Set<string>();
  const removedIds: string[] = [];

  const fieldChanged = (obj: T, baseObj: T): boolean =>
    fieldDefs.some((def) => !eq((obj as Record<string, unknown>)[def.key as string], (baseObj as Record<string, unknown>)[def.key as string]));

  for (const id of ids) {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (l && r) {
      if (!b) {
        // 双方新增且 id 相同（罕见）：优先本方
        merged.push(l);
        continue;
      }
      // 字段级合并
      const out: Record<string, unknown> = { ...(b as object) };
      let objConflicted = false;
      for (const def of fieldDefs) {
        const bv = (b as Record<string, unknown>)[def.key as string];
        const lv = (l as Record<string, unknown>)[def.key as string];
        const rv = (r as Record<string, unknown>)[def.key as string];
        let value: unknown;
        if (eq(lv, bv)) {
          value = rv; // 本方未改 → 取对方
        } else if (eq(rv, bv)) {
          value = lv; // 对方未改 → 取本方
        } else if (eq(lv, rv)) {
          value = lv; // 双方改后一致
        } else {
          // 冲突：展示本方值，选定前不写回
          value = lv;
          objConflicted = true;
          conflicts.push({
            key: `${objectType}:${id}:${String(def.key)}`,
            objectId: id,
            objectType,
            missionId: l.missionId,
            field: String(def.key),
            fieldLabel: def.label,
            unit: def.unit,
            base: bv,
            local: lv,
            remote: rv,
          });
        }
        out[def.key as string] = value;
      }
      if (objConflicted) conflictedIds.add(id);
      merged.push(out as T);
    } else if (l && !r) {
      // 对方删除（或从未有）
      if (b) {
        if (fieldChanged(l, b)) {
          // 对方删除、本方有修改 → 删除冲突
          conflictedIds.add(id);
          merged.push(l);
          conflicts.push({
            key: `${objectType}:${id}:__delete__`,
            objectId: id,
            objectType,
            missionId: l.missionId,
            field: '__delete__',
            fieldLabel: '对象整体',
            base: b,
            local: l,
            remote: null,
          });
        } else {
          removedIds.push(id);
        }
      } else {
        merged.push(l); // 本方新增
      }
    } else if (r && !l) {
      // 本方删除
      if (b) {
        if (fieldChanged(r, b)) {
          // 本方删除、对方有修改 → 删除冲突
          conflictedIds.add(id);
          merged.push(r);
          conflicts.push({
            key: `${objectType}:${id}:__delete__`,
            objectId: id,
            objectType,
            missionId: r.missionId,
            field: '__delete__',
            fieldLabel: '对象整体',
            base: b,
            local: null,
            remote: r,
          });
        } else {
          removedIds.push(id);
        }
      } else {
        merged.push(r); // 对方新增
      }
    } else {
      // 仅存在于底本 → 双方都删除
      removedIds.push(id);
    }
  }

  return { merged, conflicts, conflictedIds, removedIds };
}

/** 合并后重建底本：无冲突的对象推进到合并值，有冲突的对象保留旧底本 */
export function advanceBase<T extends { id: string }>(
  prevBase: T[],
  merged: T[],
  conflictedIds: Set<string>,
): T[] {
  const prevMap = new Map(prevBase.map((o) => [o.id, o]));
  return merged.map((o) => (conflictedIds.has(o.id) ? (prevMap.get(o.id) ?? o) : o));
}

/** 实体字段定义（供冲突弹窗复用） */
import type { Waypoint } from '../types/waypoint';
import type { FlightLine } from '../types/flightline';
import type { ImageAsset } from '../types/imageasset';

export const WAYPOINT_FIELDS: FieldDef<Waypoint>[] = [
  { key: 'seq', label: '序号' },
  { key: 'lng', label: '经度', format: (v) => Number(v).toFixed(6) },
  { key: 'lat', label: '纬度', format: (v) => Number(v).toFixed(6) },
  { key: 'altitude', label: '相对航高', unit: 'm' },
  { key: 'speed', label: '航速', unit: 'm/s' },
  { key: 'heading', label: '航向', unit: '°' },
  { key: 'gimbalPitch', label: '云台俯仰', unit: '°' },
  { key: 'action', label: '动作' },
  { key: 'hoverSec', label: '悬停', unit: 's' },
];

export const LINE_FIELDS: FieldDef<FlightLine>[] = [
  { key: 'lineNo', label: '航线号' },
  { key: 'spacing', label: '航线间距', unit: 'm' },
  { key: 'photoInterval', label: '拍照间隔', unit: 'm' },
  { key: 'overlapForward', label: '航向重叠率', unit: '%' },
  { key: 'overlapSide', label: '旁向重叠率', unit: '%' },
  { key: 'gsd', label: '地面分辨率', unit: 'cm/px' },
  { key: 'estPhotos', label: '预计张数', unit: '张' },
  { key: 'estDuration', label: '预计耗时', unit: 'min' },
  { key: 'batteryCount', label: '电池组数', unit: '组' },
  { key: 'heading', label: '航带方向', unit: '°' },
];

export const ASSET_FIELDS: FieldDef<ImageAsset>[] = [
  { key: 'imageNo', label: '片号' },
  { key: 'lng', label: '经度', format: (v) => Number(v).toFixed(6) },
  { key: 'lat', label: '纬度', format: (v) => Number(v).toFixed(6) },
  { key: 'altitude', label: '航高', unit: 'm' },
  { key: 'gsd', label: 'GSD', unit: 'cm/px' },
  { key: 'overlap', label: '重叠度', unit: '%' },
  { key: 'tiltAngle', label: '倾角', unit: '°' },
  { key: 'shotAt', label: '拍摄时间', format: (v) => new Date(Number(v)).toLocaleString('zh-CN') },
  { key: 'quality', label: '质量' },
  { key: 'folder', label: '归档目录' },
];

export const FIELD_DEFS: Record<ObjectType, FieldDef<unknown>[]> = {
  waypoint: WAYPOINT_FIELDS as FieldDef<unknown>[],
  line: LINE_FIELDS as FieldDef<unknown>[],
  asset: ASSET_FIELDS as FieldDef<unknown>[],
};

export const OBJECT_TYPE_LABEL: Record<ObjectType, string> = {
  waypoint: '航点',
  line: '航线参数',
  asset: '成果影像',
};
