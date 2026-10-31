# How the clouds got good

The hero's clouds are a few thousand flat sprites ("puffs") drawn in one instanced batch. There is no raymarching
and no volume texture. This is how they went from popcorn to cumulus in one long evening of feedback rounds,
and what each step taught us.

![The beach view at the first rework, and now](../public/images/lab/clouds/hero-before.webp)
![The beach view now](../public/images/lab/clouds/hero-after.webp)

## 1. Make a benchmark

Tuning clouds inside the hero was slow and subjective: they sit behind a rocket, in moving shots, at one sun
angle. So we built [`/lab/clouds/`](https://chernetsov.github.io/77-to-starbase/lab/clouds/). It renders single
cumulus with the hero's own code on a clear sky, with the seed, size, sun and camera height in the URL. A small
script snapped four seeds and set them beside a golden-hour cumulus photo (kept locally; it isn't ours to
publish). Every change after this was judged on that sheet, about twenty rounds in all.

The benchmark paid off at once. An earlier fix flattened each puff's shading to hide the paper look; it only
worked because the hero's sun sits behind the camera. With a side sun in the lab, the clouds went dark.

![Round 0: a clump of popcorn](../public/images/lab/clouds/step1.webp)

## 2. Build it like a real cumulus

A cumulus has a structure, so the generator (`addCumulus` in `scenery.ts`) follows it:

- a wide, flat, darker base sheet that reaches out past everything above it, all clouds sharing one base
  altitude (`CUMULUS_BASE` = 800 m), so they line up in rows toward the horizon;
- two to four towers of different heights over a low shoulder;
- big lobes filling the towers, and on the lobes' upper, outer skin, smaller lobes, and sometimes smaller again:
  the cauliflower;
- a few tiny cloudlets and thin wisps near the base: thermals that didn't make it.

![Round 4: flat base, separate towers](../public/images/lab/clouds/step2.webp)
![Round 8: one mass, but lit flat](../public/images/lab/clouds/step3.webp)

## 3. Light it like a volume

Flat lighting was the root of the "papery" look. The light model now borrows from film and game cloud rendering:

- **Shadow through the cloud.** Each pixel is dimmed by how much cloud lies between it and the sun (Beer's law).
  That depth comes from two places: a chord through the cloud's bounding ellipsoid, and a per-puff value baked
  when the cloud is built, by summing the chords of the sun ray through every other puff (Harris & Lastra,
  *Real-Time Cloud Rendering*, 2001).
- **Light bouncing inside.** Four octaves of multiple scattering, each weaker, less absorbed and less directional
  than the last (Wrenninge et al., *Oz: The Great and Volumetric*, 2013). Shadows glow instead of going grey.
- **Direction of scattering.** A two-lobe Henyey–Greenstein phase: forward for silver linings, a little
  backward because the hero sun is behind the camera. Without the backward lobe the hero clouds went stormy.
- **Powder.** Slightly darker skin on the sun side (Schneider & Vos, *The Real-Time Volumetric Cloudscapes of
  Horizon Zero Dawn*, 2015).
- **Sky above, ground below.** Blue fill on the tops, warm bounce on the undersides, both dimmer toward the base.
- **Film roll-off.** Highlights ease into cream instead of clipping greenish.

![Round 12: the grain halved](../public/images/lab/clouds/step4.webp)
![Round 15: the new light model and the cauliflower](../public/images/lab/clouds/step5.webp)

## 4. Smooth the inside, keep the edges

Next came "too many sharp knots, especially inside; borders are fine." Every puff showed its own outline and its
own little shading. That's right on the silhouette, wrong in the middle. Two steps fixed it.

First, in the shader: each puff works out how far inside its cloud's outline it sits as seen from the camera
(0 at the outline, 1 in the middle). Inner puffs get softer edges, lose their surface bumps, and take their
shading from the whole cloud's rounded shape instead of their own lump.

Then, a post-process (`CloudBlur` in `cloudblur.ts`). The clouds render to their own target, a nine-tap Gaussian
blurs it at half resolution, and the composite uses the blurred colour only where both the blurred and sharp
images are fully opaque. The outline, where the cloud fades into sky, stays sharp. In the hero the clouds draw in
their own pass between the sky and everything else, so the rocket always draws in front of them. The radius is
`cloudBlur.radius = 10` px in `scene.ts`; the lab takes `?blur=<px>` (and `?blur=0`). Phones skip it.

![Round 18: inner puffs softened in the shader](../public/images/lab/clouds/step6.webp)
![Round 21: the interior blur](../public/images/lab/clouds/step7.webp)

## 5. No holes

The last request was the holes: gaps between random lobes where the sky showed through the body. A regular
grid of buried fill puffs now follows each cloud's tower profile underneath the lobes, at two heights per column.
None of the twelve seeds checked afterwards has a hole.

![Round 22: filled, smooth, one body](../public/images/lab/clouds/step8.webp)

## 6. The whole sky

With single clouds right, the layout of the sky mattered more. Three fixes:

- **The beach view is composed by hand.** The clouds in it sit at chosen bearings and distances, bigger ones
  off to the sides. No random cloud may stand in a cone around the ship and tower, so the stack is framed by
  open sky.
- **The horizon fills in like a real one.** A cloud field has about the same number of clouds per square
  kilometre everywhere, so the number in each distance ring grows with distance. Seen from the beach, they crowd
  into a hazy band at the horizon. The 200 far clouds (out to 90 km) are now spread that way. The Earth's
  curvature lowers the farthest ones onto the horizon, by about 600 m at 90 km. A cloud that far is a few pixels
  wide, so it gets a cheap build of about 50 puffs.
- **Clouds turn their long side to the beach.** The generator lines a cloud's towers up along one side, as real
  fair-weather cumulus are a little longer than deep. The beach first saw them end-on, tall and narrow. Each
  cloud now gets a yaw facing the beach, with some jitter, so the view sees them wider than tall. The lab's
  Turn slider rotates cloud and sun together to see any side, and Play weather runs the time-lapse's growth and
  decay.

![The same cloud end-on, as the beach first saw it, and from its long side](../public/images/lab/clouds/turn.webp)

## 7. A body inside

Even with the core grid, the middle of a cloud could look hollow: smaller puffs at the front, sky-blue haze
between them. Each cloud now has a body of five big puffs along its long axis: three low, two higher between
them. Each is sized to fit inside the cloud's depth and the tower height above it
(`min(top × 1.3, depth × 1.9, width × 0.44)`), so it never pokes out of the outline, from any side.

![Without and with the body](../public/images/lab/clouds/body.webp)

## 8. An hour of weather

The ship comes back about 65 minutes after launch, and the hero fast-forwards through that gap. Real clouds
change a lot in an hour, so ours do too (`pushEvolved` and `setWeather` in `scenery.ts`):

- **Drift.** A 5 m/s onshore breeze from the south-southeast (`WIND_SPEED`) carries them about 19 km.
  Nearby clouds wrap round along the wind, fading out at one end and back in at the other, so new ones keep
  arriving off the Gulf. Far clouds just move, scaled to their drawn distance.
- **Life.** Each cloud grows or decays over a 30–70 minute cycle. Its towers rise and sink more than it
  widens, and a dying cloud thins out.
- **Churn.** Each billow swells and settles over 5–13 minutes.
- **Hold still otherwise.** At zero weather the sky is exactly as built, so the composed beach view is
  untouched before launch.

The fast-forward used to be 4.5 seconds, too quick to see any of this. It now eases up to a few hundred
times real speed and back down over 10 seconds, after the camera has come to rest on the pad and held a beat.
The lab's Play weather button runs the same model.

![One hour of weather in the lab: start, +20, +40 and +60 minutes](../public/images/lab/clouds/weather.webp)

## 9. Trails at speed

The vapor trails reuse the cloud sprites, and the cloud lessons carried over:

- **Space by distance, closer than you think.** A puff's visible core is only about half its sprite, so puffs
  need to be no more than about 0.12 of their size apart to merge into a line. A trail dropped at a fixed rate,
  or per metre of climb, strings out into beads once the vehicle is doing hundreds of metres a second.
- **Give every puff its own age.** The returning ship's trail is laid during the fast-forward, many seconds
  at once, already aged and drifted. When a whole batch shared one age, the drift jumped at each batch and the
  trail turned into beads again.
- **One source end to end.** Where the faint trail handed over to the ship's denser tank venting there was a
  hard seam. Now the trail runs live behind the ship to the flip, and venting starts after it.
- **Dissolve with age.** Trails thin over their whole life (`pow(1 − age / life, 1.6)`), so the oldest end
  fades to nothing instead of cutting off. Trails and landing smoke use the softer cloud sprites.

## 10. Warm light in the hero

On the beach the clouds looked paler than the golden scene around them. The hero now sets its own cloud light:
an oranger sun, warmer ground bounce and haze (`scene.ts`). The lab keeps its clear-sky light for comparing
with the reference photo.

## Working notes

- The snap tool renders in the hero's low-power mode below 700 px of viewport height (fewer clouds, no blur,
  wider trail spacing). Judge the hero at 1512×860.
- Its console capture stops once the page is ready, and `--eval` doesn't see module state. For live values, put
  a temporary on-screen overlay in the page and read it off the screenshot.
- Changing the generator shifts the random sequence, so every seed changes shape. Judge a change on several
  seeds and both yaws, not one before-and-after pair.

## What didn't work

- **Smooth, round puff shapes.** They read as cotton balls. Detail inside the outline is what makes cauliflower.
- **Strong self-shadowing on its own.** Every puff deep in the cloud became a dark ball with a hard edge.
- **Flattened per-puff shading.** It hid the paper look under one sun angle and broke under every other.
- **Very transparent inner puffs.** The blue sky showed through as a pale fog patch near the tops.
- **A short, sharp time-lapse.** At 4.5 seconds nobody could see the clouds change; slower easing matters more
  than the model.

## Ideas not tried yet

- Merging the puffs into one surface before lighting it, as in screen-space fluid rendering (van der Laan et al.,
  *Screen Space Fluid Rendering with Curvature Flow*, 2009): splat depth and thickness, blur, light once.
- Warmer mid-tones in the lab too; the photo's lit faces are still more orange than ours.
- The launch steam on the cloud light model and interior blur (it has to sort against the rocket and tower).
- Letting the rocket pass behind the clouds near the ascent path (needs depth in the cloud pass).
