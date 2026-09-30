/**
 * 按对象三方合并引擎（航点 / 航线参数 / 成果影像）。
 *
 * 每个标签页在加载与跨页同步时缓存对象底本（base，含合并版本号 rev）。
 * 写回时：
 * - 底本 rev 与库内 rev 相同且对象上没有待决差异：没有他页改动，直接写回；
 * - 否则逐字段三方合并——本地未改动的字段采用他页值，双方改了不同字段各自合入；
 *   双方改了同一字段且取值不同，或该字段已有待决差异而本次提交值仍不同于库内值，
 *   则登记 / 续记合并差异，在用户选定前不写回本地方值（库内保留先写入一方的值）。
 */
import type { Table } from 'dexie';
import { db } from './db';
import { MERGE_FIELDS, type MergeConflict, type MergeKind } from '../types/merge';
import type { FlightLine } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';
import type { ImageAsset } from '../types/imageasset';

export type MergeEntity = Waypoint | FlightLine | ImageAsset;
type AnyRow = Record<string, any>;

interface RevEntity {
  id: string;
  rev: number;
}

// 内部以通用行记录处理三张同构表，避免 Dexie Table 泛型协变带来的类型摩擦
const tables: Record<MergeKind, Table<AnyRow, string>> = {
  waypoint: db.waypoints as unknown as Table<AnyRow, string>,
  line: db.lines as unknown as Table<AnyRow, string>,
  asset: db.assets as unknown as Table<AnyRow, string>,
};

/** 各标签页缓存的对象底本：只在初始加载与跨页 resync 时整体替换 */
const baseCache: Record<MergeKind, Map<string, AnyRow>> = {
  waypoint: new Map(),
  line: new Map(),
  asset: new Map(),
};

export function getBase<T extends RevEntity>(kind: MergeKind, id: string): T | undefined {
  const row = baseCache[kind].get(id);
  return row ? ({ ...row } as unknown as T) : undefined;
}

export function rememberBase(kind: MergeKind, row: MergeEntity): void {
  baseCache[kind].set(row.id, { ...(row as AnyRow) });
}

export function rememberBases(kind: MergeKind, rows: MergeEntity[]): void {
  const map = baseCache[kind];
  rows.forEach((row) => map.set(row.id, { ...(row as AnyRow) }));
}

export function forgetBase(kind: MergeKind, id: string): void {
  baseCache[kind].delete(id);
}

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 对象称谓，用于差异台账展示 */
export function objectLabel(kind: MergeKind, obj: AnyRow): string {
  if (kind === 'waypoint') return `航点 #${obj.seq ?? '?'}`;
  if (kind === 'asset') return `影像 ${String(obj.imageNo ?? '')}`;
  return '航线参数';
}

export interface MergeResult<T extends MergeEntity> {
  /** 最终落库对象；对象已被他页删除时为 null（不复活） */
  committed: T | null;
  /** 本次新登记 / 仍待选定的字段 */
  conflictFields: string[];
  /** 本页提交的值是否真正落库（用于决定是否触发成果失效等联动） */
  appliedLocal: boolean;
}

/**
 * 合并写串行化队列：所有对象的合并写回 / 差异选定统一排队。
 * 数据量仅几十条航点/影像，串行即可；关键是杜绝连续编辑与「选定写回」交错时
 * 多个事务基于同一份底本提交而互相覆盖。
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = writeChain.then(task, task);
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * 按对象三方合并写回（自动排队）。
 * @param kind     对象类型
 * @param proposed 本页基于底本修改后的完整对象
 * @param tabId    本页标识
 */
export function mergePut<T extends MergeEntity>(kind: MergeKind, proposed: T, tabId: string): Promise<MergeResult<T>> {
  return enqueue(() => mergePutNow(kind, proposed, tabId));
}

async function mergePutNow<T extends MergeEntity>(kind: MergeKind, proposed: T, tabId: string): Promise<MergeResult<T>> {
  const table = tables[kind];
  const id = proposed.id;
  const proposedRow = proposed as unknown as AnyRow;
  const conflictFields: string[] = [];
  let appliedLocal = false;

  await db.transaction('rw', [table, db.conflicts], async () => {
    const remote = await table.get(id);
    if (!remote) {
      // 对象已被删除：不复活，丢弃本页写回
      return;
    }
    const base: AnyRow = (getBase(kind, id) as unknown as AnyRow | undefined) ?? remote;
    const fields = MERGE_FIELDS[kind];
    const openConflicts = (await db.conflicts.where('objectId').equals(id).toArray()).filter((c) => c.kind === kind);
    const conflictByField = new Map(openConflicts.map((c) => [c.field, c]));
    const clean = remote.rev === base.rev && openConflicts.length === 0;

    if (clean) {
      // 无他页改动、也无未决差异：直接写回
      const next: AnyRow = { ...remote, ...proposedRow, rev: remote.rev + 1 };
      if (kind === 'line') next.updatedAt = Date.now();
      await table.put(next);
      rememberBase(kind, next as unknown as MergeEntity);
      appliedLocal = true;
      return;
    }

    // 三方逐字段合并
    const merged: AnyRow = { ...remote };
    let seqTaken = false;

    for (const field of fields) {
      const bv = base[field];
      const rv = remote[field];
      const pv = proposedRow[field];
      const localChanged = !sameJson(pv, bv);
      const remoteChanged = !sameJson(rv, bv);
      const hasOpenConflict = conflictByField.has(field);

      if (sameJson(pv, rv)) {
        // 双方现值一致：自动消解，关闭该字段的待决差异
        merged[field] = rv;
        const agreed = conflictByField.get(field);
        if (agreed) await db.conflicts.delete(agreed.id);
      } else if (hasOpenConflict) {
        // 字段上仍有未决差异：在用户选定前继续保留库内现值，只续记本页提交值
        merged[field] = rv;
        conflictFields.push(field);
      } else if (!localChanged) {
        merged[field] = rv; // 本页未改，采用他页
      } else if (!remoteChanged) {
        merged[field] = pv; // 他页未改，合入本页
        appliedLocal = true;
      } else {
        merged[field] = rv; // 互不相让：保留先写入一方，本地方值挂起
        conflictFields.push(field);
      }

      if (conflictFields.includes(field)) {
        const prev = conflictByField.get(field);
        const now = Date.now();
        const record: MergeConflict = {
          id: `${kind}:${id}:${field}`,
          missionId: String(remote.missionId),
          kind,
          objectId: id,
          objectLabel: objectLabel(kind, remote),
          field,
          fieldLabel: prev?.fieldLabel ?? field,
          baseValue: JSON.stringify(bv ?? null),
          // 本记录创建/更新者 = 后写入的一方；先写入一方的现值放在 remoteValue
          localValue: JSON.stringify(pv ?? null),
          remoteValue: JSON.stringify(rv ?? null),
          localTabId: tabId,
          remoteTabId: prev?.localTabId ?? '',
          currentValue: JSON.stringify(rv ?? null),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
        };
        await db.conflicts.put(record);
      }
    }

    // 航点序号属于顺序操作：本页没动序号就沿用他页顺序，动了则按本页（拖拽换序 LWW）
    if (kind === 'waypoint') {
      if (sameJson(proposedRow.seq, base.seq)) {
        merged.seq = remote.seq;
      } else {
        merged.seq = proposedRow.seq;
        seqTaken = true;
      }
    }

    if (appliedLocal || conflictFields.length > 0 || seqTaken) {
      if (kind === 'line') merged.updatedAt = Date.now();
      merged.rev = remote.rev + 1;
      await table.put(merged);
      rememberBase(kind, merged as unknown as MergeEntity);
    } else {
      // 本页改动全部已被他页覆盖/一致，不必重复写库，仅刷新底本
      rememberBase(kind, remote as unknown as MergeEntity);
    }
  });

  const committed = ((await table.get(id)) as unknown as T | undefined) ?? null;
  return { committed, conflictFields, appliedLocal };
}

/** 用户选定差异中的一方值：写回对象、rev+1、删除该差异条目（同样按对象排队） */
export function resolveConflict(
  conflictId: string,
  side: 'local' | 'remote',
): Promise<{ kind: MergeKind; missionId: string; objectId: string } | null> {
  return enqueue(() => resolveConflictNow(conflictId, side));
}

async function resolveConflictNow(
  conflictId: string,
  side: 'local' | 'remote',
): Promise<{ kind: MergeKind; missionId: string; objectId: string } | null> {
  const allTables = [db.waypoints, db.lines, db.assets];
  return db.transaction('rw', [...allTables, db.conflicts], async () => {
    const conflict = await db.conflicts.get(conflictId);
    if (!conflict) return null;
    const table = tables[conflict.kind];
    const obj = await table.get(conflict.objectId);
    if (!obj) {
      await db.conflicts.delete(conflict.id);
      return null;
    }
    const chosen = JSON.parse(side === 'local' ? conflict.localValue : conflict.remoteValue);
    const next: AnyRow = { ...obj, [conflict.field]: chosen, rev: obj.rev + 1 };
    if (conflict.kind === 'line') next.updatedAt = Date.now();
    await table.put(next);
    rememberBase(conflict.kind, next as unknown as MergeEntity);
    await db.conflicts.delete(conflict.id);
    return { kind: conflict.kind, missionId: conflict.missionId, objectId: conflict.objectId };
  });
}
