import assert from 'node:assert/strict';
import test from 'node:test';
import { interactionFunction } from '../src/capabilities/browser-cdp-page.ts';

class FakeEvent {
  readonly type: string;
  constructor(type: string) { this.type = type; }
}

class FakeRoot {
  elements: FakeElement[] = [];
  documentElement = {};
  defaultView: any = {
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    Event: FakeEvent,
    InputEvent: FakeEvent,
    HTMLInputElement: undefined,
    HTMLTextAreaElement: undefined
  };
  body = { innerText: '' };

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
  disabled = false;
  isContentEditable = false;
  clicked = false;
  shadowRoot?: FakeRoot;
  contentDocument?: FakeRoot;
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
  getBoundingClientRect(): any { return { width: 20, height: 20 }; }
  focus(): void { /* semantic focus only */ }
  click(): void { this.clicked = true; }
  dispatchEvent(): boolean { return true; }

  matches(selector: string): boolean {
    return selector.split(',').some((raw) => {
      const token = raw.trim().toLowerCase();
      if (token === this.tagName.toLowerCase()) return true;
      if (token === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
      if (token === '[role]') return this.hasAttribute('role');
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
