/**
 * 实体 store 的通用三路合并 / 冲突解决逻辑。
 * waypointStore / lineStore / assetStore 共用，避免各写一套产生偏差。
 */
import {
  advanceBase,
  threeWayMerge,
  type FieldConflict,
  type FieldDef,
  type MergeResult,
  type ObjectType,
} from './merge';

interface WritableTable<T> {
  toArray(): Promise<T[]>;
  bulkPut(rows: T[]): Promise<unknown>;
  bulkDelete(ids: string[]): Promise<unknown>;
  put(row: T): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

export interface EntityState<T> {
  items: T[];
  baseItems: T[];
  conflicts: FieldConflict[];
}

/** 从数据库重读并三路合并；干净结果写库，冲突结果仅留内存 */
export async function syncEntity<T extends { id: string; missionId: string }>(
  table: WritableTable<T>,
  fieldDefs: FieldDef<T>[],
  objectType: ObjectType,
  get: () => EntityState<T>,
  set: (partial: Partial<EntityState<T>>) => void,
  afterMerge?: (outcome: MergeResult<T>) => void | Promise<void>,
): Promise<void> {
  const remote = await table.toArray();
  const outcome = threeWayMerge(get().baseItems, get().items, remote, objectType, fieldDefs);
  const toPut = outcome.merged.filter((o) => !outcome.conflictedIds.has(o.id));
  if (toPut.length > 0) await table.bulkPut(toPut);
  if (outcome.removedIds.length > 0) await table.bulkDelete(outcome.removedIds);
  set({
    items: outcome.merged,
    baseItems: advanceBase(get().baseItems, outcome.merged, outcome.conflictedIds),
    conflicts: outcome.conflicts,
  });
  await afterMerge?.(outcome);
}

/** 解决单个冲突：字段冲突写入选定值，删除冲突按本方/对方决定保留或删除 */
export async function resolveEntityConflict<T extends { id: string; missionId: string }>(
  table: WritableTable<T>,
  get: () => EntityState<T>,
  set: (partial: Partial<EntityState<T>>) => void,
  conflictKey: string,
  choice: 'local' | 'remote',
  notify: (missionId: string) => void,
): Promise<void> {
  const { conflicts, items, baseItems } = get();
  const conflict = conflicts.find((c) => c.key === conflictKey);
  if (!conflict) return;

  let nextItems: T[];
  let nextConflicts: FieldConflict[];
  let removed = false;

  if (conflict.field === '__delete__') {
    const remoteWantsDelete = conflict.remote === null;
    if (choice === 'local') {
      if (remoteWantsDelete) {
        // 对方删除、本方修改 → 保留本方
        nextItems = items;
      } else {
        // 本方删除、对方修改 → 按本方删除
        nextItems = items.filter((it) => it.id !== conflict.objectId);
        removed = true;
      }
    } else {
      if (remoteWantsDelete) {
        // 对方删除 → 按对方删除
        nextItems = items.filter((it) => it.id !== conflict.objectId);
        removed = true;
      } else {
        // 本方删除、对方修改 → 保留对方修改版
        nextItems = items;
      }
    }
    nextConflicts = conflicts.filter((c) => c.objectId !== conflict.objectId);
  } else {
    const chosen = choice === 'local' ? conflict.local : conflict.remote;
    nextItems = items.map((it) =>
      it.id === conflict.objectId ? { ...it, [conflict.field]: chosen } : it,
    );
    nextConflicts = conflicts.filter((c) => c.key !== conflictKey);
  }

  if (removed) {
    await table.delete(conflict.objectId);
  } else {
    const resolved = nextItems.find((it) => it.id === conflict.objectId);
    const stillConflicted = nextConflicts.some((c) => c.objectId === conflict.objectId);
    if (resolved && !stillConflicted) {
      await table.put(resolved);
    }
  }

  const stillConflictedIds = new Set(nextConflicts.map((c) => c.objectId));
  set({
    items: nextItems,
    baseItems: advanceBase(baseItems, nextItems, stillConflictedIds),
    conflicts: nextConflicts,
  });
  notify(conflict.missionId);
}
