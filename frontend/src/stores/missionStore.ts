import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { emitSync } from '../utils/syncBus';
import { scheduleAssetRecompute } from '../utils/assetSync';
import type { CameraPreset, Mission, MissionDraft, MissionStatus } from '../types/mission';

export class ArchiveBlockedError extends Error {
  conflicts: number;
  staleAssets: number;
  constructor(conflicts: number, staleAssets: number) {
    super('archive blocked');
    this.name = 'ArchiveBlockedError';
    this.conflicts = conflicts;
    this.staleAssets = staleAssets;
  }
}

interface MissionState {
  items: Mission[];
  presets: CameraPreset[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 从库中全量重拉（跨标签页变更后调用） */
  resync: () => Promise<void>;
  resyncPresets: () => Promise<void>;
  add: (draft: MissionDraft) => Promise<Mission>;
  update: (id: string, patch: Partial<Mission>) => Promise<void>;
  setStatus: (id: string, status: MissionStatus) => Promise<void>;
  /** 归档：差异清完且成果无失效条目才允许 */
  archive: (id: string) => Promise<void>;
  applyPreset: (missionId: string, presetId: string) => Promise<boolean>;
  addPreset: (draft: Omit<CameraPreset, 'id'>) => Promise<CameraPreset>;
  removePreset: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useMissionStore = create<MissionState>((set, get) => ({
  items: [],
  presets: [],
  loaded: false,
  async load() {
    const rows = await db.missions.orderBy('createdAt').reverse().toArray();
    const presets = await db.presets.toArray();
    set({ items: rows, presets, loaded: true });
  },
  async resync() {
    const rows = await db.missions.orderBy('createdAt').reverse().toArray();
    set({ items: rows });
  },
  async resyncPresets() {
    const presets = await db.presets.toArray();
    set({ presets });
  },
  async add(draft) {
    const record: Mission = { ...draft, id: newId('mission'), createdAt: Date.now() };
    await db.missions.put(record);
    set({ items: [record, ...get().items] });
    emitSync('missions', [record.id]);
    return record;
  },
  async update(id, patch) {
    await db.missions.update(id, patch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });
    emitSync('missions', [id]);
  },
  async setStatus(id, status) {
    await get().update(id, { status });
  },
  async archive(id) {
    const [openConflicts, staleAssets] = await Promise.all([
      db.conflicts.where('missionId').equals(id).count(),
      db.assets.where('missionId').equals(id).filter((a) => a.stale).count(),
    ]);
    if (openConflicts > 0 || staleAssets > 0) {
      throw new ArchiveBlockedError(openConflicts, staleAssets);
    }
    await get().update(id, { status: '已归档' });
  },
  async applyPreset(missionId, presetId) {
    const preset = get().presets.find((p) => p.id === presetId);
    if (!preset) return false;
    const before = get().items.find((m) => m.id === missionId);
    await get().update(missionId, {
      cameraModel: preset.cameraModel,
      sensorWidth: preset.sensorWidth,
      sensorHeight: preset.sensorHeight,
      focalLength: preset.focalLength,
      pixelSize: preset.pixelSize,
    });
    // 相机/传感器参数改动同样改变 GSD：相关成果立刻失效并重算
    const sensorChanged =
      before &&
      (before.sensorWidth !== preset.sensorWidth ||
        before.sensorHeight !== preset.sensorHeight ||
        before.focalLength !== preset.focalLength ||
        before.pixelSize !== preset.pixelSize);
    if (sensorChanged) {
      // 相机/传感器改动同样改变 GSD：失效与重算广播由 assetSync 统一发出
      scheduleAssetRecompute(missionId);
    }
    return true;
  },
  async addPreset(draft) {
    const record: CameraPreset = { ...draft, id: newId('preset') };
    await db.presets.put(record);
    set({ presets: [...get().presets, record] });
    emitSync('presets');
    return record;
  },
  async removePreset(id) {
    await db.presets.delete(id);
    set({ presets: get().presets.filter((p) => p.id !== id) });
    emitSync('presets');
  },
  async remove(id) {
    await db.transaction(
      'rw',
      [db.missions, db.waypoints, db.lines, db.assets, db.thumbs, db.conflicts],
      async () => {
        const [waypoints, lines, assets] = await Promise.all([
          db.waypoints.where('missionId').equals(id).toArray(),
          db.lines.where('missionId').equals(id).toArray(),
          db.assets.where('missionId').equals(id).toArray(),
        ]);
        const assetIds = assets.map((a) => a.id);
        await db.waypoints.bulkDelete(waypoints.map((w) => w.id));
        await db.lines.bulkDelete(lines.map((l) => l.id));
        await db.assets.bulkDelete(assetIds);
        await db.thumbs.bulkDelete(assetIds);
        const conflicts = await db.conflicts.where('missionId').equals(id).toArray();
        await db.conflicts.bulkDelete(conflicts.map((c) => c.id));
        await db.missions.delete(id);
      },
    );
    set({ items: get().items.filter((it) => it.id !== id) });
    emitSync(['missions', 'waypoints', 'lines', 'assets', 'thumbs', 'conflicts'], [id]);
  },
}));
