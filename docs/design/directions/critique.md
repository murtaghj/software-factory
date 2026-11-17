# Design review of the current dashboard

Verdict: **not approved.** Four presumptive blockers are present (no focal point, defaulted typography, competing accents, monotone card layout). The engineering underneath is sound and worth keeping; the look is a kit, and nothing on screen says what this product is.

Method: `.claude/commands/design-review.md`, steps 1 to 5. Line numbers refer to files under `apps/dashboard/src/` unless a path is given.

## Step 1: scope and intent

- **Under review:** the whole dashboard as built: sign-in, My work (the P-24 queue), Inbox, Decision review, Projects, Project board, Task page, Budget. Evidence is the 22 screenshots in `scratchpad/shots/` (light, dark and 390px, as Dana and Riley) and the source (`styles.css`, `components.tsx`, `shell.tsx`, `packages/client/src/queue.ts`).
- **What it is trying to be:** there is no `.interface-design/system.md`, so intent is taken from the owner's brief: "a single pane of glass where devs just see what they need to care about next." The person is a developer who is both author and reviewer, visiting between other work to unblock someone or get unblocked. The review is against that intent.

## Step 2: the whole, before the parts

- **Does one thing lead?** No. On My work the largest text is "Hello, Dana" and the highest-contrast object is the indigo button. The eye goes greeting, then button, and skips the reason, which is the only thing the server worked to produce.
- **Does it breathe?** It is the same rounded panel at the same gap on every page, then empty canvas. With one or two items the page is mostly blank and uncomposed.
- **Does it look like this product?** No. Remove the words and it is any SaaS admin: sidebar, pill chips, avatar circles, soft-shadow cards.
- **Squint test:** on My work, what survives is a tinted rectangle and a blue button. On Decision review, twelve identical boxes and three same-sized buttons. Hierarchy does not survive.

## Findings

### Blockers

**1. No focal point on the page whose job is "what next". (Lens A)**
- What defaulted: the first queue item is the same card as the rest with a tinted background (`styles.css:94-96`, `:187`). Its title is 15px/600, the same size and weight as nav links and button labels (`:85`, `:71`). The `h1` greeting is the biggest thing on the page (`:54`, `components.tsx:68`). Every row gets a primary-coloured button, so no action is demoted (`components.tsx:92`).
- Why it costs: the product's whole promise is ranking, and the rank-one item does not win. Promotion without demotion is not hierarchy.
- Crafted fix: make the top item's reason the headline of the page, in the largest type on screen, with the only filled button. Every other row gets an outline button. Remove the greeting.

**2. Typography was never decided. (Lens B)**
- What defaulted: `font-family: Inter, ui-sans-serif, system-ui…` (`styles.css:11`), but no font file ships, so it is San Francisco on a Mac and Segoe on Windows. There are **21 distinct font sizes**, 13 of them between 10.8px and 14.25px (0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.85, 0.86, 0.88, 0.9, 0.92, 0.95rem…), and six weights (400, 500, 550, 600, 650, 700). There is no ratio. Text has two colours, `--text` and `--muted`, where four levels are needed. `tabular-nums` appears nowhere, although money, counts and times update live.
- Why it costs: near-equal sizes read as mush, so tiers have to be carried by chips and colour instead. System fonts are the first tell of an undesigned interface.
- Crafted fix: one shipped family, a five-step scale on a stated ratio, three weights, a four-step ink ramp, tabular figures on every number.

**3. Six hues compete, and colour does not mean one thing. (Lens B)**
- What defaulted: an indigo accent, plus violet "waiting", blue "active", green, amber and red, each with a pale twin (`styles.css:6-8`). Avatars add an arbitrary hue per person (`:68`, `format.ts` `hueOf`). In the Dana screenshot the lead row carries an amber wash, a red left border, a red chip and an indigo button at once. Tiers 1 and 2 share one border colour (`:188`), so the stripe does not even encode the tier. Indigo is spent on nav, links, buttons, project dots, the budget meter, the current stage and the focus ring.
- Why it costs: when everything is tinted, the tint for "someone is blocked on you" is not a signal. This is the "timid or competing-accent palette" blocker.
- Crafted fix: neutral structure, ink for actions, and exactly one colour reserved for "this is waiting on you". Stop and pass keep red and green, used small.

**4. One card, one radius, one shadow, everywhere; mixed depth. (Lenses C and D)**
- What defaulted: `.panel, .card` share border, 10px radius and shadow (`styles.css:77`), and every page is a stack of them. Depth is expressed four ways at once: border, shadow, tinted fill and a 3px coloured left stripe (`:91`, `:158`, `:188`). Content runs to 1280px (`:52`), so a one-line item stretches 944px with its button marooned on the far right. A 256px sidebar holds three links and two projects. The Budget page is one panel with a 640px meter inside a 944px box.
- Why it costs: this is the SaaS-card kit, the look the owner already rejected. Proportions state no relationship.
- Crafted fix: choose one depth strategy. Put the queue on one continuous surface with rows, not a card per item. Give the content a measured column and move the four nav links to a top bar.

### Should fix

**5. Decision review treats the product's most consequential act as a generic form. (Lenses A and D)**
- The twelve sections are identical bordered tiles in an auto-fill grid (`styles.css:150-151`). They read across in rows while the plan reads 1 to 12 down, and they are not numbered, so matching a tile to the open plan is guesswork. Progress is a small "0 of 12" pill. Approve, Request changes and Reject are the same size in one row, with Approve filled even at 0 of 12 (`shell.tsx:157-159`). "What you are deciding" spends a full panel on a boilerplate sentence.
- Fix: a numbered single-order list that mirrors the plan, a progress display that is the second most prominent thing on the page, and a verdict area where Approve leads and Reject is clearly the far end.

**6. Template chrome and duplicated words. (Lens F, content)**
- Tracked all-caps eyebrows (`styles.css:44`, `:97`; "APPROVE PLAN" in the inbox). Spaced em dashes as a label device: "Stopped — ran out of budget", "Finished — take a look at the result" (`packages/client/src/queue.ts:54-55`, `:89`), "Live — last updated just now" (`view-model.ts:31-34`). Middle-dot joins (`components.tsx:154`, `:191`; `shell.tsx:134`). Arrows glued to labels: "Open board →", "← Inbox", "Open the plan ↗" (`shell.tsx:69`, `:132`, `:139`).
- The same fact is said twice per row: a "Stopped" chip above "Stopped — ran out of budget"; a "Blocked on you" chip above "Dana is blocked on you".
- Fix: say each thing once, as a sentence. Note that `queue.ts` wording is shared with the CLI and the agent tool, so this is a wording decision, not only a dashboard one.

**7. Missing states and polish. (Lens E, plus the web interface guidelines)**
- No `:active` state anywhere and no transitions; hover on the primary button is `filter: brightness(1.08)` (`styles.css:73`).
- "Mark as seen" is a text button with `padding: 2px 0` (`:75`), about 26px tall, under the 40px minimum.
- No `text-wrap: balance` on headings. No `<meta name="theme-color">` (`index.html`).
- The reason inputs have no `name` or `autocomplete` (`shell.tsx:111`, `:154`); the placeholder does not end with an ellipsis (`shell.tsx:111`).
- "Cancel task" and "Reject" act immediately. A required reason is a speed bump, not a confirmation or an undo (`shell.tsx:114`, `:159`).
- Eight `!important` declarations, seven of them fighting the sidebar's own link rule (`styles.css:44-45`, `:175-176`).

**8. The phone header gap (the known nit): cause found and fix verified.**
- Cause: `.shell` is a grid with `min-height: 100vh` (`styles.css:36`). At 860px and below it becomes one column with two implicit auto rows, and a grid stretches auto rows to share spare height. On a short page the header row is stretched to 271px.
- Fix: inside the `max-width: 860px` block add `.shell { grid-template-rows: auto 1fr; }`. Measured in the running demo at 390×844 by injecting that rule into a headless page: header 271px before, 102px after. The app source was not changed.

### Notes

- `[data-section="needsYou"] .card` and `[data-section="stopped"] .card` (`styles.css:91`) appear to be left over from before the queue; nothing in `components.tsx` renders `data-section`.
- The running-status dot pulses forever (`styles.css:63`). It respects reduced motion, but a permanent loop beside other content should be a deliberate choice.

## What is already right, and should survive any redesign

- Codes never reach the screen; every status has words (`format.ts`, `wording.ts`).
- Status is text plus colour, never colour alone.
- Semantic structure: ordered list for the queue, `<time>` with full-date titles, `fieldset` and `legend`, `details`, a skip link, `:focus-visible`, a reduced-motion guard.
- The view renders the server's order and never sorts.
- Honest staleness on the task page.
- Empty board columns fold to a strip so working columns get the room.

## The three things actually holding it back

1. The rank-one item does not lead (finding 1).
2. No typeface, no scale (finding 2).
3. Colour and cards are spread evenly over everything, so nothing reads as "yours" (findings 3 and 4).

Fix those from the decision, not as patches, and the rest is detail.
