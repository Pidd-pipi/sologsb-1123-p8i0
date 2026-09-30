import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { LINE_FIELDS, type FieldConflict, type MergeResult } from '../utils/merge';
import { resolveEntityConflict, syncEntity } from '../utils/storeSync';
import { notifyChange } from '../utils/crossTab';
import type { FlightLine } from '../types/flightline';

interface LineState {
  items: FlightLine[];
  baseItems: FlightLine[];
  conflicts: FieldConflict[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 某任务的航线参数（每任务一条，取 lineNo 最小者） */
  byMission: (missionId: string) => FlightLine | undefined;
  save: (line: FlightLine) => Promise<void>;
  /** 从数据库重读并三路合并（其他标签页改动后调用） */
  syncFromDb: () => Promise<void>;
  resolveConflict: (conflictKey: string, choice: 'local' | 'remote') => Promise<void>;
}

/** 航线参数（重叠率 / GSD）改动 → 相关成果立刻失效 */
async function markAssetsStale(missionId: string) {
  const { useAssetStore } = await import('./assetStore');
  await useAssetStore.getState().markStaleByMission(missionId);
}

export const useLineStore = create<LineState>((set, get) => ({
  items: [],
  baseItems: [],
  conflicts: [],
  loaded: false,
  async load() {
    const rows = await db.lines.toArray();
    rows.sort((a, b) => a.lineNo - b.lineNo);
    set({ items: rows, baseItems: rows, conflicts: [], loaded: true });
  },
  byMission(missionId) {
    return get()
      .items.filter((l) => l.missionId === missionId)
      .sort((a, b) => a.lineNo - b.lineNo)[0];
  },
  async save(line) {
    const record: FlightLine = { ...line, id: line.id || newId('line'), updatedAt: Date.now() };
    await db.lines.put(record);
    const exists = get().items.some((it) => it.id === record.id);
    const nextItems = exists
      ? get().items.map((it) => (it.id === record.id ? record : it))
      : [...get().items, record];
    const prev = get().baseItems.find((b) => b.id === record.id);
    // 保存后本标签页底本推进到新值
    set({ items: nextItems, baseItems: nextItems });
    const paramsChanged =
      !prev ||
      prev.overlapForward !== record.overlapForward ||
      prev.overlapSide !== record.overlapSide ||
      prev.gsd !== record.gsd ||
      prev.heading !== record.heading;
    if (paramsChanged) await markAssetsStale(record.missionId);
    notifyChange(record.missionId, 'lines');
  },
  async syncFromDb() {
    const prevBase = get().baseItems;
    await syncEntity(
      db.lines,
      LINE_FIELDS,
      'line',
      get,
      set,
      async (outcome: MergeResult<FlightLine>) => {
        // 合并后若航线参数相对底本发生变化，相关成果失效
        const changed = new Set<string>();
        outcome.merged.forEach((m) => {
          const old = prevBase.find((b) => b.id === m.id);
          if (
            old &&
            (old.overlapForward !== m.overlapForward || old.overlapSide !== m.overlapSide || old.gsd !== m.gsd)
          ) {
            changed.add(m.missionId);
          }
        });
        for (const mid of changed) await markAssetsStale(mid);
      },
    );
  },
  async resolveConflict(conflictKey, choice) {
    const objectId = conflictKey.split(':')[1];
    const before = get().items.find((l) => l.id === objectId);
    await resolveEntityConflict(db.lines, get, set, conflictKey, choice, (mid) => notifyChange(mid, 'lines'));
    const after = get().items.find((l) => l.id === objectId);
    // 解决冲突后航线参数若有变化，相关成果失效
    if (
      before &&
      after &&
      (before.overlapForward !== after.overlapForward || before.overlapSide !== after.overlapSide || before.gsd !== after.gsd)
    ) {
      await markAssetsStale(after.missionId);
    }
  },
}));
