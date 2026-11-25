/**
 * J5.6 (#344): the single editor reducer (Phase Spec #337 §6, §8)
 *
 * state = server snapshot + the unsaved command log — the visible document is always computed by replay.
 * A successful save replaces the snapshot and clears the log; `409` opens compare/reload/keep-copy options for the user to choose
 * with no silent auto-merge.
 *
 * session recovery keeps only the command log in that tab's `sessionStorage`, bound to tenant/resource/base
 * revision, and it is cleared on save/discard/reload/loss of permission
 */
import type { JourneyDiagnosticV1 } from '@d-contact/cxa-contracts';
import type { CompileSummary, JourneySnapshot } from './api.js';
import { AuthoringCommandRejected, applyCommand, replay, type AuthoringCommand } from './model.js';

export interface EditorState {
  readonly snapshot: JourneySnapshot;
  readonly commands: readonly AuthoringCommand[];
  readonly undone: readonly AuthoringCommand[];
  readonly selectedNodeId: string | null;
  /** latest server snapshot when a save conflicts — set when the user must choose a way out */
  readonly conflict: JourneySnapshot | null;
  readonly diagnostics: readonly JourneyDiagnosticV1[];
  /**
   * U1.7 (#435): the server already checked the revision being viewed (validate or the check at save) — a result with no errors
   * must show "checked, nothing found", not "not checked yet"; editing the document / loading a new snapshot = must check again
   */
  readonly checked: boolean;
  readonly compile: CompileSummary | null;
  /** reason for the most recently rejected command, to announce through a live region */
  readonly rejected: string | null;
  /** number of commands no longer usable after keep-copy on a new revision */
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
      /** keep-copy: replay the user's commands on the latest revision the user chose */
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
    checked: false,
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

/** keep only commands that can still be applied in order — used on restore/keep-copy against a base that may have changed */
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
        checked: false,
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
        checked: false,
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
        checked: false,
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
      return { ...state, diagnostics: action.diagnostics, checked: true };
    case 'COMPILED':
      return {
        ...state,
        compile: action.compile,
        diagnostics: action.compile.diagnostics,
        checked: true,
      };
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
    // storage full or disabled: recovery is a convenience, not the system's truth, so it does not block editing
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

/** clear every recovery of a resource (or the whole scope) — used on discard, loss of permission, logout, tenant change */
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
    // see saveRecovery
  }
}
