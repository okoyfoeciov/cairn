//! core/napi/src/lib.rs — Owner: 07.
//! Spec: CONTRACT.md §1.1 (conventions), §1.3 (THE command table), §1.4 (the
//! event table), §1.5 (`VaultError`), §1.6 (the flush-on-quit handshake),
//! §6.2 X8 (the runtime); `docs/VERDICT-scroll-and-stack.md` §8.2 step 5.
//!
//! ===================== THIS FILE IS THE SHELL'S COMMAND LAYER ===============
//! It obeys one rule (spec-07 §1, rule 2): **ONE CALL INTO `app.rs` PER
//! COMMAND, AND NO LOGIC OF ITS OWN.**  Every `#[napi]` body below is an
//! argument conversion and a call.  Where a body grew past that, the growth
//! belongs in `app.rs`, not here.
//!
//! IT DECLARES NO WIRE TYPE, AND THAT IS THE POINT.  `electron-shell/backend/`
//! was a THIRD copy of TreeBlob v1 and the §2 note frame — a copy that could
//! only ever drift, and that `wire.test.mjs` existed to catch drifting.  This
//! crate has zero copies: the bytes come out of `tree.rs` and `note_frame.rs`
//! themselves, and every JSON shape is `serde_json::to_value` over the very
//! struct §1.1's X13 casing rule already annotates.  Adding a
//! `#[napi(object)]` mirror of `VaultInfo` here would reintroduce exactly the
//! defect the deletion of `backend/` removes.
//! =============================================================================
//!
//! WHAT IT DOES NOT IMPLEMENT, DELIBERATELY:
//!   - **command 1, `pick_vault`.**  Electron's own `dialog.showOpenDialog` is
//!     the picker on this shell, opened by the SHELL from the main process,
//!     never by the renderer, and no `dialog:*` capability is granted to the
//!     page.
//!
//! ERRORS CROSS AS A PREFIXED JSON MESSAGE, NOT AS A STRUCTURED THROW, and the
//! reason is Electron's, not napi's: `ipcMain.handle` serialises a thrown Error
//! by its `message` and `stack` and by nothing else, so no structured payload
//! survives main -> renderer however it is thrown here.  An envelope is
//! therefore required at the `ipcMain` boundary regardless, and the addon's job
//! is only to hand `app-main.mjs` something it can reconstruct §1.5 from
//! in-process.  `CAIRN_VAULT_ERROR` is that marker.

use std::sync::{Arc, OnceLock};

use napi::bindgen_prelude::{Buffer, FnArgs, Function, Null, Uint8Array, Undefined};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use serde_json::Value;

use cairn_lib::app::{self, AppCtx};
use cairn_lib::error::VaultError;
use cairn_lib::note_frame::WriteArgs;
use cairn_lib::prefs::UiPatch;
use cairn_lib::search::{MsgSink, SearchMsg};
use cairn_lib::AppState;

/* ── §1.5 across the Node-API boundary ────────────────────────────────────── */

/// The marker `app-main.mjs` splits on.  It is a prefix rather than a bare JSON
/// body so that a napi error raised by the BINDING (a wrong argument type, a
/// missing `start`) can never be mistaken for a §1.5 condition: those have no
/// marker and must surface as the programming errors they are.
pub const CAIRN_VAULT_ERROR: &str = "cairn.VaultError:";

/// Every §1.5 condition, on the wire exactly as `serde` already writes it.
fn throw(e: &VaultError) -> napi::Error {
    // `to_string()` on the error itself is the LAST resort and is unreachable in
    // practice (`VaultError` is a closed enum of plain fields), but it must not
    // be an `unwrap`: a serialisation failure inside an error path would
    // otherwise take the process down while reporting a `notFound`.
    let body = serde_json::to_string(e).unwrap_or_else(|_| {
        format!(r#"{{"kind":"io","path":"","code":0,"message":{:?}}}"#, e.to_string())
    });
    napi::Error::new(Status::GenericFailure, format!("{CAIRN_VAULT_ERROR}{body}"))
}

/// A JS millisecond timestamp -> `i64`, refused rather than truncated.
fn as_millis(ms: f64) -> napi::Result<i64> {
    if ms.is_finite() && ms >= -(2f64.powi(63)) && ms < 2f64.powi(63) {
        #[allow(clippy::cast_possible_truncation)]
        Ok(ms as i64)
    } else {
        Err(napi::Error::new(
            Status::InvalidArg,
            format!("cairn: {ms} is not a representable millisecond timestamp"),
        ))
    }
}

/// `Result<T, VaultError>` -> `napi::Result<T>`.
fn v<T>(r: Result<T, VaultError>) -> napi::Result<T> {
    r.map_err(|e| throw(&e))
}

/// A §1.3 result type -> the JS object the frontend already reads.
///
/// `serde_json::to_value` and NOT a `#[napi(object)]` mirror: the camelCase
/// every field arrives in is `#[serde(rename_all = "camelCase")]` on the type
/// itself (§1.1 X13), so there is one source of truth for the shape and it is
/// the one `cargo test` already covers.
fn json<T: serde::Serialize>(value: &T) -> napi::Result<Value> {
    serde_json::to_value(value).map_err(|e| {
        napi::Error::new(Status::GenericFailure, format!("cairn: could not serialise a result: {e}"))
    })
}

/* ── the shell's half of `AppCtx` ─────────────────────────────────────────── */

/// `FnArgs`, NOT a bare `(String, Value)`, and the difference is visible from
/// JS: napi's blanket `JsValuesTupleIntoVec for T: ToNapiValue` turns a bare
/// tuple into ONE JavaScript **array** argument, and only `FnArgs` spreads it
/// into two.  Measured, not assumed — the first cut of this file shipped the
/// bare tuple and the smoke test read `arguments.length === 1`.
type EventArgs = FnArgs<(String, Value)>;
type EventTsfn = ThreadsafeFunction<EventArgs, Undefined, EventArgs, Status, false, true>;
/// `Weak = true` on BOTH of these, and it is the difference between an addon
/// and a leak.  A threadsafe function REFS the host's event loop by default,
/// so a process that loads this addon can never exit on its own again —
/// measured, not theorised: `node --test electron-shell/native.test.mjs` ran
/// every assertion, passed, and then hung forever.  Electron's own window
/// holds the loop open; the addon has no business doing it too.
type QuitTsfn = ThreadsafeFunction<i32, Undefined, i32, Status, false, true>;

/// The shell's `impl AppCtx`, for Electron.
///
/// Same three methods, same discards, same reasons.
#[derive(Clone)]
struct ElectronCtx {
    state: Arc<AppState>,
    events: Arc<EventTsfn>,
    on_quit: Arc<QuitTsfn>,
}

impl AppCtx for ElectronCtx {
    fn emit_event<S: serde::Serialize + Clone>(&self, event: &str, payload: S) {
        // Discarded exactly as every other emit call site discards it, and for
        // the same reason: a dead webview is not an error worth unwinding an
        // orchestration path for.  A payload that will not serialise is dropped
        // with a line rather than a panic — this runs on the watcher's
        // coalescing thread, where a panic would take the watcher with it.
        match serde_json::to_value(payload) {
            Ok(v) => {
                let _ = self
                    .events
                    .call(EventArgs::from((event.to_string(), v)), ThreadsafeFunctionCallMode::NonBlocking);
            }
            Err(e) => eprintln!("cairn: could not serialise the payload of {event}: {e}"),
        }
    }

    fn app_state(&self) -> &AppState {
        &self.state
    }

    fn quit(&self, code: i32) {
        let _ = self.on_quit.call(code, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// The search channel, wearing `search.rs`'s trait.
///
/// §1.4's rule is kept — a PER-CALL channel, never the global bus:
/// the event name carries the generation, so two live searches cannot deliver
/// into each other's subscription.
struct SearchSink {
    ctx: ElectronCtx,
    channel: String,
}

impl MsgSink for SearchSink {
    fn send(&self, msg: SearchMsg) {
        self.ctx.emit_event(&self.channel, msg);
    }
}

/* ── process state ────────────────────────────────────────────────────────── */

static CTX: OnceLock<ElectronCtx> = OnceLock::new();

fn ctx() -> napi::Result<&'static ElectronCtx> {
    CTX.get().ok_or_else(|| {
        napi::Error::new(
            Status::GenericFailure,
            "cairn: start() has not been called — the addon has no AppState, no event sink \
             and no prefs path yet",
        )
    })
}

/// CONTRACT §6.2, X8 — and it is the SAME runtime napi runs every `async fn`
/// below on, which is what makes the tuning describe the process rather than
/// half of it.
///
/// `main.rs:22-31` is the reference and this matches it value for value: 2
/// workers, 6 blocking, and the blocking count is load-bearing because the
/// search coordinator holds one of the six for a whole search.  A napi addon
/// has no `main()` to build it in, so it is built at module init — before any
/// `#[napi]` function can be called, which is the property
/// `create_custom_tokio_runtime` requires.
///
/// The handle is registered with `cairn_lib::runtime::set` BEFORE the runtime
/// is handed to napi, because napi takes ownership.
#[napi_derive::module_init]
fn init() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(6)
        .enable_all()
        .build()
        .expect("cairn: failed to build the tokio runtime");
    cairn_lib::runtime::set(rt.handle().clone());
    napi::bindgen_prelude::create_custom_tokio_runtime(rt);
}

/* ── lifecycle ────────────────────────────────────────────────────────────── */

/// Build the process's `AppState`, install the §1.4 event sink, and load
/// `state.json`.  Idempotent and first-wins, like `AppState::init_prefs`.
///
/// `prefs_path` is passed IN rather than derived here.  The shell resolves it
/// from `package.json`'s identifier, and deriving a second path in Rust — from
/// a hard-coded `com.cairn.app`, say — would create a drift between the two.
///
/// A `None` path means "this launch does not persist", which is what a harness
/// run wants: `PrefsStore` is never constructed and `app::save_ui_state`
/// returns early on every call.  Nothing then writes outside the vault.
#[napi]
pub fn start(
    on_event: Function<'_, EventArgs, Undefined>,
    on_quit: Function<'_, i32, Undefined>,
    prefs_path: Option<String>,
) -> napi::Result<()> {
    let events = on_event.build_threadsafe_function::<EventArgs>().weak::<true>().build()?;
    let quit = on_quit.build_threadsafe_function::<i32>().weak::<true>().build()?;

    let state = Arc::new(AppState::new());
    if let Some(p) = prefs_path {
        state.init_prefs(std::path::PathBuf::from(p));
    }

    let ctx = ElectronCtx { state, events: Arc::new(events), on_quit: Arc::new(quit) };
    if CTX.set(ctx).is_err() {
        return Err(napi::Error::new(
            Status::GenericFailure,
            "cairn: start() was called twice; the AppState is process-wide and cannot be replaced",
        ));
    }
    Ok(())
}

/// §1.6, the ✕ / ⌘Q / Ctrl-Q half.  Returns true when the caller must PREVENT
/// the close and wait for `confirm_close`.
///
/// One function for every close path, exactly as `lib.rs` routes both
/// `CloseRequested` and `ExitRequested` through it — two copies would drift and
/// the difference would be silent data loss on one of them.
#[napi]
pub fn begin_close() -> napi::Result<bool> {
    Ok(app::begin_close(ctx()?))
}

/// §7.5: reopen `state.json`'s last vault on a normal launch. Not a §1.3 command.
///
/// ASYNC on a blocking worker: the launch prune stats every tracked vault root
/// and may rewrite `state.json`, and a root on an unreachable mount must not
/// stall Electron's main thread (the stats are also bounded, `app::probe_dirs`).
#[napi]
pub async fn startup_open() -> napi::Result<()> {
    let ctx = ctx()?.clone();
    cairn_lib::spawn_blocking(move || app::spawn_startup_open(&ctx))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: startup_open panicked: {e}")))
}

/* ── 2-5: the vault ───────────────────────────────────────────────────────── */

/// Command 2.  Emits `nc://vault-opened` on success.
///
/// `open_vault_blocking` inside `spawn_blocking`: this future runs on one of
/// only TWO runtime workers (§6.2 X8), so a 21.8 ms walk left on it would stall
/// every other command for the duration.  The hop is the point.
#[napi]
pub async fn open_vault(path: String) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let info = cairn_lib::spawn_blocking(move || {
        app::open_vault_blocking(&ctx, ctx.app_state(), &path)
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: the vault walker panicked: {e}")))?;
    json(&v(info)?)
}

/// Command 3.  A DISCRIMINATED `VaultState`, never `Option<VaultInfo>` (M65).
#[napi]
pub fn current_vault() -> napi::Result<Value> {
    json(&app::current_vault(ctx()?.app_state()))
}

/// Command 4.  ASYNC on a blocking worker: it stats every tracked vault root,
/// and the vault switcher asks each time it opens.  A root on an unreachable
/// network mount must not stall Electron's main thread and every IPC behind it.
#[napi]
pub async fn recent_vaults() -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let rows = cairn_lib::spawn_blocking(move || app::recent_vaults(ctx.app_state()))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: recent_vaults panicked: {e}")))?;
    json(&rows)
}

/// Command 5.  Re-walks AND retries the watcher (M57).
#[napi]
pub async fn rescan_all() -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    json(&v(app::rescan_all(ctx).await)?)
}

/* ── 6-7: the tree ────────────────────────────────────────────────────────── */

/// Command 6.  RAW OUT: TreeBlob v1, one crossing (B1/B19/M49).
///
/// **K4, PAID HERE.**  Electron refuses `napi_create_external_buffer`
/// (`napi_no_external_buffers_allowed`), so napi-rs falls back to
/// `napi_create_buffer_copy` and the blob is copied once on the way out.  There
/// is a second copy at the `ipcMain` boundary, which is structured clone's and
/// not this crate's.  Both are measured in `docs/spike-R-napi-addon.md`; neither
/// is avoidable and no topology removes them.
///
/// ASYNC on a blocking worker: a snapshot while a 50k-node repair holds the
/// vault lock must queue off the event loop, not freeze window events and all
/// other IPC behind it.
#[napi]
pub async fn tree_snapshot() -> napi::Result<Buffer> {
    let ctx = ctx()?.clone();
    let blob = cairn_lib::spawn_blocking(move || app::tree_blob(ctx.app_state()))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: tree_snapshot panicked: {e}")))?;
    Ok(Buffer::from(v(blob)?))
}

/// Command 7.  Returns the NEW epoch.  Four orders, no created-time (M28/M53).
///
/// `u64` -> `i64`: JS has no u64, and an epoch that reached `i64::MAX` would
/// have needed 9.2e18 mutations.  `try_from` rather than `as` so the day it
/// somehow does, it is an error and not a negative number.
///
/// ASYNC for command 6's reason: it takes the vault write lock.
#[napi]
pub async fn set_sort(sort: u8) -> napi::Result<i64> {
    let ctx = ctx()?.clone();
    let epoch = cairn_lib::spawn_blocking(move || app::set_sort(&ctx, ctx.app_state(), sort))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: set_sort panicked: {e}")))?;
    let epoch = v(epoch)?;
    i64::try_from(epoch)
        .map_err(|_| napi::Error::new(Status::GenericFailure, "cairn: the epoch overflowed i64"))
}

/// Command 25.  The secret notes' rels, as JSON strings.  ASYNC on a blocking
/// worker like command 6: a cold cache opens every changed file's head, and
/// that I/O must queue off the event loop like the snapshot's own.
#[napi]
pub async fn secret_notes() -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let rels = cairn_lib::spawn_blocking(move || app::secret_notes(ctx.app_state()))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: secret_notes panicked: {e}")))?;
    json(&rels)
}

/* ── 8-9: notes ───────────────────────────────────────────────────────────── */

/// Command 8.  RAW OUT, the §2 frame.  See `tree_snapshot` for K4's copy.
///
/// On a blocking worker for the same reason `open_vault` is: a file read on one
/// of the two runtime workers blocks every other command behind it, and a slow
/// or networked vault (§0.12.2) is exactly where that shows.
#[napi]
pub async fn read_note(path: String) -> napi::Result<Buffer> {
    let ctx = ctx()?.clone();
    let framed = cairn_lib::spawn_blocking(move || app::read_note(ctx.app_state(), &path))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: read_note panicked: {e}")))?;
    Ok(Buffer::from(v(framed)?))
}

/// Command 9.  RAW IN plus the four write arguments.
///
/// THE GUARD IS THE TYPE: `Either<f64, Null>` accepts a number (guarded) and
/// `null` (§7.2's force-overwrite), and rejects `undefined` — which is what a
/// dropped field arrives as.  Collapsing it to `Option<f64>` would make a
/// frontend bug that omits the field silently mean "overwrite whatever is
/// there", and that is the data-loss shape the conflict guard exists to
/// prevent.
#[napi]
pub async fn write_note(
    path: String,
    body: Uint8Array,
    flags: u32,
    base_mtime_ms: napi::Either<f64, Null>,
    create: bool,
) -> napi::Result<Value> {
    let base = match base_mtime_ms {
        // `f64 -> i64`: the value is a JS number of milliseconds and JS has no
        // i64.  `as` truncates rather than saturating, so it is checked: an
        // mtime outside i64 is a broken clock, and a truncated one would defeat
        // the conflict guard by comparing equal to something it is not.
        napi::Either::A(ms) => Some(as_millis(ms)?),
        napi::Either::B(_) => None,
    };
    let args = WriteArgs { rel: path, flags, base_mtime_ms: base, create };
    // COPIED OUT OF THE JS HEAP BEFORE THE AWAIT, deliberately.  A `Uint8Array`
    // is a live reference into V8's heap; carrying one across an await and
    // reading it from a blocking worker means Rust holds a pointer the JS
    // thread may resize or collect.  A note body is bounded by
    // `MAX_NOTE_BYTES`, so this is one bounded memcpy on the write path and it
    // buys the whole class of use-after-free away.  It is the SECOND copy K4
    // costs (`tree_snapshot`'s is the first, and outbound).
    let body = body.to_vec();
    let ctx = ctx()?.clone();
    let receipt = cairn_lib::spawn_blocking(move || {
        app::write_note(&ctx, ctx.app_state(), &args, &body)
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: write_note panicked: {e}")))?;
    json(&v(receipt)?)
}

/* ── 10-13: mutations ─────────────────────────────────────────────────────── */

/// Commands 10-13.  ASYNC on a blocking worker for command 6's reason: every
/// one takes arena/filesystem locks and performs filesystem I/O, so running
/// them on Node's event loop freezes window events and all other IPC while a
/// vault walk or repair holds the lock.
#[napi]
pub async fn create_note(parent: String, name: Option<String>) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || {
        app::create_note(&ctx, ctx.app_state(), &parent, name.as_deref())
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: create_note panicked: {e}")))?;
    json(&v(out)?)
}

#[napi]
pub async fn create_folder(parent: String, name: Option<String>) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || {
        app::create_folder(&ctx, ctx.app_state(), &parent, name.as_deref())
    })
    .await
    .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: create_folder panicked: {e}")))?;
    json(&v(out)?)
}

/// Command 12.  Updates `AppState.open_note` under the write lock (M54).
#[napi]
pub async fn rename_entry(path: String, new_name: String) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || app::rename_entry(&ctx, ctx.app_state(), &path, &new_name))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: rename_entry panicked: {e}")))?;
    json(&v(out)?)
}

/// Command 13.  Delete of the OPEN note is ORDERED, not raced (B17).
#[napi]
pub async fn delete_entry(path: String, permanent: bool) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || app::delete_entry(&ctx, ctx.app_state(), &path, permanent))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: delete_entry panicked: {e}")))?;
    json(&v(out)?)
}

/// Command 24.  Drag-to-move: `path` into `dest_parent` (`""` = vault root).
/// ASYNC on a blocking worker like commands 10-13: takes arena/filesystem
/// locks and performs filesystem I/O.
#[napi]
pub async fn move_entry(path: String, dest_parent: String) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || app::move_entry(&ctx, ctx.app_state(), &path, &dest_parent))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: move_entry panicked: {e}")))?;
    json(&v(out)?)
}

/* ── 14-16: search ────────────────────────────────────────────────────────── */

/// Command 14.  4 threads per query, no persistent pool (B4/M47).
///
/// Returns as soon as the coordinator is spawned; it never awaits the scan, so
/// the messages arrive on `channel` after this promise has already resolved.
///
/// `channel` is passed in rather than composed here: the frontend owns the
/// generation number (X15, §4.3) and therefore owns the name derived from it.
#[napi]
pub async fn search_start(query: String, generation: i64, channel: String) -> napi::Result<()> {
    let ctx = ctx()?.clone();
    let gen = u64::try_from(generation).map_err(|_| {
        napi::Error::new(Status::InvalidArg, "cairn: the search generation must not be negative")
    })?;
    let sink = SearchSink { ctx: ctx.clone(), channel };
    v(app::search_start(ctx.app_state(), query, gen, sink).await)
}

/// Command 15.  Re-greps ONE file at call time (~20 µs).  On a blocking worker
/// for `read_note`'s reason: it opens a vault file, and a stalled network vault
/// must not block Electron's main thread.
#[napi]
pub async fn search_expand(query: String, rel: String) -> napi::Result<Value> {
    let ctx = ctx()?.clone();
    let out = cairn_lib::spawn_blocking(move || app::search_expand(ctx.app_state(), &query, &rel))
        .await
        .map_err(|e| napi::Error::new(Status::GenericFailure, format!("cairn: search_expand panicked: {e}")))?;
    json(&v(out)?)
}

/// Command 16.  The FRONTEND owns the generation; a vault switch CANCELS
/// rather than bumping (§4.3, X15).
#[napi]
pub fn search_cancel(generation: i64) -> napi::Result<()> {
    let gen = u64::try_from(generation).map_err(|_| {
        napi::Error::new(Status::InvalidArg, "cairn: the search generation must not be negative")
    })?;
    app::search_cancel(ctx()?.app_state(), gen);
    Ok(())
}

/* ── 17-20: state, lifecycle, diagnostics ─────────────────────────────────── */

/// Command 17.  §7.6, debounced 1,000 ms.
///
/// `UiPatch` is DESERIALISED, not rebuilt: `last_note` is
/// `Option<Option<String>>` and both layers are load-bearing — the outer `None`
/// is "the patch did not mention it", the inner is "there is no open note now" —
/// and serde is the only thing that already gets that right.
#[napi]
pub fn save_ui_state(patch: Value) -> napi::Result<()> {
    let patch: UiPatch = serde_json::from_value(patch).map_err(|e| {
        napi::Error::new(Status::InvalidArg, format!("cairn: malformed UI patch: {e}"))
    })?;
    app::save_ui_state(ctx()?.app_state(), &patch);
    Ok(())
}

/// Command 18.  §1.6.  A REJECTING FLUSH CANCELS THE CLOSE.
#[napi]
pub fn confirm_close(ok: bool, reason: Option<String>) -> napi::Result<()> {
    let ctx = ctx()?;
    app::confirm_close(ctx, ctx.app_state(), ok, reason.as_deref());
    Ok(())
}

/// Command 20.  Resolved through the arena exactly as `read_note` resolves, so
/// §7.3 case 13's traversal guarantee is unchanged.
#[napi]
pub fn reveal_in_os(path: String) -> napi::Result<()> {
    v(app::reveal_in_os(ctx()?.app_state(), &path))
}

/// Command 21.  §0.30 E70 — drop a vault from `recents`, and from nothing else.
/// SYNC, like `save_ui_state` and `confirm_close`: the write is one atomic
/// `state.json` — a file with no other writer and no base mtime — and the two
/// other commands that flush it do so on this thread too.  §1.1's "every
/// command that touches the filesystem is async" is about the VAULT, whose
/// walks and note reads are unbounded; this one is bounded by `MAX_RECENTS`.
#[napi]
pub fn forget_vault(root: String) -> napi::Result<()> {
    v(app::forget_vault(ctx()?.app_state(), &root))
}
