# @commercebill/ui

Reusable presentation primitives for the renderer (Task 1.7): Button, TextInput, PasswordInput, Alert, Card,
PageHeader, Spinner/LoadingState, EmptyState, AppShell (header + sidebar). Styled with Tailwind utility classes and the
`brand` colour scale defined in `apps/web/src/index.css`.

Rules: no API calls, no router and no application state in this package - callers pass data and render links
through `renderLink`. Primitives are added only when a screen needs them.
