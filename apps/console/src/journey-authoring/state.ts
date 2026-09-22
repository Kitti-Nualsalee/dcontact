/**
 * J5.6 (#344): reducer เดียวของ editor (Phase Spec #337 §6, §8)
 *
 * state = server snapshot + command log ที่ยังไม่บันทึก — document ที่เห็นคำนวณจาก replay เสมอ
 * บันทึกสำเร็จแทน snapshot และล้าง log; `409` เปิดทางเลือก compare/reload/keep-copy ให้ผู้ใช้เลือกเอง
 * ไม่มี auto-merge แบบเงียบ
 *
 * session recovery เก็บเฉพาะ command log ใน `sessionStorage` ของแท็บนั้น ผูก tenant/resource/base
 * revision และถูกล้างเมื่อ save/discard/reload/เสียสิทธิ์
 */
import type { JourneyDiagnosticV1 } from '@d-contact/cxa-contracts';
import type { CompileSummary, JourneySnapshot } from './api.js';
import { AuthoringCommandRejected, applyCommand, replay, type AuthoringCommand } from './model.js';

export interface EditorState {
  readonly snapshot: JourneySnapshot;
  readonly commands: readonly AuthoringCommand[];
  readonly undone: readonly AuthoringCommand[];
  readonly selectedNodeId: string | null;
  /** snapshot ล่าสุดของ server เมื่อบันทึกชน — มีค่าเมื่อผู้ใช้ต้องเลือกทางออก */
  readonly conflict: JourneySnapshot | null;
  readonly diagnostics: readonly JourneyDiagnosticV1[];
  readonly compile: CompileSummary | null;
  /** เหตุผลของ command ล่าสุดที่ถูกปฏิเสธ เพื่อประกาศผ่าน live region */
  readonly rejected: string | null;
  /** จำนวน command ที่ใช้ไม่ได้แล้วหลัง keep-copy บน revision ใหม่ */
  readonly dropped: number;
}

export type EditorAction =
  | { readonly type: 'COMMAND'; readonly command: AuthoringCommand }
  | { readonly type: 'UNDO' }
  | { readonly type: 'REDO' }
  | { readonly type: 'SELECT'; readonly nodeId: string | null }
  | {
      readonly type: 'SNAPSHOT';
      readonly snapshot: JourneySnapshot;
      /** keep-copy: เล่น command ของผู้ใช้ซ้ำบน revision ล่าสุดที่ผู้ใช้เลือกเอง */
      readonly keepCommands?: boolean;
    }
  | { readonly type: 'CONFLICT'; readonly latest: JourneySnapshot }
  | { readonly type: 'DIAGNOSTICS'; readonly diagnostics: readonly JourneyDiagnosticV1[] }
  | { readonly type: 'COMPILED'; readonly compile: CompileSummary }
  | { readonly type: 'RESTORE'; readonly commands: readonly AuthoringCommand[] };

export function initialEditorState(snapshot: JourneySnapshot): EditorState {
  return {
    snapshot,
    commands: [],
    undone: [],
    selectedNodeId: null,
    conflict: null,
    diagnostics: [],
    compile: null,
    rejected: null,
    dropped: 0,
  };
}

export function editorDocument(state: EditorState) {
  return replay(state.snapshot.draft.document, state.commands);
}

export function isDirty(state: EditorState): boolean {
  return state.commands.length > 0;
}

/** เก็บเฉพาะ command ที่ยัง apply ได้ตามลำดับ — ใช้ตอน restore/keep-copy บน base ที่อาจเปลี่ยนไป */
function applicable(snapshot: JourneySnapshot, commands: readonly AuthoringCommand[]) {
  let document = snapshot.draft.document;
  const kept: AuthoringCommand[] = [];
  for (const command of commands) {
    try {
      document = applyCommand(document, command);
      kept.push(command);
    } catch (error) {
      if (!(error instanceof AuthoringCommandRejected)) throw error;
    }
  }
  return kept;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'COMMAND': {
      try {
        applyCommand(editorDocument(state), action.command);
      } catch (error) {
        if (error instanceof AuthoringCommandRejected) return { ...state, rejected: error.reason };
        throw error;
      }
      const selectedNodeId =
        action.command.kind === 'ADD_NODE'
          ? action.command.nodeId
          : action.command.kind === 'DELETE_NODE' && state.selectedNodeId === action.command.nodeId
            ? null
            : state.selectedNodeId;
      return {
        ...state,
        commands: [...state.commands, action.command],
        undone: [],
        selectedNodeId,
        compile: null,
        rejected: null,
      };
    }
    case 'UNDO': {
      const last = state.commands.at(-1);
      if (!last) return state;
      return {
        ...state,
        commands: state.commands.slice(0, -1),
        undone: [last, ...state.undone],
        compile: null,
        rejected: null,
      };
    }
    case 'REDO': {
      const [next, ...rest] = state.undone;
      if (!next) return state;
      return {
        ...state,
        commands: [...state.commands, next],
        undone: rest,
        compile: null,
        rejected: null,
      };
    }
    case 'SELECT':
      return { ...state, selectedNodeId: action.nodeId };
    case 'SNAPSHOT': {
      const commands = action.keepCommands ? applicable(action.snapshot, state.commands) : [];
      return {
        ...initialEditorState(action.snapshot),
        commands,
        selectedNodeId: state.selectedNodeId,
        dropped: action.keepCommands ? state.commands.length - commands.length : 0,
      };
    }
    case 'CONFLICT':
      return { ...state, conflict: action.latest };
    case 'DIAGNOSTICS':
      return { ...state, diagnostics: action.diagnostics };
    case 'COMPILED':
      return { ...state, compile: action.compile, diagnostics: action.compile.diagnostics };
    case 'RESTORE':
      return { ...state, commands: applicable(state.snapshot, action.commands), undone: [] };
  }
}

// ── Session recovery ────────────────────────────────────────────────────────

const RECOVERY_PREFIX = 'dcontact:j5-authoring';
const COMMAND_KINDS = new Set([
  'ADD_NODE',
  'CONNECT',
  'DISCONNECT',
  'DELETE_NODE',
  'SET_CONFIG',
  'SET_LABEL',
  'MOVE_NODE',
  'REORDER',
  'SET_SETTING',
]);

export function recoveryKey(scope: string, journeyId: string, baseRevision: number): string {
  return `${RECOVERY_PREFIX}:${scope}:${journeyId}:${baseRevision}`;
}

export function saveRecovery(
  storage: Storage,
  key: string,
  commands: readonly AuthoringCommand[],
): void {
  try {
    if (commands.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 1, commands }));
  } catch {
    // storage เต็มหรือถูกปิด: recovery เป็นความสะดวก ไม่ใช่ความจริงของระบบ จึงไม่ขวางการแก้
  }
}

export function loadRecovery(storage: Storage, key: string): AuthoringCommand[] | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: unknown; commands?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.commands)) return null;
    const commands = parsed.commands.filter(
      (entry): entry is AuthoringCommand =>
        typeof entry === 'object' &&
        entry !== null &&
        COMMAND_KINDS.has((entry as { kind?: unknown }).kind as string),
    );
    return commands.length > 0 ? commands : null;
  } catch {
    return null;
  }
}

/** ล้างทุก recovery ของ resource (หรือทั้ง scope) — ใช้ตอน discard, เสียสิทธิ์, logout, เปลี่ยน tenant */
export function clearRecovery(storage: Storage, scope: string, journeyId?: string): void {
  const prefix = `${RECOVERY_PREFIX}:${scope}:${journeyId ? `${journeyId}:` : ''}`;
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // ดู saveRecovery
  }
}
