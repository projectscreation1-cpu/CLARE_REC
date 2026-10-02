# CLARUS – lip-reading recording app

A mobile-friendly web app that collects short lip-reading videos for **CLARUS**, a final-year B.Tech research project (Hindustan Institute of Technology and Science, AI & DS) on fairness in visual speech recognition.

Each participant fills in a consent form, passes a camera check, and records 5 sentences. Every clip is speech-checked in the browser and then uploaded to a private Supabase Storage bucket.

Plain HTML/CSS/JS with no build step. All files sit at the repository root.

| File | Purpose |
|---|---|
| `index.html` | The four screens (welcome/consent, camera check, recording, done) |
| `styles.css` | Styling |
| `app.js` | Camera, MediaPipe checks, canvas recording, speech verification, uploads |
| `logic.js` | Pure logic: sentence sets, `?set=` parsing, profanity filter, sentence matching, path sanitising |
| `config.js` | Supabase URL and **publishable** key (edit this) |
| `supabase.sql` | Creates the private bucket and its RLS policies |
| `test-logic.mjs` | Unit tests for `logic.js` (`node test-logic.mjs`) |

---

## 1. Supabase setup

1. Create a project at <https://supabase.com> (free tier is enough). If the project is **paused**, restore it first from the dashboard.
2. Open **SQL Editor**, paste in all of `supabase.sql` and click **Run**. This creates:
   - a private bucket `recordings` (10 MB per-file limit, webm/mp4/json only)
   - an `INSERT` policy for `anon`, limited to this bucket
   - an `UPDATE` policy for `anon`, limited to this bucket. `upsert: true` runs `INSERT … ON CONFLICT DO UPDATE`, and without this policy every upload fails with *"new row violates row-level security policy"*.
   - a `SELECT` policy for `anon` that only applies **during the upload operation itself** (`storage.allow_any_operation`). Supabase needs SELECT to overwrite an existing file, so without it a **re-record** fails. Anonymous users still can't list or download anything.
   - no `DELETE` policy for anon.
3. Go to **Project Settings → API Keys** and copy:
   - the **Project URL** (`https://xxxx.supabase.co`)
   - the **Publishable key** (`sb_publishable_…`). The legacy `anon` key also works.
4. Put both into `config.js`. **Never** use the `service_role`/secret key here: this file is public.

### Where the data ends up

```
recordings/
  21ad042_priya_kumar/
    01.webm … 05.webm      ← one clip per sentence (re-records overwrite)
    participant.json       ← demographics, consent, set, per-clip metadata
```

To see each clip's metadata, open **Storage → recordings → a file** in the dashboard, or run this in the SQL Editor:

```sql
select name, updated_at, user_metadata
from storage.objects where bucket_id = 'recordings' order by name;
```

## 2. Deploy on Vercel

1. Push this folder to a GitHub repo, with `index.html` at the **root**. If it's in a subfolder, Vercel returns 404.
2. In Vercel: **Add New → Project → Import** the repo. Framework preset: **Other**. Leave the build command and output directory empty.
3. Click **Deploy**. You get an `https://<project>.vercel.app` URL. The camera only works over HTTPS, and Vercel provides that automatically.

To test locally: run `python3 -m http.server 8000` and open `http://localhost:8000`. Browsers treat `localhost` as secure, so the camera works. To test on a phone, you need the HTTPS Vercel URL.

## 3. Generate the 10 participant links

Each group of 5 people gets one link. The `set` parameter picks that group's 5 sentences. A missing or invalid value (`0`, `11`, `abc`) falls back to set 1.

```bash
URL=https://<project>.vercel.app
for i in $(seq 1 10); do echo "Group $i: $URL/?set=$i"; done
```

## 4. Video spec

- Camera requested at exactly 640×480 at 25 fps. If a camera can't do exactly 640×480, the app falls back to the nearest size. The **actual** width, height and fps from `track.getSettings()` are always stored in the metadata.
- The app records from a 640×480 `<canvas>` at 25 fps plus the microphone. The disclaimer is burned into the bottom of the frame.
- Format: `video/webm;codecs=vp9,opus`, falling back to `video/webm`. Video is 400 kbps and audio 64 kbps, about 0.6 MB per 12 s clip. If a browser can't record WebM at all (older iPhones before Safari 18.4), the app records MP4 and saves `01.mp4` etc., so those participants aren't locked out. The `mimeType` metadata field records which format was used.

## 5. Speech verification rules

| Situation | Result | `verificationStatus` |
|---|---|---|
| ≥ 50% of the sentence's words heard | upload | `pass` |
| < 50% matched, or nothing heard (`no-speech`) | **not uploaded**, re-record | – |
| Blocked word or phrase heard | **not uploaded**, re-record | – |
| Speech API error (other than `no-speech`) and empty transcript | upload, flagged for manual review | `technical_error` |
| Browser has no Web Speech API (e.g. Firefox) | upload, flagged, Chrome/Edge suggested | `unsupported` |

How the profanity filter matches:
- Most blocked words match by **prefix**, so `fucking` is caught by `fuck`.
- It never matches inside a word, so `grape` does not trigger `rape`.
- Short words like `ass` must match the **whole word**, so `assist` and `assignments` (set 5) pass.
- Phrases like `kill you` match on word boundaries.
- Chrome's masked output (`f***`) is also blocked.

## 6. Tests

```bash
node test-logic.mjs
```

This covers `?set=` edge cases, the profanity matcher, sentence matching, a check that all 50 sentences are well-formed and pass the profanity filter, and path sanitising.

## Privacy

There are no analytics, cookies or third-party trackers. The only external requests are:
- the libraries, loaded from jsDelivr
- the MediaPipe face model, loaded from Google's model storage
- the browser's own speech service (Chrome/Edge)
- your Supabase project
