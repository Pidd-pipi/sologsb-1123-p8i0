import { create } from 'zustand';

interface CollabState {
  /** 合并冲突弹窗是否打开 */
  conflictModalOpen: boolean;
  /** 弹窗聚焦的任务；null 表示全部任务 */
  conflictMissionId: string | null;
  openConflictModal: (missionId?: string) => void;
  closeConflictModal: () => void;
}

export const useCollabStore = create<CollabState>((set) => ({
  conflictModalOpen: false,
  conflictMissionId: null,
  openConflictModal: (missionId) => set({ conflictModalOpen: true, conflictMissionId: missionId ?? null }),
  closeConflictModal: () => set({ conflictModalOpen: false }),
}));
