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

- Beat-Synced Shockwaves: Trigger radial disturbance pulses or ripples timed to detected kicks and transients.
- Cellular Activity Modulation: Route audio energy to the stochastic update probability mask (chill slow evolution during quiet passages, explosive rapid evolution on drops).
- Frequency-Dependent Perception Scaling: Modulate perception filter step strides so bass dilates macro structures while treble excites fine granular details.
- Audio-Driven 3D Lighting Wobble: Modulate directional light angles and specular intensity with audio volume and frequency bands.

## Phase 4: Extended Visual Fidelity

Further explore high-density rendering and state introspection.

- 512x512 High-DPI Grid Option: Support higher resolution simulations for high-density desktop displays.
- Hidden Channel Inspector: False-color visualization modes displaying hidden memory channels (channels 3 to 11) to inspect electrical waves moving beneath the surface.
