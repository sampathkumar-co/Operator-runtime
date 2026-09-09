export const TOOL_SURFACE = [
  { name: 'computer.inspect', risk: 'read', description: 'Inspect bounded native state of an authorized computer.' },
  { name: 'project.inspect', risk: 'read', description: 'Inspect semantic metadata for an authorized project root.' },
  { name: 'file.read', risk: 'read', description: 'Read a bounded file inside an authorized root.' },
  { name: 'file.list', risk: 'read', description: 'List a bounded directory inside an authorized root.' },
  { name: 'file.write', risk: 'write', description: 'Atomically write a file inside an authorized root, optionally guarded by expected SHA-256.' },
  { name: 'git.status', risk: 'read', description: 'Read structured repository status using Git directly.' },
  { name: 'git.diff', risk: 'read', description: 'Read a bounded Git diff using Git directly.' },
  { name: 'terminal.execute', risk: 'write', description: 'Execute an allowlisted executable with an argv array and no command shell.' },
  { name: 'browser.inspect', risk: 'read', description: 'Inspect Chromium tabs or a bounded semantic page snapshot through loopback CDP.' },
  { name: 'browser.navigate', risk: 'read', description: 'Navigate an existing/new Chromium tab directly through CDP and verify the resulting destination.' },
  { name: 'browser.interact', risk: 'external', description: 'Semantically click, type, or select a browser control and verify element/page state.' },
  { name: 'app.inspect', risk: 'read', description: 'Inspect a bounded Windows UIA control tree and optionally observe selector-scoped property/structure changes for up to five seconds, without screenshots.' },
  { name: 'app.operate', risk: 'external', description: 'Operate a Windows control through Invoke, Value, Focus, SelectionItem, ExpandCollapse, or bounded Scroll patterns and verify semantic state.' }
] as const;
