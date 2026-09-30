import { useEffect } from 'react';
import { subscribeSync, type SyncTable } from '../utils/syncBus';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useAssetStore } from '../stores/assetStore';
import { useLineStore } from '../stores/lineStore';
import { useConflictStore } from '../stores/conflictStore';

const RESYNC: Record<SyncTable, () => Promise<void>> = {
  missions: () => useMissionStore.getState().resync(),
  waypoints: () => useWaypointStore.getState().resync(),
  lines: () => useLineStore.getState().resync(),
  assets: () => useAssetStore.getState().resync(),
  thumbs: () => useAssetStore.getState().resync(),
  conflicts: () => useConflictStore.getState().resync(),
  presets: () => useMissionStore.getState().resyncPresets(),
};

const resyncTables = (tables: SyncTable[]) => {
  const uniq = Array.from(new Set(tables));
  uniq.forEach((t) => {
    void RESYNC[t]();
  });
};

/**
 * 挂载跨标签页数据同步：
 * - 收到其他页（含本页）广播后按表从 IndexedDB 重新拉取合并版本；
 * - 标签页重新可见 / 窗口重新聚焦时兜底再拉一次，
 *   保证切回任一标签页看到的都是合并后的同一版本。
 */
export function useCrossTabSync() {
  useEffect(() => {
    const unsubscribe = subscribeSync((msg) => resyncTables(msg.tables));

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        resyncTables(['missions', 'waypoints', 'lines', 'assets', 'conflicts', 'presets']);
      }
    };
    const onFocus = () => resyncTables(['missions', 'waypoints', 'lines', 'assets', 'conflicts', 'presets']);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
