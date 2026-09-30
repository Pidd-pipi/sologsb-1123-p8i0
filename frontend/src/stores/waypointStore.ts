import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { WAYPOINT_FIELDS, type FieldConflict } from '../utils/merge';
import { resolveEntityConflict, syncEntity } from '../utils/storeSync';
import { notifyChange } from '../utils/crossTab';
import type { Waypoint, WaypointDraft } from '../types/waypoint';

interface WaypointState {
  items: Waypoint[];
  baseItems: Waypoint[];
  conflicts: FieldConflict[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<void>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byMission: (missionId: string) => Waypoint[];
  /** 从数据库重读并三路合并（其他标签页改动后调用） */
  syncFromDb: () => Promise<void>;
  resolveConflict: (conflictKey: string, choice: 'local' | 'remote') => Promise<void>;
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  baseItems: [],
  conflicts: [],
  loaded: false,
  async load() {
    const rows = await db.waypoints.toArray();
    rows.sort((a, b) => a.seq - b.seq);
    set({ items: rows, baseItems: rows, conflicts: [], loaded: true });
  },
  async add(draft) {
    const record: Waypoint = { ...draft, id: newId('wp') };
    await db.waypoints.put(record);
    set({ items: [...get().items, record] });
    notifyChange(record.missionId, 'waypoints');
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...d, id: newId('wp') }));
    await db.waypoints.bulkPut(records);
    set({ items: [...get().items, ...records] });
    const missionIds = new Set(records.map((r) => r.missionId));
    missionIds.forEach((mid) => notifyChange(mid, 'waypoints'));
    return records;
  },
  async update(id, patch) {
    const prev = get().items.find((it) => it.id === id);
    await db.waypoints.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    if (prev) {
      // 航高改动会改变 GSD，相关成果立刻失效
      if (patch.altitude !== undefined && patch.altitude !== prev.altitude) {
        const { useAssetStore } = await import('./assetStore');
        await useAssetStore.getState().markStaleByMission(prev.missionId);
      }
      notifyChange(prev.missionId, 'waypoints');
    }
  },
  /** 与相邻航点交换序号 */
  async move(id, direction) {
    const list = get().byMission(get().items.find((it) => it.id === id)?.missionId ?? '');
    const index = list.findIndex((it) => it.id === id);
    const target = direction === 'up' ? list[index - 1] : list[index + 1];
    if (!target) return;
    await get().reorder(id, target.id);
  },
  async reorder(fromId, toId) {
    const from = get().items.find((it) => it.id === fromId);
    const to = get().items.find((it) => it.id === toId);
    if (!from || !to) return;
    const fromSeq = from.seq;
    await db.waypoints.update(from.id, { seq: to.seq });
    await db.waypoints.update(to.id, { seq: fromSeq });
    set({
      items: get().items.map((it) => {
        if (it.id === from.id) return { ...it, seq: to.seq };
        if (it.id === to.id) return { ...it, seq: fromSeq };
        return it;
      }),
    });
    notifyChange(from.missionId, 'waypoints');
  },
  async removeByMission(missionId) {
    const ids = get().items.filter((it) => it.missionId === missionId).map((it) => it.id);
    await db.waypoints.bulkDelete(ids);
    set({ items: get().items.filter((it) => it.missionId !== missionId) });
    notifyChange(missionId, 'waypoints');
  },
  async remove(id) {
    const prev = get().items.find((it) => it.id === id);
    await db.waypoints.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    if (prev) notifyChange(prev.missionId, 'waypoints');
  },
  byMission(missionId) {
    return get()
      .items.filter((it) => it.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
  },
  async syncFromDb() {
    await syncEntity(db.waypoints, WAYPOINT_FIELDS, 'waypoint', get, set);
  },
  async resolveConflict(conflictKey, choice) {
    const objectId = conflictKey.split(':')[1];
    const before = get().items.find((w) => w.id === objectId);
    await resolveEntityConflict(db.waypoints, get, set, conflictKey, choice, (mid) => notifyChange(mid, 'waypoints'));
    const after = get().items.find((w) => w.id === objectId);
    // 解决冲突后航高若有变化（GSD 随之变），相关成果失效
    if (before && after && before.altitude !== after.altitude) {
      const { useAssetStore } = await import('./assetStore');
      await useAssetStore.getState().markStaleByMission(after.missionId);
    }
  },
}));
