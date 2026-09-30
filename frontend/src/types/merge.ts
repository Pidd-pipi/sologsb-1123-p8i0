/** 多标签合并的对象类型 */
export type MergeKind = 'waypoint' | 'line' | 'asset';

export const MERGE_KIND_LABELS: Record<MergeKind, string> = {
  waypoint: '航点',
  line: '航线参数',
  asset: '成果影像',
};

/**
 * 合并差异（冲突）台账记录。
 * 同一对象同一字段只保留一条；任一方值被选定写回后即删除。
 * 值统一以 JSON 字符串保存，展示时再解析，兼容数值 / 文本 / 经纬度。
 */
export interface MergeConflict {
  /** `${kind}:${objectId}:${field}`，确定性 id，天然去重 */
  id: string;
  missionId: string;
  kind: MergeKind;
  objectId: string;
  /** 产生冲突时的对象称谓，如 航点 #3 / 影像 IMG_2002 / 航线参数 */
  objectLabel: string;
  field: string;
  fieldLabel: string;
  /** 双方共同底本上的值（可能为空字符串，表示底本缺失） */
  baseValue: string;
  /** 先写入一方（产生冲突的标签页）看到/提交的值 */
  localValue: string;
  /** 后写入一方（合并时发现底本已变）携带的值 */
  remoteValue: string;
  /** 提交该冲突的标签页标识 */
  localTabId: string;
  /** 合并发生时另一方标签页标识（未知时为空） */
  remoteTabId: string;
  /** 冲突产生后对象上该字段的当前落库值快照 */
  currentValue: string;
  createdAt: number;
  updatedAt: number;
}

interface FieldMeta {
  label: string;
  unit?: string;
  digits?: number;
}

export const MERGE_FIELD_META: Record<MergeKind, Record<string, FieldMeta>> = {
  waypoint: {
    lng: { label: '经度', digits: 6 },
    lat: { label: '纬度', digits: 6 },
    altitude: { label: '相对航高', unit: 'm' },
    speed: { label: '航速', unit: 'm/s' },
    heading: { label: '航向', unit: '°' },
    gimbalPitch: { label: '云台俯仰', unit: '°' },
    action: { label: '动作' },
    hoverSec: { label: '悬停时长', unit: 's' },
  },
  line: {
    spacing: { label: '航线间距', unit: 'm', digits: 2 },
    photoInterval: { label: '拍照间隔', unit: 'm', digits: 2 },
    overlapForward: { label: '航向重叠率', unit: '%' },
    overlapSide: { label: '旁向重叠率', unit: '%' },
    gsd: { label: '地面分辨率 GSD', unit: 'cm/px', digits: 2 },
    estPhotos: { label: '预计张数', unit: '张' },
    estDuration: { label: '预计耗时', unit: 'min', digits: 1 },
    batteryCount: { label: '预计电池组数', unit: '组' },
    heading: { label: '航带方向', unit: '°' },
  },
  asset: {
    imageNo: { label: '片号' },
    lng: { label: '经度', digits: 6 },
    lat: { label: '纬度', digits: 6 },
    altitude: { label: '航高', unit: 'm' },
    gsd: { label: 'GSD', unit: 'cm/px', digits: 2 },
    overlap: { label: '重叠度', unit: '%' },
    tiltAngle: { label: '倾角', unit: '°' },
    quality: { label: '质量' },
    folder: { label: '归档目录' },
  },
};

/** 参与三方合并的用户字段（seq / rev / stale 等系统字段不在此列） */
export const MERGE_FIELDS: Record<MergeKind, readonly string[]> = {
  waypoint: ['lng', 'lat', 'altitude', 'speed', 'heading', 'gimbalPitch', 'action', 'hoverSec'],
  line: [
    'spacing',
    'photoInterval',
    'overlapForward',
    'overlapSide',
    'gsd',
    'estPhotos',
    'estDuration',
    'batteryCount',
    'heading',
  ],
  asset: ['imageNo', 'lng', 'lat', 'altitude', 'gsd', 'overlap', 'tiltAngle', 'quality', 'folder'],
};

/**
 * 航线参数中的派生量：由航高 / 重叠率 / 航速等输入量与航点实时回算，
 * 不由人工选定。用户解决任一航线输入字段差异并重算后，这些字段的待决差异自动作废。
 */
export const DERIVED_LINE_FIELDS = ['spacing', 'photoInterval', 'gsd', 'estPhotos', 'estDuration', 'batteryCount'] as const;

/** 差异值的展示格式化 */
export function formatConflictValue(kind: MergeKind, field: string, jsonValue: string): string {
  let raw: unknown = jsonValue;
  try {
    raw = JSON.parse(jsonValue);
  } catch {
    /* 非 JSON 文本直接展示 */
  }
  const meta = MERGE_FIELD_META[kind][field];
  if (raw === null || raw === undefined || raw === '') return '—';
  if (typeof raw === 'number' && meta?.digits !== undefined) {
    return `${raw.toFixed(meta.digits)}${meta.unit ? ` ${meta.unit}` : ''}`;
  }
  if (typeof raw === 'number') return `${raw}${meta?.unit ? ` ${meta.unit}` : ''}`;
  return String(raw);
}
