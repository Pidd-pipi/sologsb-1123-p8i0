/**
 * 当前标签页的稳定短标识（仅用于合并差异台账中标注值来自哪一页）。
 * 同一标签页生命周期内不变；新建标签页即换一个编号。
 */
const LS_KEY = 'gbdronemap:tab-seq';

function makeTabId(): string {
  let seq = 1;
  try {
    seq = Number(window.sessionStorage.getItem(LS_KEY) ?? '') || 0;
    if (!seq) {
      seq = Number(window.localStorage.getItem(LS_KEY) ?? '0') + 1;
      window.localStorage.setItem(LS_KEY, String(seq));
    }
    window.sessionStorage.setItem(LS_KEY, String(seq));
  } catch {
    seq = Math.floor(Math.random() * 9000) + 1000;
  }
  return `标签页#${seq}`;
}

export const TAB_ID: string = typeof window === 'undefined' ? '标签页#?' : makeTabId();
