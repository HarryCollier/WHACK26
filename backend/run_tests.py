"""
Fast Unit Test Runner for Backend Core
Runs in ~0.05 seconds with zero external database or network overhead.
Usage:
    .\\venv\\Scripts\\python.exe backend/run_tests.py
"""
import os
import sys
import unittest

# Ensure backend root is on PYTHONPATH
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "server.settings")
os.environ["TESTING"] = "1"
os.environ["MPLCONFIGDIR"] = os.environ.get("TEMP", "/tmp")

import django
django.setup()

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    # Discover and run fast unit tests
    discovered = loader.discover(start_dir=os.path.join(BACKEND_DIR, "core"), pattern="test_*.py")
    suite.addTests(discovered)

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
