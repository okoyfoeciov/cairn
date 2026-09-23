// Owner: 07.  napi-build emits the platform link arguments a Node-API addon
// needs (on macOS, `-undefined dynamic_lookup`, because the symbols are
// resolved by the host process at load time and there is no libnode to link).
fn main() {
    napi_build::setup();
}
