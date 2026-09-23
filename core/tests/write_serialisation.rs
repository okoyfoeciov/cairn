//! Integration: two note writes with the SAME base mtime, issued at once.
//!
//! F91/F87 — two writes with the same base must serialise.
//!
//! This is what the frontend produces when a write outlives its IPC timeout
//! and the next autosave is sent with the base the first one never advanced.
//! The conflict check and the rename must behave as one step: exactly one of
//! the two writes lands, the other is a `conflict`, and the winner's receipt
//! describes what is on disk.  Interleaved, both passed the check and the
//! older text could land last under the newer write's receipt.
//!
//! A real temp vault on the real filesystem; nothing outside `tempfile`.

use std::fs;
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, SystemTime};

use cairn_lib::fsops;
use cairn_lib::note_frame::WriteArgs;
use cairn_lib::watcher::SelfWrites;

fn args(base: i64) -> WriteArgs {
    WriteArgs { rel: "Note.md".into(), flags: 0, base_mtime_ms: Some(base), create: false }
}

#[test]
fn two_writes_with_the_same_base_never_both_succeed() {
    const ROUNDS: usize = 100;
    let dir = tempfile::tempdir().expect("tempdir");
    let abs = Arc::new(dir.path().join("Note.md"));
    let sw = Arc::new(Mutex::new(SelfWrites::new()));
    let mut both_ok = 0usize;

    for round in 0..ROUNDS {
        fs::write(&*abs, format!("start {round}\n")).expect("seed");
        // A base at least a minute old, as it is after a 30 s stall: the
        // winner's fresh mtime can never equal it by clock coincidence.
        fs::File::options()
            .write(true)
            .open(&*abs)
            .and_then(|f| f.set_modified(SystemTime::now() - Duration::from_secs(60)))
            .expect("backdate");
        let base = fsops::mtime_ms(&fs::metadata(&*abs).expect("stat"));

        let gate = Arc::new(Barrier::new(2));
        let spawn = |body: String| {
            let (abs, sw, gate) = (Arc::clone(&abs), Arc::clone(&sw), Arc::clone(&gate));
            std::thread::spawn(move || {
                gate.wait();
                (fsops::write_note(&abs, &args(base), body.as_bytes(), &sw), body)
            })
        };
        let a = spawn(format!("older {round}\n"));
        let b = spawn(format!("newer {round}\n"));
        let results = [a.join().expect("join a"), b.join().expect("join b")];

        let oks: Vec<_> = results.iter().filter(|(r, _)| r.is_ok()).collect();
        if oks.len() == 2 {
            both_ok += 1;
            continue;
        }
        for (r, _) in &results {
            if let Err(e) = r {
                assert_eq!(e.kind(), "conflict", "round {round}: {e:?}");
            }
        }
        let [(winner, body)] = oks.as_slice() else {
            panic!("round {round}: neither write landed: {results:?}");
        };
        let receipt = winner.as_ref().expect("ok");
        let disk = fs::metadata(&*abs).expect("stat");
        assert_eq!(fs::read(&*abs).expect("read"), body.as_bytes(), "round {round}");
        assert_eq!(receipt.mtime_ms, fsops::mtime_ms(&disk), "round {round}: receipt is not the disk");
        assert_eq!(receipt.size, disk.len(), "round {round}");
    }

    assert_eq!(both_ok, 0, "same-base writes were both accepted in {both_ok}/{ROUNDS} rounds");
}
