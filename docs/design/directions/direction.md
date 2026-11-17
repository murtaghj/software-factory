# Dashboard direction

Three directions for the software factory dashboard, with one recommended. Nothing in the app was changed. Each direction has a self-contained specimen (open the HTML; use the button to switch theme) and a 1280px render of each theme.

| Direction | Specimen | Renders |
|---|---|---|
| A. Hold point (recommended) | `specimen-hold-point.html` | `renders/hold-point-light-1280.png`, `renders/hold-point-dark-1280.png` |
| B. Control room | `specimen-control-room.html` | `renders/control-room-light-1280.png`, `renders/control-room-dark-1280.png` |
| C. Drawing office | `specimen-drawing-office.html` | `renders/drawing-office-light-1280.png`, `renders/drawing-office-dark-1280.png` |

The specimens use proposed wording where the current wording has a problem named in `critique.md` (for example "Stopped in Orders API 3 hours ago. The review request expired." in place of "Stopped — the review request expired"). The task names, people and projects are sample content.

## Intent first

**Who is this human?** A developer who is both an author and a reviewer. They were in their editor or a terminal five minutes ago and will be back there in five more. They arrive because something pinged them, or in the gap while their own agent runs. They do not live here.

**What must they accomplish?** Lift the hold that is on them, then leave. Second: find out why their own work stopped. On the review page the verb changes: read a plan and put their name to twelve sections of it. That act is recorded and it releases someone else's work, so it should feel deliberate, not like ticking a preferences form.

**What should it feel like?** An inspection bench at shift change: quiet, exact, and unambiguous about whose signature is missing. Fast to scan on the way in, slow and accountable at the moment of signing. Not friendly, not dramatic.

## Product domain exploration

**Domain.** The product is a factory, so the territory is a job shop and its paperwork:
- the *traveler*, the sheet that moves with a job and is stamped at each station
- the *hold point*, a stop that only a named inspector can lift
- the *dispatch list*, a work centre's ranked list of what to do next
- the *andon*, the lamp that lights when the line stops
- the *mimic panel*, a control room's diagram of the line
- the *title block* of a drawing, with its drawn-by, checked-by and approved-by boxes
- the *redline*, a checker's marks on someone else's drawing
- *stores allowance*, drawn down as work runs

**Color world.** What you would see standing in that building:
- galvanised steel and a concrete floor
- stamp-pad black
- the yellow of a hold tag and of aisle markings
- lockout-tag red, and the green of an accepted tag
- green-grey machine enamel on a control desk
- amber, red and green stack lamps
- Prussian blue of a blueprint, and the white of a whiteprint
- red checking pencil on tracing paper

**Signature.** A person at a gate. This product is the only one where an agent's work physically stops until a specific colleague signs, and where everyone is on both sides of that. Each direction gives that idea one concrete form: a sign-off box (A), a gate on a line (B), a title block (C).

**Defaults to reject.**
1. A card per item with a status chip and a coloured stripe. Replace with one surface whose rows differ by what they say.
2. A wide sidebar and a greeting headline. Replace with a slim bar, and let the top-ranked reason be the headline.
3. Coloured avatar circles and a rainbow of status tints. Replace with one reserved colour that means "waiting on you".
4. A grid of twelve identical checkbox tiles. Replace with a numbered list in the plan's own order.

---

## Direction A: Hold point

The inspection bench. One sheet of paper, ink, and a yellow tag.

**Signature: the sign-off box.** Initials in a small square are a person at a gate. A solid ink box means that person has signed. A dashed box means someone else is awaited. A **yellow** box is awaiting *you*, and that is the only thing yellow is ever used for. A struck red box is stopped; a green tick is passed. Two boxes joined by a line read as a sentence: Dana, then you.

| Token | Light | Dark | Role |
|---|---|---|---|
| Bench | `#E9ECEA` | `#22282A` | page, about 60% |
| Sheet | `#FAFBF9` | `#2A3134` | the one raised surface, about 30% |
| Ink | `#15191B` | `#ECEFEC` | text, signed boxes, the primary button |
| Graphite | `#485257` | `#B6BFC0` | secondary text (Pencil `#646E73` / `#929DA0` is the third step) |
| Hold | `#F2C200` | `#F2C200` | waiting on you, and nothing else |
| Stop / Pass | `#B3261E` / `#1E7548` | `#FF8A7A` / `#70CC96` | status only, small |

- **Typeface:** Archivo, variable on weight and width. SIL Open Font License 1.1. Source: `@fontsource-variable/archivo` 5.3.0 (file `archivo-latin-wdth-normal.woff2`, 90 KB). One family: normal width for text, 76% width for the initials in the boxes. Chosen because it is a sturdy grotesque of the kind printed on forms and tags, and its width axis gives the stamps their own voice without a second family.
- **Type scale:** ratio 1.2 from 15px: 13, 15, 18, 22, 26, 31. Weights 400, 500 to 600, 650. The lead is 31/650 with -0.022em tracking.
- **Density:** 8px base. Rows are 15px by 32px padding. The queue column is 800px; the review is 1000px split 624 and 328.
- **Depth:** borders only. One surface step (bench to sheet), hairline rules inside the sheet, a heavier rule where the kind of reason changes. No shadows. Radii 2 (boxes), 4 (controls), 6 (sheet).
- **Layout:** a top bar replaces the sidebar. Everything sits on a left gutter 112px wide that holds the boxes, so the glyphs and the text each keep one edge down the whole page.

My work:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣ Software factory   My work   Inbox [2]   Projects   Budget    $7 left  RI  │
├──────────────────────────────────────────────────────────────────────────────┤
│        ┌────────────────────────────────────────────────────────────┐        │
│        │ [DA]─[RI]   Dana is blocked on you            (31px, lead) │        │
│        │             Why do some orders fail after a retry?         │        │
│        │             The plan for Orders API needs your approval.   │        │
│        │             The request expires in 2 days.                 │        │
│        │             [ Review the plan ]            (only solid btn)│        │
│        ├────────────────────────────────────────────────────────────┤        │
│        │ [DA]─[RI]   Are duplicate invoices caused…   ( Review now )│        │
│        │             Dana is blocked on you in Billing API, 4 days  │        │
│        ╞════════════════════════════════════════════════════════════╡ heavier│
│        │ [▁ ]        Your allowance is about to run out (Open budget)│  rule  │
│        ╞════════════════════════════════════════════════════════════╡        │
│        │ [╲ ]        Can we drop the legacy…  Mark as seen (See why)│        │
│        ╞════════════════════════════════════════════════════════════╡        │
│        │ [✓ ]        Add an idempotency key…  Mark as seen (See res)│        │
│        └────────────────────────────────────────────────────────────┘        │
│         How this list is ordered                                             │
│                                                                              │
│         Your other work (2)                         (on the bench, no sheet) │
│         [RI]┄[SA]   Why does proration round…           expires in 6 hours   │
│          ○          Trace the slow month-end report     started 12 min ago   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Decision review:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣ Software factory   My work   Inbox [2]   Projects   Budget    $7 left  RI  │
├──────────────────────────────────────────────────────────────────────────────┤
│  Back to inbox                                                               │
│  [DA]─[RI]   Why do some orders fail after a retry?                          │
│              Dana asked you to approve the plan for Orders API…              │
│              ( Open the plan in a new tab )                                  │
│                                                                              │
│  ┌──────────────────────────────────────────┐    5 of 12 signed              │
│  │     Plan section            Your sign-off│    ■■■■■□□□□□□□  (□ = yellow)  │
│  │  1  Intent and scope    signed 14:02 [RI]│    Approval needs all 12.      │
│  │  2  Current state       signed 14:05 [RI]│                                │
│  │  …                                       │    Your reason                 │
│  │  6  Acceptance tests                 [  ]│    ┌────────────────────────┐  │
│  │  7  Quality and security             [  ]│    │                        │  │
│  │  …                                       │    └────────────────────────┘  │
│  │ 12  Review and ownership             [  ]│    [      Approve plan      ]  │
│  └──────────────────────────────────────────┘    (Request changes)(Reject)   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Ticking a line turns its yellow box into your ink initials with the time. Lines still to do stay bold; signed lines step back.

**Cost to build:** the lowest. It needs no API change and no routing change; `QueueView` is already an ordered list, and every glyph is derivable from fields the queue and my-work payloads carry today.

---

## Direction B: Control room

The mimic panel. Everything at once, for someone who wants to see the whole line.

**Signature: the line and its lamps.** One diagram of the stages, scope to close, with a gate drawn where a person signs. On the home page every task of yours sits on it as a lamp at the stage it has reached. Lamps that need you carry the number of their row in the table underneath. The same line, for one task, heads the task page and the review.

| Token | Light | Dark | Role |
|---|---|---|---|
| Panel | `#E1E8E4` | `#1B2825` | page |
| Console | `#EEF3F0` | `#22332F` | grouped areas (Raised `#FAFCFA` / `#2B403B` marks the first row) |
| Lit | `#14211C` | `#E7F0EB` | text, the primary button |
| Dim | `#44564D` | `#ABBDB4` | secondary text |
| Amber lamp | `#F0A100` | `#FFB52E` | held by you |
| Red / Green lamp | `#C2281C` / `#1B7F4C` | `#FF7466` / `#74DDA4` | stopped / finished |

- **Typeface:** Atkinson Hyperlegible Next, variable on weight. SIL Open Font License 1.1. Source: `@fontsource-variable/atkinson-hyperlegible-next` 5.3.0 (34 KB). Chosen because it was drawn so that similar characters cannot be mistaken for each other, which suits a board read at a glance. One trait to look at before choosing: its zero is slashed. I rendered it in Chrome with the `zero`, `ss01`, `ss02` and `salt` features and with proportional figures, and none gave a plain zero, so money reads with slashes.
- **Type scale:** ratio 1.2 from 14px: 14, 17, 20, 24, with 12.5 for notes. Weights 400, 600, 700.
- **Density:** tight. 4px base, 46px table rows, 20px gutters, full width.
- **Depth:** surface shifts only: one green-grey hue at three lightness steps. No shadows, almost no borders. Lamps are the only saturated colour.

My work:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‖ Software factory  My work  Inbox (2)  Projects  Budget  (3)▬── $7 of $60  R│
├──────────────────────────────────────────────────────────────────────────────┤
│ Where your work is held      ● held by you ● stopped ● finished ○ else · run │
│                      (1)(2)(4)○        ·                              (5)    │
│   ○──────────○──────────‖──────────○──────────○──────────○──────────○        │
│  Scope      Plan    Plan review  Investigate  Evidence   Deliver    Close    │
│                  a person signs here           review                        │
├──────────────────────────────────────────────────────────────────────────────┤
│      Task                           Why it is here       Project    When     │
│ ▓(1) Why do some orders fail…       Dana is blocked…     Orders   2 days [Rev]│
│  (2) Are duplicate invoices…        Dana is blocked…     Billing  4 days (Rev)│
│  (3) Your monthly allowance         $7.00 left of $60.00          2 weeks (Bud)│
│  (4) Can we drop the legacy…        The review expired   Orders   3h ago (See)│
│  (5) Add an idempotency key…        Take a look          Orders   1h ago (See)│
│                                                                              │
│  Your other work (2)                                                         │
│   ○  Why does proration round…      Waiting on Sam       Billing  6 hours    │
│   ·  Trace the slow month-end…      An agent is running  Billing  12 min in  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Decision review:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Back to inbox                                                                │
│ Why do some orders fail after a retry?            ( Open the plan in new tab)│
│ Dana asked you to approve the plan for Orders API. 2 days left.              │
│ ┌──────────────────────────────────────────────────────────────────────────┐ │
│ │  ●━━━━━━━━━●━━━━━━━━━‖─────────○─────────○─────────○─────────○           │ │
│ │ Scope     Plan    Plan review  Investigate  Evidence   Deliver  Close    │ │
│ │ done      done   held here by you  not started …                         │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ ┌──────────────────────────┐ │
│ │ Sections of the plan                        │ │ 5 of 12 read             │ │
│ │ 1 Intent and scope  Read ●│ 7 Quality…    ○ │ │ ━ ━ ━ ━ ━ ─ ─ ─ ─ ─ ─ ─  │ │
│ │ 2 Current state     Read ●│ 8 Delivery…   ○ │ │ Your reason              │ │
│ │ …                         │ …               │ │ [                      ] │ │
│ │ 6 Acceptance tests      ○ │12 Review…     ○ │ │ [     Approve plan     ] │ │
│ └─────────────────────────────────────────────┘ │ (Request ch.) (Reject)   │ │
│                                                 └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Cost to build:** medium. The line needs each item's stage position and one agreed list of stations. My-work cards carry `currentNodeId`, but queue items do not, and the station list comes from each task's own plan (`/v2/tasks/:id/plan`). That means a small API addition (stage "n of m" on queue items and board cards), or one plan request per task. The specimen marks only Plan review as a gate, because that is the one stage I could confirm a person signs.

---

## Direction C: Drawing office

A plan is a drawing: one person writes it, another checks it, nothing is built until it is signed.

**Signature: the title block.** Every object gets the same small grid of cells: task, project, written by, checked by, stage, expires. The cell that is waiting on you is written in red pencil. The board card, the stopped task and the budget use the same grid.

**Structure: list and sheet side by side.** This is the only direction that changes how the app works. The queue stays on the left; choosing an item opens it on the right. A review never leaves the page.

| Token | Light (whiteprint) | Dark (blueprint) | Role |
|---|---|---|---|
| Vellum | `#ECF1F7` | `#0F2644` | page |
| Sheet | `#FBFCFE` | `#15335C` | the drawing |
| Ink | `#17335A` | `#E6EEF9` | text and line-work, one Prussian hue |
| Pencil | `#4A5E7E` | `#B6C7DF` | secondary text |
| Faint | `#5F7290` | `#93A9C8` | cell labels |
| Redline | `#C8322B` | `#FF9383` | waiting on you, and the reject action |

- **Typefaces:** Sofia Sans for text and Sofia Sans Semi Condensed for cell labels, both variable on weight. SIL Open Font License 1.1. Source: `@fontsource-variable/sofia-sans` and `@fontsource-variable/sofia-sans-semi-condensed` 5.3.0 (40 KB and 42 KB). A DIN-style face; that description is my reading of the design, not a claim checked against the foundry's notes.
- **Type scale:** ratio 1.25 from 16px: 16, 20, 25, 31, with 13.5 for cell labels. Weights 400, 600 to 700, 800.
- **Density:** medium. 4px base, 44px rows, cells padded 10 by 16. List 404px, sheet takes the rest.
- **Depth:** line-work only. A 1.5px frame around the sheet, hairlines between cells, square corners. No shadows, no fills except the sheet.

My work and decision review (one screen):

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⊡ Software factory   My work   Inbox 2   Projects   Budget   $7.00 left Riley│
├───────────────────────────┬──────────────────────────────────────────────────┤
│ Needs you, most urgent    │ ┌──────────────────────────┬─────────┬─────────┐ │
│▌Why do some orders… 2 days│ │ Task                     │ Project │ Plan    │ │
│▌Dana is blocked on you.   │ │ Why do some orders fail… │ Orders  │ Vers. 2 │ │
├───────────────────────────┤ ├───────────┬───────────┬──┴───────┬─┴─────────┤ │
│▌Are duplicate inv… 4 days │ │ Written by│ Checked by│ Stage    │ Expires   │ │
│▌Dana is blocked on you.   │ │ Dana      │ Riley,    │ Plan     │ in 2 days │ │
├═══════════════════════════┤ │           │ not yet   │ review   │           │ │
│▌Your allowance…  $7 left  │ ├───────────┴───────────┴──────────┴───────────┤ │
├═══════════════════════════┤ │ Dana asked you to approve…  ( Open the plan )│ │
│▌Can we drop the…  3h ago  │ │ Sections of the plan            5 of 12 chkd │ │
│ Mark as seen              │ │ 1 Intent and scope  ☑ │ 7 Quality…        ☐  │ │
├═══════════════════════════┤ │ …                     │ …                    │ │
│ Add an idempotency… 1h ago│ │ 6 Acceptance tests  ☐ │12 Review…         ☐  │ │
│ Mark as seen              │ ├───────────────────────────────┬──────────────┤ │
│                           │ │ Your reason                   │ Your decision│ │
│ Your other work (2)       │ │ [                           ] │ [ Approve  ] │ │
│ Why does proration… 6h    │ │                               │ ( Request  ) │ │
│ Trace the slow…   12 min  │ │                               │ ( Reject   ) │ │
└───────────────────────────┴─┴───────────────────────────────┴──────────────┴─┘
```

**Cost to build:** the highest. Routing changes so that a decision or task can render inside the work page, and every page needs a phone layout where the two panes become two steps. "Stage 3 of 7" needs the same stage data as direction B.

---

## The checks, and what I revised

### Against the frontend-design list of generated-design tells

| Tell | A. Hold point | B. Control room | C. Drawing office |
|---|---|---|---|
| 1. Cream, serif display, terracotta | Clear | Clear | Clear |
| 2. Near-black with one bright accent | **Near it in dark.** Graphite with yellow. Kept, because yellow is never a button or link and the light theme leads. | **Near it in dark.** The panel is a very dark green. Kept as the room's colour; three lamps, not one accent. | Clear. The dark theme is a real blue. |
| 3. Broadsheet hairlines, zero radius | Hairlines inside one sheet, radii 2, 4, 6 | Clear | **Near it.** Square corners and hairline cells. Kept, because each cell is a labelled field, not a decorative column. |
| 4. Identical rounded cards, one shadow | Clear, one sheet, no shadows | Two consoles on the review share a radius; no shadows | Clear |
| 5. Template chrome | Clear | Clear | Clear |

Tell 5 was checked item by item in all three: no all-caps labels, no eyebrow above headings, no middle-dot joins, no spaced em-dash labels, no arrows on buttons, no monospace for data. Numbering appears only where the content is a real sequence: the plan's twelve sections, and the server's rank in B, where the number links a lamp to its row.

### What changed while building

- **Rank numerals removed from A.** The current UI shows 1, 2, 3 in circles. Position already says it, so the numbers went. B keeps them because there they do a job.
- **Status chips removed from A and B.** The first B draft had a State column ("Blocked on you") beside the reason ("Dana is blocked on you"). That repeated the duplication `critique.md` complains about, so the column was cut and the state moved to the lamp's label for screen readers.
- **Titles no longer truncate in B.** The first render cut "Why do some ord…". The task column now wraps; the title is the one thing a row cannot lose.
- **The lead in A moved onto the gutter.** The boxes first sat above the headline like an eyebrow. They now sit in the same 112px gutter as every row, which gives the page one left edge for glyphs and one for text.
- **A selector collision fixed.** `.lead` (the top item) was also restyling `.btn.lead`, which pushed the Approve label off centre. The button modifier was renamed. Worth remembering when this is built for real.
- **Red restricted in C.** "Resets in 2 weeks" and "3 hours ago" were first drawn in red. Red now marks only what is still running out.
- **Costume left out of C.** No grid-paper background, no revision clouds, no stencil lettering. The title block is enough.

### The interface-design tests

- **Swap test.**
  - A: swap Archivo for Inter and the stamps lose their narrow voice and the lead loses its weight; swap the layout for cards and the gutter and the single sheet disappear. The top bar is ordinary, and would not notice the swap.
  - B: the typeface matters least here. The line is what would be missed.
  - C: the title block and the split are the design. Without them it is a blue theme.
- **Squint test.**
  - A, My work: the headline and the one black button lead, and the yellow boxes make a column down the left. Passes.
  - A, review: the yellow column is the loudest thing on the page. That is intended, since it is the work remaining; Approve is second.
  - B: the lit first row and the lamp cluster at Plan review lead. Passes, but it is busier.
  - C: the selected row and the sheet title lead. Passes.
- **Signature test (A).** The sign-off box appears in the specimen as: the product mark, the inbox count, the pair on each queue row, the awaited pair under "Your other work", each line of the review sheet, the twelve-cell strip, and the person in the top bar. Planned but not drawn: each gate on the task page, and the waiting line on board cards.
- **Token test.**
  - A: bench, sheet, well, ink, graphite, pencil, rule, hold, stop, pass.
  - B: panel, console, raised, lit, dim, unlit, trace, amber, red, green.
  - C: vellum, sheet, well, ink, pencil, faint, line, frame, redline.
  - None of the three has a `gray-700` or a `surface-2`.

## Recommendation: A, Hold point

1. **It answers the owner's sentence most directly.** "See what they need to care about next" is one thing leading. A is the only direction where the top-ranked reason is the largest thing on the screen and holds the only solid button.
2. **Its signature is the product's own idea.** A named person at a gate, on both sides, is what makes this factory different from a CI dashboard. The box says it on every screen, and it replaces three generic devices at once: avatars, status chips and count badges.
3. **Colour finally means one thing.** Yellow is "yours". A developer can learn the interface from that single rule.
4. **It is the cheapest to build and the safest.** No API change, no routing change, one font file, and the phone layout is the desktop layout stacked. B and C each need new data or new navigation before they can be finished.
5. **It fits the real volume.** The demo shows one to five items. B's density is built for thirty; with five it is a large instrument showing very little.

What I would borrow from the others later: B's line, for the task page only, with a sign-off box at each gate. It is the right picture for "where is this task", and the task page already has the data.

Confidence: high that A is the right structure and signature. Medium on the exact yellow and on Archivo against one or two close alternatives; those are cheap to tune once the owner has seen it in the real app.

## Build constraints I checked

- **How it is built.** `apps/dashboard/scripts/build.ts` runs Vite 8.3.5 with no config file and `base: './'`; output is `index.html` plus hashed assets. `main.tsx` imports `styles.css`. Importing a fontsource stylesheet from there would make Vite emit the `.woff2` as a hashed, same-origin asset.
- **Content security policy.** The dashboard has none today. The demo server (`tests/system/scripts/dev.ts:60`) sends only `cache-control`, `x-content-type-options` and `referrer-policy`; `index.html` has no policy meta tag. The only policy in the repository is on the artifact download origin (`packages/artifacts/src/download-origin.ts:14`). So nothing blocks fonts now, and self-hosting keeps a later `font-src 'self'` possible. One thing to know for that day: the app sets inline `style` attributes (the avatar hue, the meter width), which a strict `style-src` would refuse. Direction A removes the avatar hue.
- **Dependencies.** The root and dashboard `package.json` files pin exact versions, locked in `pnpm-lock.yaml`; pnpm is 12.16.1. All four font packages are OFL-1.1 by their own `package.json` and `LICENSE` files, and version 5.3.0 was published on 2026-07-19, so a release-age gate would pass. I did not find the gate's configured value, only its exclusion list in `pnpm-workspace.yaml`.
- **Licence policy.** The spec plans a licence check for new dependencies (W-118, AC-187) that is not built yet. OFL-1.1 would need to be on its allowed list.
- **Coverage.** The embedded files are the Latin subset. Fontsource also ships Latin Extended, loaded by `unicode-range` when needed. Names in other scripts would fall back to the system font.
- **Specimens.** Each HTML file embeds its fonts as base64 and was checked in headless Chrome to make no network requests. If a font failed to load, A would fall back to Helvetica Neue or Arial, B to Verdana, C to Trebuchet MS.

## What the owner needs to decide

1. **The direction:** A, B or C.
2. **A font dependency.** Whether the dashboard may add one exact-pinned OFL font package (A: `@fontsource-variable/archivo` 5.3.0, about 90 KB for the weight-and-width file).
3. **The sidebar goes.** A and B replace it with a top bar, so the project list lives on the Projects page.
4. **The headline is the reason, not the task title.** In A the lead says "Dana is blocked on you" above the task's name. That is the opposite emphasis from today.
5. **Shared wording changes.** Removing the dashes from "Stopped — ran out of budget" and its siblings means editing `packages/client/src/queue.ts`, which the CLI and the agent tool also use.
6. **"Signed" or "reviewed".** A calls a ticked section "signed" and stamps the reviewer's initials. The API field is `reviewedSectionIds` and today's label is "Sections you have reviewed". "Signed" is stronger than the current promise; the owner should choose the word.
7. **Initials can collide.** Boxes show two letters, so Dana and Dan are both "DA". The full name is always in the sentence beside the box and in its label, but if teams are large this needs a rule (a third letter, or a number).
8. **Only if B or C is chosen:** agree to the API addition for stage position (both), and to in-place review with its routing and phone work (C).
