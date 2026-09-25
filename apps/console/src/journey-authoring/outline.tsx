/**
 * J5.6 (#344): semantic outline — ทุก authoring operation (เพิ่ม/ต่อ/ตัด/เรียง/ลบ) ทำได้ที่นี่ด้วย
 * control ปกติโดยไม่ต้องลาก และส่ง command เดียวกับ canvas
 */
import { useId, useState } from 'react';
import type { AuthoringDocumentV1, JourneyPortId } from '@d-contact/cxa-contracts';
import { useTranslation } from '@d-contact/i18n/react';
import { Button } from '@d-contact/ui-react';
import { nodeDomId } from './canvas.js';
import {
  NODE_LABELS,
  PORT_LABELS,
  STEP_NODE_TYPES,
  edgeFrom,
  newId,
  nodeTitle,
  nodeTypeOf,
  outlineOrder,
  outputPorts,
  type AuthoringCommand,
  type StepNodeType,
} from './model.js';

function AddStep({
  label,
  after,
  onCommand,
}: {
  label: string;
  after?: { nodeId: string; portId: JourneyPortId };
  onCommand: (command: AuthoringCommand) => void;
}) {
  const { t } = useTranslation('journeys');
  const selectId = useId();
  const [type, setType] = useState<StepNodeType>('SEND');
  return (
    <div className="j5-add-step">
      <label htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        value={type}
        onChange={(event) => setType(event.target.value as StepNodeType)}
      >
        {STEP_NODE_TYPES.map((nodeType) => (
          <option key={nodeType} value={nodeType}>
            {NODE_LABELS[nodeType]}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        onPress={() =>
          onCommand({
            kind: 'ADD_NODE',
            nodeId: newId('step'),
            nodeType: type,
            edgeIds: [newId('edge'), newId('edge')],
            ...(after ? { after } : {}),
          })
        }
      >
        {t('outline.add')}
      </Button>
    </div>
  );
}

export function Outline({
  document,
  selectedNodeId,
  readOnly,
  diagnosticCounts,
  onSelect,
  onCommand,
}: {
  document: AuthoringDocumentV1;
  selectedNodeId: string | null;
  readOnly: boolean;
  diagnosticCounts: ReadonlyMap<string, number>;
  onSelect: (nodeId: string) => void;
  onCommand: (command: AuthoringCommand) => void;
}) {
  const { t } = useTranslation('journeys');
  const order = outlineOrder(document);
  return (
    <div className="j5-outline">
      <ol>
        {order.map((nodeId, index) => {
          const type = nodeTypeOf(document, nodeId);
          const trigger = nodeId === document.trigger.nodeId;
          const editable = !readOnly && type !== 'UNSUPPORTED';
          const issues = diagnosticCounts.get(nodeId) ?? 0;
          const documentIndex = document.nodes.findIndex((node) => node.nodeId === nodeId);
          return (
            <li
              key={nodeId}
              className="j5-outline-item"
              aria-current={selectedNodeId === nodeId ? 'true' : undefined}
            >
              <div className="j5-outline-head">
                <button
                  type="button"
                  id={nodeDomId('outline', nodeId)}
                  className="j5-link"
                  aria-current={selectedNodeId === nodeId ? 'true' : undefined}
                  onClick={() => onSelect(nodeId)}
                >
                  {index + 1}. {nodeTitle(document, nodeId)}
                </button>
                <span className="j5-outline-type">
                  {type === 'UNSUPPORTED' ? t('outline.readOnlyType') : type}
                </span>
                {issues > 0 ? (
                  <span className="j5-badge-error">{t('outline.issues', { count: issues })}</span>
                ) : null}
              </div>
              {outputPorts(document, nodeId).map((portId) => {
                const target = edgeFrom(document, nodeId, portId)?.target.nodeId ?? '';
                const selectId = `${nodeDomId('outline', nodeId)}-${portId}`;
                return (
                  <div key={portId} className="j5-port-row">
                    <label htmlFor={selectId}>
                      {t('outline.portTarget', {
                        port: PORT_LABELS[portId],
                        node: nodeTitle(document, nodeId),
                      })}
                    </label>
                    <select
                      id={selectId}
                      value={target}
                      disabled={!editable}
                      onChange={(event) =>
                        onCommand(
                          event.target.value
                            ? {
                                kind: 'CONNECT',
                                edgeId: newId('edge'),
                                source: { nodeId, portId },
                                targetNodeId: event.target.value,
                              }
                            : { kind: 'DISCONNECT', nodeId, portId },
                        )
                      }
                    >
                      <option value="">{t('outline.notConnected')}</option>
                      {order
                        .filter(
                          (candidate) =>
                            candidate !== nodeId &&
                            candidate !== document.trigger.nodeId &&
                            nodeTypeOf(document, candidate) !== 'UNSUPPORTED',
                        )
                        .map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {nodeTitle(document, candidate)}
                          </option>
                        ))}
                    </select>
                    {editable ? (
                      <AddStep
                        label={t('outline.insertAfter', { port: PORT_LABELS[portId] })}
                        after={{ nodeId, portId }}
                        onCommand={onCommand}
                      />
                    ) : null}
                  </div>
                );
              })}
              {editable && !trigger ? (
                <div className="j5-outline-actions">
                  <Button
                    size="sm"
                    isDisabled={documentIndex <= 0}
                    onPress={() => onCommand({ kind: 'REORDER', nodeId, direction: 'up' })}
                  >
                    {t('outline.moveUp')}
                    <span className="j5-sr"> {nodeTitle(document, nodeId)}</span>
                  </Button>
                  <Button
                    size="sm"
                    isDisabled={documentIndex >= document.nodes.length - 1}
                    onPress={() => onCommand({ kind: 'REORDER', nodeId, direction: 'down' })}
                  >
                    {t('outline.moveDown')}
                    <span className="j5-sr"> {nodeTitle(document, nodeId)}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onPress={() => onCommand({ kind: 'DELETE_NODE', nodeId })}
                  >
                    {t('outline.delete')}
                    <span className="j5-sr"> {nodeTitle(document, nodeId)}</span>
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {readOnly ? null : <AddStep label={t('outline.addUnconnected')} onCommand={onCommand} />}
    </div>
  );
}
