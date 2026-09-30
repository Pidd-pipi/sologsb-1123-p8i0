import { create } from 'zustand';
import { db } from '../utils/db';
import { mergePut, rememberBases, forgetBase } from '../utils/merge';
import { emitSync } from '../utils/syncBus';
import { TAB_ID } from '../utils/tabId';
import { newId } from '../utils/id';
import type { Waypoint, WaypointDraft } from '../types/waypoint';

interface WaypointState {
  items: Waypoint[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中全量重拉（跨标签页变更后调用） */
  resync: () => Promise<void>;
  add: (draft: WaypointDraft) => Promise<Waypoint>;
  addMany: (drafts: WaypointDraft[]) => Promise<Waypoint[]>;
  update: (id: string, patch: Partial<Waypoint>) => Promise<string[]>;
  move: (id: string, direction: 'up' | 'down') => Promise<void>;
  reorder: (fromId: string, toId: string) => Promise<void>;
  removeByMission: (missionId: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byMission: (missionId: string) => Waypoint[];
}

function sorted(items: Waypoint[]): Waypoint[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

export const useWaypointStore = create<WaypointState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    await get().resync();
    set({ loaded: true });
  },
  async resync() {
    const rows = await db.waypoints.toArray();
    rememberBases('waypoint', rows);
    set({ items: rows });
  },
  async add(draft) {
    const record: Waypoint = { ...draft, id: newId('wp'), rev: 1 };
    await db.waypoints.put(record);
    rememberBases('waypoint', [record]);
    set({ items: [...get().items, record] });
    emitSync('waypoints', [record.missionId]);
    return record;
  },
  async addMany(drafts) {
    const records: Waypoint[] = drafts.map((d) => ({ ...d, id: newId('wp'), rev: 1 }));
    await db.waypoints.bulkPut(records);
    rememberBases('waypoint', records);
    set({ items: [...get().items, ...records] });
    const missionIds = Array.from(new Set(records.map((r) => r.missionId)));
    emitSync('waypoints', missionIds);
    return records;
  },
  async update(id, patch) {
    const base = get().items.find((it) => it.id === id);
    if (!base) return [];
    // 完整对象基于底本提交，未改字段与他页改动按三方合并处理
    const proposed: Waypoint = { ...base, ...patch, id: base.id };
    const result = await mergePut('waypoint', proposed, TAB_ID);
    await get().resync();
    emitSync(['waypoints', 'conflicts'], [base.missionId]);
    return result.conflictFields;
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
    if (!from || !to || fromId === toId) return;
    // 换序是显式顺序操作：各自带上交换后的 seq 走三方合并，seq 按本页意图写入
    await mergePut('waypoint', { ...from, seq: to.seq }, TAB_ID);
    await mergePut('waypoint', { ...to, seq: from.seq }, TAB_ID);
    await get().resync();
    emitSync(['waypoints', 'conflicts'], [from.missionId]);
  },
  async removeByMission(missionId) {
    const rows = await db.waypoints.where('missionId').equals(missionId).toArray();
    await db.transaction('rw', [db.waypoints, db.conflicts], async () => {
      await db.waypoints.bulkDelete(rows.map((r) => r.id));
      const cs = await db.conflicts.where('missionId').equals(missionId).filter((c) => c.kind === 'waypoint').toArray();
      await db.conflicts.bulkDelete(cs.map((c) => c.id));
    });
    rows.forEach((r) => forgetBase('waypoint', r.id));
    set({ items: get().items.filter((it) => it.missionId !== missionId) });
    emitSync(['waypoints', 'conflicts'], [missionId]);
  },
  async remove(id) {
    const row = get().items.find((it) => it.id === id);
    await db.transaction('rw', [db.waypoints, db.conflicts], async () => {
      await db.waypoints.delete(id);
      const cs = await db.conflicts.where('objectId').equals(id).filter((c) => c.kind === 'waypoint').toArray();
      await db.conflicts.bulkDelete(cs.map((c) => c.id));
    });
    forgetBase('waypoint', id);
    set({ items: get().items.filter((it) => it.id !== id) });
    emitSync(['waypoints', 'conflicts'], row ? [row.missionId] : []);
  },
  byMission(missionId) {
    return sorted(get().items.filter((it) => it.missionId === missionId));
  },
}));
