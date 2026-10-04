// Test-only allocation accounting stays local to each test thread. Warm up lazy
// shared state before measuring; ordinary parallel tests remain uninstrumented.
use crate::ffi::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
thread_local! { static ACCOUNT: Cell<(bool,isize,usize)> = const { Cell::new((false,0,0)) }; }
struct Counted;
#[global_allocator]
static ALLOCATOR: Counted = Counted;
fn account(size: isize) {
    let _ = ACCOUNT.try_with(|v| {
        let (active, live, total) = v.get();
        if active {
            v.set((true, live + size, total + size.max(0) as usize));
        }
    });
}
unsafe impl GlobalAlloc for Counted {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            account(layout.size() as isize);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        account(-(layout.size() as isize));
        unsafe { System.dealloc(p, layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            account(layout.size() as isize);
        }
        p
    }
    unsafe fn realloc(&self, p: *mut u8, old: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, old, size) };
        if !q.is_null() {
            account(size as isize - old.size() as isize);
        }
        q
    }
}
struct Measurement;
impl Drop for Measurement {
    fn drop(&mut self) {
        ACCOUNT.with(|value| value.set((false, 0, 0)));
    }
}

fn measured(name: &str, mut run: impl FnMut()) {
    run();
    ACCOUNT.with(|v| v.set((true, 0, 0)));
    let _measurement = Measurement;
    for _ in 0..128 {
        run();
    }
    let (_, live, total) = ACCOUNT.with(|v| {
        let result = v.get();
        v.set((false, 0, 0));
        result
    });
    assert!(total > 1000, "{name}: positive allocation control");

    assert_eq!(
        live, 0,
        "acquisition lifetime retains allocations after completion"
    );
}
#[test]
fn returned_buffer_lifetime() {
    measured("buffer", || unsafe {
        let input =
            br#"{"window":{"text":"Synthetic private note","startKnown":true,"endKnown":true}}"#;
        let mut b = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        assert_eq!(
            voice_core_context_json(input.as_ptr(), input.len(), &mut b),
            0
        );
        let bytes = std::slice::from_raw_parts(b.data, b.length);
        assert!(
            std::str::from_utf8(bytes)
                .unwrap()
                .contains("Synthetic private note")
        );
        voice_core_buffer_free(b);
    });
}
#[test]
fn source_owner_lifetime() {
    measured("source", || unsafe {
        let text = b"Synthetic private source";
        let mut owner = std::ptr::null_mut();
        assert_eq!(
            voice_core_source_scalar_new(text.len(), 0, text.len(), &mut owner),
            0
        );
        let (mut from, mut length) = (0, 0);
        assert_eq!(voice_core_source_next(owner, &mut from, &mut length), 0);
        assert_eq!((from, length), (0, text.len()));
        assert_eq!(
            voice_core_source_utf8_offer(owner, text.as_ptr(), text.len()),
            0
        );
        assert_eq!(voice_core_source_next(owner, &mut from, &mut length), 0);
        assert_eq!(length, 0);
        let mut b = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        assert_eq!(voice_core_source_finish(owner, &mut b), 0);
        assert!(
            std::str::from_utf8(std::slice::from_raw_parts(b.data, b.length))
                .unwrap()
                .contains("Synthetic private source")
        );
        voice_core_buffer_free(b);
        voice_core_source_free(owner);
        // Independent refused owner must also release its pending state.
        assert_eq!(
            voice_core_source_scalar_new(text.len(), 0, text.len(), &mut owner),
            0
        );
        assert_ne!(
            voice_core_source_utf8_offer(owner, text.as_ptr(), text.len() - 1),
            0
        );
        let mut b = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        assert_ne!(voice_core_source_finish(owner, &mut b), 0);
        assert!(b.data.is_null());
        voice_core_source_free(owner);
    });
}
#[test]
fn semantic_owner_lifetime() {
    measured("semantic", || unsafe {
        let text = b"Synthetic private semantic label";
        let mut owner = std::ptr::null_mut();
        let mut decision = 0;
        assert_eq!(voice_core_semantic_new(2, &mut owner, &mut decision), 0);
        assert_eq!(decision, 1);
        assert_eq!(
            voice_core_semantic_offer(owner, 1, text.as_ptr(), text.len(), &mut decision),
            0
        );
        assert_eq!(decision, 3);
        let mut b = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        assert_eq!(voice_core_semantic_finish(owner, &mut b), 0);
        assert_eq!(std::slice::from_raw_parts(b.data, b.length), text);
        voice_core_buffer_free(b);
        voice_core_semantic_free(owner);
        assert_eq!(voice_core_semantic_new(2, &mut owner, &mut decision), 0);
        assert_ne!(
            voice_core_semantic_offer(owner, 2, text.as_ptr(), text.len(), &mut decision),
            0
        );
        let mut b = Buffer {
            data: std::ptr::null_mut(),
            length: 0,
        };
        assert_ne!(voice_core_semantic_finish(owner, &mut b), 0);
        assert!(b.data.is_null());
        voice_core_semantic_free(owner);
    });
}
