/**
 * J5.6 (#344): visual projection ของ graph — ทุกอย่างที่ทำบน canvas ทำได้ด้วย keyboard และทุกคำสั่ง
 * ส่งเข้า reducer ตัวเดียวกับ outline
 *
 * - roving tabindex: Tab เข้า canvas ได้หนึ่งจุด ลูกศรขึ้น/ลงย้าย focus ตามลำดับเดียวกับ outline
 * - Enter/Space เลือก node เพื่อแก้ใน properties; Shift+ลูกศรขยับตำแหน่ง (visual-only); Delete ลบ
 * - ลากด้วย pointer ได้แต่ไม่จำเป็น — ตำแหน่งเป็น layout ล้วน compiler ไม่อ่าน
 */
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { AuthoringDocumentV1 } from '@d-contact/cxa-contracts';
import { useTranslation } from '@d-contact/i18n/react';
import {
  PORT_LABELS,
  edgeFrom,
  nodeTitle,
  nodeTypeOf,
  outlineOrder,
  outputPorts,
  type AuthoringCommand,
} from './model.js';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 76;
const MOVE_STEP = 20;

export function nodeDomId(prefix: 'canvas' | 'outline', nodeId: string) {
  return `j5-${prefix}-${nodeId}`;
}

export function Canvas({
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
  const [focusId, setFocusId] = useState<string>(order[0]!);
  const rovingId = order.includes(selectedNodeId ?? '')
    ? selectedNodeId!
    : order.includes(focusId)
      ? focusId
      : order[0]!;
  const drag = useRef<{ nodeId: string; dx: number; dy: number; moved: boolean } | null>(null);
  const [dragPoint, setDragPoint] = useState<{ nodeId: string; x: number; y: number } | null>(null);

  const position = (nodeId: string, index: number) => {
    if (dragPoint?.nodeId === nodeId) return dragPoint;
    return document.layout.nodes[nodeId] ?? { x: 80, y: 40 + index * 140 };
  };
  const points = new Map(order.map((nodeId, index) => [nodeId, position(nodeId, index)]));
  const width = Math.max(...[...points.values()].map((point) => point.x + NODE_WIDTH + 80), 640);
  const height = Math.max(...[...points.values()].map((point) => point.y + NODE_HEIGHT + 80), 360);

  const focusNode = (nodeId: string) => {
    setFocusId(nodeId);
    window.document.getElementById(nodeDomId('canvas', nodeId))?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, nodeId: string) => {
    const index = order.indexOf(nodeId);
    const point = points.get(nodeId)!;
    if (event.shiftKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      if (readOnly) return;
      const delta = {
        ArrowUp: [0, -MOVE_STEP],
        ArrowDown: [0, MOVE_STEP],
        ArrowLeft: [-MOVE_STEP, 0],
        ArrowRight: [MOVE_STEP, 0],
      }[event.key];
      if (delta)
        onCommand({ kind: 'MOVE_NODE', nodeId, x: point.x + delta[0]!, y: point.y + delta[1]! });
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      focusNode(order[Math.min(index + 1, order.length - 1)]!);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusNode(order[Math.max(index - 1, 0)]!);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusNode(order[0]!);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusNode(order.at(-1)!);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && !readOnly) {
      event.preventDefault();
      if (nodeId !== document.trigger.nodeId) {
        onCommand({ kind: 'DELETE_NODE', nodeId });
        focusNode(order[Math.max(index - 1, 0)]!);
      }
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, nodeId: string) => {
    if (readOnly || event.button !== 0) return;
    const point = points.get(nodeId)!;
    drag.current = {
      nodeId,
      dx: event.clientX - point.x,
      dy: event.clientY - point.y,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current) return;
    current.moved = true;
    setDragPoint({
      nodeId: current.nodeId,
      x: Math.max(0, event.clientX - current.dx),
      y: Math.max(0, event.clientY - current.dy),
    });
  };
  const onPointerUp = () => {
    const current = drag.current;
    drag.current = null;
    if (current?.moved && dragPoint) {
      onCommand({ kind: 'MOVE_NODE', nodeId: current.nodeId, x: dragPoint.x, y: dragPoint.y });
    }
    setDragPoint(null);
  };

  return (
    <div className="j5-canvas-scroll">
      <p id="j5-canvas-help" className="j5-help">
        {t('canvas.help')}
        {readOnly ? '' : t('canvas.helpEdit')}
      </p>
      <div
        className="j5-canvas"
        role="group"
        aria-label={t('canvas.label')}
        aria-describedby="j5-canvas-help"
        style={{ width, height }}
      >
        <svg className="j5-edges" width={width} height={height} aria-hidden="true">
          {document.edges.map((edge) => {
            const from = points.get(edge.source.nodeId);
            const to = points.get(edge.target.nodeId);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH / 2;
            const y1 = from.y + NODE_HEIGHT;
            const x2 = to.x + NODE_WIDTH / 2;
            const y2 = to.y;
            const mid = (y1 + y2) / 2;
            return (
              <g key={edge.edgeId}>
                <path
                  d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
                  className={`j5-edge j5-edge-${edge.source.portId}`}
                />
                <text x={(x1 + x2) / 2 + 6} y={mid} className="j5-edge-label">
                  {PORT_LABELS[edge.source.portId]}
                </text>
              </g>
            );
          })}
        </svg>
        {order.map((nodeId) => {
          const point = points.get(nodeId)!;
          const type = nodeTypeOf(document, nodeId);
          const connections = outputPorts(document, nodeId)
            .map((portId) => {
              const target = edgeFrom(document, nodeId, portId)?.target.nodeId;
              return `${PORT_LABELS[portId]}: ${target ? nodeTitle(document, target) : t('canvas.notConnected')}`;
            })
            .join(' · ');
          const issues = diagnosticCounts.get(nodeId) ?? 0;
          return (
            <button
              key={nodeId}
              id={nodeDomId('canvas', nodeId)}
              type="button"
              className={`j5-node j5-node-${type === 'UNSUPPORTED' ? 'unsupported' : 'known'}`}
              style={{ left: point.x, top: point.y, width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
              tabIndex={nodeId === rovingId ? 0 : -1}
              aria-pressed={selectedNodeId === nodeId}
              aria-label={`${nodeTitle(document, nodeId)}${issues > 0 ? t('canvas.withIssues', { count: issues }) : ''}`}
              aria-description={connections || t('canvas.terminal')}
              onFocus={() => setFocusId(nodeId)}
              onClick={() => onSelect(nodeId)}
              onKeyDown={(event) => onKeyDown(event, nodeId)}
              onPointerDown={(event) => onPointerDown(event, nodeId)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span className="j5-node-type">
                {type === 'UNSUPPORTED' ? t('canvas.readOnlyType') : type}
              </span>
              <strong>{nodeTitle(document, nodeId)}</strong>
              {issues > 0 ? (
                <span className="j5-node-issues">{t('canvas.issues', { count: issues })}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
