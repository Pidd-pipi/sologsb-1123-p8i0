import { create } from 'zustand';
import { db } from '../utils/db';
import { emitSync } from '../utils/syncBus';
import { resolveConflict } from '../utils/merge';
import { invalidateAndRecompute } from '../utils/assetSync';
import { refinalizeLine } from './lineStore';
import { useLineStore } from './lineStore';
import type { MergeConflict, MergeKind } from '../types/merge';

interface ConflictState {
  items: MergeConflict[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中全量重拉（跨标签页变更后调用） */
  resync: () => Promise<void>;
  /** 选定一方值写回；航线参数选定后还要重算派生量并使成果失效 */
  resolve: (conflictId: string, side: 'local' | 'remote') => Promise<{ ok: boolean; kind?: MergeKind; missionId?: string }>;
  /** 一次性选定同一对象多个差异的同一方值 */
  resolveMany: (ids: string[], side: 'local' | 'remote') => Promise<void>;
  byMission: (missionId: string) => MergeConflict[];
  openCount: (missionId?: string) => number;
  /** 归档前检查：未清差异数 + 失效成果数 */
  archiveBlockers: (missionId: string) => Promise<{ conflicts: number; staleAssets: number }>;
}

async function reconcileStaleConflicts(): Promise<void> {
  // 差异对象已被删除时，连带删掉悬空调账
  const rows = await db.conflicts.toArray();
  const deadIds: string[] = [];
  await Promise.all(
    rows.map(async (c) => {
      const table = c.kind === 'waypoint' ? db.waypoints : c.kind === 'line' ? db.lines : db.assets;
      const obj = await table.get(c.objectId);
      if (!obj) deadIds.push(c.id);
    }),
  );
  if (deadIds.length > 0) await db.conflicts.bulkDelete(deadIds);
}

export const useConflictStore = create<ConflictState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    await get().resync();
    set({ loaded: true });
  },
  async resync() {
    await reconcileStaleConflicts();
    const rows = await db.conflicts.orderBy('createdAt').toArray();
    set({ items: rows });
  },
  async resolve(conflictId, side) {
    const result = await resolveConflict(conflictId, side);
    if (!result) {
      await get().resync();
      return { ok: false };
    }
    const { kind, missionId } = result;
    if (kind === 'line') {
      // 航线参数字段被选定：先按选定后的参数重算整条航线派生量，再让相关成果失效重算
      await refinalizeLine(missionId);
      await useLineStore.getState().resync();
      await invalidateAndRecompute(missionId);
      // 航线 + 成果的发布已由上面的 resync/assetSync 完成，这里只补差异台账
      emitSync(['lines', 'conflicts'], [missionId]);
    } else {
      emitSync(kind === 'waypoint' ? ['waypoints', 'conflicts'] : ['assets', 'conflicts'], [missionId]);
    }
    await get().resync();
    return { ok: true, kind, missionId };
  },
  async resolveMany(ids, side) {
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      await get().resolve(id, side);
    }
  },
  byMission(missionId) {
    return get()
      .items.filter((c) => c.missionId === missionId)
      .sort((a, b) => a.updatedAt - b.updatedAt);
  },
  openCount(missionId) {
    return typeof missionId === 'string' ? get().items.filter((c) => c.missionId === missionId).length : get().items.length;
  },
  async archiveBlockers(missionId) {
    const [conflicts, staleAssets] = await Promise.all([
      db.conflicts.where('missionId').equals(missionId).count(),
      db.assets.where('missionId').equals(missionId).filter((a) => a.stale).count(),
    ]);
    return { conflicts, staleAssets };
  },
}));
