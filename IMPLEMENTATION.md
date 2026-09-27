# Reliability, Android and interface work

Requested: implement every confirmed audit fix and practical addition; restore bidirectional LAN database synchronization; deliver Android APK and polished responsive UI.

## Sequence and acceptance

1. Protect manuscripts: one editor model, durable recovery, centralized encryption, validated atomic import, complete backups. Verify replacement, AI, history, crash recovery, malicious input and encrypted raw storage.
2. Restore LAN database reconciliation: missing records in both directions, persistent pending changes, acknowledgements, stale-message rejection, conflict preservation and comparison. Test two isolated databases over the actual broker, including offline edits and deletes.
3. Restore Android project and native integration: offline assets, file sharing/export, LAN cleartext configuration, keyboard/insets/back navigation and lifecycle saving. Produce and inspect APK.
4. Practical tools: rotating external backups, recoverable trash, ordered book export with chapter selection and optional notes, return to manuscript position, cross-document review queue, AI cancellation and explicit chapter/world association.
5. UI and performance: adaptive toolbar, readable contrast, opaque mobile surfaces, focus management, reduced motion, compact cards, concise settings, onboarding import/restore, local fonts, incremental spelling/analysis and lazy assets.
6. Full verification: unit/integration, browser regression, desktop/mobile screenshots, production build, dependency audit, Android build. Log changes in updates.md. Preserve card-grid 1fr and existing animations.

## Evidence

- Start checkpoint: 982aa2d; clean master branch.
- Previous audit artifacts: C:/Users/sasat/AppData/Local/Temp/nocturne-audit-ax0yk0qh.
- Android platform/config absent at start; Java 21 available, SDK location not yet established.

## Progress

- Architecture rechecked; same audited failures are present. Regression suite is being added before production edits.
