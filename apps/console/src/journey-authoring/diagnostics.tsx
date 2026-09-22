/**
 * J5.6 (#344): error summary จาก server — แต่ละรายการลิงก์กลับไปที่ node/field ที่เกี่ยวข้อง
 * และจำนวนปัญหาประกาศผ่าน live region (ไม่ใช้ toast เป็นตัวบอก blocker)
 */
import type { AuthoringDocumentV1, JourneyDiagnosticV1 } from '@d-contact/cxa-contracts';
import { errorMessage, nodeTitle, nodeTypeOf } from './model.js';

export function diagnosticNodeId(diagnostic: JourneyDiagnosticV1): string | undefined {
  const params = diagnostic.safeParams as Record<string, unknown> | undefined;
  const nodeId = diagnostic.path?.nodeId ?? params?.nodeId;
  return typeof nodeId === 'string' ? nodeId : undefined;
}

export function diagnosticCounts(
  diagnostics: readonly JourneyDiagnosticV1[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const nodeId = diagnosticNodeId(diagnostic);
    if (nodeId && diagnostic.severity === 'ERROR')
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
  }
  return counts;
}

export function Diagnostics({
  document,
  diagnostics,
  checked,
  onFocusNode,
}: {
  document: AuthoringDocumentV1;
  diagnostics: readonly JourneyDiagnosticV1[];
  /** ยังไม่เคยตรวจกับ server — ไม่แสดงว่า "ไม่มีปัญหา" แบบเข้าใจผิด */
  checked: boolean;
  onFocusNode: (nodeId: string) => void;
}) {
  const errors = diagnostics.filter((entry) => entry.severity === 'ERROR');
  const summary = !checked
    ? 'ยังไม่ได้ตรวจกับ server สำหรับฉบับที่เห็นอยู่'
    : errors.length === 0
      ? 'server ตรวจแล้วไม่พบข้อผิดพลาด'
      : `server พบข้อผิดพลาด ${errors.length} รายการ`;
  return (
    <div className="j5-diagnostics">
      <p
        role="status"
        aria-live="polite"
        className={errors.length > 0 ? 'j5-status-error' : 'j5-status'}
      >
        {summary}
      </p>
      {diagnostics.length > 0 ? (
        <ul>
          {diagnostics.map((diagnostic, index) => {
            const nodeId = diagnosticNodeId(diagnostic);
            const known = nodeId && nodeTypeOf(document, nodeId);
            const field =
              diagnostic.path?.field ??
              (diagnostic.safeParams as { field?: string } | undefined)?.field;
            return (
              <li
                key={`${diagnostic.code}-${index}`}
                className={`j5-diagnostic-${diagnostic.severity.toLowerCase()}`}
              >
                <span className="j5-code">{diagnostic.code}</span> {errorMessage(diagnostic.code)}
                {field ? <span className="j5-help"> · field {String(field)}</span> : null}
                {known ? (
                  <>
                    {' '}
                    <button type="button" className="gov-link" onClick={() => onFocusNode(nodeId)}>
                      ไปที่ {nodeTitle(document, nodeId)}
                    </button>
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
