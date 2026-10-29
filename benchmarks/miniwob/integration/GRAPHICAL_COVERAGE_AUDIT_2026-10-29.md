# MiniWoB graphical coverage: second source audit (29 October 2026)

**Verdict: improved, NOT complete or benchmark-qualified.** This report audits the frozen
Meta Contributor -> Python grounded-controller -> isolated Mecord CDP bridge -> Mecord
browser provider -> BrowserGym independent-reward path. It does **not** audit or modify
the shipping production TaskOrchestrator. All additions are staged in draft PR #695
on top of draft #694, not merged or released.

## References and evidence boundaries

- Browser provider source: `src/capabilities/browser-cdp.ts`,
  `browser-cdp-frames.ts`, `browser-cdp-page.ts` on the main branch.
- Isolated bridge: `benchmarks/miniwob/integration/mecord_bridge.mjs`,
  `bridge_actions.mjs`, `browser_visual.mjs`.
- Controller: `benchmarks/miniwob/mecord_observation.py`,
  `integration/run_live.py`.
- Independent scored results: the previous 2/7 checkpoint (including one Meta
  transport failure). **No new model-driven score was obtained here.**
- Official MiniWoB task and action classifications:
  https://miniwob.farama.org/environments/list/
  and https://ppasupat.github.io/miniwob-plusplus/content/action_space/
  (the repo-pinned local list of 125 tasks is authoritative when evaluating).
- The owner laptop was inaccessible through both available device connectors.
  No live CDP/Meta/BrowserGym execution was performed in this audit.

## Action-level coverage matrix

| Graphical requirement | Current source path | Confidence / limitation |
| --- | --- | --- |
| DOM click and target hover | `click`, `hover` through Mecord provider | Implemented, isolated tests only |
| SVG/canvas/image observed-region click | `click_relative` with named or two-decimal normalized ratios, provider hit test | Implemented in bridge/controller; live perception unverified |
| Hover a non-actionable observed graphic | `hover` on validated visual ref | Implemented; live UI events unverified |
| Horizontal/vertical scrolling | `scroll` on observed scroller, 40–640 CSS px | Implemented; wheel postconditions unverified |
| Drag sortable item to another sortable item | `drag_between` with current same-generation refs | Implemented; source-only checks |
| Drag any observed graphic to another observed element | `drag_to` -> provider `drag_between`, same frame/generation | Implemented; live drag/drop unverified |
| Relative directional or diagonal drag from element center | `drag_by`, 8 directions, 10–320 CSS px | Implemented; not arbitrary start-point |
| Resize observed element | `resize` bounded deltas | Implemented; actual handle still verified by provider |
| Slider set value | `set_value` -> slider provider operation | Implemented; textboxes dispatched via `type` |
| Date, keyboard and text selection | observed target, bounded operations | Implemented; browser behavior requires live tests |
| JavaScript alert/confirm/prompt | dialog accept/dismiss from exact observed dialog ref | Implemented; live lifecycle unverified |
| Multimodal screenshot | CDP JPEG from exact synthetic tab, opt-in `--vision` | Source implemented, Meta request format documented, untested against live browser |
| Same-origin and explicitly approved cross-origin frames | frame-bound observed refs / URL checks | Implemented, no actual multi-frame qualification |
| **Double-click** (MiniWoB `DBLCLICK_COORDS`) | No provider `double_click` operation | **NOT IMPLEMENTED** |
| **Mouse-down/up with held pointer** | Provider has atomic drag; no persistent held-button state | **NOT IMPLEMENTED** |
| **Arbitrary trajectory drawing / circle / line** | Directional drag from center and two-element drag only | **NOT IMPLEMENTED** |
| **Shift + click or click with modifiers** | No modifier parameter to provider click | **NOT IMPLEMENTED** |
| **Continuous moving-target pursuit** | One model/tool decision each step; no continuous pointer controller | **NOT IMPLEMENTED** |
| Completely empty/transparent canvas grounding | Depends on provider visual extraction/pagination | Not proved; possible visibility gap |
| Rich dynamic scroll/canvas full visual coverage | Screenshot + bounded candidate list, no stable paged selection | Partial, task dependent |

The official task list includes `draw-line`, `draw-circle`, `click-scroll-list`
(which requires Shift+click), `drag-cube`, `drag-shapes-2`, `use-colorwheel`,
`click-menu`, `hot-cold`, and `chase-circle`. Their presence prevents a
credible claim of **100% graphical task coverage** without the missing
modifier and pointer trajectory operations.

## Source-level fixes made during this deeper pass

1. `hover` may target an observed, non-actionable graphical node without
   accidentally granting ordinary click authority.
2. `drag_to` maps to Mecord's existing native `drag_between`, requiring
   two exact current refs in the same frame and observation generation.
3. Scrolls support both axes; directional drags support eight directions and
   small bounded distances. The provider still performs target/pointer checks.
4. `click_relative` accepts two-decimal normalized ratios **inside** an
   observed graphic, not arbitrary viewport coordinates. The runner now
   actually forwards the chosen point; previously it silently fell back
   to center.
5. Frame-aware round-robin candidate selection prevents a dense main page
   from starving all authorized nested-frame controls.
6. Color, fill, stroke, circle, ellipse, line and bounded point facts from
   source observations are preserved for Meta instead of discarded.
7. Stable replay fingerprints account for checked/selected/expanded/value
   changes; explicit observed progress no longer counts as a no-progress
   repetition.
8. Oversized model action values are refused, not silently sliced.
9. The bridge preserves the richer semantic version of a control when the
   same ref appears in both control and visual collections; conflicting
   cross-frame identities are rejected.
10. Wait now consumes an actual BrowserGym action step and records the
    resulting independent reward.

## Remaining engineering risks discovered on second audit

- **P0, new provider capability required:** Double-click, held-button
  move sequences, drawn paths, and Shift+click require a typed, explicit,
  side-effect-aware Mecord provider contract with native CDP input events.
  They must not be impersonated by direct uncontrolled CDP commands in this
  benchmark bridge, because that would stop measuring Mecord.
- **P0, live compatibility:** Pinned Mecord runtime `2.0.7-rc.6` is a built
  artifact, not the current main source. Source checks do not prove that
  the pinned binary exposes all observed fields, CDP screenshot imports,
  or frame behavior used by this branch.
- **P0, accuracy:** The original 2/7 remains the only measured checkpoint.
  There is no independent full 50/125 scored result, no comparable checkpoint
  at identical task IDs, and no proved 70% reward gate.
- **P1, multimodal budget:** The image path reserves 32,768 assumed input
  tokens per call. At $0.10/M input tokens, *50 calls alone* would reserve
  $0.16384 before output. The $0.07 workspace reservation ceiling therefore
  cannot certify a full 50-task vision run without a different verified
  resource plan. This is reservation math, **not actual billed usage**.
- **P1, observation pagination:** The provider supports control/visual offsets,
  but the runner does not implement a synchronized, source-validated
  observation-paging decision. Target elements may be omitted.
- **P1, graphical postconditions:** An operation may return `ok:true`
  without satisfying the MiniWoB task's independent reward. The internal
  progress signal and model's next explanation must never substitute for
  BrowserGym's reward.
- **P1, benchmark isolation:** The benchmark directly uses
  `BrowserCdpProvider`. It still does not exercise the canonical production
  TaskOrchestrator, task approval fences, or signed release.
- **P1, visual privacy:** Contributor-mode data may be used by the model
  provider for training. Keep visual input limited to synthetic fixtures;
  never send real user tabs, secrets or personal data.

## Qualification gates before claiming completion

- Offline Python and Node tests, syntax, PR evidence contract on exact PR SHA.
- Browser provider smoke on pinned/rebuilt original runtime, including
  SVG/canvas hit tests, drag/drop, horizontal scroll, iframe, modal dialog.
- Regression cases for double-click, Shift+click and held-pointer trajectory
  **after the provider adds those typed operations**.
- A frozen, worker-manifest-attested 50-task campaign, independent rewards
  and explicit per-task failures; then the complete 125-task suite.
- Only afterward, separately review incorporation into the shipping operator,
  with its own approval, budgets, recovery, independent goal proofs and
  original-device release acceptance.

**Release decision: KEEP DRAFT / DO NOT PUBLISH.**

## Additional native graphical provider work (draft PR #696)

After this audit identified the missing provider primitives, a separate
**unmerged, unreleased** source PR was opened:
https://github.com/sampathkumar-co/Operator-runtime/pull/696

That branch stages three typed operations on the Mecord CDP provider:
`double_click`, `shift_click`, and `drag_path` (2-24 normalized points
inside one exact observed ref). Path points are validated before dispatch,
including freshness and per-point hit testing; the native CDP dispatch
maintains a held left button between points. Canvas bitmap updates may
not produce a DOM state delta, so action dispatch **does not certify task
success**, and identical no-progress gestures remain replay-limited.

This code is **not present in runtime 2.0.7-rc.6**. The existing MiniWoB
bridge intentionally does not advertise these three operations until a
source-pinned candidate contains them and a real CDP qualification succeeds.
This report therefore continues to mark them as unsupported in the actual
current benchmark environment. Provider source CI and physical evaluation
remain separate gates.
