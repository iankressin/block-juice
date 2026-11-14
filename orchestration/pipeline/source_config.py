"""Source files use dotenv's Node grammar, without Python-dotenv interpolation or escape rules."""

import re
from pathlib import Path

# ECMAScript WhiteSpace + LineTerminator. Python's \s also accepts characters Number rejects.
JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_SPACE = f"[{JS_WHITESPACE}]"
_START = r"(?:\A|(?<=\n)|(?<=\u2028)|(?<=\u2029))"
_END = r"(?=\Z|\n|\u2028|\u2029)"
_LINE = re.compile(
    _START + _SPACE + r"*(?:export" + _SPACE + r"+)?([A-Za-z0-9_.-]+)"
    r"(?:" + _SPACE + r"*=" + _SPACE + r"*?|:" + _SPACE + r"+?)"
    r"(" + _SPACE + r"*'(?:\\'|[^'])*'|" + _SPACE + r'*"(?:\\"|[^"])*"|'
    + _SPACE + r"*`(?:\\`|[^`])*`|[^#\r\n]+)?" + _SPACE + r"*(?:#[^\n\u2028\u2029]*)?" + _END
)


def parse_source_env(text: str) -> dict[str, str]:
    """Match dotenv 18's default parser; only double-quoted \\n and \\r expand."""
    values = {}
    for match in _LINE.finditer(text.replace("\r\n", "\n").replace("\r", "\n")):
        value = (match[2] or "").strip(JS_WHITESPACE)
        quote = value[:1]
        if len(value) >= 2 and quote in ("'", '"', "`") and value[-1:] == quote:
            value = value[1:-1]
        if quote == '"':
            value = value.replace(r"\n", "\n").replace(r"\r", "\r")
        values[match[1]] = value
    return values


def source_env_values(path: Path) -> dict[str, str]:
    try:
        return parse_source_env(path.read_text())
    except FileNotFoundError:
        return {}
