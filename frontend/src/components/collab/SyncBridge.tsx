import { useEffect } from 'react';
import { subscribeChanges } from '../../utils/crossTab';
import { useWaypointStore } from '../../stores/waypointStore';
import { useLineStore } from '../../stores/lineStore';
import { useAssetStore } from '../../stores/assetStore';
import { useMissionStore } from '../../stores/missionStore';

/**
 * 挂载在应用根部：监听其他标签页（及切回标签页）的变更通知，
 * 分发给对应 store 重新读库并三路合并，保证任一标签页都显示合并后的同一版本。
 */
export default function SyncBridge() {
  useEffect(() => {
    const unsubscribe = subscribeChanges((msg) => {
      const { kind } = msg;
      if (kind === 'waypoints' || kind === 'all') {
        void useWaypointStore.getState().syncFromDb();
      }
      if (kind === 'lines' || kind === 'all') {
        void useLineStore.getState().syncFromDb();
      }
      if (kind === 'assets' || kind === 'all') {
        void useAssetStore.getState().syncFromDb();
      }
      if (kind === 'mission' || kind === 'all') {
        void useMissionStore.getState().load();
      }
    });
    return unsubscribe;
  }, []);

  return null;
}
