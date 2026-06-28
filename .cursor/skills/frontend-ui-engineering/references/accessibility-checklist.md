# Accessibility Checklist (WCAG 2.1 AA)

Detailed reference for the `frontend-ui-engineering` skill. Use this when building or auditing UI to meet WCAG 2.1 AA.

## Perceivable

- [ ] **Text alternatives**: All non-decorative images have `alt` text. Decorative images use `alt=""` or `role="presentation"`.
- [ ] **Icon-only controls**: Have `aria-label` or visually-hidden text describing the action.
- [ ] **Color contrast**: 4.5:1 for normal text, 3:1 for large text (≥18.66px bold or ≥24px), 3:1 for UI components and graphical objects.
- [ ] **Color is not the only signal**: State (error, success, selected) is also conveyed via text, icon, or pattern.
- [ ] **Reflow**: Content reflows without horizontal scrolling at 320px width / 400% zoom.
- [ ] **Text spacing**: Layout survives increased line-height, letter-spacing, and paragraph spacing.

## Operable

- [ ] **Keyboard accessible**: All functionality works with keyboard alone — no mouse-only interactions.
- [ ] **No keyboard trap**: Focus can move into and out of every component (modals trap intentionally but release on close).
- [ ] **Visible focus**: Every focusable element has a clear, visible focus indicator (don't remove `outline` without a replacement).
- [ ] **Logical focus order**: Tab order follows the visual/reading order.
- [ ] **Skip link**: A "Skip to content" link is available for keyboard users on pages with large navigation.
- [ ] **Target size**: Interactive targets are at least 24×24px (44×44px recommended for touch).
- [ ] **No timing traps**: Time limits are adjustable or absent; no content auto-updates in a way users can't pause.
- [ ] **Motion**: Respect `prefers-reduced-motion`; avoid content that flashes more than 3 times per second.

## Understandable

- [ ] **Labels**: Every form input has an associated `<label>` (via `htmlFor`/`id`) or `aria-label`/`aria-labelledby`.
- [ ] **Error identification**: Errors are described in text, programmatically associated (`aria-describedby`), and `aria-invalid` is set.
- [ ] **Error suggestions**: Where known, suggest how to fix the error.
- [ ] **Consistent navigation**: Repeated components appear in the same relative order across pages.
- [ ] **Language**: The page declares `lang` on `<html>`.
- [ ] **Predictable**: Focus or input does not trigger unexpected context changes (no auto-submit on focus).

## Robust

- [ ] **Valid markup**: No duplicate IDs; elements are properly nested.
- [ ] **Semantic HTML first**: Use native elements (`button`, `a`, `nav`, `main`, `ul`) before ARIA.
- [ ] **ARIA correctness**: Roles, states, and properties are valid and not contradicted by native semantics.
- [ ] **Name, role, value**: Custom components expose an accessible name, correct role, and current state/value.
- [ ] **Status messages**: Dynamic updates use `aria-live` (`polite` for status, `assertive` for errors) or `role="status"`/`role="alert"`.

## Landmarks and Structure

- [ ] One `<main>` per page.
- [ ] `<header>`, `<nav>`, `<footer>` used appropriately.
- [ ] Headings are hierarchical (no skipped levels); one `h1` per page.
- [ ] Lists use `ul`/`ol`/`li`; data tables use `<th>` with `scope`.

## Component-Specific Patterns

- **Modal/Dialog**: `role="dialog"` + `aria-modal="true"`, labelled by its title, focus moved in on open, focus trapped, focus restored to trigger on close, closes on `Esc`.
- **Menu/Dropdown**: Arrow-key navigation, `Esc` to close, `aria-expanded` on the trigger, `aria-haspopup` where relevant.
- **Tabs**: `role="tablist"`/`tab`/`tabpanel`, arrow-key navigation, `aria-selected`, roving `tabIndex`.
- **Tooltip**: Triggered on focus and hover, `aria-describedby` links trigger to tooltip, dismissible with `Esc`.
- **Form**: Group related fields with `<fieldset>`/`<legend>`; mark required fields with `required`/`aria-required` and a visible indicator.
- **Toast/Notification**: `role="status"` (polite) or `role="alert"` (assertive); don't steal focus.

## Testing Tools

- **axe-core / @axe-core/react**: Automated checks in dev; logs violations to the console.
- **eslint-plugin-jsx-a11y**: Lint JSX for common a11y mistakes at author time.
- **Lighthouse (Chrome DevTools)**: Accessibility audit score and issue list.
- **Keyboard pass**: Tab through the entire page; confirm order, focus visibility, and that all actions are reachable.
- **Screen readers**: VoiceOver (macOS: `Cmd+F5`), NVDA (Windows), TalkBack (Android) — verify names, roles, and announcements.
- **Zoom/reflow**: Test at 200% and 400% browser zoom and at 320px width.
- **Contrast**: Use a contrast checker or DevTools' built-in contrast ratio in the color picker.

## Quick Triage Order

1. Run axe-core / Lighthouse → fix reported violations.
2. Keyboard-only pass → fix focus order, traps, and unreachable controls.
3. Screen reader pass on key flows → fix missing names/roles/announcements.
4. Contrast + reflow + reduced-motion checks.
