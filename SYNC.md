# Private device sync

Tiny Sounds shares the existing Quorum Supabase project. Tiny Sounds has its own `tiny_sound_boards` table, `tiny-sounds-media` private bucket, and `tiny_sounds_private` helper schema. Existing Quorum tables, billing, and project lifecycle settings are unchanged.

## Parent flow

Hold the gear for three seconds and sign in in the sync section. Use the same account on each device. Existing Quorum accounts can sign in here. Photos, recordings, names, ordering, and the active play selection sync together. Anonymous local play remains available.

The local IndexedDB board remains the source for playback. Changes save locally first, then upload in the background. Offline edits queue until the connection returns. The app checks for remote changes on sign-in, reconnect, return to the app, entry to parent controls, and about every 30 seconds while signed in. A new starter-only device adopts the account board automatically. A device with personal content asks before replacing anything.

If devices both changed, a parent chooses **Use this device’s board** or **Use account board**. The alternate version is saved in this device's IndexedDB as `board-backup`; **Restore the previous board** recovers it. Only the latest alternate board is retained. Remote updates wait until recording/editing dialogs close.

Signing out ends only the Tiny Sounds session on this device; the local board stays playable. Quorum's app session uses a separate storage key and is not signed out. Sign-out is not a device-data erasure operation.

## API and data model

The public frontend contains only a Supabase URL and publishable key. No secret or service-role key is bundled. The pinned Supabase JS SDK 2.119.0 is stored in `vendor/`, including its MIT license, and cached for offline use.

Authentication uses Supabase Auth with PKCE for Google redirects, email/password sign-in, account verification, password recovery, and session refresh. Tiny Sounds uses the dedicated browser storage namespace `tiny-sounds-auth-v1`.

`public.tiny_sound_boards`:

- `user_id uuid`: authenticated owner, primary key.
- `revision bigint`: monotonically increasing cloud revision.
- `items jsonb`: ordered array of at most 50 sound manifests (25 library and 25 custom, with at most 12 active), at most 128 KiB total.
- `updated_at timestamptz`: last cloud write.

Each manifest item has `id`, `name`, `emoji`, `color`, `demo`, `kind`, `catalogKey`, `active`, optional `demoKey` and `demoVersion`, `audio`, and nullable `photo`. Custom media entries have `path` and MIME `type`. Library audio uses `{builtin: catalogKey, version, type: "audio/mpeg"}` with a validated catalog key and no photo. Library references reconstruct the bundled recording locally and consume no private media quota. Legacy manifests remain supported and normalize into the collection model. Objects are immutable, addressed as `<owner UUID>/<SHA-256>.bin`. The path hash is verified after downloads. Actual blobs live in the private Storage bucket and IndexedDB; manifests contain no encoded photos or audio.

The client reads its manifest through the Supabase Data API. `tiny_sounds_save_board(p_expected_revision bigint,p_items jsonb)` performs an owner-scoped compare-and-set. A stale revision returns HTTP 409 (`PT409`). The RPC verifies each referenced file exists and belongs to the caller, validates known library references, and enforces collection and active-selection limits. It runs as `SECURITY INVOKER` with an empty search path.

Local IndexedDB `state` keys:

- `board`: ordered items with Blob fields.
- `revision`: local write counter for cross-window conflict protection.
- `sync-meta`: `{owner,remoteRevision,dirty}`.
- `board-backup`: latest alternate board with complete offline blobs.

Media uploads are limited to 5 MiB each, 25 MiB per account, and 100 MiB for Tiny Sounds in total. The quota helper uses a transaction lock to serialize bucket accounting. This reserves most of Quorum's free Storage allowance for its existing app. Private helpers have restricted grants and fixed search paths. A storage-limit error preserves all local content and reports that sync needs attention; no automatic billing upgrade occurs.

RLS limits table rows and Storage paths to `auth.uid()`. Anonymous callers have no board-table privileges. Interrupted uploads are reclaimed before new uploads, and failed pushes clean up their staged objects. Cleanup deletes only unreferenced files, with server-side checks preventing removal of files referenced by the latest manifest. The RPC and cleanup checks share a transaction lock so deleted files cannot become live references during cleanup.

## Deployment

Runtime files include `catalog.js`, `demo-sounds.js`, `sync-config.js`, `sync.js`, and `vendor/`. Their paths are in the service worker precache. Auth redirects must allow `https://jacobflanglais.github.io/tiny-sounds/` (and the exact localhost origin used during development). Add these redirects to the existing Auth configuration without replacing Quorum's URLs.

## Verification

Live backend tests use disposable accounts, two isolated browser contexts for one account, and another context for a different account. Coverage includes photo/audio transfer, offline reload and playback, queued edits, conflict selection and backup restore, stale revision rejection, unauthorized board/media reads, and protection of referenced files from deletion. Test credentials remain in ignored local work files and are removed after testing.
