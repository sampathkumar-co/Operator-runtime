import assert from 'node:assert/strict';
import test from 'node:test';
import { dateSelectFunction, interactionFunction, semanticSnapshotFunction } from '../src/capabilities/browser-cdp-page.ts';
import { semanticLocatorFunction } from '../src/capabilities/browser-cdp-frames.ts';

class FakeEvent {
  readonly type: string;
  readonly key?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly buttons?: number;
  constructor(type: string, init?: any) { this.type = type; this.key = init?.key; this.clientX = init?.clientX; this.clientY = init?.clientY; this.buttons = init?.buttons; }
}

class FakeText {
  readonly nodeType = 3;
  readonly childNodes: never[] = [];
  data: string;
  constructor(data: string) { this.data = data; }
}

class FakeMutationObserver {
  static created = 0;
  static disconnected = 0;
  constructor(_callback: () => void) { FakeMutationObserver.created += 1; }
  observe(): void { /* synthetic observer */ }
  disconnect(): void { FakeMutationObserver.disconnected += 1; }
}

class FakeRoot {
  elements: FakeElement[] = [];
  hit?: FakeElement;
  documentElement = {};
  defaultView: any = {
    getComputedStyle: (element: FakeElement) => ({ visibility: element.visibility, display: element.display, cursor: element.cursor, pointerEvents: element.pointerEvents, opacity: element.style.opacity ?? '1', fontSize: element.style.fontSize ?? '16px', backgroundColor: element.backgroundColor, fill: element.fill, stroke: element.stroke, color: element.style.color === 'olive' ? 'rgb(128, 128, 0)' : element.style.color }),
    Event: FakeEvent,
    InputEvent: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    HTMLInputElement: undefined,
    HTMLTextAreaElement: undefined
  };
  body = { innerText: '', appendChild: () => undefined };
  activeElement?: FakeElement;
  selectionRange?: { startNode?: FakeText; startOffset?: number; endNode?: FakeText; endOffset?: number };

  createElement(tagName: string): FakeElement { const element = new FakeElement(tagName); element.ownerDocument = this; return element; }
  createRange(): any {
    const draft: { startNode?: FakeText; startOffset?: number; endNode?: FakeText; endOffset?: number } = {};
    return {
      draft,
      setStart(node: FakeText, offset: number) { draft.startNode = node; draft.startOffset = offset; },
      setEnd(node: FakeText, offset: number) { draft.endNode = node; draft.endOffset = offset; }
    };
  }
  getSelection(): any {
    const root = this;
    return {
      get rangeCount() { return root.selectionRange ? 1 : 0; },
      removeAllRanges() { root.selectionRange = undefined; },
      addRange(range: any) { root.selectionRange = { ...range.draft }; },
      toString() {
        const selected = root.selectionRange;
        if (!selected?.startNode || !selected.endNode) return '';
        if (selected.startNode === selected.endNode) return selected.startNode.data.slice(selected.startOffset ?? 0, selected.endOffset ?? 0);
        return '';
      }
    };
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '*') return [...this.elements];
    return this.elements.filter((element) => element.matches(selector));
  }

  getElementById(id: string): FakeElement | undefined {
    return this.elements.find((element) => element.id === id);
  }

  elementFromPoint(): FakeElement | undefined { return this.hit; }
}

class FakeElement {
  readonly nodeType = 1;
  readonly tagName: string;
  childNodes: Array<FakeElement | FakeText> = [];
  textContent = '';
  innerText?: string;
  id = '';
  value = '';
  min = '';
  max = '';
  step = '';
  disabled = false;
  isConnected = true;
  checked = false;
  isContentEditable = false;
  clicked = false;
  cursor = 'auto';
  pointerEvents = 'auto';
  visibility = 'visible';
  display = 'block';
  backgroundColor = 'rgba(0, 0, 0, 0)';
  fill = 'none';
  stroke = 'none';
  style: any = {};
  shadowRoot?: FakeRoot;
  contentDocument?: FakeRoot;
  child?: FakeElement;
  parentElement?: FakeElement;
  children: FakeElement[] = [];
  tabIndex = -1;
  multiple = false;
  selected = false;
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 20;
  scrollWidth = 20;
  clientHeight = 20;
  clientWidth = 20;
  options: FakeElement[] = [];
  onKey?: (key: string) => void;
  onEvent?: (event: FakeEvent) => void;
  x = 0;
  y = 0;
  screenMatrix?: { a: number; b: number; c: number; d: number; e: number; f: number };
  ownerDocument!: FakeRoot;
  #attrs = new Map<string, string>();

  constructor(tagName: string, text = '') {
    this.tagName = tagName.toUpperCase();
    this.textContent = text;
  }

  setAttribute(name: string, value: string): void { this.#attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.#attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.#attrs.has(name); }
  getRootNode(): FakeRoot { return this.ownerDocument; }
  getBoundingClientRect(): any { return { x: this.x, y: this.y, left: this.x, top: this.y, width: 20, height: 20 }; }
  getScreenCTM(): any { return this.screenMatrix ?? null; }
  focus(): void { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end; }
  click(): void { this.clicked = true; this.onEvent?.(new FakeEvent('click')); }
  remove(): void { /* synthetic style probe */ }
  contains(element: FakeElement): boolean { return this === element || this.children.includes(element); }
  querySelector(selector?: string): FakeElement | null {
    if (!selector) return this.child ?? null;
    if (this.child?.matches(selector)) return this.child;
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const parts = selector.trim().split(/\s+/);
    const leafSelector = parts.at(-1) ?? selector;
    const ancestorSelector = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
    const hasAncestor = (node: FakeElement, wanted: string) => {
      let current = node.parentElement;
      while (current) {
        if (current.matches(wanted)) return true;
        current = current.parentElement;
      }
      return false;
    };
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child.matches(leafSelector) && (!ancestorSelector || hasAncestor(child, ancestorSelector))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  get classList(): { contains(name: string): boolean } {
    const classes = String(this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    return { contains: (name: string) => classes.includes(name) };
  }
  closest(): FakeElement | null {
    if (this.hasAttribute('id') || this.hasAttribute('aria-label') || this.hasAttribute('title')) return this;
    return this.parentElement ?? null;
  }
  dispatchEvent(event?: FakeEvent): boolean {
    if (event) this.onEvent?.(event);
    if (event?.type === 'keydown' && event.key) this.onKey?.(event.key);
    if (this.getAttribute('role') === 'slider' && event?.type === 'keydown' && event.key?.startsWith('Arrow')) {
      const current = Number(this.getAttribute('aria-valuenow'));
      const min = Number(this.getAttribute('aria-valuemin') ?? '0');
      const max = Number(this.getAttribute('aria-valuemax') ?? '100');
      const step = Number(this.getAttribute('aria-valuestep') ?? this.getAttribute('step') ?? '1');
      const up = event.key === 'ArrowRight' || event.key === 'ArrowUp';
      this.setAttribute('aria-valuenow', String(Math.max(min, Math.min(max, current + (up ? step : -step)))));
    }
    return true;
  }

  matches(selector: string): boolean {
    return selector.split(',').some((raw) => {
      const token = raw.trim().toLowerCase();
      if (token === '*') return true;
      if (token.startsWith('.')) return this.classList.contains(token.slice(1));
      if (token === this.tagName.toLowerCase()) return true;
      if (token === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
      if (token === '[role]') return this.hasAttribute('role');
      if (token === '[tabindex]') return this.hasAttribute('tabindex');
      if (token === '[contenteditable="true"]') return this.getAttribute('contenteditable') === 'true';
      if (token === '[role="heading"]') return this.getAttribute('role') === 'heading';
      return false;
    });
  }
}

function installDocument(t: any, root: FakeRoot): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: root, configurable: true, writable: true });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete (globalThis as any).document;
  });
}

function attach(root: FakeRoot, ...elements: FakeElement[]): void {
  for (const element of elements) element.ownerDocument = root;
  root.elements.push(...elements);
}

test('semantic click traverses an open shadow root and returns context evidence', (t) => {
  const documentRoot = new FakeRoot();
  const shadowRoot = new FakeRoot();
  shadowRoot.defaultView = documentRoot.defaultView;
  const host = new FakeElement('agent-panel');
  const save = new FakeElement('button', 'Save');
  host.shadowRoot = shadowRoot;
  attach(documentRoot, host);
  attach(shadowRoot, save);
  save.ownerDocument = documentRoot;
  installDocument(t, documentRoot);

  const result = interactionFunction({ operation: 'click', target: { role: 'button', name: 'Save' }, value: null }) as any;
  assert.equal(result.ok, true);
  assert.equal(save.clicked, true);
  assert.equal(result.matched.context.shadowDepth, 1);
  assert.equal(result.matched.context.frameDepth, 0);
});

test('semantic click traverses a same-origin iframe without treating it as the parent realm', (t) => {
  const documentRoot = new FakeRoot();
  const frameDocument = new FakeRoot();
  const iframe = new FakeElement('iframe');
  const next = new FakeElement('button', 'Continue');
  iframe.contentDocument = frameDocument;
  attach(documentRoot, iframe);
  attach(frameDocument, next);
  installDocument(t, documentRoot);

  const result = interactionFunction({ operation: 'click', target: { role: 'button', name: 'Continue' }, value: null }) as any;
  assert.equal(result.ok, true);
  assert.equal(next.clicked, true);
  assert.equal(result.matched.context.frameDepth, 1);
});

test('semantic type verifies the resulting value inside an open shadow root', (t) => {
  const documentRoot = new FakeRoot();
  const shadowRoot = new FakeRoot();
  const host = new FakeElement('agent-form');
  const input = new FakeElement('input');
  input.setAttribute('placeholder', 'Email');
  input.setAttribute('type', 'text');
  host.shadowRoot = shadowRoot;
  attach(documentRoot, host);
  attach(shadowRoot, input);
  input.ownerDocument = documentRoot;
  installDocument(t, documentRoot);

  const result = interactionFunction({ operation: 'type', target: { role: 'textbox', name: 'Email' }, value: 'hello@example.com' }) as any;
  assert.equal(result.ok, true);
  assert.equal(input.value, 'hello@example.com');
  assert.equal(result.after.value, 'hello@example.com');
});

test('cross-origin-style iframe access failure is isolated and does not escape the browser boundary', (t) => {
  const documentRoot = new FakeRoot();
  const iframe = new FakeElement('iframe');
  Object.defineProperty(iframe, 'contentDocument', { get() { throw new Error('SecurityError'); }, configurable: true });
  attach(documentRoot, iframe);
  installDocument(t, documentRoot);

  const result = interactionFunction({ operation: 'click', target: { role: 'button', name: 'Never visible' }, value: null }) as any;
  assert.equal(result.ok, false);
  assert.match(result.error, /No matching semantic element/);
});


test('native button text wins over implementation id for semantic name matching', (t) => {
  const documentRoot = new FakeRoot();
  const button = new FakeElement('button', 'Increment');
  button.id = 'inc';
  attach(documentRoot, button);
  installDocument(t, documentRoot);

  const snapshot = semanticSnapshotFunction() as any;
  assert.equal(snapshot.controls[0].role, 'button');
  assert.equal(snapshot.controls[0].name, 'Increment');

  const clicked = interactionFunction({ operation: 'click', target: { role: 'button', name: 'Increment' }, value: null }) as any;
  assert.equal(clicked.ok, true);
  assert.equal(clicked.matched.name, 'Increment');
  assert.equal(button.clicked, true);
});

test('cross-origin frame locator uses native button text instead of element id', (t) => {
  const documentRoot = new FakeRoot();
  const button = new FakeElement('button', 'Increment');
  button.id = 'inc';
  attach(documentRoot, button);
  installDocument(t, documentRoot);

  const located = semanticLocatorFunction({ role: 'button', name: 'Increment' }) as any;
  assert.equal(located.count, 1);
  assert.equal(located.matches[0].name, 'Increment');
});

test('explicit ARIA role text supplies the semantic name', (t) => {
  const root = new FakeRoot();
  const item = new FakeElement('div', 'Lyssa'); item.setAttribute('role', 'menuitem');
  attach(root, item); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  assert.deepEqual(snapshot.controls.map((control: any) => [control.role, control.name]), [['menuitem', 'Lyssa']]);
  assert.equal((semanticLocatorFunction({ role: 'menuitem', name: 'Lyssa' }) as any).count, 1);
});

test('pointer-style custom controls are discoverable through shadow roots and same-origin frames', (t) => {
  const root = new FakeRoot();
  const shadow = new FakeRoot(); shadow.defaultView = root.defaultView;
  const frame = new FakeRoot(); frame.defaultView = root.defaultView;
  const host = new FakeElement('agent-panel'); host.shadowRoot = shadow;
  const iframe = new FakeElement('iframe'); iframe.contentDocument = frame;
  const shadowControl = new FakeElement('div', 'Shadow action'); shadowControl.cursor = 'pointer';
  const frameControl = new FakeElement('span', 'Frame action'); frameControl.cursor = 'pointer';
  attach(root, host, iframe); attach(shadow, shadowControl); attach(frame, frameControl);
  shadowControl.ownerDocument = root; frameControl.ownerDocument = root;
  installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  assert.equal(snapshot.controls.find((control: any) => control.name === 'Shadow action').context.shadowDepth, 1);
  assert.equal(snapshot.controls.find((control: any) => control.name === 'Frame action').context.frameDepth, 1);
});

test('semantic snapshot exposes contenteditable controls as editable textboxes', (t) => {
  const root = new FakeRoot();
  const editor = new FakeElement('div', 'Draft text');
  editor.isContentEditable = true;
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('aria-label', 'Editor');
  attach(root, editor); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.name === 'Editor');
  assert.ok(control);
  assert.equal(control.role, 'textbox');
  assert.equal(control.editable, true);
});

test('semantic snapshot keeps visible editable inputs even without an accessible name', (t) => {
  const root = new FakeRoot();
  const input = new FakeElement('input');
  input.setAttribute('type', 'text');
  attach(root, input); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.tag === 'input');
  assert.ok(control);
  assert.equal(control.name, '');
  assert.equal(control.role, 'textbox');
  assert.equal(control.editable, true);
  assert.equal(control.actionable, true);
});

test('active visually hidden editable control is exposed only as a bounded keyboard sink', (t) => {
  const root = new FakeRoot();
  const sink = new FakeElement('input');
  sink.id = 'terminal-target';
  sink.setAttribute('type', 'text');
  sink.style.opacity = '0';
  attach(root, sink); root.activeElement = sink; installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.name === 'terminal-target');
  assert.ok(control);
  assert.equal(control.role, 'textbox');
  assert.equal(control.editable, true);
  assert.equal(control.visuallyHidden, true);
  assert.equal(control.keyboardSink, true);
  assert.equal((semanticLocatorFunction({ ref: control.ref }) as any).count, 1);
  assert.equal((interactionFunction({ operation: 'focus', target: { ref: control.ref }, value: null }) as any).ok, true);
  assert.match((interactionFunction({ operation: 'click', target: { ref: control.ref }, value: null }) as any).error, /No matching|stale/i);
});

test('hover-only CSS pointer affordance exposes an icon-like control without requiring visible text', (t) => {
  const root = new FakeRoot();
  (root as any).styleSheets = [{ cssRules: [{ selectorText: 'span:hover', style: { cursor: 'pointer' } }] }];
  const icon = new FakeElement('span');
  attach(root, icon); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.tag === 'span');
  assert.ok(control);
  assert.equal(control.role, 'pointer');
  assert.equal(control.name, '');
  assert.equal(control.selector, 'span');
});

test('semantic snapshot emits distinct structural selectors for duplicate visible siblings', (t) => {
  const root = new FakeRoot();
  const parent = new FakeElement('section');
  const first = new FakeElement('div', 'Open'); first.cursor = 'pointer';
  const second = new FakeElement('div', 'Open'); second.cursor = 'pointer';
  first.parentElement = parent; second.parentElement = parent; parent.children = [first, second];
  attach(root, parent, first, second); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const controls = snapshot.controls.filter((control: any) => control.name === 'Open');
  assert.equal(controls.length, 2);
  assert.notEqual(controls[0].selector, controls[1].selector);
  assert.match(controls[0].selector, /nth-of-type\(1\)/);
  assert.match(controls[1].selector, /nth-of-type\(2\)/);
});

test('semantic snapshot exposes bounded control state and geometry without password values', (t) => {
  const root = new FakeRoot();
  const text = new FakeElement('input'); text.setAttribute('type', 'text'); text.setAttribute('placeholder', 'Name'); text.value = 'Alice'; text.x = 10; text.y = 20;
  const password = new FakeElement('input'); password.setAttribute('type', 'password'); password.setAttribute('placeholder', 'Password'); password.value = 'super-secret';
  const textarea = new FakeElement('textarea'); textarea.setAttribute('aria-label', 'Exact copy'); textarea.value = 'A  B\n C ';
  const checkbox = new FakeElement('input'); checkbox.setAttribute('type', 'checkbox'); checkbox.setAttribute('aria-label', 'Enabled'); checkbox.checked = true;
  attach(root, text, password, textarea, checkbox); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const byName = new Map(snapshot.controls.map((control: any) => [control.name, control]));
  assert.equal((byName.get('Name') as any).value, 'Alice');
  assert.deepEqual((byName.get('Name') as any).rect, { x: 10, y: 20, width: 20, height: 20 });
  assert.equal('value' in (byName.get('Password') as any), false);
  assert.equal((byName.get('Exact copy') as any).value, 'A  B\n C ');
  assert.equal((byName.get('Enabled') as any).checked, true);
});

test('Browser Observation V2 ranks before truncation and reports truthful pagination', (t) => {
  const root = new FakeRoot();
  const disabled = new FakeElement('button', 'Disabled first'); disabled.disabled = true; disabled.y = 1;
  const first = new FakeElement('button', 'First active'); first.y = 10;
  const second = new FakeElement('button', 'Second active'); second.y = 20;
  attach(root, disabled, second, first); installDocument(t, root);

  const firstPage = semanticSnapshotFunction({ maxControls: 1, maxText: 1, maxVisuals: 1 }) as any;
  assert.equal(firstPage.schemaVersion, 2);
  assert.equal(firstPage.controls[0].name, 'First active');
  assert.deepEqual(firstPage.visualObjects, firstPage.visuals);
  assert.deepEqual(firstPage.pagination.controls, {
    offset: 0, limit: 1, returned: 1, total: 3, truncated: true, nextOffset: 1
  });

  const secondPage = semanticSnapshotFunction({ controlOffset: 1, maxControls: 1, maxText: 1, maxVisuals: 1 }) as any;
  assert.equal(secondPage.controls[0].name, 'Second active');
  assert.equal(secondPage.pagination.controls.nextOffset, 2);
});

test('shared DOM contract keeps inspect and actionability aligned for ancestor-hidden and pointer-blocked controls', (t) => {
  const root = new FakeRoot();
  const hiddenParent = new FakeElement('div'); hiddenParent.display = 'none';
  const hiddenChild = new FakeElement('button', 'Hidden child'); hiddenChild.parentElement = hiddenParent; hiddenParent.children = [hiddenChild];
  const blockedParent = new FakeElement('div'); blockedParent.pointerEvents = 'none';
  const blockedChild = new FakeElement('button', 'Blocked child'); blockedChild.parentElement = blockedParent; blockedParent.children = [blockedChild];
  attach(root, hiddenParent, hiddenChild, blockedParent, blockedChild); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  assert.equal(snapshot.controls.some((control: any) => control.name === 'Hidden child'), false);
  const blocked = snapshot.controls.find((control: any) => control.name === 'Blocked child');
  assert.ok(blocked);
  assert.equal(blocked.actionable, false);
  assert.equal(blocked.pointerBlocked, true);
  assert.equal((semanticLocatorFunction({ name: 'Blocked child' }) as any).count, 0);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Blocked child' }, value: null }) as any).error, /No matching/);
});

test('shared DOM contract marks center-point occlusion non-actionable before dispatch', (t) => {
  const root = new FakeRoot();
  const target = new FakeElement('button', 'Target');
  const overlay = new FakeElement('div', 'Overlay');
  attach(root, target, overlay); root.hit = overlay; installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.controls.find((control: any) => control.name === 'Target');
  assert.ok(observed);
  assert.equal(observed.actionable, false);
  assert.equal(observed.occluded, true);
  assert.equal((semanticLocatorFunction({ name: 'Target' }) as any).count, 0);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Target' }, value: null }) as any).error, /No matching/);
});

test('semantic snapshot exposes rendered leaf text but suppresses visually hidden text', (t) => {
  const root = new FakeRoot();
  const visibleCard = new FakeElement('div', '42'); visibleCard.cursor = 'pointer';
  const hiddenCard = new FakeElement('div', '99'); hiddenCard.cursor = 'pointer'; hiddenCard.style.fontSize = '0px';
  attach(root, visibleCard, hiddenCard); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  assert.ok(snapshot.controls.some((control: any) => control.name === '42'));
  assert.equal(snapshot.controls.some((control: any) => control.name === '99'), false);
  assert.ok(snapshot.visibleText.some((item: any) => item.text === '42'));
  assert.equal(snapshot.visibleText.some((item: any) => item.text === '99'), false);
  assert.match(snapshot.textExcerpt, /42/);
  assert.doesNotMatch(snapshot.textExcerpt, /99/);
});

test('exact custom-control name disambiguates a containing partial match', (t) => {
  const root = new FakeRoot();
  const exact = new FakeElement('div', 'Save'); exact.cursor = 'pointer';
  const partial = new FakeElement('div', 'Save all'); partial.cursor = 'pointer';
  attach(root, exact, partial); installDocument(t, root);
  const result = interactionFunction({ operation: 'click', target: { text: 'Save' }, value: null }) as any;
  assert.equal(result.ok, true); assert.equal(exact.clicked, true); assert.equal(partial.clicked, false);
});

test('ambiguous, hidden, disabled, and pointer-events-none custom controls fail closed', (t) => {
  const root = new FakeRoot();
  const first = new FakeElement('div', 'Duplicate'); first.cursor = 'pointer';
  const second = new FakeElement('div', 'Duplicate'); second.cursor = 'pointer';
  const hidden = new FakeElement('div', 'Hidden'); hidden.cursor = 'pointer'; hidden.display = 'none';
  const disabled = new FakeElement('div', 'Disabled'); disabled.cursor = 'pointer'; disabled.setAttribute('aria-disabled', 'true');
  const inert = new FakeElement('div', 'Inert'); inert.cursor = 'pointer'; inert.pointerEvents = 'none';
  attach(root, first, second, hidden, disabled, inert); installDocument(t, root);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Duplicate' }, value: null }) as any).error, /multiple/);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Hidden' }, value: null }) as any).error, /No matching/);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Disabled' }, value: null }) as any).error, /disabled/);
  assert.match((interactionFunction({ operation: 'click', target: { name: 'Inert' }, value: null }) as any).error, /No matching/);
});

test('click uses a coherent pointer sequence so delegated menu state activates the exact child', (t) => {
  const root = new FakeRoot();
  const child = new FakeElement('div', 'Lyssa'); child.setAttribute('role', 'menuitem');
  let active = false; let selected = false;
  child.onEvent = (event) => { if (event.type === 'mouseover' || event.type === 'mousemove') active = true; if (event.type === 'click') selected = active; };
  attach(root, child); installDocument(t, root);
  const result = interactionFunction({ operation: 'click', target: { role: 'menuitem', name: 'Lyssa' }, value: null }) as any;
  assert.equal(result.ok, true); assert.equal(selected, true);
});

test('drag emits bounded intermediate pointer motion and verifies changed geometry', (t) => {
  const root = new FakeRoot();
  const shape = new FakeElement('svg', 'Shape'); shape.setAttribute('role', 'graphics-symbol');
  shape.onEvent = (event) => { if (event.type === 'mousemove' && event.buttons === 1) { shape.x = Number(event.clientX) - 10; shape.y = Number(event.clientY) - 10; } };
  attach(root, shape); installDocument(t, root);
  const result = interactionFunction({ operation: 'drag', target: { role: 'graphics-symbol', name: 'Shape' }, value: null, deltaX: 80, deltaY: -40 }) as any;
  assert.equal(result.ok, true); assert.equal(result.after.geometry.x, 80); assert.equal(result.after.geometry.y, -40);
  assert.equal((interactionFunction({ operation: 'drag', target: { role: 'graphics-symbol', name: 'Shape' }, value: null, deltaX: 3000, deltaY: 0 }) as any).ok, false);
});

test('rendered visual colors are bounded, normalized, and uniquely actionable', (t) => {
  const root = new FakeRoot();
  const olive = new FakeElement('div'); olive.cursor = 'pointer'; olive.backgroundColor = 'rgb(128, 128, 0)';
  const blue = new FakeElement('div'); blue.cursor = 'pointer'; blue.backgroundColor = 'rgb(0, 0, 255)';
  attach(root, olive, blue); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  assert.equal(snapshot.visuals.length, 2);
  assert.equal(snapshot.visuals[0].colors.background, 'rgb(128, 128, 0)');
  const clicked = interactionFunction({ operation: 'click', target: { renderedColor: 'olive' }, value: null }) as any;
  assert.equal(clicked.ok, true); assert.equal(olive.clicked, true); assert.equal(blue.clicked, false);
  blue.backgroundColor = 'rgb(128, 128, 0)';
  assert.match((interactionFunction({ operation: 'click', target: { renderedColor: 'olive' }, value: null }) as any).error, /multiple/);
});

test('visual observations derive names from rendered text without embedded source text', (t) => {
  const root = new FakeRoot();
  const page = new FakeElement('html', 'Visible task text function hiddenImplementation() { return 42; }');
  page.innerText = 'Visible task text';
  page.backgroundColor = 'rgb(255, 255, 255)';
  const script = new FakeElement('script', 'function hiddenImplementation() { return 42; }');
  script.backgroundColor = 'rgb(255, 255, 255)';
  attach(root, page, script); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const pageVisual = snapshot.visualObjects.find((item: any) => item.tag === 'html');
  const scriptVisual = snapshot.visualObjects.find((item: any) => item.tag === 'script');
  assert.equal(pageVisual.name, 'Visible task text');
  assert.equal(scriptVisual.name, '');
  assert.equal(snapshot.visibleText.some((item: any) => /hiddenImplementation/.test(item.text)), false);
});

test('semantic select preserves bounded native multi-select values', (t) => {
  const root = new FakeRoot();
  const select = new FakeElement('select');
  select.setAttribute('id', 'options');
  select.id = 'options';
  select.multiple = true;
  const ertha = new FakeElement('option', 'Ertha'); ertha.value = 'Ertha';
  const merridie = new FakeElement('option', 'Merridie'); merridie.value = 'Merridie';
  const aurel = new FakeElement('option', 'Aurel'); aurel.value = 'Aurel';
  select.options = [ertha, merridie, aurel];
  attach(root, select, ertha, merridie, aurel);
  installDocument(t, root);

  const result = interactionFunction({
    operation: 'select',
    target: { role: 'combobox', name: 'options' },
    value: ['Ertha', 'Aurel']
  }) as any;

  assert.equal(result.ok, true);
  assert.equal(ertha.selected, true);
  assert.equal(merridie.selected, false);
  assert.equal(aurel.selected, true);
});

test('semantic snapshot exposes bounded native range slider metadata', (t) => {
  const root = new FakeRoot();
  const slider = new FakeElement('input');
  slider.setAttribute('type', 'range');
  slider.setAttribute('aria-label', 'Volume');
  slider.min = '0'; slider.max = '10'; slider.step = '2'; slider.value = '4';
  attach(root, slider);
  installDocument(t, root);
  const control = (semanticSnapshotFunction() as any).controls[0];
  assert.deepEqual({ role: control.role, name: control.name, min: control.min, max: control.max, step: control.step, value: control.value },
    { role: 'slider', name: 'Volume', min: '0', max: '10', step: '2', value: '4' });
});

test('semantic set_value enforces slider bounds and step, then verifies the value', (t) => {
  const root = new FakeRoot();
  const slider = new FakeElement('input');
  slider.setAttribute('type', 'range'); slider.setAttribute('aria-label', 'Volume');
  slider.min = '0'; slider.max = '10'; slider.step = '2'; slider.value = '0';
  attach(root, slider); installDocument(t, root);
  const success = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'Volume' }, value: 6 }) as any;
  assert.equal(success.ok, true); assert.equal(slider.value, '6'); assert.equal(success.after.value, '6');
  for (const value of [-2, 12, 3, Number.NaN]) {
    const rejected = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'Volume' }, value }) as any;
    assert.equal(rejected.ok, false);
  }
});

test('semantic tab activation clicks its native interactive descendant', (t) => {
  const root = new FakeRoot();
  const tab = new FakeElement('div', 'Tab #2'); tab.setAttribute('role', 'tab');
  const anchor = new FakeElement('a', 'Tab #2'); anchor.setAttribute('href', '#panel-2'); tab.child = anchor;
  attach(root, tab); installDocument(t, root);
  const result = interactionFunction({ operation: 'click', target: { role: 'tab', name: 'Tab #2' }, value: null }) as any;
  assert.equal(result.ok, true); assert.equal(tab.clicked, false); assert.equal(anchor.clicked, true);
});

test('semantic snapshot names an ARIA slider from its widget container and exposes its value bounds', (t) => {
  const root = new FakeRoot();
  const widget = new FakeElement('div'); widget.id = 'volume-control'; widget.setAttribute('id', widget.id);
  const handle = new FakeElement('span');
  handle.setAttribute('role', 'slider'); handle.setAttribute('aria-valuemin', '-10');
  handle.setAttribute('aria-valuemax', '10'); handle.setAttribute('aria-valuenow', '2');
  handle.setAttribute('aria-valuestep', '2'); handle.parentElement = widget;
  attach(root, widget, handle); installDocument(t, root);
  const control = (semanticSnapshotFunction() as any).controls.find((item: any) => item.role === 'slider');
  assert.deepEqual({ role: control.role, name: control.name, min: control.min, max: control.max, step: control.step, value: control.value },
    { role: 'slider', name: 'volume-control', min: '-10', max: '10', step: '2', value: '2' });
});

test('ARIA slider set_value uses bounded keyboard steps and verifies the resulting value', (t) => {
  const root = new FakeRoot();
  const widget = new FakeElement('div'); widget.id = 'volume-control'; widget.setAttribute('id', widget.id);
  const handle = new FakeElement('span');
  handle.setAttribute('role', 'slider'); handle.setAttribute('aria-valuemin', '-10');
  handle.setAttribute('aria-valuemax', '10'); handle.setAttribute('aria-valuenow', '2');
  handle.setAttribute('aria-valuestep', '2'); handle.parentElement = widget;
  attach(root, widget, handle); installDocument(t, root);
  const result = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'volume-control' }, value: 8 }) as any;
  assert.equal(result.ok, true); assert.deepEqual(result.pendingKeys, Array(3).fill('ArrowRight'));
  handle.setAttribute('aria-valuenow', '8');
  const verified = interactionFunction({ operation: 'verify_value', target: { role: 'slider', name: 'volume-control' }, value: 8 }) as any;
  assert.equal(verified.ok, true); assert.equal(verified.after.value, '8');
  const rejected = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'volume-control' }, value: 20 }) as any;
  assert.equal(rejected.ok, false);
});

test('focusable slider widgets expose their container name and use keyboard activation with value readback', (t) => {
  const root = new FakeRoot();
  const group = new FakeElement('div');
  const track = new FakeElement('div'); track.setAttribute('class', 'ui-slider'); track.setAttribute('id', 'volume-widget');
  track.parentElement = group;
  const output = new FakeElement('div', '2'); output.parentElement = group;
  group.children = [track, output];
  const handle = new FakeElement('span'); handle.setAttribute('class', 'ui-slider-handle');
  handle.setAttribute('tabindex', '0'); handle.tabIndex = 0; handle.parentElement = track;
  handle.onKey = (key) => {
    if (key === 'ArrowRight') output.textContent = String(Number(output.textContent) + 1);
    if (key === 'ArrowLeft') output.textContent = String(Number(output.textContent) - 1);
  };
  track.children = [handle];
  attach(root, group, track, output, handle); installDocument(t, root);
  const control = (semanticSnapshotFunction() as any).controls.find((item: any) => item.role === 'slider');
  assert.equal(control.name, 'volume-widget'); assert.equal(control.value, '2');
  const result = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'volume-widget' }, value: 8 }) as any;
  assert.equal(result.ok, true); assert.deepEqual(result.pendingKeys, Array(6).fill('ArrowRight'));
  handle.setAttribute('aria-valuenow', '8');
  const verified = interactionFunction({ operation: 'verify_value', target: { role: 'slider', name: 'volume-widget' }, value: 8 }) as any;
  assert.equal(verified.ok, true); assert.equal(verified.after.value, '8');
});

test('legacy slider value readback stays associated with the nearest following output', (t) => {
  const root = new FakeRoot();
  const group = new FakeElement('div');
  const firstTrack = new FakeElement('div'); firstTrack.setAttribute('class', 'ui-slider'); firstTrack.setAttribute('id', 'first-slider'); firstTrack.parentElement = group;
  const firstOutput = new FakeElement('div', '2'); firstOutput.parentElement = group;
  const secondTrack = new FakeElement('div'); secondTrack.setAttribute('class', 'ui-slider'); secondTrack.setAttribute('id', 'second-slider'); secondTrack.parentElement = group;
  const secondOutput = new FakeElement('div', '5'); secondOutput.parentElement = group;
  const firstHandle = new FakeElement('span'); firstHandle.setAttribute('class', 'ui-slider-handle'); firstHandle.setAttribute('tabindex', '0'); firstHandle.tabIndex = 0; firstHandle.parentElement = firstTrack;
  const secondHandle = new FakeElement('span'); secondHandle.setAttribute('class', 'ui-slider-handle'); secondHandle.setAttribute('tabindex', '0'); secondHandle.tabIndex = 0; secondHandle.parentElement = secondTrack;
  firstTrack.children = [firstHandle]; secondTrack.children = [secondHandle];
  group.children = [firstTrack, firstOutput, secondTrack, secondOutput];
  attach(root, group, firstTrack, firstHandle, firstOutput, secondTrack, secondHandle, secondOutput); installDocument(t, root);

  const sliders = (semanticSnapshotFunction() as any).controls.filter((item: any) => item.role === 'slider');
  assert.deepEqual(sliders.map((item: any) => [item.name, item.value]), [['first-slider', '2'], ['second-slider', '5']]);
  const result = interactionFunction({ operation: 'set_value', target: { role: 'slider', name: 'second-slider' }, value: 8 }) as any;
  assert.equal(result.ok, true); assert.deepEqual(result.pendingKeys, Array(3).fill('ArrowRight'));
  secondOutput.textContent = '8';
  const verified = interactionFunction({ operation: 'verify_value', target: { role: 'slider', name: 'second-slider' }, value: 8 }) as any;
  assert.equal(verified.ok, true); assert.equal(verified.after.value, '8');
});


test('Browser Observation V2 refs are ephemeral, relationship-aware, and heal only a unique semantic replacement', (t) => {
  const root = new FakeRoot();
  const menu = new FakeElement('div', 'Actions'); menu.setAttribute('role', 'menu');
  const button = new FakeElement('button', 'Forward');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-pressed', 'true');
  button.setAttribute('aria-current', 'page');
  button.parentElement = menu; menu.children = [button];
  attach(root, menu, button); installDocument(t, root);

  const first = semanticSnapshotFunction() as any;
  const menuControl = first.controls.find((control: any) => control.role === 'menu');
  const observed = first.controls.find((control: any) => control.name === 'Forward');
  assert.ok(menuControl?.ref);
  assert.ok(observed?.ref);
  assert.match(observed.ref, /^b-/);
  assert.equal(observed.parentRef, menuControl.ref);
  assert.equal(observed.groupRef, menuControl.ref);
  assert.deepEqual(menuControl.children, [observed.ref]);
  assert.equal(observed.expanded, false);
  assert.equal(observed.pressed, true);
  assert.equal(observed.current, 'page');
  assert.equal(observed.geometry.coordinateSpace, 'viewport');
  assert.deepEqual(observed.geometry.center, { x: 10, y: 10 });

  const clicked = interactionFunction({ operation: 'click', target: { ref: observed.ref }, value: null }) as any;
  assert.equal(clicked.ok, true);
  assert.equal(button.clicked, true);

  const second = semanticSnapshotFunction() as any;
  const refreshed = second.controls.find((control: any) => control.name === 'Forward');
  assert.ok(refreshed?.ref);
  assert.notEqual(refreshed.ref, observed.ref);
  button.clicked = false;
  const healed = interactionFunction({ operation: 'click', target: { ref: observed.ref }, value: null }) as any;
  assert.equal(healed.ok, true);
  assert.equal(button.clicked, true);
});

test('Browser Observation V2 stale-ref healing fails closed when semantic replacement is ambiguous', (t) => {
  const root = new FakeRoot();
  const button = new FakeElement('button', 'Forward');
  attach(root, button); installDocument(t, root);

  const first = semanticSnapshotFunction() as any;
  const observed = first.controls.find((control: any) => control.name === 'Forward');
  assert.ok(observed?.ref);

  semanticSnapshotFunction();
  root.elements.length = 0;
  const firstReplacement = new FakeElement('button', 'Forward');
  const secondReplacement = new FakeElement('button', 'Forward');
  attach(root, firstReplacement, secondReplacement);

  const ambiguous = interactionFunction({ operation: 'click', target: { ref: observed.ref }, value: null }) as any;
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.matches, 2);
  assert.match(ambiguous.error, /multiple/i);
  assert.equal(firstReplacement.clicked, false);
  assert.equal(secondReplacement.clicked, false);
});

test('Browser Observation V2 exposes bounded deterministic SVG and grid geometry facts with explicit coordinate spaces', (t) => {
  const root = new FakeRoot();
  const polygon = new FakeElement('polygon');
  polygon.setAttribute('points', '0,0 10,0 10,10');
  polygon.setAttribute('aria-rowindex', '2');
  polygon.setAttribute('aria-colindex', '3');
  polygon.fill = 'rgb(1, 2, 3)';
  polygon.screenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 };
  const line = new FakeElement('line');
  line.setAttribute('x1', '2'); line.setAttribute('y1', '3'); line.setAttribute('x2', '12'); line.setAttribute('y2', '13');
  line.stroke = 'rgb(0, 0, 0)'; line.screenMatrix = { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 };
  attach(root, polygon, line); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const visual = snapshot.visualObjects.find((item: any) => item.tag === 'polygon');
  assert.ok(visual);
  assert.equal(visual.primitive, 'polygon');
  assert.equal(visual.pointCount, 3);
  assert.equal(visual.pointsCoordinateSpace, 'svg-local');
  assert.deepEqual(visual.points, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(visual.viewportPointsCoordinateSpace, 'viewport');
  assert.deepEqual(visual.viewportPoints, [{ x: 20, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 40 }]);
  assert.equal(visual.row, 2);
  assert.equal(visual.column, 3);
  assert.equal(visual.geometry.coordinateSpace, 'viewport');

  const lineVisual = snapshot.visualObjects.find((item: any) => item.tag === 'line');
  assert.equal(lineVisual.line.coordinateSpace, 'svg-local');
  assert.deepEqual(lineVisual.viewportLine, { coordinateSpace: 'viewport', x1: 22, y1: 33, x2: 32, y2: 43, vector: { dx: 10, dy: 10, length: 14.142, angleDegrees: 45 } });
  assert.deepEqual(lineVisual.line.vector, { dx: 10, dy: 10, length: 14.142, angleDegrees: 45 });
});


test('Browser Observation V2 gives repeated controls bounded rendered container context without changing their semantic name', (t) => {
  const root = new FakeRoot();
  const row = new FakeElement('div', 'Spicy Thai Peanut Chicken - +');
  const plus = new FakeElement('span', '+'); plus.cursor = 'pointer'; plus.parentElement = row; row.children.push(plus);
  attach(root, row, plus); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.name === '+');
  assert.ok(control);
  assert.equal(control.name, '+');
  assert.equal(control.contextLabel, 'Spicy Thai Peanut Chicken - +');
  assert.deepEqual(control.ancestorContextLabels, ['Spicy Thai Peanut Chicken - +']);
});

test('repeated-item context stops at the owning card instead of absorbing neighboring entities', (t) => {
  const root = new FakeRoot();
  const area = new FakeElement('div', '@myron card @aenean card');
  const myron = new FakeElement('div', '@myron Share via DM'); myron.setAttribute('class', 'media');
  const aenean = new FakeElement('div', '@aenean Share via DM'); aenean.setAttribute('class', 'media');
  const controls = new FakeElement('div', 'Share via DM'); controls.setAttribute('class', 'controls');
  const wrapper = new FakeElement('span', 'Share via DM');
  const menu = new FakeElement('ul', 'Share via DM');
  const action = new FakeElement('li', 'Share via DM'); action.cursor = 'pointer';

  myron.parentElement = area; aenean.parentElement = area; area.children = [myron, aenean];
  controls.parentElement = myron; myron.children = [controls];
  wrapper.parentElement = controls; controls.children = [wrapper];
  menu.parentElement = wrapper; wrapper.children = [menu];
  action.parentElement = menu; menu.children = [action];

  attach(root, area, myron, aenean, controls, wrapper, menu, action); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  const control = snapshot.controls.find((item: any) => item.name === 'Share via DM' && item.tag === 'li');
  assert.ok(control);
  assert.equal(control.ancestorContextLabels.some((label: string) => label.includes('@myron')), true);
  assert.equal(control.ancestorContextLabels.some((label: string) => label.includes('@aenean')), false);
});

test('Browser Observation V2 exposes bounded scroll state for visual regions', (t) => {
  const root = new FakeRoot();
  const scroller = new FakeElement('div', 'Scrollable list');
  scroller.scrollTop = 40; scroller.scrollHeight = 400; scroller.clientHeight = 120;
  attach(root, scroller); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.visualObjects.find((item: any) => item.name === 'Scrollable list');
  assert.ok(observed);
  assert.equal(observed.scrollable, true);
  assert.deepEqual(observed.scroll, {
    top: 40, left: 0, scrollHeight: 400, scrollWidth: 20, clientHeight: 120, clientWidth: 20,
    canScrollY: true, canScrollX: false
  });
  assert.equal(Number.isSafeInteger(snapshot.documentMutationVersion), true);
});

test('semantic locator carries document mutation version and scroll state into action fingerprints', (t) => {
  const root = new FakeRoot();
  const scroller = new FakeElement('div', 'List'); scroller.cursor = 'pointer';
  scroller.scrollTop = 10; scroller.scrollHeight = 300; scroller.clientHeight = 100;
  attach(root, scroller); installDocument(t, root);
  semanticSnapshotFunction();
  const registry = (globalThis as any)[Symbol.for('mecord.browser.observed-targets.v2')];
  registry.mutationVersion = 7;
  const located = semanticLocatorFunction({ name: 'List' }) as any;
  assert.equal(located.count, 1);
  assert.equal(located.matches[0].documentMutationVersion, 7);
  assert.equal(located.matches[0].scroll.top, 10);
  assert.equal(located.matches[0].scroll.canScrollY, true);
  assert.deepEqual(located.matches[0].subtreeSignature, { descendantCount: 0, digest: '811c9dc5' });

  const marker = new FakeElement('span'); marker.id = 'blue-point'; marker.parentElement = scroller; scroller.children.push(marker); attach(root, marker);
  const changed = semanticLocatorFunction({ name: 'List' }) as any;
  assert.equal(changed.matches[0].subtreeSignature.descendantCount, 1);
  assert.notEqual(changed.matches[0].subtreeSignature.digest, located.matches[0].subtreeSignature.digest);
});

test('same-origin iframe geometry is converted into the owning CDP target viewport', (t) => {
  const root = new FakeRoot();
  const frameDocument = new FakeRoot();
  const iframe = new FakeElement('iframe'); iframe.x = 100; iframe.y = 200;
  const button = new FakeElement('button', 'Inside frame'); button.x = 10; button.y = 20;
  iframe.contentDocument = frameDocument;
  frameDocument.defaultView.frameElement = iframe;
  attach(root, iframe);
  attach(frameDocument, button);
  installDocument(t, root);

  const located = semanticLocatorFunction({ role: 'button', name: 'Inside frame' }) as any;
  assert.equal(located.count, 1);
  assert.equal(located.matches[0].geometry.coordinateSpace, 'viewport');
  assert.equal(located.matches[0].geometry.frameDepth, 1);
  assert.equal(located.matches[0].geometry.x, 110);
  assert.equal(located.matches[0].geometry.y, 220);

  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.controls.find((control: any) => control.name === 'Inside frame');
  assert.equal(observed.geometry.coordinateSpace, 'viewport');
  assert.equal(observed.geometry.x, 110);
  assert.equal(observed.geometry.y, 220);
});


test('bounded text selection uses visible control offsets and verifies its postcondition', (t) => {
  const root = new FakeRoot();
  const textarea = new FakeElement('textarea'); textarea.setAttribute('aria-label', 'Editor'); textarea.value = 'hello world';
  attach(root, textarea); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.controls.find((control: any) => control.name === 'Editor');
  const selected = interactionFunction({ operation: 'select_text_range', target: { ref: observed.ref }, value: null, start: 0, end: 5 }) as any;
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.after.selection, { start: 0, end: 5 });
  assert.equal(root.activeElement, textarea);

  const invalid = interactionFunction({ operation: 'select_text_range', target: { ref: observed.ref }, value: null, start: 0, end: 50 }) as any;
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /exceeds/i);
});


test('bounded text selection supports ordinary observed static text', (t) => {
  const root = new FakeRoot();
  const paragraph = new FakeElement('p', 'select this phrase');
  paragraph.childNodes = [new FakeText('select this phrase')];
  attach(root, paragraph); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.visibleText.find((item: any) => item.text === 'select this phrase');
  assert.ok(observed?.ref);

  const selected = interactionFunction({ operation: 'select_text_range', target: { ref: observed.ref }, value: null, start: 0, end: 6 }) as any;
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.after.selection, { start: 0, end: 6 });
  assert.equal(root.getSelection().toString(), 'select');
});

test('Browser Observation V2 exposes a bounded page scroll target when the document can scroll', (t) => {
  const root = new FakeRoot();
  const scroller = new FakeElement('html');
  scroller.scrollTop = 25;
  scroller.scrollHeight = 600;
  scroller.clientHeight = 120;
  (root as any).scrollingElement = scroller;
  attach(root, scroller); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  assert.ok(snapshot.pageScroll?.ref);
  assert.equal(snapshot.pageScroll.scroll.top, 25);
  assert.equal(snapshot.pageScroll.scroll.canScrollY, true);

  const located = semanticLocatorFunction({ ref: snapshot.pageScroll.ref }) as any;
  assert.equal(located.count, 1);
  assert.equal(located.matches[0].scroll.canScrollY, true);
});

test('Browser Observation V2 marks autocomplete text controls and preserves the hint through lookup and typing', (t) => {
  const root = new FakeRoot();
  const input = new FakeElement('input');
  input.setAttribute('aria-label', 'Destination');
  input.setAttribute('aria-autocomplete', 'list');
  attach(root, input); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.controls.find((control: any) => control.name === 'Destination');
  assert.equal(observed.autocomplete, true);
  assert.equal(observed.autocompleteMode, 'list');

  const located = semanticLocatorFunction({ ref: observed.ref }) as any;
  assert.equal(located.count, 1);
  assert.equal(located.matches[0].autocomplete, true);

  const typed = interactionFunction({ operation: 'type', target: { ref: observed.ref }, value: 'SHG' }) as any;
  assert.equal(typed.ok, true);
  assert.equal(typed.matched.autocomplete, true);
  assert.equal(typed.after.value, 'SHG');
});

test('native date input normalizes a locale-aware numeric value', (t) => {
  const root = new FakeRoot();
  root.defaultView.navigator = { language: 'en-US' };
  const input = new FakeElement('input');
  input.setAttribute('type', 'date');
  input.setAttribute('aria-label', 'Date field');
  attach(root, input); installDocument(t, root);
  const snapshot = semanticSnapshotFunction() as any;
  const observed = snapshot.controls.find((control: any) => control.name === 'Date field');
  assert.equal(observed.nativeValueFormat, 'YYYY-MM-DD');
  const typed = interactionFunction({ operation: 'type', target: { ref: observed.ref }, value: '02/04/2012' }) as any;
  assert.equal(typed.ok, true);
  assert.equal(input.value, '2012-02-04');
});

test('bounded select_date navigates a visible calendar widget and verifies the chosen date', (t) => {
  const root = new FakeRoot();
  const input = new FakeElement('input'); input.id = 'datepicker';
  const picker = new FakeElement('div'); picker.setAttribute('class', 'ui-datepicker');
  const header = new FakeElement('div'); header.setAttribute('class', 'ui-datepicker-header');
  const prev = new FakeElement('a', 'Prev'); prev.setAttribute('class', 'ui-datepicker-prev');
  const next = new FakeElement('a', 'Next'); next.setAttribute('class', 'ui-datepicker-next');
  const title = new FakeElement('div'); title.setAttribute('class', 'ui-datepicker-title');
  const month = new FakeElement('span', 'December'); month.setAttribute('class', 'ui-datepicker-month');
  const year = new FakeElement('span', '2016'); year.setAttribute('class', 'ui-datepicker-year');
  const table = new FakeElement('table'); table.setAttribute('class', 'ui-datepicker-calendar');
  const row = new FakeElement('tr');
  const cell = new FakeElement('td');
  const day = new FakeElement('a', '17');

  picker.children = [header, table]; header.parentElement = picker; table.parentElement = picker;
  header.children = [prev, title, next]; prev.parentElement = header; title.parentElement = header; next.parentElement = header;
  title.children = [month, year]; month.parentElement = title; year.parentElement = title;
  table.children = [row]; row.parentElement = table; row.children = [cell]; cell.parentElement = row; cell.children = [day]; day.parentElement = cell;

  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  let monthIndex = 11;
  prev.onEvent = () => { monthIndex -= 1; month.textContent = months[monthIndex]!; };
  next.onEvent = () => { monthIndex += 1; month.textContent = months[monthIndex]!; };
  day.onEvent = () => { input.value = '03/17/2016'; };

  attach(root, input, picker, header, prev, next, title, month, year, table, row, cell, day);
  installDocument(t, root);
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  const priorRegistry = (globalThis as any)[registryKey];
  (globalThis as any)[registryKey] = { refs: new Map([['b-date-input', input]]) };
  t.after(() => { if (priorRegistry === undefined) delete (globalThis as any)[registryKey]; else (globalThis as any)[registryKey] = priorRegistry; });

  const contract = { stateOf: () => ({ rendered: true, visible: true, disabled: false }) } as any;
  const result = dateSelectFunction({ target: { ref: 'b-date-input' }, value: '2016-03-17' }, contract) as any;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.after.navigationSteps, 9);
  assert.equal(result.after.displayedMonth, 3);
  assert.equal(result.after.displayedYear, 2016);
  assert.equal(input.value, '03/17/2016');
  assert.equal(day.clicked, true);
});

test('Browser Observation V2 disconnects observers for detached iframe documents', (t) => {
  const registryKey = Symbol.for('mecord.browser.observed-targets.v2');
  const priorRegistry = (globalThis as any)[registryKey];
  delete (globalThis as any)[registryKey];
  t.after(() => {
    if (priorRegistry === undefined) delete (globalThis as any)[registryKey];
    else (globalThis as any)[registryKey] = priorRegistry;
  });
  FakeMutationObserver.created = 0;
  FakeMutationObserver.disconnected = 0;

  const root = new FakeRoot();
  const frameDocument = new FakeRoot();
  root.defaultView.MutationObserver = FakeMutationObserver;
  frameDocument.defaultView.MutationObserver = FakeMutationObserver;
  const iframe = new FakeElement('iframe');
  const frameText = new FakeElement('p', 'frame text');
  iframe.contentDocument = frameDocument;
  frameDocument.defaultView.frameElement = iframe;
  attach(root, iframe);
  attach(frameDocument, frameText);
  installDocument(t, root);

  semanticSnapshotFunction();
  const registry = (globalThis as any)[registryKey];
  assert.equal(registry.observers.length, 2);
  assert.equal(FakeMutationObserver.created, 2);

  iframe.isConnected = false;
  iframe.contentDocument = undefined;
  semanticSnapshotFunction();
  assert.equal(registry.observers.length, 1);
  assert.equal(FakeMutationObserver.disconnected, 1);
});

test('focused Browser Observation V2 ranks a prior observed ref before truncation and refreshes its generation', (t) => {
  const root = new FakeRoot();
  const firstButton = new FakeElement('button', 'First'); firstButton.y = 10;
  const desired = new FakeElement('button', 'Desired'); desired.y = 500;
  const third = new FakeElement('button', 'Third'); third.y = 20;
  attach(root, firstButton, desired, third); installDocument(t, root);

  const initial = semanticSnapshotFunction({ maxControls: 3 }) as any;
  const prior = initial.controls.find((control: any) => control.name === 'Desired');
  assert.ok(prior?.ref);

  const focused = semanticSnapshotFunction({ maxControls: 1, focusRef: prior.ref }) as any;
  assert.equal(focused.focus.ref, prior.ref);
  assert.equal(focused.focus.refResolved, true);
  assert.equal(focused.controls.length, 1);
  assert.equal(focused.controls[0].name, 'Desired');
  assert.notEqual(focused.controls[0].ref, prior.ref);

  const staleFocus = semanticSnapshotFunction({ maxControls: 1, focusRef: prior.ref }) as any;
  assert.equal(staleFocus.focus.refResolved, false);
});

test('focused observation can prioritize role, text, and viewport region without enlarging budgets', (t) => {
  const root = new FakeRoot();
  const outside = new FakeElement('button', 'Outside'); outside.x = 0; outside.y = 0;
  const regionMatch = new FakeElement('button', 'Schedule meeting'); regionMatch.x = 400; regionMatch.y = 300;
  attach(root, outside, regionMatch); installDocument(t, root);

  const focused = semanticSnapshotFunction({
    maxControls: 1,
    focusRole: 'button',
    focusText: 'schedule',
    focusRegion: { x: 390, y: 290, width: 100, height: 100 }
  }) as any;
  assert.equal(focused.controls.length, 1);
  assert.equal(focused.controls[0].name, 'Schedule meeting');
  assert.equal(focused.pagination.controls.limit, 1);
});
