/**
 * 多标签页同步通道。
 *
 * - BroadcastChannel：同域标签页实时通信（现代浏览器）。
 * - localStorage tick：降级方案，触发其他标签页的 storage 事件。
 * - visibilitychange / focus：切回标签页时重连，确保“切回任一标签页都显示合并后的同一版本”。
 *
 * 收到变更通知后，由 SyncBridge 分发给对应 store 重新读库并三路合并。
 */

export type ChangeKind = 'waypoints' | 'lines' | 'assets' | 'mission' | 'all';

export interface SyncMessage {
  missionId: string; // '*' 表示全部任务
  kind: ChangeKind;
  ts: number;
}

const CHANNEL_NAME = 'gbdronemap-sync';
const LS_TICK_KEY = 'gbdronemap:sync-tick';

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** 本标签页写库后通知其他标签页 */
export function notifyChange(missionId: string, kind: ChangeKind): void {
  const msg: SyncMessage = { missionId, kind, ts: Date.now() };
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* BroadcastChannel 不可用时忽略 */
  }
  try {
    // localStorage 写入会在其他标签页触发 storage 事件（本标签页不触发）
    window.localStorage.setItem(LS_TICK_KEY, JSON.stringify(msg));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

/** 订阅其他标签页（或切回标签页）的变更 */
export function subscribeChanges(cb: (msg: SyncMessage) => void): () => void {
  const ch = getChannel();
  const onMessage = (event: MessageEvent) => {
    const data = event.data as SyncMessage | undefined;
    if (data && typeof data.missionId === 'string') cb(data);
  };
  ch?.addEventListener('message', onMessage as EventListener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== LS_TICK_KEY || !event.newValue) return;
    try {
      const data = JSON.parse(event.newValue) as SyncMessage;
      if (data && typeof data.missionId === 'string') cb(data);
    } catch {
      /* 忽略解析失败 */
    }
  };
  window.addEventListener('storage', onStorage);

  const onReturn = () => {
    if (document.visibilityState === 'visible') {
      cb({ missionId: '*', kind: 'all', ts: Date.now() });
    }
  };
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);

  return () => {
    ch?.removeEventListener('message', onMessage as EventListener);
    window.removeEventListener('storage', onStorage);
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('focus', onReturn);
  };
}
