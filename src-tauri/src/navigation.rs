//! App-local macOS swipe navigation (including Logitech Back/Forward actions).
#[cfg(target_os = "macos")]
mod macos {
    use block2::RcBlock;
    use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
    use objc2_app_kit::{NSApplication, NSEvent, NSEventMask};
    use std::{cell::RefCell, ptr::NonNull};
    use tauri::{Emitter, WebviewWindow};

    struct Monitor(Retained<AnyObject>);
    impl Drop for Monitor {
        fn drop(&mut self) {
            // The thread-local monitor is created and destroyed on the AppKit main thread.
            unsafe { NSEvent::removeMonitor(&self.0) };
        }
    }
    thread_local! {
        static MONITOR: RefCell<Option<Monitor>> = const { RefCell::new(None) };
    }

    pub fn install(window: WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
        let mtm = MainThreadMarker::new().ok_or("Navigation must initialize on the main thread")?;
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
            // AppKit owns the event for the duration of this local callback.
            let event_ref = unsafe { event.as_ref() };
            let is_main_window = event_ref
                .window(mtm)
                .or_else(|| NSApplication::sharedApplication(mtm).keyWindow())
                .is_some_and(|native| {
                    window.ns_window().is_ok_and(|target| {
                        Retained::as_ptr(&native).cast::<std::ffi::c_void>() == target.cast_const()
                    })
                });
            if !is_main_window {
                return event.as_ptr();
            }
            if let Some(direction) = super::swipe_direction(event_ref.deltaX(), event_ref.deltaY())
                && window.emit("boa:history-navigation", direction).is_ok()
            {
                // Consume the gesture so WebKit cannot also navigate its document history.
                return std::ptr::null_mut();
            }
            event.as_ptr()
        });
        // A local monitor only sees events already addressed to BOA. No global input access.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe, &handler)
        }
        .ok_or("Unable to register native navigation gestures")?;
        MONITOR.with(|current| *current.borrow_mut() = Some(Monitor(monitor)));
        Ok(())
    }
}

#[cfg(any(target_os = "macos", test))]
fn swipe_direction(x: f64, y: f64) -> Option<i8> {
    // AppKit NSEventTypeSwipe: positive deltaX is left/back; negative is right/forward.
    if !x.is_finite() || !y.is_finite() || x == 0.0 || x.abs() <= y.abs() {
        None
    } else if x > 0.0 {
        Some(-1)
    } else {
        Some(1)
    }
}

#[cfg(target_os = "macos")]
pub use macos::install;

#[cfg(test)]
mod tests {
    use super::swipe_direction;
    #[test]
    fn horizontal_swipes_navigate_but_vertical_and_invalid_events_do_not() {
        assert_eq!(swipe_direction(1.0, 0.0), Some(-1));
        assert_eq!(swipe_direction(-1.0, 0.0), Some(1));
        for (x, y) in [
            (0.0, 1.0),
            (0.0, -1.0),
            (0.0, 0.0),
            (0.2, 1.0),
            (f64::NAN, 0.0),
        ] {
            assert_eq!(swipe_direction(x, y), None);
        }
    }
}
