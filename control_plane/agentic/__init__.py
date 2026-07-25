"""Agentic session trading: market hunter, per-session trading engines, reconciliation.

This is a NEW subsystem, independent of the 1% session engine and the
trading-session engine. It reuses existing infra only (screener store,
trade-halts store, eToro broker client, instrument resolution).
"""
