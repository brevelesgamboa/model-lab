# Neural Growth Roadmap

Development roadmap focusing on expanding Neural Growth into a high-fidelity, interactive, and audio-reactive cellular synthesis engine.

## Completed Milestones

- Custom Model Library: Integrated 22 curated custom NCA models (25 Originals total, 91 patterns overall) across ambientCG, NASA, Wikimedia, and DTD sources.
- Startup and Noise Initialization: Added runtime support for Gaussian noise seeding (seedState: noise) on reset.
- Unified Pattern Gallery: Integrated gallery modal with instant search, tab filters, favorites bookmarking, recents strip, and citation info overlays.
- Provenance and Citations: Documented dataset origins and licenses in CITATIONS.md with verified SHA-256 asset checksums.
- Real-Time 3D Relief Shading: WebGL2 fragment shader surface normal shading with directional diffuse, specular gloss, and normal vector map inspection modes.
- High-Fidelity 256x256 Default Grid: Simulations default to 256x256 resolution and preserve the active grid size across pattern selections.
- Viewport Display Filtering: Configurable smooth bilinear interpolation versus crisp nearest-neighbor cell magnification.
- Light Angle and Relief Depth Modulation: Circularly wrapping directional light angle and relief depth controls wired for LFO and audio modulation.
- Phase 1 Coordinate Geometries and Vector Fields:
  - Concentric and Vortex Perception: Radial coordinate mapping producing centered mandala and eye-like concentric rings.
  - Log-Polar Spiral Perception: Conformal logarithmic spiral mapping where patterns swirl along exponential spiral rays with continuous spin.
  - Mathematical and Fractal Geometries: Integrated Apollonian Dipole and Julia Complex Dynamics ($z \leftarrow z^2 + c$) conformal vector fields.
  - Interactive Vector Pitch and Twist: Dedicated pitch control with audio and LFO modulation support for live swelling and swirling.
- Phase 2 Interactive Brush Toolkit:
  - Top Canvas Toolbar: Quick-access toolbar above the stage with Set A tools (Erase, Noise, Color, Ripple, Freeze, Unfreeze, Flow).
  - Color Infusion Brush: Direct RGB state infusion with preset pills, native color picker, and hex input.
  - Ripple Pulse Tool: Sinusoidal radial displacement wave rippling outward from pointer clicks and drags.
  - Freeze Barrier with Mask vs Draw Toggle: Inverted dashed perimeter outline for frozen barriers. Supports Mask mode (protected wall blocking growth and brushes) and Draw mode (editable canvas allowing drawing on frozen cells before unfreezing).
  - Directional Flow Grooming Brush: Dragging pointer combs local cell orientation angles along stroke velocity vectors.

## Phase 3: Audio-Visual Reactivity and Modulation

Transform Neural Growth into an expressive audio-reactive performance visualizer.

- Beat-Synced Shockwaves: Trigger non-destructive radial display ripples timed to detected audio kicks or interactive pointer drawing, with independent reach modes (Follow Brush, Whole Canvas default).
- Audio-Reactive Modulation Presets: Built-in presets (Subtle, Continuous, Dynamic) configuring speed, vector twist, relief depth, and 3D lighting routes, featuring dynamic audio activity energy scaling and instant synchronization.
- Full Custom Modulation Parity: Any preset configuration maps directly to gl-bench's parameter MOD panels, giving users full visibility and freedom to fine-tune depths, with automatic fallback to Custom mode when edited.
- Shockwave Stylization and Color: Configurable shockwave styles including chromatic aberration dispersion, luminous color glow rings matching active brush pigment, and harmonic multi-ring resonance wavefronts.
- Generative State Shockwaves (Cellular Infusion): Option for expanding shockwaves to write directly into simulation state buffers (inverting cell colors, infusing dye pigment rings, or seeding noise along the wavefront), stimulating live morphogenetic regeneration as the NCA heals and adapts to the pulse.
- Saved Run Enablement: Full experiment saving and archive restoration for Neural Growth configurations (pattern checkpoint, seed, parameters, modulation matrix, and thumbnail).

## Phase 4: Extended Visual Fidelity

Further explore high-density rendering and state introspection.

- 512x512 High-DPI Grid Option: Support higher resolution simulations for high-density desktop displays.
- Hidden Channel Inspector: False-color visualization modes displaying hidden memory channels (channels 3 to 11) to inspect electrical waves moving beneath the surface.

## Future Milestones: Shared Audio and Modulation Architecture

Shared engine enhancements benefiting all generative models across gl-bench:

- Audio Feature Extraction Rework: Multi-band frequency separation (sub-bass, mid, highs), adaptive energy normalization, and cleaner kick/transient separation in the shared rhythm controller.
- Modulation Panel UX Overhaul: Redesign parameter modulation popups with visual response curves, bidirectional bipolar depth controls, and streamlined routing.

