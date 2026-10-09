import { BrowserCdpProvider } from "../../src/capabilities/browser-cdp.ts";

const endpoint = process.argv[2] || "http://127.0.0.1:9222";
const provider = new BrowserCdpProvider(endpoint);

try {
  const inspected = await provider.execute({
    id: "benchmark-browser-inspect",
    capability: "browser.inspect",
    risk: "read",
    input: {},
    provenance: { kind: "runtime" }
  });

  if (!inspected.ok) {
    console.error(JSON.stringify({ ok: false, phase: "inspect", error: inspected.error }));
    process.exitCode = 2;
  } else {
    const tabs = inspected.output?.tabs ?? [];
    const target = tabs.find((tab) => String(tab.url ?? "").includes("click-test.html"));
    if (!target?.id) {
      console.error(JSON.stringify({
        ok: false,
        phase: "target",
        tabCount: tabs.length,
        urls: tabs.map((tab) => String(tab.url ?? "").slice(0, 300))
      }));
      process.exitCode = 3;
    } else {
      const acted = await provider.execute({
        id: "benchmark-browser-interact",
        capability: "browser.interact",
        risk: "write",
        input: {
          targetId: target.id,
          operation: "click",
          target: { css: "button" }
        },
        provenance: { kind: "runtime" }
      });

      console.log(JSON.stringify({
        ok: acted.ok,
        provider: acted.provider,
        capability: acted.capability,
        durationMs: acted.durationMs,
        targetId: target.id,
        evidenceKinds: Array.isArray(acted.evidence) ? acted.evidence.map((item) => item.kind) : [],
        error: acted.error ?? null
      }));

      if (!acted.ok) process.exitCode = 4;
    }
  }
} finally {
  provider.close();
}
