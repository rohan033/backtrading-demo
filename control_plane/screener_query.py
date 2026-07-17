"""Safe TradingView screener DSL: parse/validate Query/Column method chains.

Never uses eval/exec. Accepts only a whitelist of AST nodes that mirror:
  Query().select(...).where(...).order_by(...).limit(...)
"""

from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Any

from control_plane.screener_fields import field_label

ALLOWED_COLUMN_METHODS = frozenset(
    {
        "between",
        "not_between",
        "isin",
        "not_in",
        "has",
        "has_none_of",
        "in_day_range",
        "in_week_range",
        "in_month_range",
        "above_pct",
        "below_pct",
        "between_pct",
        "not_between_pct",
        "like",
        "not_like",
        "empty",
        "not_empty",
        "crosses",
        "crosses_above",
        "crosses_below",
    }
)

ALLOWED_QUERY_METHODS = frozenset(
    {
        "select",
        "where",
        "where2",
        "order_by",
        "limit",
        "offset",
        "set_markets",
    }
)

FIELD_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_./|]*$")


class ScreenerQueryError(ValueError):
    """Raised when DSL text or a definition is invalid."""


@dataclass
class FilterCond:
    left: str
    operation: str
    right: Any = None

    def to_dict(self) -> dict[str, Any]:
        return {"left": self.left, "operation": self.operation, "right": self.right}


@dataclass
class FilterGroup:
    operator: str  # "and" | "or"
    conditions: list[FilterCond | FilterGroup] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "operator": self.operator,
            "conditions": [
                c.to_dict() if isinstance(c, (FilterCond, FilterGroup)) else c
                for c in self.conditions
            ],
        }


@dataclass
class ScreenerDefinition:
    columns: list[str] = field(default_factory=list)
    filters: list[FilterCond] = field(default_factory=list)
    filter_group: FilterGroup | None = None
    order_by: str | None = None
    ascending: bool = False
    limit: int = 50
    offset: int = 0
    market: str = "america"

    def to_dict(self) -> dict[str, Any]:
        return {
            "columns": list(self.columns),
            "filters": [f.to_dict() for f in self.filters],
            "filter_group": self.filter_group.to_dict() if self.filter_group else None,
            "order_by": self.order_by,
            "ascending": bool(self.ascending),
            "limit": int(self.limit),
            "offset": int(self.offset),
            "market": self.market or "america",
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> ScreenerDefinition:
        raw = data or {}
        filters = [_parse_filter_cond(item) for item in (raw.get("filters") or [])]
        group_raw = raw.get("filter_group")
        group = _parse_filter_group(group_raw) if group_raw else None
        columns = [str(c) for c in (raw.get("columns") or []) if str(c).strip()]
        if not columns:
            columns = ["name", "close", "volume", "market_cap_basic"]
        limit = int(raw.get("limit") or 50)
        offset = int(raw.get("offset") or 0)
        if limit < 1 or limit > 500:
            raise ScreenerQueryError("limit must be between 1 and 500")
        if offset < 0 or offset > 10_000:
            raise ScreenerQueryError("offset must be between 0 and 10000")
        order_by = raw.get("order_by")
        if order_by is not None:
            order_by = str(order_by).strip() or None
            if order_by and not FIELD_KEY_RE.match(order_by):
                raise ScreenerQueryError(f"Invalid order_by field: {order_by!r}")
        for col in columns:
            if not FIELD_KEY_RE.match(col):
                raise ScreenerQueryError(f"Invalid column field: {col!r}")
        market = str(raw.get("market") or "america").strip() or "america"
        if not re.match(r"^[a-z0-9_]+$", market):
            raise ScreenerQueryError(f"Invalid market: {market!r}")
        return cls(
            columns=columns,
            filters=filters,
            filter_group=group,
            order_by=order_by,
            ascending=bool(raw.get("ascending", False)),
            limit=limit,
            offset=offset,
            market=market,
        )


def _parse_filter_cond(item: Any) -> FilterCond:
    if isinstance(item, FilterCond):
        return item
    if not isinstance(item, dict):
        raise ScreenerQueryError("Filter must be an object")
    left = str(item.get("left") or "").strip()
    operation = str(item.get("operation") or "").strip()
    if not left or not FIELD_KEY_RE.match(left):
        raise ScreenerQueryError(f"Invalid filter field: {left!r}")
    if not operation:
        raise ScreenerQueryError("Filter operation is required")
    return FilterCond(left=left, operation=operation, right=item.get("right"))


def _parse_filter_group(item: Any) -> FilterGroup:
    if isinstance(item, FilterGroup):
        return item
    if not isinstance(item, dict):
        raise ScreenerQueryError("Filter group must be an object")
    operator = str(item.get("operator") or "and").lower()
    if operator not in {"and", "or"}:
        raise ScreenerQueryError("Filter group operator must be 'and' or 'or'")
    conditions: list[FilterCond | FilterGroup] = []
    for child in item.get("conditions") or []:
        if isinstance(child, dict) and "operator" in child and "conditions" in child:
            conditions.append(_parse_filter_group(child))
        else:
            conditions.append(_parse_filter_cond(child))
    return FilterGroup(operator=operator, conditions=conditions)


# ── Literal / value extraction ───────────────────────────────────────────────


def _literal(node: ast.AST) -> Any:
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        value = _literal(node.operand)
        if not isinstance(value, (int, float)):
            raise ScreenerQueryError("Unary +/- only allowed on numbers")
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, (ast.List, ast.Tuple)):
        return [_literal(elt) for elt in node.elts]
    if isinstance(node, ast.Name):
        if node.id == "True":
            return True
        if node.id == "False":
            return False
        if node.id == "None":
            return None
        raise ScreenerQueryError(f"Name {node.id!r} is not allowed as a literal")
    raise ScreenerQueryError(f"Unsupported literal: {type(node).__name__}")


def _field_name(node: ast.AST) -> str:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        name = node.value
    else:
        raise ScreenerQueryError("Field names must be string literals")
    if not FIELD_KEY_RE.match(name):
        raise ScreenerQueryError(f"Invalid field name: {name!r}")
    return name


def _column_name_from_call(node: ast.AST) -> str:
    if not isinstance(node, ast.Call):
        raise ScreenerQueryError("Expected Column(...) or col(...)")
    if not isinstance(node.func, ast.Name) or node.func.id not in {"Column", "col"}:
        raise ScreenerQueryError("Expected Column(...) or col(...)")
    if len(node.args) != 1 or node.keywords:
        raise ScreenerQueryError("Column(...) takes exactly one string argument")
    return _field_name(node.args[0])


def _value_or_column(node: ast.AST) -> Any:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {
        "Column",
        "col",
    }:
        return _column_name_from_call(node)
    return _literal(node)


# ── Filter expression parsing ────────────────────────────────────────────────


def _parse_compare(node: ast.Compare) -> FilterCond:
    if len(node.ops) != 1 or len(node.comparators) != 1:
        raise ScreenerQueryError("Chained comparisons are not supported")
    left = _column_name_from_call(node.left)
    right = _value_or_column(node.comparators[0])
    op = node.ops[0]
    if isinstance(op, ast.Gt):
        operation = "greater"
    elif isinstance(op, ast.GtE):
        operation = "egreater"
    elif isinstance(op, ast.Lt):
        operation = "less"
    elif isinstance(op, ast.LtE):
        operation = "eless"
    elif isinstance(op, ast.Eq):
        operation = "equal"
    elif isinstance(op, ast.NotEq):
        operation = "nequal"
    else:
        raise ScreenerQueryError(f"Unsupported comparison operator: {type(op).__name__}")
    return FilterCond(left=left, operation=operation, right=right)


def _parse_column_method(node: ast.Call) -> FilterCond:
    if not isinstance(node.func, ast.Attribute):
        raise ScreenerQueryError("Expected Column(...).method(...)")
    method = node.func.attr
    if method not in ALLOWED_COLUMN_METHODS:
        raise ScreenerQueryError(f"Column method {method!r} is not allowed")
    left = _column_name_from_call(node.func.value)
    args = [_value_or_column(a) for a in node.args]
    if node.keywords:
        raise ScreenerQueryError("Keyword arguments on Column methods are not allowed")

    if method == "between":
        if len(args) != 2:
            raise ScreenerQueryError("between() takes exactly 2 arguments")
        return FilterCond(left=left, operation="in_range", right=list(args))
    if method == "not_between":
        if len(args) != 2:
            raise ScreenerQueryError("not_between() takes exactly 2 arguments")
        return FilterCond(left=left, operation="not_in_range", right=list(args))
    if method == "isin":
        if len(args) != 1:
            raise ScreenerQueryError("isin() takes exactly 1 argument")
        return FilterCond(left=left, operation="in_range", right=args[0])
    if method == "not_in":
        if len(args) != 1:
            raise ScreenerQueryError("not_in() takes exactly 1 argument")
        return FilterCond(left=left, operation="not_in_range", right=args[0])
    if method == "has":
        if len(args) != 1:
            raise ScreenerQueryError("has() takes exactly 1 argument")
        return FilterCond(left=left, operation="has", right=args[0])
    if method == "has_none_of":
        if len(args) != 1:
            raise ScreenerQueryError("has_none_of() takes exactly 1 argument")
        return FilterCond(left=left, operation="has_none_of", right=args[0])
    if method in {"in_day_range", "in_week_range", "in_month_range"}:
        if len(args) != 2:
            raise ScreenerQueryError(f"{method}() takes exactly 2 arguments")
        return FilterCond(left=left, operation=method, right=list(args))
    if method in {"above_pct", "below_pct"}:
        if len(args) != 2:
            raise ScreenerQueryError(f"{method}() takes exactly 2 arguments")
        op_map = {"above_pct": "above%", "below_pct": "below%"}
        return FilterCond(left=left, operation=op_map[method], right=list(args))
    if method in {"between_pct", "not_between_pct"}:
        if len(args) not in {2, 3}:
            raise ScreenerQueryError(f"{method}() takes 2 or 3 arguments")
        op_map = {"between_pct": "in_range%", "not_between_pct": "not_in_range%"}
        return FilterCond(left=left, operation=op_map[method], right=list(args))
    if method == "like":
        if len(args) != 1:
            raise ScreenerQueryError("like() takes exactly 1 argument")
        return FilterCond(left=left, operation="match", right=args[0])
    if method == "not_like":
        if len(args) != 1:
            raise ScreenerQueryError("not_like() takes exactly 1 argument")
        return FilterCond(left=left, operation="nmatch", right=args[0])
    if method == "empty":
        if args:
            raise ScreenerQueryError("empty() takes no arguments")
        return FilterCond(left=left, operation="empty", right=None)
    if method == "not_empty":
        if args:
            raise ScreenerQueryError("not_empty() takes no arguments")
        return FilterCond(left=left, operation="nempty", right=None)
    if method in {"crosses", "crosses_above", "crosses_below"}:
        if len(args) != 1:
            raise ScreenerQueryError(f"{method}() takes exactly 1 argument")
        return FilterCond(left=left, operation=method, right=args[0])
    raise ScreenerQueryError(f"Unhandled Column method: {method}")


def _parse_filter_expr(node: ast.AST) -> FilterCond | FilterGroup:
    if isinstance(node, ast.Compare):
        return _parse_compare(node)
    if isinstance(node, ast.Call):
        if isinstance(node.func, ast.Name) and node.func.id in {"And", "Or"}:
            operator = "and" if node.func.id == "And" else "or"
            if node.keywords:
                raise ScreenerQueryError(f"{node.func.id}() does not accept keywords")
            conditions = [_parse_filter_expr(arg) for arg in node.args]
            return FilterGroup(operator=operator, conditions=conditions)
        return _parse_column_method(node)
    raise ScreenerQueryError(f"Unsupported filter expression: {type(node).__name__}")


# ── Query chain parsing ──────────────────────────────────────────────────────


def _parse_query_ctor(node: ast.Call) -> ScreenerDefinition:
    if not isinstance(node.func, ast.Name) or node.func.id != "Query":
        raise ScreenerQueryError("Expected Query(...)")
    market = "america"
    if node.args:
        if len(node.args) > 1:
            raise ScreenerQueryError("Query() takes at most one market argument")
        market = str(_literal(node.args[0]))
    for kw in node.keywords:
        if kw.arg != "market":
            raise ScreenerQueryError(f"Unsupported Query() keyword: {kw.arg}")
        market = str(_literal(kw.value))
    if not re.match(r"^[a-z0-9_]+$", market):
        raise ScreenerQueryError(f"Invalid market: {market!r}")
    return ScreenerDefinition(market=market)


def _apply_query_method(defn: ScreenerDefinition, method: str, call: ast.Call) -> None:
    if method not in ALLOWED_QUERY_METHODS:
        raise ScreenerQueryError(f"Query method {method!r} is not allowed")
    if method == "select":
        if call.keywords:
            raise ScreenerQueryError("select() does not accept keywords")
        cols: list[str] = []
        for arg in call.args:
            if isinstance(arg, ast.Call):
                cols.append(_column_name_from_call(arg))
            else:
                cols.append(_field_name(arg))
        if not cols:
            raise ScreenerQueryError("select() requires at least one column")
        defn.columns = cols
        return
    if method == "where":
        if call.keywords:
            raise ScreenerQueryError("where() does not accept keywords")
        defn.filters = [_parse_filter_expr(arg) for arg in call.args]  # type: ignore[misc]
        # flatten only FilterCond; groups go to filter_group via where2
        flat: list[FilterCond] = []
        for item in defn.filters:
            if isinstance(item, FilterGroup):
                raise ScreenerQueryError("Use where2(And(...)/Or(...)) for nested groups")
            flat.append(item)
        defn.filters = flat
        return
    if method == "where2":
        if len(call.args) != 1 or call.keywords:
            raise ScreenerQueryError("where2() takes exactly one And(...)/Or(...) argument")
        group = _parse_filter_expr(call.args[0])
        if not isinstance(group, FilterGroup):
            raise ScreenerQueryError("where2() argument must be And(...) or Or(...)")
        defn.filter_group = group
        return
    if method == "order_by":
        if not call.args:
            raise ScreenerQueryError("order_by() requires a column")
        col_arg = call.args[0]
        if isinstance(col_arg, ast.Call):
            defn.order_by = _column_name_from_call(col_arg)
        else:
            defn.order_by = _field_name(col_arg)
        ascending = False
        if len(call.args) > 1:
            ascending = bool(_literal(call.args[1]))
        for kw in call.keywords:
            if kw.arg == "ascending":
                ascending = bool(_literal(kw.value))
            elif kw.arg in {"nulls_first", "nulls_last"}:
                continue  # ignored safely
            else:
                raise ScreenerQueryError(f"Unsupported order_by keyword: {kw.arg}")
        defn.ascending = ascending
        return
    if method == "limit":
        if len(call.args) != 1 or call.keywords:
            raise ScreenerQueryError("limit() takes exactly one integer argument")
        value = _literal(call.args[0])
        if not isinstance(value, int):
            raise ScreenerQueryError("limit() argument must be an integer")
        if value < 1 or value > 500:
            raise ScreenerQueryError("limit must be between 1 and 500")
        defn.limit = value
        return
    if method == "offset":
        if len(call.args) != 1 or call.keywords:
            raise ScreenerQueryError("offset() takes exactly one integer argument")
        value = _literal(call.args[0])
        if not isinstance(value, int):
            raise ScreenerQueryError("offset() argument must be an integer")
        if value < 0 or value > 10_000:
            raise ScreenerQueryError("offset must be between 0 and 10000")
        defn.offset = value
        return
    if method == "set_markets":
        if not call.args or call.keywords:
            raise ScreenerQueryError("set_markets() requires positional market names")
        markets = [_literal(a) for a in call.args]
        if len(markets) != 1 or not isinstance(markets[0], str):
            raise ScreenerQueryError("Only a single market string is supported")
        market = markets[0].strip()
        if not re.match(r"^[a-z0-9_]+$", market):
            raise ScreenerQueryError(f"Invalid market: {market!r}")
        defn.market = market
        return
    raise ScreenerQueryError(f"Unhandled Query method: {method}")


def _walk_query_chain(node: ast.AST) -> ScreenerDefinition:
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "Query":
        return _parse_query_ctor(node)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        defn = _walk_query_chain(node.func.value)
        _apply_query_method(defn, node.func.attr, node)
        return defn
    raise ScreenerQueryError("DSL must be a Query() method chain")


def parse_dsl(text: str) -> ScreenerDefinition:
    """Parse restricted Python-style Query DSL into a ScreenerDefinition."""
    source = (text or "").strip()
    if not source:
        raise ScreenerQueryError("Query is empty")

    try:
        tree = ast.parse(source, mode="exec")
    except SyntaxError as exc:
        raise ScreenerQueryError(f"Syntax error: {exc.msg}") from exc

    query_expr: ast.AST | None = None
    for stmt in tree.body:
        if isinstance(stmt, ast.ImportFrom):
            if stmt.module != "tradingview_screener":
                raise ScreenerQueryError("Only 'from tradingview_screener import ...' is allowed")
            allowed = {"Query", "Column", "col", "And", "Or"}
            for alias in stmt.names:
                if alias.name not in allowed:
                    raise ScreenerQueryError(f"Import of {alias.name!r} is not allowed")
            continue
        if isinstance(stmt, ast.Import):
            raise ScreenerQueryError("Use 'from tradingview_screener import Query, Column'")
        if isinstance(stmt, ast.Assign):
            if len(stmt.targets) != 1 or not isinstance(stmt.targets[0], ast.Name):
                raise ScreenerQueryError("Only simple assignments like query = Query()... are allowed")
            query_expr = stmt.value
            continue
        if isinstance(stmt, ast.Expr):
            query_expr = stmt.value
            continue
        raise ScreenerQueryError(f"Statement type {type(stmt).__name__} is not allowed")

    if query_expr is None:
        raise ScreenerQueryError("No Query() expression found")

    # Strip trailing .get_scanner_data() if present
    if (
        isinstance(query_expr, ast.Call)
        and isinstance(query_expr.func, ast.Attribute)
        and query_expr.func.attr == "get_scanner_data"
    ):
        query_expr = query_expr.func.value

    defn = _walk_query_chain(query_expr)
    if not defn.columns:
        defn.columns = ["name", "close", "volume", "market_cap_basic"]
    return ScreenerDefinition.from_dict(defn.to_dict())


# ── Definition → DSL serialization ───────────────────────────────────────────


def _format_value(value: Any) -> str:
    if isinstance(value, bool):
        return "True" if value else "False"
    if value is None:
        return "None"
    if isinstance(value, str):
        return repr(value)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_format_value(v) for v in value) + "]"
    return repr(value)


def _format_cond(cond: FilterCond) -> str:
    left = f"Column({cond.left!r})"
    op = cond.operation
    right = cond.right
    if op == "greater":
        return f"{left} > {_format_value(right)}"
    if op == "egreater":
        return f"{left} >= {_format_value(right)}"
    if op == "less":
        return f"{left} < {_format_value(right)}"
    if op == "eless":
        return f"{left} <= {_format_value(right)}"
    if op == "equal":
        return f"{left} == {_format_value(right)}"
    if op == "nequal":
        return f"{left} != {_format_value(right)}"
    if op == "in_range":
        if isinstance(right, list) and len(right) == 2:
            return f"{left}.between({_format_value(right[0])}, {_format_value(right[1])})"
        return f"{left}.isin({_format_value(right)})"
    if op == "not_in_range":
        if isinstance(right, list) and len(right) == 2:
            return f"{left}.not_between({_format_value(right[0])}, {_format_value(right[1])})"
        return f"{left}.not_in({_format_value(right)})"
    if op == "has":
        return f"{left}.has({_format_value(right)})"
    if op == "has_none_of":
        return f"{left}.has_none_of({_format_value(right)})"
    if op == "match":
        return f"{left}.like({_format_value(right)})"
    if op == "nmatch":
        return f"{left}.not_like({_format_value(right)})"
    if op == "empty":
        return f"{left}.empty()"
    if op == "nempty":
        return f"{left}.not_empty()"
    if op in {"above%", "below%", "in_range%", "not_in_range%"}:
        method = {
            "above%": "above_pct",
            "below%": "below_pct",
            "in_range%": "between_pct",
            "not_in_range%": "not_between_pct",
        }[op]
        args = right if isinstance(right, list) else [right]
        return f"{left}.{method}({', '.join(_format_value(a) for a in args)})"
    if op in {"in_day_range", "in_week_range", "in_month_range", "crosses", "crosses_above", "crosses_below"}:
        args = right if isinstance(right, list) else [right]
        return f"{left}.{op}({', '.join(_format_value(a) for a in args)})"
    raise ScreenerQueryError(f"Cannot serialize filter operation: {op}")


def _format_group(group: FilterGroup) -> str:
    fn = "And" if group.operator == "and" else "Or"
    parts: list[str] = []
    for child in group.conditions:
        if isinstance(child, FilterGroup):
            parts.append(_format_group(child))
        else:
            parts.append(_format_cond(child))
    return f"{fn}({', '.join(parts)})"


def definition_to_dsl(defn: ScreenerDefinition | dict[str, Any]) -> str:
    if isinstance(defn, dict):
        defn = ScreenerDefinition.from_dict(defn)
    lines = [
        "from tradingview_screener import Query, Column",
        "",
        f"query = (Query({defn.market!r})" if defn.market != "america" else "query = (Query()",
    ]
    cols = ", ".join(repr(c) for c in defn.columns)
    lines.append(f"    .select({cols})")
    if defn.filters:
        filter_args = ",\n        ".join(_format_cond(f) for f in defn.filters)
        lines.append(f"    .where(\n        {filter_args}\n    )")
    if defn.filter_group and defn.filter_group.conditions:
        lines.append(f"    .where2({_format_group(defn.filter_group)})")
    if defn.order_by:
        lines.append(
            f"    .order_by({defn.order_by!r}, ascending={bool(defn.ascending)})"
        )
    if defn.offset:
        lines.append(f"    .offset({int(defn.offset)})")
    lines.append(f"    .limit({int(defn.limit)})")
    lines.append(")")
    return "\n".join(lines) + "\n"


# ── Execute against tradingview-screener ─────────────────────────────────────


def _build_column_filter(cond: FilterCond):
    from tradingview_screener import Column

    col = Column(cond.left)
    op = cond.operation
    right = cond.right
    if op == "greater":
        return col > right
    if op == "egreater":
        return col >= right
    if op == "less":
        return col < right
    if op == "eless":
        return col <= right
    if op == "equal":
        return col == right
    if op == "nequal":
        return col != right
    if op == "in_range":
        if isinstance(right, list) and len(right) == 2:
            return col.between(right[0], right[1])
        return col.isin(right)
    if op == "not_in_range":
        if isinstance(right, list) and len(right) == 2:
            return col.not_between(right[0], right[1])
        return col.not_in(right)
    if op == "has":
        return col.has(right)
    if op == "has_none_of":
        return col.has_none_of(right)
    if op == "match":
        return col.like(right)
    if op == "nmatch":
        return col.not_like(right)
    if op == "empty":
        return col.empty()
    if op == "nempty":
        return col.not_empty()
    if op == "above%":
        return col.above_pct(right[0], right[1])
    if op == "below%":
        return col.below_pct(right[0], right[1])
    if op == "in_range%":
        return col.between_pct(*right)
    if op == "not_in_range%":
        return col.not_between_pct(*right)
    if op == "in_day_range":
        return col.in_day_range(right[0], right[1])
    if op == "in_week_range":
        return col.in_week_range(right[0], right[1])
    if op == "in_month_range":
        return col.in_month_range(right[0], right[1])
    if op == "crosses":
        return col.crosses(right)
    if op == "crosses_above":
        return col.crosses_above(right)
    if op == "crosses_below":
        return col.crosses_below(right)
    raise ScreenerQueryError(f"Unsupported filter operation: {op}")


def _build_operation(group: FilterGroup):
    from tradingview_screener import And, Or

    parts = []
    for child in group.conditions:
        if isinstance(child, FilterGroup):
            parts.append(_build_operation(child))
        else:
            parts.append(_build_column_filter(child))
    if group.operator == "or":
        return Or(*parts)
    return And(*parts)


def build_query(defn: ScreenerDefinition | dict[str, Any]):
    """Construct a tradingview_screener.Query from a validated definition."""
    from tradingview_screener import Query

    if isinstance(defn, dict):
        defn = ScreenerDefinition.from_dict(defn)
    q = Query(defn.market)
    q = q.select(*defn.columns)
    if defn.filters:
        q = q.where(*[_build_column_filter(f) for f in defn.filters])
    if defn.filter_group and defn.filter_group.conditions:
        q = q.where2(_build_operation(defn.filter_group))
    if defn.order_by:
        q = q.order_by(defn.order_by, ascending=defn.ascending)
    if defn.offset:
        q = q.offset(defn.offset)
    q = q.limit(defn.limit)
    return q


def normalize_cell(value: Any) -> Any:
    if value is None:
        return None
    try:
        import math

        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            return None
    except Exception:
        pass
    # numpy / pandas scalars
    item = getattr(value, "item", None)
    if callable(item):
        try:
            value = item()
        except Exception:
            pass
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def run_scanner(defn: ScreenerDefinition | dict[str, Any]) -> tuple[int, list[dict[str, Any]], list[str]]:
    """Execute scanner and return (total_count, rows, columns)."""
    if isinstance(defn, dict):
        defn = ScreenerDefinition.from_dict(defn)
    query = build_query(defn)
    total, df = query.get_scanner_data()
    columns = ["ticker", *defn.columns]
    rows: list[dict[str, Any]] = []
    if df is None or getattr(df, "empty", True):
        return int(total or 0), rows, columns
    records = df.to_dict(orient="records")
    for record in records:
        row = {str(k): normalize_cell(v) for k, v in record.items()}
        # Ensure ticker/name always present
        if "ticker" not in row and "name" in row:
            row["ticker"] = row["name"]
        rows.append(row)
    return int(total or len(rows)), rows, columns


def column_headers(columns: list[str]) -> list[dict[str, str]]:
    return [{"key": c, "label": "Symbol" if c == "ticker" else field_label(c)} for c in columns]


PREMARKET_MOVERS_DEFINITION = ScreenerDefinition(
    columns=["name", "close", "premarket_change", "premarket_volume", "market_cap_basic"],
    filters=[
        FilterCond(left="premarket_change", operation="greater", right=5),
        FilterCond(left="close", operation="less", right=20),
        FilterCond(left="premarket_volume", operation="greater", right=100_000),
    ],
    order_by="premarket_change",
    ascending=False,
    limit=50,
    market="america",
)

# Pre Market gainers — same filters as above, columns aligned to TradingView overview.
PRE_MARKET_GAINERS_DEFINITION = ScreenerDefinition(
    columns=[
        "name",
        "premarket_change",
        "premarket_close",
        "premarket_change_abs",
        "premarket_volume",
        "premarket_gap",
        "close",
        "change",
        "volume",
        "market_cap_basic",
        "Perf.1Y.MarketCap",
    ],
    filters=[
        FilterCond(left="premarket_change", operation="greater", right=5),
        FilterCond(left="close", operation="less", right=20),
        FilterCond(left="premarket_volume", operation="greater", right=100_000),
    ],
    order_by="premarket_change",
    ascending=False,
    limit=50,
    market="america",
)
PRE_MARKET_GAINERS_NAME = "Pre Market gainers"
