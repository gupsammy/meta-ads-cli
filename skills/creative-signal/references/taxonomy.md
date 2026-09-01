# Attribute Taxonomy (v1)

Every attribute `correlate.py` can test, its producer, and how to read it. Anything not on this page is not an attribute. Values are cached per `asset_hash` in `creative_tags` — a creative is tagged once, ever.

Two producers write into one flat `attributes` dict per ad. Missing values mean "absent" (the ad does not enter that test), never zero.

## Gemini tags — `scripts/tag_gemini.py`

Model `gemini-3.1-flash-lite`, temperature 0, whole native video (audio + frames). Enums are fixed in code; the model cannot add values.

| attribute | values | tested as | reads on |
|---|---|---|---|
| `format_style` | `ugc` `studio` `motion` `static` | each value vs rest | production style |
| `subject` | `person` `product` `person_and_product` `text_graphic` `other` | each value vs rest | what fills the frame most of the time |
| `first3s_content` | `face` `product` `text` `scene` `logo` `other` | each value vs rest | the opening frame — **hook** attribute |
| `cta_style` | `none` `spoken` `on_screen` `both` | each value vs rest | how the CTA is delivered |
| `sound_mode` | `voice_only` `music_only` `voice_and_music` `ambient_or_sfx` `none` | each value vs rest | gate `tempo_bpm` on music being present |
| `emotion` | `excitement` `humor` `calm` `urgency` `aspiration` `trust` `neutral` | each value vs rest | the single dominant register |
| `faces_present` | bool | `true` vs rest (tested once) | any face anywhere |
| `branding_first3s` | bool | `true` vs rest (tested once) | logo/brand name in the first 3 s — **hook** attribute |

Verbatim text fields — stored, **never tested**, quoted in the brief:

| field | content |
|---|---|
| `hook_text` | exact opening words (spoken or on-screen) in the first ~3 s; `null` if none |
| `cta_text` | exact CTA words; `null` if none |
| `transcript` | every spoken word in order; on-screen text if no speech; `null` if neither |

Failure states: `tag_failed: true` in the cache means the model returned malformed output twice — the ad has no Gemini attributes until `tag_gemini.py --retry-failed`. API/quota errors write nothing (the ad stays untagged for the next run).

## Deterministic features — `scripts/deterministic.py`

**Core lane** (ffmpeg/ffprobe + stdlib; always runs). Numeric attributes are tested by median split (`key>=<median>` vs rest).

| feature | type | meaning | reads on |
|---|---|---|---|
| `duration_s` | float | video length | length |
| `aspect_ratio` | `9:16` `4:5` `1:1` `16:9` `other` | nearest standard ratio (±6%) | placement fit |
| `has_audio` | bool | audio stream present | `false` ⇒ every audio feature is absent |
| `cut_count` | int | shot changes (`scene > 0.4`) | editing density — **hold** attribute |
| `time_to_first_cut` | float s | first shot change; `null` if none | opening pacing — **hook** attribute |
| `avg_shot_len` | float s | `duration_s / (cut_count + 1)` | pacing — **hold** attribute |
| `loudness_lufs` | float | EBU R128 integrated loudness | mix level; more negative = quieter |
| `silence_ratio` | 0–1 | share of runtime under −35 dBFS for ≥ 0.5 s | dead air |

Not tested (structural, excluded in code): `width`, `height`, `aspect_value`, `cut_times`, `deterministic_version`, `audio_analysis`.

**Advanced lane** (`scripts/audio_lane.py`, librosa; optional). Present only when `audio_analysis: "advanced"` in the cached envelope; otherwise every field is `null` and the ad is absent from these tests.

| feature | meaning | reads on |
|---|---|---|
| `tempo_bpm` | beat tempo | only meaningful with `sound_mode` ∈ {`music_only`, `voice_and_music`} |
| `beat_count` `onset_count` `onset_rate` | rhythmic density | energy of the track |
| `energy_first3s` | mean normalised RMS in the first 3 s | audio hook — **hook** attribute |
| `energy_mean` `energy_peak_t` | overall level, time of peak | build |
| `energy_phase_count` | number of distinct energy phases | dynamics |
| `surge_count` `drop_count` `hard_stop_count` | dynamic events | dynamics — **hold** attributes |

Excluded: `energy_level_sequence` (a string like `HIGH>MEDIUM>VOID`; descriptive only).

`audio_analysis` values: `none` (no audio stream), `basic` (core only — librosa missing), `advanced` (lane ran).

## Metrics

| metric | formula | source fields | needs |
|---|---|---|---|
| `hook_rate` | `video_view / impressions` | Meta 3-second view | any delivered video ad |
| `hold_rate` | `thruplay / video_view` | thruplay = 15 s or complete | retention fields fetched for **every** day in the window (CLI ≥ 0.19); otherwise `null` and the ad is flagged `partial_retention` |

Eligibility: `impressions >= min_impressions` (default 1000), `hook_rate` not null, cached tags present. One ad = one observation, unweighted.

## Confidence

| bucket | requires |
|---|---|
| `strong` | both groups n ≥ 20, \|Cohen's d\| ≥ 0.5, Mann-Whitney p < 0.05 |
| `directional` | both groups n ≥ 8, lift and d agree in sign, p < 0.20 |
| `anecdotal` | clears minimum group size (3), nothing more |

`q_value` = Benjamini-Hochberg across all tests in the run. Buckets use raw `p`; `q` is for the caveats paragraph.
