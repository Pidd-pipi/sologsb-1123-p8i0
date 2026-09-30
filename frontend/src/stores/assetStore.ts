import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { ASSET_FIELDS, type FieldConflict } from '../utils/merge';
import { resolveEntityConflict, syncEntity } from '../utils/storeSync';
import { notifyChange } from '../utils/crossTab';
import { calcGsd } from '../utils/geoCalc';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  baseItems: ImageAsset[];
  conflicts: FieldConflict[];
  loaded: boolean;
  load: () => Promise<void>;
  addMany: (drafts: ImageAssetDraft[]) => Promise<ImageAsset[]>;
  update: (id: string, patch: Partial<ImageAsset>) => Promise<void>;
  markMany: (ids: string[], quality: ImageQuality) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (missionId: string) => { quality: ImageQuality; count: number }[];
  /** 把某任务的成果标记为失效（航线参数改动后调用） */
  markStaleByMission: (missionId: string) => Promise<void>;
  /** 按当前航线参数重算某任务的失效成果，清除 stale 标记 */
  recalcMission: (missionId: string) => Promise<number>;
  staleCount: (missionId: string) => number;
  /** 从数据库重读并三路合并（其他标签页改动后调用） */
  syncFromDb: () => Promise<void>;
  resolveConflict: (conflictKey: string, choice: 'local' | 'remote') => Promise<void>;
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  baseItems: [],
  conflicts: [],
  loaded: false,
  async load() {
    const rows = await db.assets.toArray();
    rows.sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs, baseItems: rows, conflicts: [], loaded: true });
  },
  async addMany(drafts) {
    const records: ImageAsset[] = drafts.map((d) => ({ ...d, id: newId('asset') }));
    const thumbRecords: AssetThumb[] = records.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
    }));
    // 缩略图单独建表存放
    await db.assets.bulkPut(records);
    await db.thumbs.bulkPut(thumbRecords);
    const nextThumbs = { ...get().thumbs };
    thumbRecords.forEach((t) => {
      nextThumbs[t.id] = t.dataUrl;
    });
    set({ items: [...get().items, ...records], thumbs: nextThumbs });
    const missionIds = new Set(records.map((r) => r.missionId));
    missionIds.forEach((mid) => notifyChange(mid, 'assets'));
    return records;
  },
  async update(id, patch) {
    await db.assets.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    const prev = get().items.find((it) => it.id === id);
    if (prev) notifyChange(prev.missionId, 'assets');
  },
  async markMany(ids, quality) {
    for (const id of ids) {
      await db.assets.update(id, { quality });
    }
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, quality } : it)) });
    const missionIds = new Set(
      get().items.filter((it) => ids.includes(it.id)).map((it) => it.missionId),
    );
    missionIds.forEach((mid) => notifyChange(mid, 'assets'));
  },
  async removeMany(ids) {
    const missionIds = new Set(
      get().items.filter((it) => ids.includes(it.id)).map((it) => it.missionId),
    );
    await db.assets.bulkDelete(ids);
    await db.thumbs.bulkDelete(ids);
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    set({ items: get().items.filter((it) => !ids.includes(it.id)), thumbs: nextThumbs });
    missionIds.forEach((mid) => notifyChange(mid, 'assets'));
  },
  byMission(missionId) {
    return get().items.filter((it) => it.missionId === missionId);
  },
  qualityStats(missionId) {
    const list = get().items.filter((it) => it.missionId === missionId);
    return (['合格', '模糊', '过曝'] as ImageQuality[]).map((quality) => ({
      quality,
      count: list.filter((it) => it.quality === quality).length,
    }));
  },
  async markStaleByMission(missionId) {
    const targets = get().items.filter((it) => it.missionId === missionId && !it.stale);
    if (targets.length === 0) return;
    const ids = targets.map((it) => it.id);
    await db.assets.bulkUpdate(ids.map((id) => ({ key: id, changes: { stale: true } })));
    set({ items: get().items.map((it) => (ids.includes(it.id) ? { ...it, stale: true } : it)) });
    notifyChange(missionId, 'assets');
  },
  async recalcMission(missionId) {
    const { useMissionStore } = await import('./missionStore');
    const { useLineStore } = await import('./lineStore');
    const mission = useMissionStore.getState().items.find((m) => m.id === missionId);
    const line = useLineStore.getState().byMission(missionId);
    const stale = get().items.filter((it) => it.missionId === missionId && it.stale);
    if (stale.length === 0) return 0;
    const focal = mission?.focalLength ?? 8.8;
    const pixel = mission?.pixelSize ?? 2.4;
    const nextOverlap = line?.overlapForward;
    const updated: ImageAsset[] = stale.map((it) => ({
      ...it,
      gsd: calcGsd(pixel, it.altitude, focal),
      overlap: nextOverlap ?? it.overlap,
      stale: false,
    }));
    await db.assets.bulkPut(updated);
    const updatedIds = new Set(updated.map((u) => u.id));
    set({
      items: get().items.map((it) => (updatedIds.has(it.id) ? { ...it, stale: false } : it)),
    });
    notifyChange(missionId, 'assets');
    return updated.length;
  },
  staleCount(missionId) {
    return get().items.filter((it) => it.missionId === missionId && it.stale).length;
  },
  async syncFromDb() {
    await syncEntity(db.assets, ASSET_FIELDS, 'asset', get, set);
  },
  async resolveConflict(conflictKey, choice) {
    await resolveEntityConflict(db.assets, get, set, conflictKey, choice, (mid) => notifyChange(mid, 'assets'));
  },
}));
