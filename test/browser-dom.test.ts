import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionFunction, semanticSnapshotFunction } from '../src/capabilities/browser-cdp-page.ts';
import { semanticLocatorFunction } from '../src/capabilities/browser-cdp-frames.ts';

class FakeEvent {
  readonly type: string;
  readonly key?: string;
  readonly clientX?: number;
  readonly clientY?: number;
  readonly buttons?: number;
  constructor(type: string, init?: any) { this.type = type; this.key = init?.key; this.clientX = init?.clientX; this.clientY = init?.clientY; this.buttons = init?.buttons; }
}

class FakeRoot {
  elements: FakeElement[] = [];
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

  createElement(tagName: string): FakeElement { const element = new FakeElement(tagName); element.ownerDocument = this; return element; }

  querySelectorAll(selector: string): FakeElement[] {
    if (selector === '*') return [...this.elements];
    return this.elements.filter((element) => element.matches(selector));
  }

  getElementById(id: string): FakeElement | undefined {
    return this.elements.find((element) => element.id === id);
  }
}

class FakeElement {
  readonly tagName: string;
  textContent = '';
  id = '';
  value = '';
  min = '';
  max = '';
  step = '';
  disabled = false;
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
  options: FakeElement[] = [];
  onKey?: (key: string) => void;
  onEvent?: (event: FakeEvent) => void;
  x = 0;
  y = 0;
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
  focus(): void { /* semantic focus only */ }
  click(): void { this.clicked = true; this.onEvent?.(new FakeEvent('click')); }
  remove(): void { /* synthetic style probe */ }
  contains(element: FakeElement): boolean { return this === element || this.children.includes(element); }
  querySelector(): FakeElement | null { return this.child ?? null; }
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

test('semantic snapshot exposes bounded control state and geometry without password values', (t) => {
  const root = new FakeRoot();
  const text = new FakeElement('input'); text.setAttribute('type', 'text'); text.setAttribute('placeholder', 'Name'); text.value = 'Alice'; text.x = 10; text.y = 20;
  const password = new FakeElement('input'); password.setAttribute('type', 'password'); password.setAttribute('placeholder', 'Password'); password.value = 'super-secret';
  const checkbox = new FakeElement('input'); checkbox.setAttribute('type', 'checkbox'); checkbox.setAttribute('aria-label', 'Enabled'); checkbox.checked = true;
  attach(root, text, password, checkbox); installDocument(t, root);

  const snapshot = semanticSnapshotFunction() as any;
  const byName = new Map(snapshot.controls.map((control: any) => [control.name, control]));
  assert.equal((byName.get('Name') as any).value, 'Alice');
  assert.deepEqual((byName.get('Name') as any).rect, { x: 10, y: 20, width: 20, height: 20 });
  assert.equal('value' in (byName.get('Password') as any), false);
  assert.equal((byName.get('Enabled') as any).checked, true);
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
