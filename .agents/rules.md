# Workspace Performance & Quick Execution Rules

## 1. Fast File Lookups
- **NEVER** run unbounded recursive searches (`Get-ChildItem -Recurse` or `findstr /s`) across the workspace root.
- `venv/` contains PyTorch, SciPy, and Scikit-learn with over 50,000 files; scanning it takes minutes and hangs terminal tasks.
- Always scope searches specifically to `backend/core/` or `frontend/src/`.

## 2. Instant Backend Testing (Runs in 0.002s)
- **Fast Test Runner:** Run `.\\venv\\Scripts\\python.exe backend/run_tests.py`
- Do not run `manage.py test` without `--noinput` or outside targeted test suites, as full runs test third-party network APIs with long fallbacks.
- Daphne in `settings.py` is configured to bypass on test runs (`IS_TESTING`) to prevent Python 3.14 Windows Twisted reactor deadlocks.

## 3. Instant Frontend Verification
- Run `npm --prefix frontend run build` (builds in ~1.2s) to verify JSX/JS syntax and imports.
