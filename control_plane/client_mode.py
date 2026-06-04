def normalize_client_mode(broker: str | None, client_mode: str | None = None) -> str:
    """Return bracket for eToro when client_mode is unset; otherwise honor explicit values."""
    broker_key = (broker or "").strip().lower()
    mode = (client_mode or "").strip().lower()
    if mode == "bracket":
        return "bracket"
    if mode == "standard":
        return "standard"
    return "bracket" if broker_key == "etoro" else "standard"
