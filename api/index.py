"""Vercel entry point: exposes the FastAPI app from backend/server.py.
All /api/* requests are routed here by vercel.json."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from server import app  # noqa: E402,F401
