//! The platform backend: Win32 on Windows, an "unavailable" stub elsewhere. Both export the same functions.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(crate) use windows::*;

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub(crate) use unsupported::*;
