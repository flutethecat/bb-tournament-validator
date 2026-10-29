// Open popups register here so Escape closes only the topmost one (a picker over the casualty form closes first).
const stack: symbol[] = [];
export const pushSheet = (): symbol => { const id = Symbol("sheet"); stack.push(id); return id; };
export const dropSheet = (id: symbol): void => { const i = stack.indexOf(id); if (i >= 0) stack.splice(i, 1); };
export const isTopSheet = (id: symbol): boolean => stack[stack.length - 1] === id;
