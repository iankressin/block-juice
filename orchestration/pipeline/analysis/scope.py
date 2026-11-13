"""Bind the supported token query parameters to the scope certified by coverage."""
import re
from pipeline.cli import BadInput

ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def validate_token_scope(parameters, blocks, sources, label):
    token = parameters.get("token")
    if not isinstance(token, dict) or not isinstance(token.get("windows"), list) or not token["windows"]:
        raise BadInput(f"{label}: parameter_scope token_windows requires a token object with non-empty windows")
    if not isinstance(token.get("ethereum"), str) or not ADDRESS.fullmatch(token["ethereum"]):
        raise BadInput(f"{label}: token.ethereum must be an Ethereum token address")
    if not isinstance(token.get("decimals"), int) or isinstance(token["decimals"], bool) or not 0 <= token["decimals"] <= 255:
        raise BadInput(f"{label}: token.decimals must be an integer from 0 to 255")
    windows = {}
    for window in token["windows"]:
        if not isinstance(window, dict) or not isinstance(window.get("chain"), str):
            raise BadInput(f"{label}: each token window needs chain, token and blocks")
        chain, span, asset = window["chain"], window.get("blocks"), window.get("token")
        if chain in windows:
            raise BadInput(f"{label}: token scope supports one window per chain, repeated {chain}")
        if not isinstance(span, (list, tuple)) or len(span) != 2 or not all(isinstance(n, int) and not isinstance(n, bool) and n >= 0 for n in span) or span[0] > span[1]:
            raise BadInput(f"{label}: token.windows blocks must be inclusive [from, to] with from <= to")
        if not isinstance(asset, str) or not ADDRESS.fullmatch(asset):
            raise BadInput(f"{label}: token.windows token must be an Ethereum-compatible token address")
        windows[chain] = (tuple(span), asset.lower())
    declared = {chain: span for chain, (span, _) in windows.items()}
    if declared != blocks:
        raise BadInput(f"{label}: effective token.windows must match the selected window.blocks exactly; "
                       "update values/window together, or set eval_values matching eval_window for --eval")
    by_source = {}
    for source in sources:
        by_source.setdefault(source.source, []).append(source)
    for chain, (_, asset) in windows.items():
        name = f"{chain}.erc20_transfers"
        if name not in by_source:
            raise BadInput(f"{label}: token scope requires input {name} with filter.tokens [{asset}]")
        for source in by_source[name]:
            if {value.lower() for value in source.filter.get("tokens", [])} != {asset}:
                raise BadInput(f"{label}: {name} filter.tokens must match effective token.windows token {asset}")
    for source in sources:
        if source.chain not in windows:
            continue
        if source.source == "arbitrum.token_bridge":
            asset = token["ethereum"].lower()
        elif source.source.endswith(".op_standard_bridge"):
            asset = windows[source.chain][1]
        else:
            continue
        if {value.lower() for value in source.filter.get("tokens", [])} != {asset}:
            raise BadInput(f"{label}: {source.source} filter.tokens must match effective bridge token {asset}")
