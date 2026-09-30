import { create } from 'zustand';
import { db, loadFlightLine } from '../utils/db';
import { mergePut, rememberBases, forgetBase } from '../utils/merge';
import { emitSync } from '../utils/syncBus';
import { TAB_ID } from '../utils/tabId';
import { newId } from '../utils/id';
import { makeThumbDataUrl, type AssetThumb, type ImageAsset, type ImageAssetDraft, type ImageQuality } from '../types/imageasset';

interface AssetState {
  items: ImageAsset[];
  thumbs: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中全量重拉（跨标签页变更后调用） */
  resync: () => Promise<void>;
  addMany: (drafts: ImageAssetDraft[]) => Promise<ImageAsset[]>;
  /** 返回本次提交仍待选定的字段（对象 id → 字段列表） */
  update: (id: string, patch: Partial<ImageAsset>) => Promise<string[]>;
  markMany: (ids: string[], quality: ImageQuality) => Promise<void>;
  removeMany: (ids: string[]) => Promise<void>;
  staleCount: (missionId: string) => number;
  byMission: (missionId: string) => ImageAsset[];
  qualityStats: (missionId: string) => { quality: ImageQuality; count: number }[];
}

function sortByImageNo(items: ImageAsset[]): ImageAsset[] {
  return [...items].sort((a, b) => a.imageNo.localeCompare(b.imageNo, 'zh-Hans-CN', { numeric: true }));
}

export const useAssetStore = create<AssetState>((set, get) => ({
  items: [],
  thumbs: {},
  loaded: false,
  async load() {
    const rows = sortByImageNo(await db.assets.toArray());
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    rememberBases('asset', rows);
    set({ items: rows, thumbs, loaded: true });
  },
  async resync() {
    const rows = sortByImageNo(await db.assets.toArray());
    rememberBases('asset', rows);
    const thumbRows = await db.thumbs.toArray();
    const thumbs: Record<string, string> = {};
    thumbRows.forEach((t) => {
      thumbs[t.id] = t.dataUrl;
    });
    set({ items: rows, thumbs });
  },
  async addMany(drafts) {
    // 新建成果以当前航线版本为基线，不处于失效态
    const lineRev = drafts[0] ? (await loadFlightLine(drafts[0].missionId))?.rev ?? 0 : 0;
    const records: ImageAsset[] = drafts.map((d) => ({ ...d, id: newId('asset'), rev: 1, stale: false, lineRev }));
    const thumbRecords: AssetThumb[] = records.map((r) => ({
      id: r.id,
      missionId: r.missionId,
      dataUrl: makeThumbDataUrl(r.imageNo, r.quality, r.lng, r.lat),
    }));
    // 缩略图单独建表存放
    await db.assets.bulkPut(records);
    await db.thumbs.bulkPut(thumbRecords);
    rememberBases('asset', records);
    const nextThumbs = { ...get().thumbs };
    thumbRecords.forEach((t) => {
      nextThumbs[t.id] = t.dataUrl;
    });
    set({ items: sortByImageNo([...get().items, ...records]), thumbs: nextThumbs });
    const missionIds = Array.from(new Set(records.map((r) => r.missionId)));
    emitSync(['assets', 'thumbs'], missionIds);
    return records;
  },
  async update(id, patch) {
    const base = get().items.find((it) => it.id === id);
    if (!base) return [];
    const proposed: ImageAsset = { ...base, ...patch, id: base.id };
    const result = await mergePut('asset', proposed, TAB_ID);
    await get().resync();
    emitSync(['assets', 'conflicts'], [base.missionId]);
    return result.conflictFields;
  },
  async markMany(ids, quality) {
    const missionIds = new Set<string>();
    for (const id of ids) {
      const base = get().items.find((it) => it.id === id);
      if (!base) continue;
      missionIds.add(base.missionId);
      // 批量标记按对象逐个三方合并，避免覆盖他页对同一影像的编目改动
      // eslint-disable-next-line no-await-in-loop
      await mergePut('asset', { ...base, quality, id: base.id }, TAB_ID);
    }
    await get().resync();
    emitSync(['assets', 'conflicts'], Array.from(missionIds));
  },
  async removeMany(ids) {
    await db.transaction('rw', [db.assets, db.thumbs, db.conflicts], async () => {
      await db.assets.bulkDelete(ids);
      await db.thumbs.bulkDelete(ids);
      const all = await db.conflicts.where('objectId').anyOf(ids).toArray();
      await db.conflicts.bulkDelete(all.filter((c) => c.kind === 'asset').map((c) => c.id));
    });
    ids.forEach((id) => forgetBase('asset', id));
    const nextThumbs = { ...get().thumbs };
    ids.forEach((id) => {
      delete nextThumbs[id];
    });
    const missionIds = Array.from(new Set(get().items.filter((it) => ids.includes(it.id)).map((it) => it.missionId)));
    set({ items: get().items.filter((it) => !ids.includes(it.id)), thumbs: nextThumbs });
    emitSync(['assets', 'conflicts'], missionIds);
  },
  staleCount(missionId) {
    return get().items.filter((it) => it.missionId === missionId && it.stale).length;
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
}));
