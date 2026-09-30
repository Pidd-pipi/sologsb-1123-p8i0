import { useState } from 'react';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { MergeCellsOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMissionCollab } from '../../utils/collab';
import { useCollabStore } from '../../stores/collabStore';
import { useAssetStore } from '../../stores/assetStore';

/**
 * 任务级协作横幅：
 * - 存在未解决合并差异 → 提示并可打开合并弹窗（选定前不写回）。
 * - 存在因航线参数改动而失效的成果 → 提示并可一键重算。
 * 被航线规划页 / 航点明细页 / 成果编目页消费。
 */
export default function MissionCollabBanner({ missionId }: { missionId: string | undefined }) {
  const { conflicts, staleCount } = useMissionCollab(missionId);
  const openConflictModal = useCollabStore((s) => s.openConflictModal);
  const recalcMission = useAssetStore((s) => s.recalcMission);
  const [recalcMsg, setRecalcMsg] = useState('');

  if (!missionId) return null;
  if (conflicts.length === 0 && staleCount === 0) return null;

  const conflictCount = conflicts.length;

  const onRecalc = async () => {
    const n = await recalcMission(missionId);
    setRecalcMsg(`已按当前航线参数重算 ${n} 张失效成果`);
    window.setTimeout(() => setRecalcMsg(''), 2600);
  };

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {conflictCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          icon={<MergeCellsOutlined />}
          message={
            <Space wrap>
              <span>
                本任务有 <Tag color="red">{conflictCount}</Tag> 处航点 / 航线参数 / 成果影像差异待合并
                （其他标签页与本方改动了同一对象，底本不同）。
              </span>
              <Button size="small" type="primary" onClick={() => openConflictModal(missionId)}>
                去合并差异
              </Button>
            </Space>
          }
        />
      ) : null}
      {staleCount > 0 ? (
        <Alert
          type="error"
          showIcon
          icon={<ThunderboltOutlined />}
          message={
            <Space wrap>
              <span>
                航线参数已改动，<Tag color="red">{staleCount}</Tag> 张成果影像失效（GSD / 重叠度不再反映当前航线），需重算后才能归档。
              </span>
              <Button size="small" type="primary" danger onClick={onRecalc}>
                一键重算失效成果
              </Button>
              {recalcMsg ? <Typography.Text type="secondary">{recalcMsg}</Typography.Text> : null}
            </Space>
          }
        />
      ) : null}
    </Space>
  );
}
