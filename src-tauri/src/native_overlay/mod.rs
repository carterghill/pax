//! Native GPU overlay rendering (desktop) vs no-op stubs on Android / iOS.
//!
//! The real implementation is Windows-focused (`desktop` module) and pulls in
//! `wgpu`, which is intentionally not linked for mobile targets.

#[cfg(desktop)]
mod desktop;

#[cfg(desktop)]
pub use desktop::*;

#[cfg(not(desktop))]
mod stub;

#[cfg(not(desktop))]
pub use stub::*;
