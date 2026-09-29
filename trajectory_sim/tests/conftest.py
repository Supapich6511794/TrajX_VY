"""Shared pytest fixtures for the trajectory_sim test suite.

Isolates module-level mutable performance state so one test (or an
import side-effect) can't leak into another. ``api.server`` registers the
VY AIP field elevations into ``performance._FIELD_ELEV_FT`` at import
time; without this, importing it in any test (e.g. the SID/STAR splice
wiring tests) would silently change the elevations ``test_performance``
asserts against. Conftest is imported before any test module — and thus
before that side-effect — so the snapshot here captures the pristine
hardcoded defaults.
"""

from __future__ import annotations

import copy

import pytest

import trajectory_sim.performance as _perf

# Captured at conftest import — before any test module imports api.server,
# so this is the un-registered, hardcoded default elevation set.
_PRISTINE_FIELD_ELEV = copy.deepcopy(_perf._FIELD_ELEV_FT)


@pytest.fixture(autouse=True)
def _isolate_field_elevations() -> "object":
    """Reset the field-elevation registry to its pristine defaults per test."""
    _perf._FIELD_ELEV_FT.clear()
    _perf._FIELD_ELEV_FT.update(_PRISTINE_FIELD_ELEV)
    yield
    _perf._FIELD_ELEV_FT.clear()
    _perf._FIELD_ELEV_FT.update(_PRISTINE_FIELD_ELEV)
