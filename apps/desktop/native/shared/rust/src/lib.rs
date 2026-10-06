// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod address;
mod context;
mod ffi;
mod gesture;
mod policy;
pub mod privacy;
mod request;
mod screen;
mod semantic;

mod source_window;

pub mod source;

mod viewport;
mod walk;

#[cfg(test)]
mod allocation_tests;
