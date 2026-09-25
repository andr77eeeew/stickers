import { normalizeParams, sameEditorState } from './editorModel.js';

const HISTORY_LIMIT = 50;

export const createEditorHistory = (initial) => ({ initial, current: initial, committed: initial, past: [] });

/**
 * Pure undo history. 'update' changes the live state; 'checkpoint' records it
 * when a gesture ends, so dragging a slider is one undo step, not hundreds.
 */
export function editorHistoryReducer(state, action) {
  switch (action.type) {
    case 'update': {
      const { patch } = action;
      const current = {
        params: normalizeParams({ ...state.current.params, ...(patch.params || {}) }),
        start: patch.start !== undefined ? patch.start : state.current.start
      };
      return { ...state, current };
    }
    case 'checkpoint': {
      if (sameEditorState(state.current, state.committed)) return state;
      return { ...state, past: [...state.past, state.committed].slice(-HISTORY_LIMIT), committed: state.current };
    }
    case 'undo': {
      if (!sameEditorState(state.current, state.committed)) return { ...state, current: state.committed };
      if (!state.past.length) return state;
      const previous = state.past[state.past.length - 1];
      return { ...state, past: state.past.slice(0, -1), current: previous, committed: previous };
    }
    case 'reset': {
      if (sameEditorState(state.current, state.initial)) return state;
      return {
        ...state,
        past: [...state.past, state.current].slice(-HISTORY_LIMIT),
        current: state.initial,
        committed: state.initial
      };
    }
    default:
      return state;
  }
}

export const canUndo = (state) => state.past.length > 0 || !sameEditorState(state.current, state.committed);
export const isDirty = (state) => !sameEditorState(state.current, state.initial);
