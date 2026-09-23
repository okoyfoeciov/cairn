//! core/src/lib.rs — Owner: 07.
//! Spec: CONTRACT.md §1.3 (the twenty commands), §1.4 (the event table), §1.6
//! (the flush-on-quit handshake, B11/B18/M55).
//!
//! The module tree and the ONE entry into the blocking pool.  No logic beyond
//! that: every command body is in its owner's module.

pub mod app;
pub mod error;
pub mod fsops;
pub mod note_frame;
pub mod path;
pub mod prefs;
pub mod scan;
pub mod search;
pub mod tree;
pub mod vault;
pub mod watcher;

/// THE ONE PLACE THE BLOCKING POOL IS ENTERED.
///
/// The shell builds the runtime at `worker_threads(2)` /
/// `max_blocking_threads(6)` and registers its handle before serving a command,
/// so every spawn routed here lands on THAT pool — and the search coordinator
/// holds one of those six slots for the whole of a search, which is what makes
/// the count load-bearing rather than decorative.
///
/// It delegates to `runtime::handle()` rather than
/// `tokio::task::spawn_blocking`, deliberately: the registered handle is
/// resolved explicitly, while tokio's reads a thread-local runtime context and
/// PANICS when there is none.
pub fn spawn_blocking<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    runtime::handle().spawn_blocking(f)
}

/// The registry the spawner above reads.  One handle, registered once by the
/// shell before it serves a command.
pub mod runtime {
    use std::sync::OnceLock;
    use tokio::runtime::Handle;

    static HANDLE: OnceLock<Handle> = OnceLock::new();

    /// Register the process's runtime.  Idempotent and first-wins: the handle
    /// cannot be re-pointed once the app is serving commands.
    pub fn set(handle: Handle) {
        let _ = HANDLE.set(handle);
    }

    /// PANICS RATHER THAN FALLING BACK TO `Handle::current()`, deliberately.
    /// A thread-local fallback would work from inside a task and panic from a
    /// callback, so the failure would show up as an intermittent crash in the
    /// shell instead of a startup error in the one line that forgot to call
    /// `set`.
    #[must_use]
    pub fn handle() -> &'static Handle {
        HANDLE.get().expect(
            "cairn: the runtime handle was never registered — the shell must call \
             cairn_lib::runtime::set(rt.handle().clone()) before any command runs",
        )
    }
}

/// The process-wide state every command takes as `State<'_, AppState>`.
///
/// DEFINED IN `app.rs` AND RE-EXPORTED HERE, so that `cairn_lib::AppState` — the
/// path every command signature in §1.3 is written against — does not move.  It
/// lives beside its methods because those methods ARE the orchestration: the
/// `Arc<VaultSnapshot>` seam (§4.2), `open_note` (M54), the ONE epoch counter
/// (§1.4), the watcher handle and the §1.6 close handshake.  See `app.rs`'s
/// header for why that file exists at all.
pub use app::AppState;
