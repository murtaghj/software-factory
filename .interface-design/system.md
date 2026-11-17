# Dashboard design system: direction B, Control room

Source of truth: `docs/design/directions/specimen-control-room.html`. Code: `apps/dashboard/src/styles.css`, `line.tsx`, `components.tsx`, `shell.tsx`.

## Direction and feel
An enamelled control desk with a mimic diagram of the line. Fast to scan on the way in, deliberate at the gate. Signature: the line (stations scope to close, a gate drawn as two bars where a person decides) with numbered lamps. Lamps are the only saturated colour. Light by default, dark by `prefers-color-scheme`; no toggle.

## Tokens (light / dark)
- `--panel` #E1E8E4 / #1B2825 page. `--console` #EEF3F0 / #22332F grouped areas, top bar. `--raised` #FAFCFA / #2B403B first row, board cards, callouts.
- `--lit` #14211C / #E7F0EB text and primary button. `--dim` #44564D / #ABBDB4 secondary. `--unlit` #566860 / #8A9E94 tertiary (light value darkened slightly from the specimen's #5C6E65 for contrast on the panel).
- `--trace` 13% / 12% lit, `--trace-strong` 34%: hairlines and outlines.
- Lamps: `--amber` #F0A100 / #FFB52E held by you; `--red` #C2281C / #FF7466 stopped; `--green` #1B7F4C / #74DDA4 finished or done. Each has an `--on-*` text colour.
- `--font`: "Atkinson Hyperlegible Next Variable", Verdana, system-ui. One token; swap it there. Slashed zero is the font's own. `font-variant-numeric: tabular-nums` on body.

## Depth
Surface shifts only (panel, console, raised). No shadows. Borders are `--trace` hairlines between table rows and `--trace-strong` outlines on keys and inputs. Lamps carry a 3px 24% glow ring.

## Spacing and density
4px base. Table rows 46px (flight rows 38px). Gutter 20px (16px at 860px and below). Full width, no max-width on pages. Band padding 18px 20px 20px. Console panels 16px 20px 18px, radius 4px.

## Type scale
Ratio 1.2 from 14px: 12.5 notes, 14 body and table, 17 heading/empty, 20 count, 24 page title (letter-spacing -0.012em). Weights 400, 600, 700. Sentence case.

## Key components
- Top bar: 46px, console, gate mark (two 3x14px bars), nav links 12px side padding with 2px inset underline for the current page, inbox count token 18px, allowance gauge (96x6px tube, amber at 10% or less) and user at the right.
- Key (button): 30px high, 12px padding, radius 4, 13px/600, 1px `--trace-strong` outline; `.on` solid lit; `.refuse` red text; `.tall` 40px/14px; hover `--trace` fill, active scale .97, disabled .45 opacity. Plain action: underlined 13px `--unlit`.
- Lamp (`.lamp`): 9px dot with ring. Token (`.tok`): 22px pill with the row number, 12px/700; hollow 14px = waiting on someone else; solid 8px = agent running.
- Work line (`WorkLine`): grid of stations, 2px connector, 10px marks, gate 16x18px, lamps stacked above the station (36px zone), labels 13px, "a person signs here" under the gate. Task line (`TaskLine`, `.compact`): same with done (green), here, failed (red) and a state word under each; stands up as a column at 700px and below.
- Mini line (`MiniLine`): 6px marks, 3px gap, gate 7x11px bars, filled green up to the card's station.
- Table: fixed layout, columns 56px / task / 23% / 104px / 148px / 264px; first row raised; stacks to a grid at 700px and below.
- Review: sections in two columns (`--rows` = ceil(n/2)), 42px rows, 18px lamp toggle with "Read"/"Not read"; verdict panel 372px with count (20/700), 12-segment strip, reason field, three 40px keys.
- Board: columns on console, cards on raised, empty columns fold to a 44px strip; stacked on a phone.

## Rules held
No colour for decoration; a status is always a word as well as a colour. Focus ring 2px lit, offset 2px. Reduced motion disables pulse and press transforms. `theme-color` set for both schemes. No external requests (font is bundled).
