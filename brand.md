# SafeSpend interface direction

_Status: active_

SafeSpend is an operator console, not a fintech landing page. The interface
should feel closer to a well-maintained deployment tool than a portfolio
tracker: quiet, dense enough to scan, and explicit about state.

## Current palette

- **Primary:** `#0f766e` — trust, safety, active controls
- **Secondary:** `#334155` — operational structure
- **Accent:** `#d97706` — Devnet and attention states
- **Neutrals:** Slate scale — backgrounds, borders, and text
- **Success:** `#15803d`
- **Warning:** `#b45309`
- **Error:** `#b91c1c`

## Typography

- **UI:** System sans-serif stack
- **Data:** System monospace stack

## UI rules

- Use one connected ledger for treasury facts; do not repeat identical metric
  cards.
- Use teal only for an available action or verified boundary. Amber means
  Devnet or attention. Red means a refused operation.
- Keep surfaces flat, borders visible, and radii small. Shadows are reserved for
  overlays.
- Show actual slots, base units, policy floors, run IDs, and signatures. Do not
  invent company names, user profiles, growth metrics, or activity.
- Motion should explain a state change. No decorative gradients, glass panels,
  floating shapes, or ambient animation.
- Prefer direct operational copy: `Blocked by protected policy`, not
  `Something went wrong`.

## Voice

Calm, exact, and operational. SafeSpend should explain what is protected, what needs approval, and what has actually happened onchain without exaggeration.
