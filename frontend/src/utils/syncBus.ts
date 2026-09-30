/**
 * 多标签页数据同步总线。
 *
 * 任一标签页完成 IndexedDB 写入后 emit；其他标签页收到后只做「重新从 DB 读取」，
 * 不直接套用消息体，因此各页最终一定读到同一份落库的合并版本。
 *
 * 双通道：BroadcastChannel（首选，同源标签页）+ window storage 事件（兜底）。
 * 同一微任务批次内对同一表的多次 emit 合并为一次，避免批量写入触发抖动。
 */
import { TAB_ID } from './tabId';

export type SyncTable = 'missions' | 'waypoints' | 'lines' | 'assets' | 'thumbs' | 'conflicts' | 'presets';

export interface SyncMessage {
  /** 发送方标签页标识 */
  from: string;
  tables: SyncTable[];
  /** 受影响的任务 id（用于页面级提示，可缺省） */
  missionIds?: string[];
  at: number;
}

const CHANNEL_NAME = 'gbdronemap:sync';
const STORAGE_KEY = 'gbdronemap:sync-ping';

type Listener = (msg: SyncMessage) => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function dispatch(msg: SyncMessage): void {
  listeners.forEach((fn) => {
    try {
      fn(msg);
    } catch {
      /* 单个监听失败不影响其余 */
    }
  });
}

function initChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (ev: MessageEvent<SyncMessage>) => {
    if (ev.data && Array.isArray(ev.data.tables)) dispatch(ev.data);
  };
  return channel;
}

if (typeof window !== 'undefined') {
  initChannel();
  // BroadcastChannel 不可用时的兜底通道
  window.addEventListener('storage', (ev) => {
    if (ev.key !== STORAGE_KEY || !ev.newValue) return;
    try {
      const msg = JSON.parse(ev.newValue) as SyncMessage;
      if (msg && Array.isArray(msg.tables)) dispatch(msg);
    } catch {
      /* 忽略无法解析的兜底消息 */
    }
  });
}

/** 订阅其他标签页（默认不含自己）的数据变更 */
export function subscribeSync(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const pending = new Map<SyncTable, Set<string>>();
let flushScheduled = false;

function flush(from: string): void {
  flushScheduled = false;
  const tables = Array.from(pending.keys());
  const missionIds = Array.from(new Set(Array.from(pending.values()).flatMap((s) => Array.from(s))));
  pending.clear();
  if (tables.length === 0) return;
  const msg: SyncMessage = { from, tables, missionIds: missionIds.length > 0 ? missionIds : undefined, at: Date.now() };
  channel?.postMessage(msg);
  try {
    // storage 兜底：同页不触发 storage 事件，只会被其他标签页收到
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(msg));
  } catch {
    /* localStorage 不可用时仅依赖 BroadcastChannel */
  }
}

/**
 * 广播一次数据变更。默认所有标签页（含发送方自身）都会重新拉取，
 * 保证「切回任一标签页都显示合并后的同一版本」。
 */
export function emitSync(tables: SyncTable | SyncTable[], missionIds: string[] = [], from: string = TAB_ID): void {
  const list = Array.isArray(tables) ? tables : [tables];
  list.forEach((t) => {
    let set = pending.get(t);
    if (!set) {
      set = new Set<string>();
      pending.set(t, set);
    }
    missionIds.forEach((id) => set!.add(id));
  });
  if (!flushScheduled) {
    flushScheduled = true;
    // 用微任务批量合并同一轮事务里的多张表
    Promise.resolve().then(() => flush(from));
  }
}
