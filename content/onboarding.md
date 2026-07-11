# Loomfall — Onboarding Script: The First Ten Minutes

The world speaking, gently, to a newly Waking Thread. Each section below is one game event. The quoted block is the **exact on-screen text**; the italic line beneath it (where present) is a **control hint** shown in smaller type under the main line. Every section ends with a one-line `[builder note]` on when and how to fire it.

**Global builder conventions**

- Display as a soft parchment toast, lower-center, ~6 seconds (control-hint lines persist until the action is performed). One toast on screen at a time; queue the rest in order.
- Every event fires **once per save** unless its builder note says otherwise.
- `[MOVE]`, `[BREAK]`, `[PLACE]`, `[INVENTORY]`, `[INTERACT]`, `[EAT]` are keybind tokens — substitute the player's current bindings at render time.
- Where a section names a canon trigger (`first_block_broken`, `craft_item:handloom`, etc.), wire the toast to the same trigger as the matching achievement in `achievements.json`, and show the toast **after** the achievement banner clears.
- Never harden the tone. The world is not a drill sergeant. It is an old cloth, talking in its sleep, and it is fond of you.

---

## on_world_start

> You were woven into this field like any other thread. This morning, you came loose.
> Open your eyes, Mender. The ground is cloth. The sky is thread. None of it is finished.

[builder note]: Fires once on first spawn in a new world; fade in from a white thread-blur, hold the text ~5s before the HUD appears.

---

## on_first_move

> Good. The legs still answer.
> You are the one thing in all the weave that chooses its own direction. Start by choosing one.

*Use [MOVE] to walk. Hold nothing. Carry nothing, yet.*

[builder note]: Fires on first movement input; if the player stands idle 10s after on_world_start, show only the control-hint line early.

---

## on_first_block_broken

> The warpsod gives like cloth, because it is cloth. A block is only a knot — a thread that agreed, for a while, to hold.
> You have just changed its mind.

*Hold [BREAK] to pick a block loose. What comes free is yours to keep.*

[builder note]: Fires on canon trigger `first_block_broken`, alongside achievement `a_thread_comes_loose`; queue this toast after the achievement banner.

---

## on_first_wood_collected

> Thrumwood, cut from a braided trunk. Feel it hum, faint, in your hands? Everything here is still strung to the Loom.
> Wood becomes plank, plank becomes handloom, and a handloom puts a Mender's work in your hands.

[builder note]: Fires on first pickup of `thrumwood_bole` (collect_count:thrumwood_bole:1); suppress if the crafting toast is already queued.

---

## on_first_block_placed

> And there — set down again, but where *you* chose.
> Breaking is picking loose. Building is stitching. The Loom does the first without thinking. Only you do the second on purpose.

*Use [PLACE] to stitch a block back into the world.*

[builder note]: Fires on the client-side "first block placed" UI event — this is NOT a canon trigger (the canonical `place_block:<block_id>` form requires a concrete block id); handle it the same way as on_first_move / on_first_shelter. Skip the control-hint line if the block is already placed.

---

## on_open_inventory

> Everything you gather is thread of one kind or another. This is your skein — what you carry, and what you can be made to lose.
> Carry less than you would grieve to leave behind.

*Press [INVENTORY] to open your skein.*

[builder note]: Fires on first inventory open; if the player hasn't opened it within 60s of their first pickup, show the control-hint line alone as a nudge.

---

## on_first_skein_sheared

> The skeinling trusted you the whole while, and the wool will grow back. Raw Skein spins to thread, thread to cloth, cloth to warmth.
> Shear, do not slaughter. A patient Mender eats many nights from a flock kept whole.

[builder note]: Fires on canon trigger `collect_count:raw_skein:1`, alongside achievement `something_to_spin`; only in the first ten minutes if a skeinling is nearby — do not force-spawn one.

---

## on_craft_handloom

> A handloom of your own. The great Loom weaves without wanting; this small one weaves whatever you ask of it.
> That is the whole difference between them, and it is everything.

[builder note]: Fires on canon trigger `craft_item:handloom`, alongside achievement `the_first_stitch`; if the player holds 4+ `knotwood_plank` for 90s without crafting, pre-show a recipe hint in the crafting UI.

---

## on_craft_first_tool

> Threadstone and old cord, pressed hard into a pick. Rough work — but enough to open the ground and ask it what it hides.
> Stone first. Iron, dawn, and Everthread will each come in their season.

[builder note]: Fires on canon trigger `craft_item:threadstone_pickaxe`, alongside achievement `threadbare_tools`; gate the "what it hides" line into the same toast, not a second one.

---

## on_first_ore_mined

> There — a cold grey seam pressed hard into the cloth. Needle-Iron, named for the needles the woven folk once mended themselves with, back when they knew they could tear.
> The deeper cloth hides harder thread yet. Cut stairs as you go; a straight drop through cloth opens under your own weight. Nothing beneath you catches gently.

[builder note]: Fires on the first ore-type block broken (expected: `needle_iron`, per canon Warpwold's surface ores are Needle-Iron and Dawnthread); wire alongside `collect_count:needle_iron:1` (achievement `the_cold_workhorse`) when that is the first ore met. Emberskein flavor moved to on_enter_cinderloom_first_ore below — do not mention emberskein here.

---

## on_enter_cinderloom_first_ore

> There — a seam that kept its own fire. Emberskein burns as its own fuel; feed it to a furnace and the flame owes you nothing more.
> Carry it carefully. It does not wait to be asked.

[builder note]: Fires OUTSIDE the first ten minutes — on first mining of `emberskein_ore` after `enter_dimension:cinderloom`; pairs with the `smelt_with:emberskein_ore` achievement (`it_burns_its_own_fuel`) — no second toast needed at the smelt itself.

---

## on_first_knotlight_placed

> One warmth the Loom lets you keep. Where the glow ends, the dark begins to move — so ring your camp before the light goes.
> Leave no dark corner standing open. A dark corner is a door.

[builder note]: Fires on canon trigger `place_block:knotlight`, alongside achievement `one_warmth_kept`; if dusk is under 2 minutes away and no knotlight has been crafted, surface its recipe hint instead.

---

## on_set_anchor

> This flame is now your knot — your own thread tied fast to one place in all the weave. If the dark takes you, you wake here.
> Set a new knot often, and never far from the work you mean to come back to.

*Press [INTERACT] on a placed knotlight to knot your thread to it.*

[builder note]: Fires on canon trigger `set_anchor`, alongside achievement `a_knot_of_your_own`; if a knotlight has been placed but not knotted within 60s, pulse the interact prompt on it.

---

## on_first_night_warning

> The dreamdye is draining from the sky. Night is when the crooked-woven unbend and go walking.
> Walls, a roof, a ring of light — have them before the last color goes. This dusk is beautiful. It is not on your side.

[builder note]: Fires once, ~2 minutes before first sundown; suppress entirely if the player is already inside a lit, enclosed shelter.

---

## on_first_mob_encounter

> Hold. That needle-limbed thing was woven wrong, and then it was left that way. It will stitch whatever it kills into the tangle of itself.
> Pity it if you must — from behind a wall, or from behind a raised tool. It cannot be talked down.

[builder note]: Fires the first time a needlejack comes within ~16 blocks with line of sight to the player; do not pause gameplay — keep the toast brief and non-blocking.

---

## on_first_shelter

> Walls of your own raising. A roof. A light. A knot. Small, and honest, and yours.
> There is no Mender walking who did not begin their nights under Knotwood. The Loom did not make this room. You did. Keep hold of what that feels like.

[builder note]: Fires the first time the player stands 10s inside an enclosed, roofed, player-built space at light level above the hostile-spawn threshold during night.

---

## on_hunger_low

> You are wearing thin — not wounded, only worn. A thread spends itself in the walking and the working.
> Eat, or your own cloth begins to fray from want alone. The hedgerows are generous. The meadow is kind. It will not always be.

*Select food and hold [EAT].*

[builder note]: Fires the first time the hunger meter drops below ~40%; repeat once (shortened to the control hint) with a long cooldown if it falls below 20% uneaten.

---

## on_first_death

> Be still. You are not ended — only unpicked, pulled loose from the pattern for a moment.
> A weaving with its ending still unstitched cannot yet be allowed to stop. Neither, yet, can you.

[builder note]: Fires on canon trigger `player_unpicked`, alongside achievement `re_stitched`; render on the death screen itself, above the respawn button, and relabel that button **"Re-knot"**.

---

## on_respawn

> Re-stitched, at your last knot. A little of your gathered thread was lost in the tearing — it usually is.
> What you dropped lies where you fell, fraying slowly. Go back for it, or let it go. Both are allowed.

[builder note]: Fires once, on the first respawn after `player_unpicked`; if the player never set an anchor, append "You had tied no knot. The world chose one for you. Choose your own, next time."

---

## on_survive_first_night

> Dawn, bleeding back through the cloth. You outlasted the long first dark, and you are still knotted.
> Every morning here is the same quiet miracle: the world, unfinished, deciding to go on. So do you.

[builder note]: Fires on canon trigger `survive_first_night`, alongside achievement `the_long_first_dark`, at first sunrise; delay until the player is out of combat.

---

## on_hear_thrum

> That low hum in your teeth, before it ever reaches your ears — that is the Thrum. The great Loom, still turning, and no hand on the shuttle.
> Nobody is weaving. The weaving goes on. Sit with that as long as you can bear to. Then get up, Mender. There is work.

[builder note]: Fires on canon trigger `hear_thrum` (first time the ambient Thrum plays at full strength, e.g. near Thrumwood or thin weave); duck music under the Thrum audio while the toast shows.

---

## minute_10_wrapup

> Ten minutes loose, and already you can walk, pick free, stitch back, make light, tie a knot, eat, and last a night. That is a Mender's whole alphabet. Everything after is only longer words.
>
> As for the rest — why the maker left with the ends untied; what old world ghosts up through the thin ground of the Understitch Downs; why the land at the Unfinished Hem simply stops, mid-stitch; and what waits, patient as a needle, past the last edge of everything — the world will not tell you.
>
> It will let you find out.
>
> Go carefully. Mend what you can. Bind what you love.
> Nothing here is finished. That is not a flaw. That is the invitation.

[builder note]: Fires at 10 minutes of play, or after both `survive_first_night` and on_first_shelter, whichever comes later; present as a full-screen vellum "journal" page (not a toast) that also unlocks the Tips codex, dismissed with any key.
