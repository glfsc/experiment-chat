'use strict';

// 编辑页的“当前编辑器”与清理函数。ES Module 的 import 绑定是只读的，
// 不能 export let 后由别的模块赋值，所以统一放进一个可变 holder。
export const editorContext = { ctx: null, dispose: null };

export function setEditorContext(ctx) { editorContext.ctx = ctx; }
export function setEditorDispose(fn) { editorContext.dispose = fn; }
export function disposeEditor() {
  const fn = editorContext.dispose;
  editorContext.dispose = null;
  editorContext.ctx = null;
  if (!fn) return;
  try { fn(); } catch { /* 切页清理失败不影响后续渲染 */ }
}


