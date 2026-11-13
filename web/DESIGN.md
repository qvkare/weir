# Weir design brief: "Silicon", v3

This brief describes the site as it is. Change it before building something it does not allow. Every figure on the site comes from the contract views (SPEC section 12), `evidence/`, `backtest/` results or the engine running on the server or in the browser. No page types a number; examples and simulations are computed by the engine and labelled as such where they appear.

## 1. Direction

**The subject is GPUs and the people who trade GPU time.** The thing traded is one hour of a real chip, so the chip is drawn like a museum specimen; every order is a die on a wafer; the people on each side are drawn in fine lines; and everything around them is a calm, exact cleanroom: neutral ground, hairlines, mono spec sheets, one dot-matrix face for figures you should remember, and colour spent only on the two groups of people the market serves.

The direction is SILICON, the first of three art-direction boards (`brand/proposals/hydraulic/board.html`; the folder name is historical). Two ideas from the SWARM board survive, redrawn in SILICON's hand: the market as a shift of work on a floor (section 7.4), and a house character with a face (the mark). From EXCHANGE: the two sides made explicit as people ("Who is in the room", section 6.1) and one ink stamp, CLEARED, at the moment a round is called. Left out on purpose: SWARM's rounded chip-people and its flock, EXCHANGE's black split-flap board, vermilion and serif. The name "Weir" is only a name; nothing on the site illustrates it (no water, dams or levels).

**First five seconds, in order:** the headline "Take the heat out of your GPU bill." with its last words in the dot-matrix face; the live H100 index figure under it; the wafer, a simulated sealed round clearing behind the copy.

**Section lines.** "Many agents. One price." heads the round on the floor; "Next week's compute, called today." heads the payoff; the footer signs off with the headline.

## 2. Name

**Weir.** Pair it with a product word ("Weir auction") in search. Known collisions outside the category: WEIR AI (weir.ai) and The Weir Group.

## 3. Mark

### 3.1 What it is

**Crew cut** (SILICON proposal A): a heatsink seen end-on, fins standing on a solid base, two arched eyes punched through the base, looking up at the fins. It is the most recognisable silhouette in a machine room, it reads at 16 px, and it is the only thing on the site with a face. One colour, always `currentColor`. The eyes are holes, never a second colour.

### 3.2 Construction (`lib/logo.ts`, exports in `brand/`)

![Construction](brand/mark-construction.svg)

- **Full cut**, 48 grid, for anything drawn 32 px tall or more: five fins 4.4 wide on a 7.9 pitch from x = 6 (gaps 3.5), tops rounded 1.2, feet square on the base line y = 23; base 36 wide (x 6 to 42, y 23 to 43) with 7-unit lower corners; eyes 5.4 wide, arched (radius 2.7), from y 27.6 to 36, centred 6.7 either side of the axis x = 24. Crop `5 4 38 40`.
- **Small cut**, 24 grid, under 32 px (header lockup, favicon): three fins 4 wide on a 7 pitch (gaps 3), base 18 wide with 3.5 corners, eyes 3 wide from y 13.5 to 18. Every straight edge is on a whole unit, so it is pixel-exact at 24 and 48 px and still a face at 16 px. Crop `2 1 20 21`.
- **Small-size rule:** `Mark` picks the cut from its rendered size (`SMALL_BELOW = 32`). Never draw the five-fin cut under 32 px: the gaps close and the eyes fill in.
- **What changed from the board's drawing.** The fins now stop exactly on the base line instead of overlapping it, so the even-odd rule only touches the eyes and the shape exports cleanly; the base corners and eye tops are true arcs, not quadratic curves; the small cut was redrawn on its own 24 grid (the board scaled its 48-grid cut) with the eyes set one unit low, so at 16 px they read as looking up rather than as two dots in the middle.
- **Wordmark.** Set, not drawn: Geist 600, tracking -0.045 em. The lockup uses the small cut, cropped, 0.92 em tall, centred on the x-height, gap 0.3 em.

### 3.3 Usage

- Clear space: one fin pitch on every side of the lockup. Minimum: 16 px mark, 72 px lockup.
- Do: ink on paper, paper on ink; the full cut alone at 32 px and up; the house character on the floor (the one place the eyes move).
- Do not: colour it in a side colour, give it coloured eyes, outline it, add a shadow, rotate it, or put it in a circle.

### 3.4 Files

`components/logo.tsx` (`Mark`, `Lockup`), `lib/logo.ts` (geometry, and the body without eyes for the floor), `brand/mark.svg`, `brand/mark-small.svg`, `brand/mark-construction.svg`. `tools/og-image.ts` renders `public/icon.svg` (small cut on an ink tile, a paper tile for dark tab bars), `icon-32.png` (small cut), `apple-icon.png` and `icon-512.png` (full cut, full-bleed squares) and `opengraph-image.png` (lockup, headline, a still of the wafer from the same engine clearing).

## 4. Colour and type

### 4.1 Colour (`app/globals.css`; ratios against the ground, then the sheet)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#ECECE8` | `#0B0B0C` | The cleanroom ground |
| `--sheet` | `#F7F7F4` | `#131416` | Panels, cards, figures, the wafer |
| `--panel` | `#E2E2DD` | `#191A1D` | Bands, hover rows, the rack's spine |
| `--rule`, `--rule-2` | `#C8C8C1`, `#DADAD4` | `#2E2F33`, `#222327` | Lines only |
| `--die` | `#D3D3CC` | `#26272B` | A sealed or unfilled die |
| `--ink` | `#111214` 15.8 / 17.5 | `#EDEDEA` 16.8 / 15.7 | Text, drawings, the clearing price |
| `--ink-2` | `#4A4B50` 7.3 / 8.1 | `#A3A4A9` 7.9 / 7.4 | Secondary text |
| `--ink-3` | `#66676C` 4.8 / 5.2 | `#85868B` 5.4 / 5.1 | Ticks, drawing labels; text 13 px and up only |
| `--long` | `#2D43C4` 6.5 / 7.2 | `#8D9BFF` 7.7 / 7.3 | Buyers, LONG, demand. Always solid |
| `--short` | `#8A6000` 4.7 / 5.2 | `#E3B23C` 10.0 / 9.4 | Sellers, SHORT, supply: text and lines. Always with a second cue |
| `--short-lit` | `#C99200` | `#F2C454` | Fills only (a lit seller die, hatch grounds); never text |
| `--flag` (= `--bad`) | `#A1301F` 6.0 / 6.6 | `#F08C78` 8.2 / 7.7 | Sample, simulated, stale, void, errors |

**Two side colours, and a second cue that is not colour.** Blue and gold sit at the two ends of the blue-yellow axis that protan and deutan readers keep, and differ in lightness, so they survive greyscale. Blue is always solid; gold is always hatched (`#hatch-short`, `--hatch-short`), dashed (supply lines, the SHORT payoff) or labelled SHORT. No red-green pair, no purple, no gradients, no glow. The model ribbon is ink with a MODEL tag; errors are told apart from sample tags by a solid left rule and `role="alert"`.

### 4.2 Type

One system, SILICON's: **Geist** (text and headings, variable 100 to 900), **Geist Mono** (labels, tables, spec sheets, hashes, code), and a **dot-matrix face for figures to remember** (the index, the countdown, specimen names, section numbers, "GPU bill."). Both Geist files are self-hosted in `app/fonts` with `LICENSE-geist.txt` (OFL 1.1). The dot-matrix face is not a font: `lib/dotmatrix.ts` draws each character on the same 5 by 7 grid as a die, as one SVG path, and `components/dot-text.tsx` keeps the real text in the page for screen readers, search and copying. It needs no file, renders identically everywhere and is part of the server HTML, so it never delays the first paint. Why this system over the other boards': SWARM's Bricolage and Instrument pair is friendly but soft for tables of money; EXCHANGE's condensed display and serif belong to its black board. Geist is neutral and exact at 11 px in mono and at 96 px in a headline, and the dots tie the figures to the wafer.

**The type scale, one for the whole site (12 Nov 2026).** Eight steps, defined once in `app/globals.css` `:root` and mapped onto Tailwind's text sizes in `app/site.css`; nothing else sets a font size except the labels inside drawings, which are in the drawing's own units.

| Token | Size | Tailwind | Use |
|---|---|---|---|
| `--t12` | 12 px | `text-xs` | labels, captions, the live-read line |
| `--t14` | 14 px | `text-sm` | secondary text, tables, links in lists |
| `--t16` | 16 px | `text-base` | body |
| `--t18` | 18 px | `text-lg` | lede, card titles |
| `--t24` | 24 px | `text-2xl` | sub-heads, figures in cards |
| `--t36` | 36 px | `text-4xl` | section headings (h2), the statement |
| `--tdisplay` | clamp(40, 4.6vw, 60) px | `text-6xl` | the large live figure, page titles |
| `--thero` | clamp(44, 5.4vw, 72) px | `text-7xl` | the homepage headline |

The homepage uses all eight and no other (measured in the browser at 1440 x 900: 12, 14, 16, 18, 24, 36, 60, 72 px), weights 400 and 500, no uppercase, mono only for figures. Headline at -0.035 em; headings at -0.02 em. Section headings follow one pattern: a lead phrase in the ink colour runs into the rest of the sentence in the muted grey ("How it works. Four rules do the work a broker would."). The inner pages were moved onto the same steps by find-and-replace (15 to 16, 17 to 18/19 to 18, 21 to 24, 32 to 36, and stray pixel sizes to the nearest step); their uppercase mono labels are unchanged for now. Tabular figures everywhere. No italic.

### 4.3 Space and shape

Space 4, 8, 12, 16, 24, 32, 48, 80, 120 px. Gutter max(16 px, 4vw), content 1240 px. Radius 14 px on panels, 999 px on buttons and tags, 1 to 2 px on dies and swatches. Lines 1 px; drawings 0.6 to 1.2 px. Tap targets 44 px.

**Numbers.** A unit on every figure: "$2.31 /GPU-h", "1,344 GPU-h". Times in UTC with the zone written. Missing is "no data", never 0; a real zero amount reads "none"; a chart origin reads "0".

## 5. Site map

| Path | Purpose |
|---|---|
| `/` | First screen (headline, live index, wafer), the round as work, who is in the room, the specimen and chip cards, series and phase clock, index chart, the index and its sources, last clearing, payoff and hedge sizer, three facts, limits |
| `/auction` | The round in progress (countdown in dots), sealed book, curves as reveals land, last cleared round, recent rounds. `?series=&round=` for any past round |
| `/simulate` | Scripted agents cleared by the real engine in a Web Worker |
| `/backtest` | Hedged against unhedged cost over real H100 history, and band coverage |
| `/how` | The round as work, then five sequences (series clock, commit and reveal, clearing, settlement, funding), limits and trust |
| `/proof` | Contracts, the audit findings ("Audited"), live solvency with the burned total, bundle verifier on the selected chip's bundle, parameters, transactions |
| `/spec` | docs/SPEC.md rendered with an anchor per section (`/spec#s9`), for the audit table and the copy to link to |
| `/audit` | docs/AUDIT.md, the reviewer's own record, rendered the same way |
| `/agents` | A key that bids and cannot withdraw; commands, commit string, a minimal loop; agents on the book |

**Markets.** One market per chip and cadence: `h100-weekly` (the default), `h100-fast` (hourly demo), `h200-weekly`, `a100-80-weekly`, the ids of the agents package's `MARKETS`. The default market's pages are at the plain path (`/proof`); the others at `/m/<id>/...` (`/m/h200-weekly/proof`), each written at build. `?m=<id>` links redirect there (worker/route.ts); `?m=weekly` and `?m=fast` still mean the two H100 markets. Markets come from `deployments.json` (`{ id, label, chip, contract, usdc }`); model mode offers all four, and with nothing deployed all four show their not-deployed states.

Header (sticky, translucent cleanroom; between 961 and 1180 px the market switcher and theme button take a second row): lockup, seven links (current page marked with a small ink die), a Testnet tag, the market switcher (chip first: H100, H200, A100 80 GB; then Weekly / Hourly where the chip has two markets), the theme button; the model ribbon above it in model mode. Footer on the sheet: the full mark and the headline on an ink rule, the lockup, three link columns, a mono colophon.

## 6. Page by page

### 6.1 `/` (rebuilt 12–13 Nov 2026, landscape and motion 13 Nov)
Built in `components/front/`: a centred hero (pill, the serif headline "Next week's GPU hours, / priced today.", one sentence, two buttons) standing in a drawn landscape (section 7.7); under it the **application window**, which is the application itself: the Clearings view of section 6.2, with the same sidebar, title row, chips and grid, live from the chain, its lower edge behind the foreground dunes. Then the sources ribbon (the six public price lists, as plain names); the statement, three short paragraphs that light in turn on scroll (the backtest's measured spread, what Weir does, what it does not and the testnet line); **one market, four views**, a tablist (Auction, Index, Payoff, Proof) over the application's own views for the window's market as published (`fourViewTabs` in `components/pages/home-page.tsx`, `components/front/four-views.tsx`): the active tab's underline fills over 9 s and moves to the next tab, pausing while the pointer or focus is in the section, while the tab is hidden and always under reduced motion; arrows and a one-line caption that says when the copy was read and links to the live view; the round's countdown is replaced there by the phase's end time, so no clock runs on a copy. Then how it works as three step cards that pin under the header and slide over one another from 768 px up (`position: sticky`, no script; a plain stack on phones and under reduced motion); a bento of five objects read from the chain; the three markets; the review wall; check it yourself with the grouped questions; "Built by Qvkare"; and the closing section, text on the left and the application window on the right, standing in the dunes.

Moved off the homepage, nothing deleted: the floor, "Who is in the room" and the payoff tool to `/how`; the series clock to `/auction`; the index chart and sources to `/auction/prints`. The wafer and the specimen drawing are gone from the site (`lib/wafer.ts` and its test stay for the record).

### 6.2 The application: `/auction`, `/agents`, `/proof` (13 Nov 2026)
One frame for every market page (`components/front/app/parts.tsx`): a sidebar with the four markets and their last print (switching keeps the view), the views, the Proof group and the network; a title row with the market, series, phase and countdown; a chip row; a main area that scrolls inside a frame as tall as the screen allows. Below 768 px the sidebar becomes two selectors, Market and View. Nine views, each a page (`lib/app-views.ts`): Round in progress, Sealed book, Clearings, Index prints, Agents, and Proof's Contracts, Solvency, Review and Record. Each shows the figures as published, labelled, then reads the chain in the browser. Old anchors (`/proof#audited`, `/auction#book-h`, …) and `/auction?series=&round=` are forwarded to their view. The verifier's three states: matched, did not match (red, the only red), not published (grey: the host has no file; not a failed check).

`/simulate` uses the same parts: one toolbar (Play in the primary style, the others secondary, speed as a segmented control, a compact seed field, a quiet Reset, the void option as a labelled switch with a one-line hint), a status line, and four panels of fixed height that scroll inside (agents with a short line each and the full rule on "More", the sealed book, the last clearing, the event log). The page opens on the state after setup, computed at build by the same engine and seed as the worker.

### 6.3 `/how`, `/backtest`, `/spec`, `/audit` (the reading pages)
On the homepage's system through `<main class="doc">` (`app/site.css`): the serif for h1 and h2, the type scale, sentence-case labels in Geist instead of uppercase mono, the same column, cards and buttons. `/backtest` opens on its three figures and the chart; the rule and the tables follow. `/spec` and `/audit` are a document column with a table of contents at the side on desktop.

### 6.3b `/how`
Opens with the round as work (the same floor as the home page), then the five sequences as before (their clearing chart now dashes and hatches supply), then limits and trust.

### 6.3a The rules of specifications 0.4 to 0.6, in the site's words
- **Burned dollars.** Forfeits and the per-commit fee are burned when a round clears and belong to nobody: the solvency check lists `burned` as its fifth term, a cleared round shows what it burned, the open round shows the fees it holds.
- **Prints.** A bucket is decided when every reporter has reported or its window closes; the print is the median; with an even number deciding, the two middle reports must agree within `max_spread_bps`. A bucket can end with no print: the index chart marks it with a `--flag` cross on the axis and the prints table lists it as "no print" (the model reads every gap; on chain the newest 48).
- **Guard and round lock.** The guard and its reference are fixed at commit (/how); the round lock limit `max_round_lock` is the second thing that bounds an agent (/agents, with the `set_guard` command).
- **Results** keep only filled orders, so a past round's step chart and fills table show what traded.
- **Void series (0.6).** A void series is cancelled at the centre of its band: every LONG and every SHORT is paid half the band. Wherever one is shown or explained it reads "void: cancelled at the centre of the band, $… to each side", never as a fixing (`settlementLine` in `lib/views.ts`). A series' average traded price may be shown, labelled "information only". The quorum must be a majority; the presets' commit fee is ten cents.
- **Reporters' power** (SPEC 15) is said on /how and in the limits: a majority sets the fixing; with one absent either of the others can drop buckets or make a series void, which a reporter who also trades can profit from.
- **Audited** on /proof (`lib/audit.ts`, item for item from the final `docs/AUDIT.md`, four passes against 0.3 to 0.6): the record's verdict; open findings first, then those the specification states as limits, each with its `limit_` test and the record's number, and the blocking cost recomputed from the market's `get_params`; findings closed by a rule, with the test that asserts each; the history pass by pass, including the 0.5 void rule the third pass found faulty; who did the review and what it was not. `lib/audit.test.ts` fails if a numbered finding of the record's final table, or a `limit_` or `audit` test in the contract's tests, is missing from the page. The full record is at /audit. No badge, no "secure".
- **Simulation:** a "Silent reporters (void series)" control runs the agents' void scenario (`silentSeries: 0`), and settled series are listed with `settlementLine`.

### 6.4 States
Loading: sheen bars, never `$0.00`. Error: a 3 px `--flag` rule on a flag tint, "The NEAR RPC did not answer", the last good read time, "Read again". Stale: `--flag` rule. **Empty and not deployed**: a dashed outline and a small wafer with no dies lit (its edge dashed too when not deployed), the sentence, and for "not deployed" a line pointing to the simulation and the backtest.

### 6.5 404 and error
404: "No page at this address", a wafer where the only dies that pass spell 404, lighting one by one, the heatsink rising behind it, and every page as large links. Error: the page head, "This page could not be drawn", Read again.

### 6.6 Hardware facts and their sources
The three chip cards print the facts below, one market per chip; the specimen stays H100. Printed: H100 SXM 80 GB HBM3, 3.35 TB/s, up to 700 W (nvidia.com H100 page); GH100 814 mm², 80 billion transistors, five HBM3 stacks (NVIDIA Hopper in-depth blog); H200 SXM 141 GB HBM3e, 4.8 TB/s, up to 700 W (nvidia.com H200 page); A100 80GB SXM 80 GB HBM2e, 2,039 GB/s, 400 W (nvidia.com A100 page), die 826 mm² (Hopper blog, table 3). Removed for want of a checked source: the H200's die area, stack counts for H200 and A100 (their cards draw memory as two blocks, not a count), the board's "nickel lid", "aluminium fin stack" and "silicon interposer" wording, and AMD parts. No logos or trade dress; drawings say "Illustration · not to scale".

## 7. Motion

### 7.1 Principle
Motion explains, confirms or gives the brand its pulse; it never decorates a number. Things with weight move with anticipation, travel and overshoot; interface feedback is quick and plain. Every generative or looping piece pauses off screen and in a hidden tab, caps its work per frame and never blocks input. Under `prefers-reduced-motion: reduce` every CSS animation and transition is off, and each animated piece shows a composed still frame with a caption.

### 7.1a Time, pauses and the test override
Every scripted piece runs on `Clock` (`lib/clock.ts`): its position is wall time since start, less time paused, so a slow or throttled frame rate changes smoothness, never duration or end state, and a piece that leaves the screen or a hidden tab stops and resumes from the same moment. Tests feed each timeline uneven frame times (4 ms to 700 ms) and a pause, and assert it ends on its final state at the stated time (`lib/wafer.test.ts`, `lib/floor.test.ts`, the specimen's `specimenStep` in `lib/motion.ts`). `?motion=reduce` (testing only) sets `<html data-motion="reduce">` before paint; `motionQuery()` in `lib/reduced-motion.ts` treats it exactly like the reader's setting, and CSS turns every animation and transition off; the smoke test checks the override script on every page.

### 7.2 Tokens: one easing, one set of durations (`app/site.css`, 13 Nov 2026)

Every transition and entrance on the site uses one curve, `--ease-settle`, cubic-bezier(0.16, 1, 0.3, 1): quick to start, long to settle, no overshoot. The older names in `app/globals.css` (`--ease-out`, `--ease-in-out`, `--ease-overshoot`) are pointed at it in `app/site.css`, and Tailwind's default transition takes it too (`--default-transition-timing-function`, 200 ms), so a hover written without a duration moves the same way.

| Token | Value | For |
|---|---|---|
| `--dur-micro` | 120 ms | Press and focus |
| `--dur-quick` | 200 ms | Hovers, tabs, the FAQ's plus sign (Tailwind's default) |
| `--dur-base` | 320 ms | Colour and state changes; the statement's paragraphs lighting |
| `--dur-settle` | 560 ms | The header's change to a pill; an app view's cross-fade |
| `--dur-enter` | 700 ms | Entrances: the hero's text and window; sections, a short fade with a 14 px rise, driven by the scroll where the browser supports `animation-timeline: view()` and simply shown elsewhere |
| `--dur-draw` | 900 ms | A chart's line drawing itself (legacy charts) |

`EASE_FN` in `lib/motion.ts` keeps its own curves for the scripted drawings on `/how` (the floor, the sequences), which are posed frame by frame; they are not transitions.

### 7.2a The landscape (`components/front/scene.tsx`, 13 Nov 2026)
Ours, drawn by hand on a 1600 x 900 canvas as inline SVG: a sky gradient, hills at three depths with haze between them, and two soft dunes in front. No strokes, no glow, low saturation; colours are variables in `app/site.css` (dark: slate to mauve at dusk, dark olive hills, dusty-rose dunes; light: a pale morning). It is not data and says nothing; the earlier backdrop drawn from the backtest's weekly series, and its caption, are gone. No image files: the five shapes are 750 bytes of path data and the grain is a small inline SVG filter. On scroll (the hero's progress, `--hp`, 0 to 1, set from one passive scroll listener per frame) the sky moves 220 px, the far hills 190 px, the middle 130 px, the near 70 px, the text rises 80 px and fades, the window sinks 150 px behind the dunes, and the scene fades into the page; transforms and opacity only, so no layout shifts. Fail open: without script, animation frames, under reduced motion or `?motion=reduce`, the scene stands still at its first frame. The closing section reuses the sky, the far hills and the dunes, still.

### 7.3 The wafer (`lib/wafer.ts`, `components/wafer.tsx`)
One canvas. Dies are laid on the wafer's grid inside the edge exclusion (about 1,000 to 1,400 at desktop, capped at 1,400). Each round a seeded generator draws one order per die around the live index (or an example price when none, said in the caption), `clearRound` clears it, and the keenest orders of each side are placed nearest the centre. The resting state is the sealed wafer, every die present and grey: a CSS wafer sits under the canvas before any script runs, the first canvas frame is drawn in a layout effect before the browser paints and before any animation frame is requested, and every round both begins and ends sealed, so the hand-over between books never shows an empty area. A 12 s round: every die sealed; a probe line sweeps down, revealing each die faintly in its side's colour (3.4 s, in-out); the clearing ring grows from the centre and the filled dies light at full colour, sellers hatched, part fills cut, the rest grey (1.4 s, ease-out); hold; the dies seal again from the edge in (1.2 s); a new book. Frames in the hold are skipped; dies are drawn in one fill per colour; the pixel ratio is capped at 2. Pauses off screen, in a hidden tab and on its pause button. Reduced motion: one cleared frame, caption "still frame, motion reduced". Tests: `lib/wafer.test.ts`.

### 7.4 The floor (`lib/floor.ts`, `components/floor-scene.tsx`)
An elevation in fine lines: the bench, the rack, ten tickets, two gates and the house heatsink on the rack. The plan is built on the server from an example book cleared by the engine: the rack's rows are the book's prices, the scanner's readings are the engine's `curves`, the row it settles on and every fill are `clearRound`'s. Beats (about 13 s): sealed tickets slide in with weight (anticipate, travel, overshoot, a small lean) while the heatsink watches; the gates drop and every cover lifts at once, a late ticket bumps the gate and is turned away; tickets hop into price order; each is tossed into its row; the scanner swings and settles (damped) on the clearing row, counting GPU-hours bid and offered; the row lights, filled tickets outline and show their fill bar, unfilled ones drop back to the bench and dim; a price pill and an ink CLEARED stamp land with overshoot; the heatsink hops and blinks. Play / Pause and Replay (44 px), a progress line and a caption per beat. Autoplays once when 40% in view; pauses off screen and in a hidden tab. Server HTML and reduced motion show the final frame with the full summary as the caption. Tests: `lib/floor.test.ts`.

### 7.5 The specimen (`components/specimen.tsx`)
Five steps, each a 1 s in-out tween of the explode amounts; leader labels fade in on their step. Plays once through when half in view, then stops; Back, Next, step buttons and arrow keys. Reduced motion: step 4 (the die and its memory) as the still, steps change instantly.

### 7.6 Everywhere else

| Motion | Where |
|---|---|
| Lines draw in once when a chart first enters view; clearing lines fade in after; supply's filled steps fade in (they are dashed) | Every `ChartFrame` chart |
| /how sequences (Web Animations scores, `lib/how-scores.ts`) | /how |
| A revealed row lands: a blue tint and an ink edge fade | Sealed book on /auction and /simulate |
| The clock beats: an ink die shrinks and fades once a second | Every phase countdown |
| Checks resolve one after another with overshoot | Bundle verifier |
| A live figure settles when its value changes after a refresh | Hero index, last clearing, auction figures |
| Buttons press to 96% and spring back; arrows nudge; the header mark lifts | Everywhere |
| Theme: one 320 ms cross-fade (View Transitions), every transition off during the swap | Theme button |
| 404 dies light in sequence; the heatsink rises | 404 |

## 8. Charts
Cleanroom: hairline grid in `--rule-2`, mono 11 px labels, ink axis. **Auction step chart:** demand a falling staircase in blue, supply a rising one in gold, dashed where filled; the clearing an ink line with "Clears at $0.62 · forward $2.31"; the paid areas tinted blue and hatched gold. **Index chart:** reporters as thin lines, the index an ink step line. **Payoff:** LONG solid blue, SHORT dashed gold. **Backtest:** band per week, unhedged dots, hedged ticks, `--flag` marks outside the band.

## 9. Copy rules
A clerk reading the results: the figure, then its source. Headings are names without a full stop (the three brand lines are sentences and keep theirs). No "X, not Y" turns, em dashes or emoji. Banned: revolutionary, seamless, unlock, empower, trustless, guaranteed, risk-free, insurance, yield, bet, AI-powered, next-gen. Sample, simulated and example figures say so where they appear (Simulated tag on the wafer, "Example orders" on the floor, "Illustration · not to scale" on the specimen, "(model)" after model figures, the ribbon in model mode).

## 10. Build notes
Next.js App Router, React, TypeScript. The homepage, the header and the footer are built on Tailwind v4 utilities (theme and utilities only, no preflight; `app/site.css` puts the old CSS in a `legacy` layer under the utilities and generates utilities only from `components/front` and `components/ui`) and five components adapted from Ruixen UI's MIT registry (`THIRD_PARTY_NOTICES.md`), with `motion` for the scroll-linked statement. Every other page is still hand-written CSS: Canvas, SVG, CSS and the Web Animations API. Charts are hand-written SVG. Shared SVG patterns (`hatch-short`, `hatch-short-soft`, `hatch-sealed`, `dots`) are defined once in `app/layout.tsx`. The floor plan and the /how scores are built at build time and passed as data. Every page is a static file (`output: "export"`); pages with chain data carry the figures the build read, labelled with the build time, and the browser reads them again from the RPC endpoints (`components/live.tsx`). No external requests beyond the RPC endpoints and the bundle host. The Worker is 22.63 KiB, 8.23 KiB gzipped (`wrangler deploy --dry-run`, 12 Nov 2026); it serves /api and the `?m=` redirects only.

## 11. Still in force from v1 and v2
No order form and no wallet; two markets (Weekly / Fast, `?m=fast`); the series strip; reporter lines on the index chart; no refund column; "none" for exact zeros; the phone fills table; the recorded bundle in the verifier when no host is set; model mode with its ribbon.
